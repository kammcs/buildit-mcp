// Location stripping for photos and videos, checked against the same
// vectors the app's own pass is tested with: real files made with ImageIO,
// cwebp, ffmpeg and exiftool (test/fixtures/location/README.md says how),
// and structures built here byte by byte. Where ffmpeg or exiftool is
// installed, the stripped videos are also read back with them; elsewhere
// those checks are skipped.
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LocationUnreadableError,
  copyWithPatches,
  crc32,
  diffPatch,
  isMovie,
  patchChunk,
  stripLocation,
  stripXmpLocation,
  videoLocationPatches,
  type FilePatch,
} from '../src/files/location.js';

const here = dirname(fileURLToPath(import.meta.url));

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(here, 'fixtures', 'location', name)));
}

function buf(b: Uint8Array): Buffer {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength);
}

function latin1(s: string): number[] {
  return Array.from(Buffer.from(s, 'latin1'));
}

function utf8(s: string): number[] {
  return Array.from(Buffer.from(s, 'utf8'));
}

function ascii(b: Uint8Array, from: number, to: number): string {
  return buf(b.subarray(from, to)).toString('latin1');
}

/** Whether [haystack] holds [needle], spelled in Latin-1. */
function has(haystack: Uint8Array, needle: string): boolean {
  return buf(haystack).indexOf(Buffer.from(needle, 'latin1')) >= 0;
}

function indexOfBytes(b: Uint8Array, n: number[], from = 0): number {
  return buf(b).indexOf(Buffer.from(n), from);
}

/** A small seeded random number generator (mulberry32), for repeatable damage. */
function seeded(seed: number): { nextInt: (max: number) => number } {
  let a = seed >>> 0;
  return {
    nextInt(max: number): number {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * max);
    },
  };
}

function refused(e: unknown): boolean {
  if (e instanceof LocationUnreadableError) return true;
  throw e;
}

// ---------------------------------------------------------------------------
// Photos

const formats = ['gps.jpg', 'gps.png', 'gps.webp', 'gps.heic', 'gps.tif'];

/** Text that only the location fields hold (UTF-8 and Latin-1 spellings). */
const locationText = [
  'Montr',
  'Vieux-Port',
  'bec', // Québec
  'Canada',
  'GPSLatitude',
  'GPSLongitude',
  'LocationShown',
  'photoshop:City',
  'CountryCode',
];

/**
 * The tags of a TIFF block's IFD0, Exif IFD and GPS IFD, and the ASCII
 * values of IFD0's and the Exif IFD's text tags. Lenient: what can't be
 * read is left out.
 */
interface TiffSummary {
  ifd0: Set<number>;
  exif: Set<number>;
  text: Map<number, string>;
  gpsIfd: number | null;
  gpsLength: number;
  hasGps: boolean;
}

function tiffSummary(b: Uint8Array, at: number): TiffSummary {
  const s = {
    ifd0: new Set<number>(),
    exif: new Set<number>(),
    text: new Map<number, string>(),
    gpsIfd: null as number | null,
    gpsLength: 0,
  };
  const summary = (): TiffSummary => ({
    ...s,
    hasGps: s.ifd0.has(0x8825) || s.exif.has(0x8825),
  });
  const d = new DataView(b.buffer, b.byteOffset + at, b.length - at);
  if (d.byteLength < 8) return summary();
  const little = b[at] === 0x49;
  const read = (ifd: number, into: Set<number>): void => {
    if (ifd + 2 > d.byteLength) return;
    const count = d.getUint16(ifd, little);
    for (let n = 0; n < count; n++) {
      const entry = ifd + 2 + n * 12;
      if (entry + 12 > d.byteLength) return;
      const tag = d.getUint16(entry, little);
      const type = d.getUint16(entry + 2, little);
      const length = d.getUint32(entry + 4, little);
      into.add(tag);
      if (type === 2) {
        const value = length <= 4 ? entry + 8 : d.getUint32(entry + 8, little);
        if (value + length <= d.byteLength) {
          s.text.set(tag, ascii(b, at + value, at + value + length - 1));
        }
      }
      if (tag === 0x8769) read(d.getUint32(entry + 8, little), s.exif);
      if (tag === 0x8825) {
        s.gpsIfd = at + d.getUint32(entry + 8, little);
        const g = d.getUint32(entry + 8, little);
        if (g + 2 <= d.byteLength) s.gpsLength = 2 + d.getUint16(g, little) * 12 + 4;
      }
    }
  };
  read(d.getUint32(4, little), s.ifd0);
  return summary();
}

/** Where the (first) Exif TIFF header is in [b]. */
function tiffAt(b: Uint8Array): number {
  const mm = indexOfBytes(b, [0x4d, 0x4d, 0x00, 0x2a]);
  const ii = indexOfBytes(b, [0x49, 0x49, 0x2a, 0x00]);
  if (mm < 0) return ii;
  if (ii < 0) return mm;
  return Math.min(mm, ii);
}

/** Where a JPEG's image data (its first top-level SOS marker) starts. */
function sos(b: Uint8Array): number {
  let i = 2;
  while (b[i] === 0xff && b[i + 1] !== 0xda) i += 2 + ((b[i + 2]! << 8) | b[i + 3]!);
  return i;
}

/**
 * The bytes that hold the image itself, per format: JPEG from SOS on, the
 * PNG IDAT chunks, the WebP VP8 chunk, the HEIF mdat box, the TIFF strip.
 */
function imageData(name: string, b: Uint8Array): Uint8Array {
  const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
  switch (name.split('.').pop()) {
    case 'jpg':
      return b.slice(sos(b));
    case 'png': {
      const parts: number[] = [];
      for (let i = 8; i + 8 <= b.length;) {
        const length = d.getUint32(i);
        if (ascii(b, i + 4, i + 8) === 'IDAT') parts.push(...b.subarray(i + 8, i + 8 + length));
        i += 12 + length;
      }
      return new Uint8Array(parts);
    }
    case 'webp': {
      let at = indexOfBytes(b, latin1('VP8 '));
      if (at < 0) at = indexOfBytes(b, latin1('VP8L'));
      return b.slice(at, at + 8 + d.getUint32(at + 4, true));
    }
    case 'heic': {
      const at = indexOfBytes(b, latin1('mdat')) - 4;
      return b.slice(at, at + d.getUint32(at));
    }
    case 'tif':
      // ImageIO writes the single strip right before the end.
      return b.slice(b.length - 24 * 16 * 3);
  }
  throw new Error(name);
}

describe('photos: the fixtures', () => {
  it('have a location to remove', () => {
    for (const name of formats) {
      const b = fixture(name);
      expect(tiffSummary(b, tiffAt(b)).hasGps, `${name} has a GPS IFD`).toBe(true);
      expect(has(b, 'Montr'), `${name} has a city`).toBe(true);
    }
  });
});

for (const name of formats) {
  describe(name, () => {
    const input = fixture(name);
    let stripped: Uint8Array | undefined;
    const out = (): Uint8Array => (stripped ??= stripLocation(input));

    it('loses the GPS IFD and the location text', () => {
      const tiff = tiffSummary(out(), tiffAt(out()));
      expect(tiff.hasGps).toBe(false);
      for (const text of locationText) expect(has(out(), text), `"${text}" is gone`).toBe(false);
    });

    it('zeroes the GPS IFD it removed', () => {
      const before = tiffSummary(input, tiffAt(input));
      const start = before.gpsIfd!;
      expect(
        out()
          .subarray(start, start + before.gpsLength)
          .every((c) => c === 0),
      ).toBe(true);
    });

    it('keeps the other metadata', () => {
      const tiff = tiffSummary(out(), tiffAt(out()));
      expect(tiff.text.get(0x010f)).toBe('Apple'); // Make
      expect(tiff.text.get(0x0110)).toBe('iPhone 17 Pro'); // Model
      expect(tiff.text.get(0x9003) ?? '').toBe('2026:10:03 12:34:56');
      expect(tiff.exif.has(0x9003)).toBe(true); // DateTimeOriginal
      expect(has(out(), 'Harbour'), 'XMP title').toBe(true);
      expect(has(out(), 'xmp:Rating')).toBe(true);
    });

    it('keeps the image data byte for byte', () => {
      expect(out().length, 'same length').toBe(input.length);
      expect(imageData(name, out())).toEqual(imageData(name, input));
    });

    it('leaves the input alone', () => {
      expect(out()).not.toBe(input);
      expect(fixture(name)).toEqual(input);
    });

    it('does nothing the second time', () => {
      expect(stripLocation(out())).toBe(out());
    });
  });
}

describe('photos: other checks', () => {
  it('PNG chunk CRCs stay valid', () => {
    const out = stripLocation(fixture('gps.png'));
    const d = new DataView(out.buffer, out.byteOffset, out.byteLength);
    for (let i = 8; i + 12 <= out.length;) {
      const length = d.getUint32(i);
      expect(d.getUint32(i + 8 + length), ascii(out, i + 4, i + 8)).toBe(
        crc32(out.subarray(i + 4, i + 8 + length)),
      );
      i += 12 + length;
    }
  });

  it('the JPEG thumbnail loses its own GPS IFD', () => {
    const input = fixture('gps.jpg');
    const out = stripLocation(input);
    // The thumbnail is a whole JPEG inside the Exif block, after IFD0's.
    const thumb = indexOfBytes(out, [0xff, 0xd8, 0xff], 2);
    expect(thumb).toBeGreaterThan(0);
    const at = indexOfBytes(out, [0x4d, 0x4d, 0x00, 0x2a], thumb);
    expect(tiffSummary(input, at).hasGps).toBe(true);
    expect(tiffSummary(out, at).hasGps).toBe(false);
    expect(tiffSummary(out, at).text.get(0x010f)).toBe('Apple');
  });
});

describe('nothing to remove', () => {
  it('a photo without metadata comes back as it is', () => {
    const plain = fixture('plain.png');
    expect(stripLocation(plain)).toBe(plain);
  });

  it('other files come back as they are', () => {
    for (const bytes of [
      new Uint8Array(utf8('%PDF-1.7 GPSLatitude Montréal')),
      new Uint8Array(0),
      new Uint8Array([0xff, 0xd8]),
      new Uint8Array(latin1('GIF89a')),
    ]) {
      expect(stripLocation(bytes)).toBe(bytes);
    }
  });
});

describe('MPF images (gain map, second view)', () => {
  it('the second image loses its location too', () => {
    const primary = fixture('gps.jpg');
    const second = fixture('gps.jpg');
    // SOI, APP2 MPF, then the primary's own segments, then the second.
    const mpfLength = 2 + 4 + 8 + 2 + 12 + 4 + 32;
    const headerAt = 2 + 4 + 4; // after SOI, marker, length, "MPF\0"
    const primaryLength = primary.length + 4 + mpfLength - 2;
    const m = new Uint8Array(mpfLength + 2);
    const mpf = new DataView(m.buffer);
    mpf.setUint16(0, 0xffe2);
    mpf.setUint16(2, mpfLength);
    m.set(latin1('MPF\x00'), 4);
    const h = new DataView(m.buffer, 8);
    h.setUint32(0, 0x4d4d002a);
    h.setUint32(4, 8);
    h.setUint16(8, 1);
    h.setUint16(10, 0xb002);
    h.setUint16(12, 7);
    h.setUint32(14, 32);
    h.setUint32(18, 26);
    h.setUint32(22, 0);
    // Entry 1: the primary, offset 0. Entry 2: the second image.
    h.setUint32(26 + 4, primaryLength);
    h.setUint32(42 + 4, second.length);
    h.setUint32(42 + 8, primaryLength - headerAt);
    expect(h.byteLength).toBe(58);
    const file = new Uint8Array([0xff, 0xd8, ...m, ...primary.subarray(2), ...second]);
    expect(file.length).toBe(primaryLength + second.length);

    const out = stripLocation(file);
    expect(out.length).toBe(file.length);
    const secondOut = out.slice(primaryLength);
    expect(tiffSummary(secondOut, tiffAt(secondOut)).hasGps).toBe(false);
    for (const text of locationText) expect(has(out, text), text).toBe(false);
    expect(imageData('x.jpg', secondOut)).toEqual(imageData('x.jpg', second));
  });
});

describe('extended XMP', () => {
  it('location split across chunks is removed', () => {
    const packet =
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF ' +
      'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      '<rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/">' +
      '<exif:GPSLatitude>45,30.1N</exif:GPSLatitude>' +
      '<dc:format>image/jpeg</dc:format>' +
      '</rdf:Description></rdf:RDF></x:xmpmeta>';
    const bytes = latin1(packet);
    const split = packet.indexOf('GPSLat') + 3;
    const guid = '0123456789ABCDEF0123456789ABCDEF';
    const chunk = (offset: number, data: number[]): number[] => {
      const header = latin1(`http://ns.adobe.com/xmp/extension/\x00${guid}`);
      const length = 2 + header.length + 8 + data.length;
      return [
        0xff,
        0xe1,
        length >> 8,
        length & 0xff,
        ...header,
        ...[0, 0, bytes.length >> 8, bytes.length & 0xff],
        ...[0, 0, offset >> 8, offset & 0xff],
        ...data,
      ];
    };

    // A JPEG with no location of its own.
    const plain = stripLocation(fixture('gps.jpg'));
    const file = new Uint8Array([
      0xff,
      0xd8,
      ...chunk(split, bytes.slice(split)),
      ...chunk(0, bytes.slice(0, split)),
      ...plain.subarray(2),
    ]);
    const out = stripLocation(file);
    expect(out.length).toBe(file.length);
    expect(has(file, 'Latitude>45,30.1N')).toBe(true);
    expect(has(out, 'Latitude')).toBe(false);
    expect(has(out, '45,30')).toBe(false);
    expect(has(out, '<dc:format>image/jpeg</dc:format>')).toBe(true);
  });
});

describe('XMP', () => {
  const strip = (xmp: string): string => {
    const b = new Uint8Array(utf8(xmp));
    const changed = stripXmpLocation(b);
    const out = buf(b).toString('utf8');
    expect(changed).toBe(out !== xmp);
    return out.replace(/ +/g, ' ');
  };

  const open = '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">';

  it('attributes and elements, any prefix', () => {
    expect(
      strip(
        `${open}<rdf:Description xmlns:ps="http://ns.adobe.com/photoshop/1.0/" ` +
          'xmlns:exif="http://ns.adobe.com/exif/1.0/" ' +
          'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
          'ps:City=\'Montréal\' ps:Headline="Port" exif:GPSAltitude="36/1">' +
          '<ps:Country>Canada</ps:Country><exif:GPSVersionID/>' +
          '<dc:title>Harbour</dc:title></rdf:Description></rdf:RDF>',
      ),
    ).toBe(
      `${open}<rdf:Description xmlns:ps="http://ns.adobe.com/photoshop/1.0/" ` +
        'xmlns:exif="http://ns.adobe.com/exif/1.0/" ' +
        'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
        'ps:Headline="Port" > <dc:title>Harbour</dc:title>' +
        '</rdf:Description></rdf:RDF>',
    );
  });

  it('nested structures go whole', () => {
    const out = strip(
      `${open}<rdf:Description ` +
        'xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" ' +
        'xmlns:Iptc4xmpCore="http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/">' +
        '<Iptc4xmpExt:LocationShown><rdf:Bag><rdf:li rdf:parseType="Resource">' +
        '<Iptc4xmpExt:City>Montréal</Iptc4xmpExt:City></rdf:li></rdf:Bag>' +
        '</Iptc4xmpExt:LocationShown>' +
        '<Iptc4xmpCore:Location>Vieux-Port</Iptc4xmpCore:Location>' +
        '<Iptc4xmpCore:IntellectualGenre>News</Iptc4xmpCore:IntellectualGenre>' +
        '</rdf:Description></rdf:RDF>',
    );
    expect(out).not.toContain('Montr');
    expect(out).not.toContain('Vieux');
    expect(out).toContain('<Iptc4xmpCore:IntellectualGenre>News<');
  });

  it('a drone position, in its own namespace', () => {
    const out = strip(
      `${open}<rdf:Description xmlns:drone-dji="http://www.dji.com/drone-dji/1.0/" ` +
        'drone-dji:GpsLatitude="45.5" drone-dji:GpsLongitude="-73.5" ' +
        'drone-dji:FlightYawDegree="12"/></rdf:RDF>',
    );
    expect(out).not.toContain('45.5');
    expect(out).toContain('FlightYawDegree="12"');
  });

  it('a packet that cannot be parsed is blanked', () => {
    const b = new Uint8Array(utf8('<x:xmpmeta><photoshop:City>Montréal</x:xmpmeta>'));
    expect(stripXmpLocation(b)).toBe(true);
    expect(b.every((c) => c === 0x20)).toBe(true);
  });

  it('comments, CDATA and processing instructions are skipped', () => {
    const out = strip(
      '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
        '<!-- <photoshop:City>x</photoshop:City> -->' +
        `${open}<rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/">` +
        '<exif:GPSAreaInformation><![CDATA[<a>Montréal</a>]]>' +
        '</exif:GPSAreaInformation></rdf:Description></rdf:RDF>' +
        '<?xpacket end="w"?>',
    );
    expect(out).not.toContain('Montr');
    expect(out).toContain('<?xpacket end="w"?>');
  });
});

describe('broken photos never crash, and never keep a readable location', () => {
  it('a JPEG cut anywhere in its metadata', () => {
    const input = fixture('gps.jpg');
    for (let length = 0; length < sos(input) + 16; length++) {
      const cut = input.slice(0, length);
      const out = stripLocation(cut);
      expect(out.length).toBe(cut.length);
      const at = tiffAt(out);
      if (at >= 0) expect(tiffSummary(out, at).hasGps, `${length}`).toBe(false);
      for (const text of ['GPSLatitude', 'photoshop:City', 'Montr']) {
        expect(has(out, text), `${text} at ${length}`).toBe(false);
      }
    }
  });

  it('a PNG or WebP cut anywhere', () => {
    for (const name of ['gps.png', 'gps.webp']) {
      const input = fixture(name);
      for (let length = 0; length < input.length; length++) {
        const out = stripLocation(input.slice(0, length));
        const at = tiffAt(out);
        if (at >= 0) expect(tiffSummary(out, at).hasGps, `${length}`).toBe(false);
        expect(has(out, 'Montr'), `${name} at ${length}`).toBe(false);
      }
    }
  });

  it('a HEIC or TIFF cut in its metadata is refused', () => {
    for (const name of ['gps.heic', 'gps.tif']) {
      const input = fixture(name);
      for (let length = 0; length < input.length; length++) {
        const cut = input.slice(0, length);
        let out: Uint8Array;
        try {
          out = stripLocation(cut);
        } catch (e) {
          if (refused(e)) continue; // Refused: fine.
          throw e;
        }
        const at = tiffAt(out);
        if (at >= 0) expect(tiffSummary(out, at).hasGps, `${length}`).toBe(false);
        expect(has(out, 'Montr'), `${length}`).toBe(false);
      }
    }
  });

  it('an unreadable Exif block becomes an empty one', () => {
    const input = fixture('gps.jpg');
    const at = tiffAt(input);
    const broken = new Uint8Array(input);
    new DataView(broken.buffer).setUint32(at + 4, 0x7ffffff0); // IFD0
    const out = stripLocation(broken);
    expect(Array.from(out.subarray(at, at + 8))).toEqual([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8]);
    expect(Array.from(out.subarray(at + 8, at + 14))).toEqual([0, 0, 0, 0, 0, 0]);
    expect(has(out, 'Apple')).toBe(false);
    expect(imageData('x.jpg', out)).toEqual(imageData('x.jpg', input));
  });

  it('random damage to the metadata', () => {
    const random = seeded(36);
    for (const name of formats) {
      const input = fixture(name);
      const metadataEnd = name === 'gps.tif' ? input.length : 3000;
      for (let round = 0; round < 300; round++) {
        const b = new Uint8Array(input);
        for (let k = 0; k < 1 + random.nextInt(8); k++) {
          b[random.nextInt(Math.min(metadataEnd, b.length))] = random.nextInt(256);
        }
        try {
          stripLocation(b);
        } catch (e) {
          // A refusal, for HEIF and TIFF.
          expect(refused(e)).toBe(true);
          expect(['gps.heic', 'gps.tif']).toContain(name);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Videos

const videos = ['gps.mov', 'gps-tagged.mov', 'gps.mp4'];

/** Text that only the location fields hold. */
const videoLocationText = [
  '45.50', // ISO 6709, XMP
  '73.56',
  'Montr',
  'Vieux-Port',
  'GPSLatitude',
  'GPSLongitude',
  'photoshop:City',
  'earth', // loci's body
];

/** A box as the test reads it: its path (`moov/udta/loci`), type and span. */
interface TestBox {
  path: string;
  type: string;
  start: number;
  end: number;
}

/**
 * Every box under the containers that hold metadata, read independently
 * of the code under test. `ilst` items are listed by their key name
 * (`ilst/com.apple.quicktime.location.ISO6709`) when the `meta` box has
 * `keys`.
 */
function boxTree(b: Uint8Array): TestBox[] {
  const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: TestBox[] = [];
  const walk = (from: number, to: number, parent: string, keys: string[] | null): void => {
    let i = from;
    while (i + 8 <= to) {
      let size = d.getUint32(i);
      let header = 8;
      const type = ascii(b, i + 4, i + 8);
      if (size === 1) {
        size = d.getUint32(i + 8) * 0x100000000 + d.getUint32(i + 12);
        header = 16;
      } else if (size === 0) {
        size = to - i;
      }
      if (size < header || i + size > to) return;
      let name = type;
      if (parent.endsWith('ilst') && keys !== null && type !== 'free') {
        const index = d.getUint32(i + 4);
        if (index >= 1 && index <= keys.length) name = keys[index - 1]!;
      }
      const path = parent === '' ? name : `${parent}/${name}`;
      out.push({ path, type, start: i, end: i + size });
      switch (type) {
        case 'moov':
        case 'trak':
        case 'udta':
          walk(i + header, i + size, path, null);
          break;
        case 'meta': {
          let at = i + header;
          if (d.getUint32(at) === 0) at += 4;
          walk(at, i + size, path, metaKeys(b, at, i + size));
          break;
        }
        case 'ilst':
          walk(i + header, i + size, path, keys);
          break;
      }
      i += size;
    }
  };
  walk(0, b.length, '', null);
  return out;
}

/** The key names of the `keys` box among the boxes from [from] to [to]. */
function metaKeys(b: Uint8Array, from: number, to: number): string[] | null {
  const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let i = from; i + 8 <= to; i += d.getUint32(i)) {
    if (d.getUint32(i) < 8) return null;
    if (ascii(b, i + 4, i + 8) !== 'keys') continue;
    const names: string[] = [];
    let p = i + 16;
    for (let n = 0; n < d.getUint32(i + 12); n++) {
      const size = d.getUint32(p);
      names.push(buf(b.subarray(p + 8, p + size)).toString('utf8'));
      p += size;
    }
    return names;
  }
  return null;
}

/** The bytes of every box of [type] in [b], in order. */
function boxesOf(b: Uint8Array, type: string): Uint8Array[] {
  return boxTree(b)
    .filter((box) => box.type === type)
    .map((box) => b.slice(box.start, box.end));
}

/** The location boxes and items a file holds, by path. */
function locationBoxes(b: Uint8Array): string[] {
  return boxTree(b)
    .filter(
      (box) =>
        box.type === '©xyz' ||
        box.type === 'loci' ||
        (box.path.includes('/ilst/') &&
          /location|gps|iso6709/i.test(box.path.split('/ilst/').pop()!)),
    )
    .map((box) => box.path);
}

/** A box of [type] holding [content]. */
function box(type: string, content: number[]): number[] {
  const size = 8 + content.length;
  return [
    size >>> 24,
    (size >> 16) & 0xff,
    (size >> 8) & 0xff,
    size & 0xff,
    ...latin1(type),
    ...content,
  ];
}

/** A `keys` box with these names, and an `ilst` with one UTF-8 value each. */
function keyedMeta(items: Record<string, string>): number[] {
  const names = Object.keys(items);
  return box('meta', [
    ...box('hdlr', [
      ...new Array<number>(8).fill(0),
      ...latin1('mdta'),
      ...new Array<number>(13).fill(0),
    ]),
    ...box('keys', [
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      names.length,
      // Each key: its size, its namespace, its name.
      ...names.flatMap((n) => box('mdta', utf8(n))),
    ]),
    ...box(
      'ilst',
      names.flatMap((n, k) =>
        box(
          String.fromCharCode(0, 0, 0, k + 1),
          box('data', [0, 0, 0, 1, 0, 0, 0, 0, ...utf8(items[n]!)]),
        ),
      ),
    ),
  ]);
}

/** The time [run] takes, in milliseconds. */
function timed(run: () => void): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

function installed(tool: string, flag: string): boolean {
  const r = spawnSync(tool, [flag], { stdio: 'ignore' });
  return r.error === undefined && r.status === 0;
}

function filled(length: number, value: number): number[] {
  return new Array<number>(length).fill(value);
}

const hasExiftool = installed('exiftool', '-ver');
const hasFfmpeg = installed('ffprobe', '-version') && installed('ffmpeg', '-version');

let temp = '';
beforeAll(() => {
  temp = mkdtempSync(join(tmpdir(), 'location-test-'));
});
afterAll(() => {
  rmSync(temp, { recursive: true, force: true });
});

function writeTemp(name: string, bytes: Uint8Array): string {
  const path = join(temp, name);
  writeFileSync(path, bytes);
  return path;
}

describe('videos: the fixtures', () => {
  it('have a location to remove, in the expected places', () => {
    for (const name of videos) {
      const b = fixture(name);
      expect(isMovie(b), name).toBe(true);
      expect(has(b, '45.50'), name).toBe(true);
      expect(locationBoxes(b), name).not.toEqual([]);
      expect(b.length, `small, ${name}`).toBeLessThan(200 * 1024);
    }
    expect(locationBoxes(fixture('gps.mov'))).toEqual([
      'moov/udta/meta/ilst/com.apple.quicktime.location.ISO6709',
      'moov/udta/meta/ilst/com.apple.quicktime.location.name',
      'moov/udta/meta/ilst/location',
      'moov/udta/loci',
    ]);
    expect(locationBoxes(fixture('gps-tagged.mov'))).toEqual([
      'moov/udta/meta/ilst/location',
      'moov/udta/loci',
      'moov/udta/©xyz',
      'moov/meta/ilst/com.apple.quicktime.location.ISO6709',
      'moov/meta/ilst/com.apple.quicktime.location.name',
    ]);
    expect(locationBoxes(fixture('gps.mp4'))).toEqual([
      'moov/udta/meta/ilst/©xyz',
      'moov/udta/loci',
      'moov/udta/©xyz',
    ]);
    // A phone's layout: the media data comes before moov.
    expect(
      boxTree(fixture('gps.mov'))
        .map((b) => b.path)
        .slice(0, 4),
    ).toEqual(['ftyp', 'wide', 'mdat', 'moov']);
  });
});

for (const name of videos) {
  describe(name, () => {
    const input = fixture(name);
    let stripped: Uint8Array | undefined;
    const out = (): Uint8Array => (stripped ??= stripLocation(input));

    it('loses every location box and the location text', () => {
      expect(locationBoxes(out())).toEqual([]);
      for (const text of videoLocationText) {
        expect(has(out(), text), `"${text}" is gone`).toBe(false);
      }
    });

    it('keeps the other metadata', () => {
      expect(has(out(), 'Harbour'), 'title').toBe(true);
      expect(has(out(), '2026-10-03T12:34:56Z') || name === 'gps.mp4').toBe(true);
      if (name !== 'gps.mp4') {
        expect(has(out(), 'iPhone 17 Pro')).toBe(true);
        expect(has(out(), 'com.apple.quicktime.make')).toBe(true);
      }
      if (name !== 'gps.mov') expect(has(out(), 'xmp:Rating')).toBe(true);
    });

    it('keeps the media data, the tracks and every offset', () => {
      expect(out().length, 'same length').toBe(input.length);
      expect(boxesOf(out(), 'mdat')).toEqual(boxesOf(input, 'mdat'));
      // The sample tables (stco, stsz, stsd...) are in the tracks.
      expect(boxesOf(out(), 'trak')).toEqual(boxesOf(input, 'trak'));
      expect(boxesOf(out(), 'mvhd')).toEqual(boxesOf(input, 'mvhd'));
      expect(
        boxTree(out()).map((b) => [b.start, b.end]),
        'no box moved or changed size',
      ).toEqual(boxTree(input).map((b) => [b.start, b.end]));
    });

    it('turns location atoms into zeroed free boxes', () => {
      const located = locationBoxes(input);
      for (const b of boxTree(input)) {
        if (!located.includes(b.path)) continue;
        expect(ascii(out(), b.start + 4, b.start + 8)).toBe('free');
        expect(
          out()
            .subarray(b.start + 8, b.end)
            .every((c) => c === 0),
        ).toBe(true);
      }
    });

    it('leaves the input alone', () => {
      expect(out()).not.toBe(input);
      expect(fixture(name)).toEqual(input);
    });

    it('does nothing the second time', () => {
      expect(stripLocation(out())).toBe(out());
    });

    it.skipIf(!hasExiftool)('exiftool finds no location, and the rest', () => {
      const file = writeTemp(`out-${name}`, out());
      const result = spawnSync('exiftool', ['-j', '-a', '-G1', '-struct', file], {
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      const tags = (JSON.parse(result.stdout) as Record<string, unknown>[])[0]!;
      const location = Object.entries(tags).filter(
        ([key, value]) =>
          /gps|location/i.test(key) ||
          /45\.5|73\.5|Montr/.test(typeof value === 'string' ? value : JSON.stringify(value)),
      );
      expect(location.map(([key]) => key)).toEqual([]);
      expect(Object.entries(tags).find(([key]) => key.endsWith(':Title'))?.[1]).toBe('Harbour');
      if (name !== 'gps.mp4') expect(tags['Keys:Model']).toBe('iPhone 17 Pro');
      expect(tags['ExifTool:Warning']).toBeUndefined();
    });

    it.skipIf(!hasFfmpeg)('ffmpeg still reads it, and decodes the same frames and audio', () => {
      const before = writeTemp(`in-${name}`, input);
      const after = writeTemp(name, out());
      const probe = spawnSync(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'format_tags:stream=codec_name', '-of', 'json', after],
        { encoding: 'utf8' },
      );
      expect(probe.status, probe.stderr).toBe(0);
      expect(probe.stderr).toBe('');
      const json = probe.stdout;
      expect(json).toContain('"h264"');
      expect(json).toContain('"aac"');
      for (const text of ['45.50', '73.56', 'Montr', 'Vieux']) {
        expect(json, text).not.toContain(text);
      }
      const md5 = (path: string): string => {
        const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-map', '0', '-f', 'md5', '-'], {
          encoding: 'utf8',
        });
        expect(r.status, r.stderr).toBe(0);
        expect(r.stderr).toBe('');
        return r.stdout;
      };
      expect(md5(after)).toBe(md5(before));
    });
  });
}

describe('structures the fixtures lack', () => {
  const ftyp = box('ftyp', latin1('qt  \x00\x00\x02\x00qt  '));
  const mdat = box('mdat', filled(64, 0xab));
  const xyz = box('©xyz', [0, 18, 0x15, 0xc7, ...latin1('+45.5017-073.5673/')]);
  const stbl = box('stbl', [
    ...box('stsz', filled(20, 1)),
    ...box('co64', [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0]),
  ]);

  it("a track's own udta and meta, a co64 table", () => {
    const trak = box('trak', [
      ...box('tkhd', filled(84, 0)),
      ...box('mdia', box('minf', stbl)),
      ...box('udta', xyz),
      ...keyedMeta({
        'com.apple.quicktime.location.ISO6709': '+45.5017-073.5673/',
        'com.apple.quicktime.camera.lens_model': 'back camera',
      }),
    ]);
    const file = new Uint8Array([
      ...ftyp,
      ...mdat,
      ...box('moov', [...box('mvhd', filled(100, 0)), ...trak]),
    ]);
    expect(locationBoxes(file)).toEqual([
      'moov/trak/udta/©xyz',
      'moov/trak/meta/ilst/com.apple.quicktime.location.ISO6709',
    ]);
    const out = stripLocation(file);
    expect(locationBoxes(out)).toEqual([]);
    expect(has(out, '45.50')).toBe(false);
    expect(has(out, 'back camera')).toBe(true);
    // The sample table, co64 included, is in mdia.
    expect(boxesOf(out, 'mdia')).toEqual(boxesOf(file, 'mdia'));
    expect(has(boxesOf(out, 'mdia')[0]!, 'co64')).toBe(true);
    expect(boxesOf(out, 'mdia')).toHaveLength(1);
    expect(boxesOf(out, 'mdat')).toEqual([new Uint8Array(mdat)]);
  });

  it('an ISO meta box (a full box), with a ©xyz item', () => {
    const meta = box('meta', [
      0,
      0,
      0,
      0,
      ...box('hdlr', [...filled(8, 0), ...latin1('mdir'), ...filled(13, 0)]),
      ...box('ilst', [
        ...box('©nam', box('data', [0, 0, 0, 1, 0, 0, 0, 0, ...latin1('Harbour')])),
        ...box('©xyz', box('data', [0, 0, 0, 1, 0, 0, 0, 0, ...latin1('+45.5017-073.5673/')])),
      ]),
    ]);
    const file = new Uint8Array([...ftyp, ...box('moov', box('udta', meta)), ...mdat]);
    const out = stripLocation(file);
    expect(has(out, '45.50')).toBe(false);
    expect(has(out, 'Harbour')).toBe(true);
    expect(locationBoxes(out)).toEqual([]);
  });

  it('64-bit box sizes, and a last box that runs to the end', () => {
    const big = [0, 0, 0, 1, ...latin1('mdat'), 0, 0, 0, 0, 0, 0, 0, 80, ...filled(64, 7)];
    const moov64 = [
      0,
      0,
      0,
      1,
      ...latin1('moov'),
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      16 + xyz.length + 8,
      ...box('udta', xyz),
    ];
    const toEnd = [0, 0, 0, 0, ...latin1('mdat'), ...filled(40, 9)];
    const file = new Uint8Array([...ftyp, ...big, ...moov64, ...toEnd]);
    const out = stripLocation(file);
    expect(has(out, '45.50')).toBe(false);
    expect(out.slice(0, ftyp.length + big.length)).toEqual(file.slice(0, ftyp.length + big.length));
    expect(Array.from(out.slice(out.length - toEnd.length))).toEqual(toEnd);
  });

  it('XMP in uuid boxes, at the top level and in moov', () => {
    const xmpUuid = [
      0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8, 0x9c, 0x71, 0x99, 0x94, 0x91, 0xe3, 0xaf,
      0xac,
    ];
    const xmp = (city: string): number[] =>
      box('uuid', [
        ...xmpUuid,
        ...utf8(
          '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF ' +
            'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
            '<rdf:Description xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" ' +
            `xmlns:dc="http://purl.org/dc/elements/1.1/" photoshop:City="${city}" ` +
            'dc:format="video/mp4"/></rdf:RDF></x:xmpmeta>',
        ),
      ]);
    const file = new Uint8Array([
      ...ftyp,
      ...box('moov', xmp('Montréal')),
      ...xmp('Vieux-Port'),
      ...mdat,
    ]);
    const out = stripLocation(file);
    expect(has(out, 'Montr')).toBe(false);
    expect(has(out, 'Vieux')).toBe(false);
    expect(has(out, 'dc:format="video/mp4"')).toBe(true);
    expect(out.length).toBe(file.length);
  });

  it('a udta that cannot be read becomes a free box', () => {
    const udta = box('udta', [...box('©nam', latin1('Harbour')), 0, 0, 0x7f, 0xff, ...xyz]);
    const file = new Uint8Array([...ftyp, ...box('moov', udta), ...mdat]);
    const out = stripLocation(file);
    const at = ftyp.length + 8;
    expect(ascii(out, at + 4, at + 8)).toBe('free');
    expect(out.subarray(at + 8, at + udta.length).every((c) => c === 0)).toBe(true);
    expect(Array.from(out.slice(file.length - mdat.length))).toEqual(mdat);
  });

  it('a meta whose keys cannot be read becomes a free box', () => {
    const meta = keyedMeta({ 'com.apple.quicktime.location.ISO6709': '+45.5017-073.5673/' });
    // The key's size runs past the keys box.
    const keysAt = Buffer.from(meta).toString('latin1').indexOf('keys') - 4;
    meta[keysAt + 16 + 3] = 0xf0;
    const file = new Uint8Array([...ftyp, ...box('moov', meta), ...mdat]);
    const out = stripLocation(file);
    expect(has(out, '45.50')).toBe(false);
    expect(boxTree(out).map((b) => b.path)).toEqual(['ftyp', 'moov', 'moov/free', 'mdat']);
  });

  it('a moov that cannot be walked is refused', () => {
    const file = new Uint8Array([
      ...ftyp,
      ...box('moov', [...box('udta', xyz), 0, 0, 0, 3, 1, 2, 3, 4]),
      ...mdat,
    ]);
    expect(() => stripLocation(file)).toThrow(LocationUnreadableError);
  });

  it('garbage among the top-level boxes is refused', () => {
    const file = new Uint8Array([
      ...ftyp,
      0,
      0,
      0,
      16,
      0xff,
      0,
      1,
      2,
      ...filled(8, 0),
      ...box('moov', box('udta', xyz)),
    ]);
    expect(() => stripLocation(file)).toThrow(LocationUnreadableError);
  });

  it('a file cut before its moov has no location left to remove', () => {
    const input = fixture('gps.mov');
    const moov = boxTree(input).find((b) => b.type === 'moov')!;
    const cut = input.slice(0, moov.start + 4);
    expect(stripLocation(cut)).toBe(cut);
  });

  it('other ISO files and videos come back as they are', () => {
    const noLocation = stripLocation(fixture('gps.mp4'));
    expect(stripLocation(noLocation)).toBe(noLocation);
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...filled(40, 1)]);
    expect(stripLocation(webm)).toBe(webm);
    expect(isMovie(new Uint8Array(latin1('ftyp')))).toBe(false);
  });
});

describe('broken videos never crash, and never keep a readable location', () => {
  it('a video cut anywhere', { timeout: 120_000 }, () => {
    for (const name of videos) {
      const input = fixture(name);
      let refusals = 0;
      for (let length = 0; length < input.length; length++) {
        const cut = input.slice(0, length);
        let out: Uint8Array;
        try {
          out = stripLocation(cut);
        } catch (e) {
          if (refused(e)) refusals++; // cut inside moov
          continue;
        }
        for (const text of ['45.50', 'Montr', 'Vieux']) {
          expect(has(out, text), `${name} at ${length}`).toBe(false);
        }
      }
      expect(refusals, name).toBeGreaterThan(0);
      expect(refusals, name).toBeLessThan(input.length);
    }
  });

  it('random damage', () => {
    const random = seeded(36);
    for (const name of videos) {
      const input = fixture(name);
      for (let round = 0; round < 500; round++) {
        const b = new Uint8Array(input);
        for (let k = 0; k < 1 + random.nextInt(8); k++) {
          b[random.nextInt(b.length)] = random.nextInt(256);
        }
        try {
          stripLocation(b);
        } catch (e) {
          expect(refused(e)).toBe(true); // A refusal.
        }
      }
    }
  });
});

describe('100 MiB videos', () => {
  // Synthetic, at the app's file size limit: the fixtures' boxes around
  // 100 MiB of media data, with moov first (MP4) and last (phone MOV).
  const maxFileBytes = 100 * 1024 * 1024;
  const grown = (name: string): Uint8Array => {
    const input = fixture(name);
    const mdat = boxTree(input).find((b) => b.type === 'mdat')!;
    const size = maxFileBytes - 64 * 1024;
    const out = new Uint8Array(input.length - (mdat.end - mdat.start) + size);
    out.set(input.subarray(0, mdat.start), 0);
    new DataView(out.buffer).setUint32(mdat.start, size);
    out.set(latin1('mdat'), mdat.start + 4);
    out.set(input.subarray(mdat.end), mdat.start + size);
    return out;
  };

  for (const name of ['gps.mp4', 'gps.mov']) {
    it(`${name} is stripped in well under a second`, () => {
      const input = grown(name);
      let out = input;
      const ms = timed(() => (out = stripLocation(input)));
      let same = false;
      const again = timed(() => (same = stripLocation(out) === out));
      console.log(
        `${name}, ${input.length >> 20} MiB: ${ms.toFixed(0)}ms stripped ` +
          `(one copy), ${again.toFixed(0)}ms with nothing to strip`,
      );
      expect(same).toBe(true);
      expect(locationBoxes(out)).toEqual([]);
      expect(out.length).toBe(input.length);
      expect(ms).toBeLessThan(1000);
      expect(again, 'no copy, no scan of the media').toBeLessThan(50);
    });
  }
});

// ---------------------------------------------------------------------------
// A video kept as a file: the patches found without reading the file into
// memory remove exactly what stripLocation removes in memory, on the real
// fixtures and on every cut of them; streamed into a copy they give the
// same bytes and keep the file's length.

describe('a video kept as a file', () => {
  let n = 0;
  const write = (bytes: Uint8Array | number[]): string =>
    writeTemp(`v${n++}.mov`, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));

  /** What the file-based pass makes of [bytes]: the patches applied to a copy. */
  const patched = async (bytes: Uint8Array): Promise<Uint8Array> => {
    const path = write(bytes);
    const dest = `${path}.out`;
    await copyWithPatches(path, dest, await videoLocationPatches(path));
    return new Uint8Array(readFileSync(dest));
  };

  it('the fixtures: the same bytes as stripLocation, the length kept, the location gone', async () => {
    for (const name of videos) {
      const input = fixture(name);
      const out = await patched(input);
      expect(out, name).toEqual(stripLocation(input));
      expect(out.length, name).toBe(input.length);
      expect(has(out, '45.50'), name).toBe(false);
    }
  });

  it('streamed with the patches: the same bytes, the file untouched', async () => {
    for (const name of videos) {
      const input = fixture(name);
      const path = write(input);
      const patches = await videoLocationPatches(path);
      expect(patches, name).not.toEqual([]);
      // Small patches: only the changed range of a box.
      expect(
        patches.reduce((sum, p) => sum + p.bytes.length, 0),
        name,
      ).toBeLessThan(Math.floor(input.length / 2));
      const dest = `${path}.out`;
      await copyWithPatches(path, dest, patches);
      expect(new Uint8Array(readFileSync(dest)), name).toEqual(stripLocation(input));
      expect(new Uint8Array(readFileSync(path)), 'not modified').toEqual(input);
    }
  });

  it(
    'every cut of every fixture: the same result as in memory, or the same refusal',
    { timeout: 120_000 },
    async () => {
      for (const name of videos) {
        const input = fixture(name);
        const step = Math.max(1, Math.floor(input.length / 400));
        for (let length = 0; length <= input.length; length += step) {
          const cut = input.slice(0, length);
          let memory: Uint8Array | 'refused';
          try {
            memory = stripLocation(cut);
          } catch (e) {
            refused(e);
            memory = 'refused';
          }
          let file: Uint8Array | 'refused';
          try {
            file = await patched(cut);
          } catch (e) {
            refused(e);
            file = 'refused';
          }
          expect(file, `${name} at ${length}`).toEqual(memory);
        }
      }
    },
  );

  it(
    'random damage: never a different result from the memory pass',
    { timeout: 120_000 },
    async () => {
      const random = seeded(301);
      for (const name of videos) {
        const input = fixture(name);
        for (let round = 0; round < 60; round++) {
          const b = new Uint8Array(input);
          for (let k = 0; k < 1 + random.nextInt(6); k++) {
            b[random.nextInt(b.length)] = random.nextInt(256);
          }
          let memory: Uint8Array | 'refused';
          let file: Uint8Array | 'refused';
          try {
            memory = stripLocation(b);
          } catch (e) {
            refused(e);
            memory = 'refused';
          }
          try {
            file = await patched(b);
          } catch (e) {
            refused(e);
            file = 'refused';
          }
          expect(file, `${name}, round ${round}`).toEqual(memory);
        }
      }
    },
  );

  it('no location: no patches; not a movie: as it is', async () => {
    const clean = stripLocation(fixture('gps.mp4'));
    expect(await videoLocationPatches(write(clean))).toEqual([]);
    const webm = [0x1a, 0x45, 0xdf, 0xa3, ...filled(40, 1)];
    expect(await videoLocationPatches(write(webm))).toEqual([]);
    expect(await videoLocationPatches(write([]))).toEqual([]);
  });

  it('a moov over the limit is refused rather than read', async () => {
    const ftyp = box('ftyp', latin1('qt  \x00\x00\x02\x00qt  '));
    const moov = box('moov', box('udta', filled(2000, 0)));
    const path = write([...ftyp, ...moov]);
    await expect(videoLocationPatches(path, { maxBoxBytes: 1000 })).rejects.toBeInstanceOf(
      LocationUnreadableError,
    );
    expect(await videoLocationPatches(path)).toEqual([]);
  });

  it('patchChunk writes only what falls in the chunk', () => {
    const patches: FilePatch[] = [
      { offset: 3, bytes: new Uint8Array([9, 9, 9, 9]) },
      { offset: 12, bytes: new Uint8Array([7]) },
    ];
    expect(Array.from(patchChunk(new Uint8Array(5), 0, patches))).toEqual([0, 0, 0, 9, 9]);
    expect(Array.from(patchChunk(new Uint8Array(5), 5, patches))).toEqual([9, 9, 0, 0, 0]);
    const untouched = new Uint8Array(2);
    expect(patchChunk(untouched, 20, patches)).toBe(untouched);
  });

  it('diffPatch covers exactly the changed range', () => {
    const before = new Uint8Array([1, 2, 3, 4, 5, 6]);
    expect(diffPatch(10, before, new Uint8Array(before))).toBeNull();
    const patch = diffPatch(10, before, new Uint8Array([1, 2, 0, 4, 0, 6]));
    expect(patch?.offset).toBe(12);
    expect(Array.from(patch?.bytes ?? [])).toEqual([0, 4, 0]);
  });

  it('copyWithPatches never writes over an existing file, and leaves no partial copy', async () => {
    const path = write(fixture('gps.mov'));
    const dest = `${path}.out`;
    writeFileSync(dest, 'already here');
    await expect(copyWithPatches(path, dest, [])).rejects.toMatchObject({ code: 'EEXIST' });
    expect(readFileSync(dest, 'utf8')).toBe('already here');

    const past = `${path}.past`;
    await expect(
      copyWithPatches(path, past, [{ offset: 1 << 30, bytes: new Uint8Array([1]) }]),
    ).rejects.toThrow(RangeError);
    expect(existsSync(past)).toBe(false);
  });
});
