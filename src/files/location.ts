/**
 * Location metadata stripping for photos and videos: a port of the
 * buildIt.Social app's lossless location stripping, so that a file sent
 * from here loses exactly the bytes the app would remove. Pure byte work,
 * with no image or video codec.
 *
 * Every edit is lossless: the image or video data is never decoded or
 * re-encoded, and except for PNG (whose chunks carry no offsets) the file
 * keeps its length, so every offset in it stays valid. GPS and other
 * location fields go; the rest of the metadata (capture date, camera, lens,
 * orientation, colour profile) stays.
 *
 * | Format | What goes |
 * | --- | --- |
 * | JPEG | Exif GPS IFD, XMP and extended XMP location, IPTC location (APP13), the same in MPF images (gain map, second view) and the Exif thumbnail |
 * | HEIC, HEIF, AVIF | the Exif item's GPS IFD, the XMP item's location |
 * | PNG | `eXIf` GPS IFD, XMP (`iTXt`) location; compressed XMP and `Raw profile` chunks are dropped |
 * | WebP | `EXIF` GPS IFD, `XMP ` location |
 * | TIFF | GPS IFD, XMP and IPTC location |
 * | MOV, MP4, M4V, 3GP (and M4A) | `©xyz` and `loci` atoms, location items in `meta` (`keys`/`ilst`), XMP location, in `moov`, `trak`, `udta` and `meta` |
 *
 * Formats are told apart by their bytes, not their names. Anything else
 * (GIF, BMP, WebM, documents) comes back unchanged.
 *
 * A video kept as a file is handled without reading it whole:
 * `videoLocationPatches` walks its top-level boxes by their headers and
 * returns small patches at fixed offsets, and `copyWithPatches` streams a
 * copy with them applied.
 */
import { Buffer } from 'node:buffer';
import { createReadStream } from 'node:fs';
import { open, rm, type FileHandle } from 'node:fs/promises';

/**
 * The location can't be looked for: a HEIF's `meta` box, a TIFF file's
 * first IFD, or a video's top-level, `moov` or `trak` boxes can't be read.
 * Removing it blindly would lose the file, so the file should be refused.
 */
export class LocationUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocationUnreadableError';
  }
}

// ---------------------------------------------------------------------------
// Byte helpers

/** The byte at [i]; a RangeError past the end (never expected: callers check first). */
function byte(b: Uint8Array, i: number): number {
  const v = b[i];
  if (v === undefined) throw new RangeError(`index ${i} out of range`);
  return v;
}

/** A big- or little-endian view of [b] from [from] to [to]. */
function view(b: Uint8Array, from = 0, to = b.length): DataView {
  return new DataView(b.buffer, b.byteOffset + from, to - from);
}

/** The bytes from [from] to [to] as a string, one character per byte (Latin-1). */
function latin1(b: Uint8Array, from: number, to: number): string {
  const s = b.subarray(from, to);
  return Buffer.from(s.buffer, s.byteOffset, s.byteLength).toString('latin1');
}

function startsWith(b: Uint8Array, s: string): boolean {
  if (b.length < s.length) return false;
  for (let k = 0; k < s.length; k++) {
    if (b[k] !== s.charCodeAt(k)) return false;
  }
  return true;
}

/** A copy of [b], never a view of the same memory. */
function copyOf(b: Uint8Array): Uint8Array {
  return new Uint8Array(b);
}

/** Zeroes [bytes]; whether anything changed. */
function zero(bytes: Uint8Array): boolean {
  if (bytes.every((c) => c === 0)) return false;
  bytes.fill(0);
  return true;
}

// ---------------------------------------------------------------------------
// The entry point

/**
 * [bytes] without location metadata: [bytes] itself when there's nothing
 * to remove, otherwise a new array. [bytes] is never modified.
 *
 * A metadata block that can't be read is removed whole (an empty Exif, a
 * blank XMP, a video's `udta` or `meta` box), which keeps the image or
 * video. Throws LocationUnreadableError only when a HEIF's `meta` box, a
 * TIFF file's first IFD, or a video's top-level, `moov` or `trak` boxes
 * can't be read: the location can't be found then, and removing it
 * blindly would lose the file.
 *
 * A video is only copied when it has a location to remove: its boxes are
 * walked in place and the media data skipped.
 */
export function stripLocation(bytes: Uint8Array): Uint8Array {
  if (isJpeg(bytes)) return inPlace(bytes, (b) => stripJpegLocation(b, true));
  if (isPng(bytes)) return stripPngLocation(bytes) ?? bytes;
  if (isWebp(bytes)) return inPlace(bytes, stripWebpLocation);
  if (isHeifContainer(bytes)) {
    const photo = inPlace(bytes, stripHeifLocation);
    // An image sequence can carry a movie's metadata too.
    if (!hasMovieBox(photo)) return photo;
    return stripMovieLocation(photo) ?? photo;
  }
  if (isMovie(bytes)) return stripMovieLocation(bytes) ?? bytes;
  if (isTiff(bytes)) return inPlace(bytes, (b) => stripTiffLocation(b, false));
  return bytes;
}

function inPlace(bytes: Uint8Array, strip: (b: Uint8Array) => boolean): Uint8Array {
  const copy = copyOf(bytes);
  return strip(copy) ? copy : bytes;
}

function isTiff(b: Uint8Array): boolean {
  return (
    b.length >= 4 &&
    ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) ||
      (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a))
  );
}

// ---------------------------------------------------------------------------
// XMP

const SPACE = 0x20;

/**
 * Blanks the location properties in an XMP packet, in place and without
 * changing its length: each one, attribute or element with all its
 * content, is overwritten with spaces, which XML and RDF ignore there. So
 * offsets around the packet stay valid and nothing needs re-encoding.
 *
 * Location properties (isXmpLocation): any whose name starts with `GPS` or
 * names a latitude or longitude, in any namespace (`exif:GPSLatitude`, a
 * drone's `drone-dji:GpsLongitude`), plus `photoshop:City`, `State` and
 * `Country`, `Iptc4xmpCore:Location` and `CountryCode`,
 * `Iptc4xmpExt:LocationCreated` and `LocationShown`, and
 * `xmpDM:shotLocation`.
 *
 * A packet that can't be parsed is blanked entirely. Returns whether
 * anything changed.
 */
export function stripXmpLocation(xmp: Uint8Array): boolean {
  let ranges: [number, number][];
  try {
    ranges = new XmpScanner(xmp).locationRanges();
  } catch (e) {
    if (!(e instanceof LocationUnreadableError)) throw e;
    if (xmp.every((c) => c === SPACE)) return false;
    xmp.fill(SPACE);
    return true;
  }
  for (const [start, end] of ranges) xmp.fill(SPACE, start, end);
  return ranges.length > 0;
}

const NS_PHOTOSHOP = 'http://ns.adobe.com/photoshop/1.0/';
const NS_IPTC_CORE = 'http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/';
const NS_IPTC_EXT = 'http://iptc.org/std/Iptc4xmpExt/2008-02-29/';
const NS_DYNAMIC_MEDIA = 'http://ns.adobe.com/xmp/1.0/DynamicMedia/';

/** The usual prefixes, for a packet that uses one without declaring it. */
const KNOWN_PREFIXES = new Map<string, string>([
  ['photoshop', NS_PHOTOSHOP],
  ['Iptc4xmpCore', NS_IPTC_CORE],
  ['Iptc4xmpExt', NS_IPTC_EXT],
  ['xmpDM', NS_DYNAMIC_MEDIA],
]);

const LOCATION_NAMES = new Map<string, Set<string>>([
  [NS_PHOTOSHOP, new Set(['City', 'State', 'Country'])],
  [NS_IPTC_CORE, new Set(['Location', 'CountryCode'])],
  [NS_IPTC_EXT, new Set(['LocationCreated', 'LocationShown'])],
  [NS_DYNAMIC_MEDIA, new Set(['shotLocation'])],
]);

/** Whether the property [local] in [namespace] is location data. */
function isXmpLocation(namespace: string | undefined, local: string): boolean {
  const name = local.toLowerCase();
  if (name.startsWith('gps') || name.includes('latitude') || name.includes('longitude')) {
    return true;
  }
  if (namespace === undefined) return false;
  return LOCATION_NAMES.get(namespace)?.has(local) ?? false;
}

interface OpenElement {
  name: string;
  namespaces: Map<string, string>;
  /** Where a location element starts, or null. */
  start: number | null;
}

const NO_NAMESPACES: Map<string, string> = new Map();

function isXmlSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

function isNameEnd(c: number): boolean {
  return isXmlSpace(c) || c === 0x3e || c === 0x2f || c === 0x3d; // > / =
}

function namespaceOf(qname: string, scope: Map<string, string>): string | undefined {
  const colon = qname.indexOf(':');
  const prefix = colon < 0 ? '' : qname.substring(0, colon);
  return scope.get(prefix) ?? KNOWN_PREFIXES.get(prefix);
}

function localOf(qname: string): string {
  return qname.substring(qname.indexOf(':') + 1);
}

/**
 * A small, strict XML scanner: enough to find elements, attributes and
 * namespace declarations by byte offset. Throws LocationUnreadableError for
 * anything it can't follow.
 */
class XmpScanner {
  constructor(private readonly b: Uint8Array) {}

  private indexOf(s: string, from: number): number {
    const b = this.b;
    const first = s.charCodeAt(0);
    if (s.length === 1) return from >= b.length ? -1 : b.indexOf(first, from);
    outer: for (let i = from; i + s.length <= b.length; i++) {
      if (b[i] !== first) continue;
      for (let k = 1; k < s.length; k++) {
        if (b[i + k] !== s.charCodeAt(k)) continue outer;
      }
      return i;
    }
    return -1;
  }

  private at(i: number, s: string): boolean {
    const b = this.b;
    if (i + s.length > b.length) return false;
    for (let k = 0; k < s.length; k++) {
      if (b[i + k] !== s.charCodeAt(k)) return false;
    }
    return true;
  }

  private skipTo(s: string, from: number): number {
    const i = this.indexOf(s, from);
    if (i < 0) throw new LocationUnreadableError('XMP: unterminated markup');
    return i + s.length;
  }

  private name(i: number): [string, number] {
    const b = this.b;
    const start = i;
    while (i < b.length && !isNameEnd(byte(b, i))) i++;
    if (i === start || i >= b.length) throw new LocationUnreadableError('XMP: bad name');
    return [latin1(b, start, i), i];
  }

  private skipSpace(i: number): number {
    const b = this.b;
    while (i < b.length && isXmlSpace(byte(b, i))) i++;
    return i;
  }

  locationRanges(): [number, number][] {
    const b = this.b;
    const ranges: [number, number][] = [];
    const stack: OpenElement[] = [];
    let i = 0;
    for (;;) {
      const lt = this.indexOf('<', i);
      if (lt < 0) break;
      if (this.at(lt, '<!--')) {
        i = this.skipTo('-->', lt + 4);
      } else if (this.at(lt, '<![CDATA[')) {
        i = this.skipTo(']]>', lt + 9);
      } else if (this.at(lt, '<?')) {
        i = this.skipTo('?>', lt + 2);
      } else if (this.at(lt, '<!')) {
        i = this.skipTo('>', lt + 2);
      } else if (this.at(lt, '</')) {
        const [name, after] = this.name(lt + 2);
        const gt = this.skipSpace(after);
        if (gt >= b.length || b[gt] !== 0x3e) {
          throw new LocationUnreadableError('XMP: bad end tag');
        }
        const open = stack.pop();
        if (open?.name !== name) {
          throw new LocationUnreadableError('XMP: mismatched end tag');
        }
        if (open.start !== null) ranges.push([open.start, gt + 1]);
        i = gt + 1;
      } else {
        i = this.startTag(lt, stack, ranges);
      }
    }
    if (stack.length > 0) throw new LocationUnreadableError('XMP: unclosed element');
    return ranges;
  }

  /** Reads the start tag at [lt]; returns where it ends. */
  private startTag(lt: number, stack: OpenElement[], ranges: [number, number][]): number {
    const b = this.b;
    const [name, afterName] = this.name(lt + 1);
    const attributes: [string, string, number, number][] = []; // name, value, from, to
    let i = afterName;
    let selfClosing: boolean;
    for (;;) {
      i = this.skipSpace(i);
      if (i >= b.length) throw new LocationUnreadableError('XMP: unterminated tag');
      if (b[i] === 0x3e) {
        selfClosing = false;
        break;
      }
      if (b[i] === 0x2f) {
        if (i + 1 >= b.length || b[i + 1] !== 0x3e) {
          throw new LocationUnreadableError('XMP: bad tag end');
        }
        selfClosing = true;
        i++;
        break;
      }
      const [attribute, afterAttribute] = this.name(i);
      let j = this.skipSpace(afterAttribute);
      if (j >= b.length || b[j] !== 0x3d) {
        throw new LocationUnreadableError('XMP: attribute without value');
      }
      j = this.skipSpace(j + 1);
      if (j >= b.length || (b[j] !== 0x22 && b[j] !== 0x27)) {
        throw new LocationUnreadableError('XMP: unquoted attribute');
      }
      const quote = byte(b, j);
      let k = j + 1;
      while (k < b.length && b[k] !== quote) {
        if (b[k] === 0x3c) throw new LocationUnreadableError('XMP: < in attribute');
        k++;
      }
      if (k >= b.length) throw new LocationUnreadableError('XMP: unterminated value');
      attributes.push([attribute, latin1(b, j + 1, k), i, k + 1]);
      i = k + 1;
    }
    const end = i + 1;

    const parent = stack[stack.length - 1]?.namespaces ?? NO_NAMESPACES;
    let scope = parent;
    for (const [attribute, value] of attributes) {
      if (attribute === 'xmlns' || attribute.startsWith('xmlns:')) {
        if (scope === parent) scope = new Map(parent);
        scope.set(attribute === 'xmlns' ? '' : attribute.substring(6), value);
      }
    }
    for (const [attribute, , from, to] of attributes) {
      if (attribute === 'xmlns' || attribute.startsWith('xmlns:')) continue;
      // Unprefixed attributes have no namespace.
      const namespace = attribute.includes(':') ? namespaceOf(attribute, scope) : undefined;
      if (isXmpLocation(namespace, localOf(attribute))) ranges.push([from, to]);
    }
    const location = isXmpLocation(namespaceOf(name, scope), localOf(name));
    if (selfClosing) {
      if (location) ranges.push([lt, end]);
    } else {
      stack.push({ name, namespaces: scope, start: location ? lt : null });
    }
    return end;
  }
}

// ---------------------------------------------------------------------------
// IPTC-IIM and Photoshop image resources

/**
 * IPTC-IIM application record (2) datasets that hold a place: content
 * location code and name, city, sublocation, province or state, country
 * code and country name.
 */
const IIM_LOCATION_DATASETS = new Set([26, 27, 90, 92, 95, 100, 101]);

/**
 * Blanks the location datasets of an IPTC-IIM block in place, with spaces,
 * keeping every length. A block that can't be read is zeroed, so readers
 * find nothing in it. Returns whether anything changed.
 */
function stripIimLocation(iim: Uint8Array): boolean {
  const ranges: [number, number][] = [];
  let i = 0;
  let readable = true;
  while (i + 5 <= iim.length) {
    if (iim[i] !== 0x1c) {
      // Padding at the end is fine; anything else isn't IIM.
      readable = iim.subarray(i).every((c) => c === 0);
      break;
    }
    const record = byte(iim, i + 1);
    const dataset = byte(iim, i + 2);
    let length = (byte(iim, i + 3) << 8) | byte(iim, i + 4);
    let start = i + 5;
    if ((length & 0x8000) !== 0) {
      // An extended dataset: the next (length & 0x7FFF) bytes are its length.
      const size = length & 0x7fff;
      if (size > 4 || start + size > iim.length) {
        readable = false;
        break;
      }
      length = 0;
      for (let k = 0; k < size; k++) length = length * 256 + byte(iim, start + k);
      start += size;
    }
    const end = start + length;
    if (end > iim.length) {
      readable = false;
      break;
    }
    if (record === 2 && IIM_LOCATION_DATASETS.has(dataset) && length > 0) {
      ranges.push([start, end]);
    }
    i = end;
  }
  if (!readable) return zero(iim);
  let changed = false;
  for (const [start, end] of ranges) {
    for (let k = start; k < end; k++) {
      if (iim[k] !== SPACE) {
        iim[k] = SPACE;
        changed = true;
      }
    }
  }
  return changed;
}

/** `8BIM` and the older signatures Photoshop image resources may carry. */
const RESOURCE_SIGNATURES = new Set(['8BIM', 'PHUT', 'AgHg', 'DCSR', 'MeSa']);

/** Photoshop's IPTC-IIM resource. */
const IPTC_RESOURCE = 0x0404;

/**
 * Blanks the IPTC location in Photoshop image resources (a JPEG's APP13
 * after `Photoshop 3.0\0`), in place. Resources that can't be read are
 * zeroed. Returns whether anything changed.
 */
function stripPhotoshopLocation(resources: Uint8Array): boolean {
  const d = view(resources);
  let i = 0;
  let changed = false;
  while (i + 12 <= resources.length) {
    const signature = latin1(resources, i, i + 4);
    if (!RESOURCE_SIGNATURES.has(signature)) {
      if (resources.subarray(i).every((c) => c === 0)) return changed;
      return zero(resources) || changed;
    }
    const id = d.getUint16(i + 4);
    // A Pascal string, padded to an even length.
    const nameLength = byte(resources, i + 6);
    const sizeAt = i + 6 + ((nameLength + 2) & ~1);
    if (sizeAt + 4 > resources.length) return zero(resources) || changed;
    const size = d.getUint32(sizeAt);
    const start = sizeAt + 4;
    const end = start + size;
    if (end > resources.length) return zero(resources) || changed;
    if (id === IPTC_RESOURCE) {
      changed = stripIimLocation(resources.subarray(start, end)) || changed;
    }
    i = end + (size & 1);
  }
  return changed;
}

// ---------------------------------------------------------------------------
// TIFF (and every Exif block)

/**
 * Removes the GPS IFD from a TIFF structure: the Exif block of a JPEG,
 * PNG, WebP or HEIF, or a whole TIFF file.
 *
 * Edits [tiff] in place without changing its length, so every offset in
 * and around it stays valid: IFD0's GPS pointer (tag 0x8825) is removed
 * (the entries after it move up, and the 12 bytes freed at the end of the
 * IFD are zeroed), and the GPS IFD and the values it points to are zeroed.
 * IFD0's XMP (tag 700) and IPTC (tag 33723) lose their location fields,
 * and the thumbnail JPEG in IFD1 is cleaned the same way as a JPEG. Every
 * other tag is kept.
 *
 * When [tiff] can't be read, an [embedded] block is replaced by an empty
 * TIFF (no tags at all, same length); a whole TIFF file throws
 * LocationUnreadableError, since blanking it would lose the image. Returns
 * whether anything changed.
 */
function stripTiffLocation(tiff: Uint8Array, embedded: boolean): boolean {
  try {
    return new TiffEditor(tiff).strip();
  } catch (e) {
    if (!(e instanceof LocationUnreadableError) || !embedded) throw e;
    blankTiff(tiff);
    return true;
  }
}

/**
 * Overwrites [tiff] with an empty big-endian TIFF (header, an IFD0 with no
 * entries) followed by zeros, or with zeros if it's too short for that.
 */
function blankTiff(tiff: Uint8Array): void {
  tiff.fill(0);
  if (tiff.length < 14) return;
  // MM, 42, IFD0 at 8; IFD0 has no entries and no next IFD.
  tiff.set([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08], 0);
}

const TAG_GPS_IFD = 0x8825;
const TAG_EXIF_IFD = 0x8769;
const TAG_XMP = 0x02bc;
const TAG_IPTC = 0x83bb;
const TAG_THUMBNAIL_OFFSET = 0x0201;
const TAG_THUMBNAIL_LENGTH = 0x0202;

/** Bytes per value, by TIFF field type (1 BYTE ... 13 IFD). */
const TYPE_SIZES = new Map<number, number>([
  [1, 1],
  [2, 1],
  [3, 2],
  [4, 4],
  [5, 8],
  [6, 1],
  [7, 1],
  [8, 2],
  [9, 4],
  [10, 8],
  [11, 4],
  [12, 8],
  [13, 4],
]);

/**
 * The most IFDs followed in IFD0's chain: IFD0 and IFD1 in practice, more
 * in a multi-page TIFF.
 */
const MAX_CHAINED_IFDS = 64;

interface TiffEntry {
  /** Where the 12-byte entry starts. */
  position: number;
  tag: number;
  type: number;
  count: number;
}

class TiffEditor {
  private readonly d: DataView;
  private little = false;

  constructor(private readonly b: Uint8Array) {
    this.d = view(b);
  }

  private u16(at: number): number {
    return this.d.getUint16(at, this.little);
  }

  private u32(at: number): number {
    return this.d.getUint32(at, this.little);
  }

  strip(): boolean {
    const b = this.b;
    if (b.length < 8) throw new LocationUnreadableError('TIFF header');
    if (b[0] === 0x49 && b[1] === 0x49) {
      this.little = true;
    } else if (b[0] === 0x4d && b[1] === 0x4d) {
      this.little = false;
    } else {
      throw new LocationUnreadableError('TIFF byte order');
    }
    if (this.u16(2) !== 42) throw new LocationUnreadableError('TIFF magic');

    const ifd0 = this.u32(4);
    // IFD0 has to be readable; later IFDs that aren't are skipped (a reader
    // can't find anything in them either).
    const first = this.entries(ifd0);
    if (first === null) throw new LocationUnreadableError('TIFF IFD0');

    let changed = false;
    const seen = new Set<number>([ifd0]);
    let ifd = ifd0;
    let entries = first;
    for (let index = 0; ; index++) {
      // The Exif IFD gets checked too, for writers that put the GPS pointer
      // there by mistake. Read before cleaning moves entries.
      const subs: number[] = [];
      for (const e of entries) {
        if (e.tag !== TAG_EXIF_IFD) continue;
        const p = this.pointer(e);
        if (p !== null) subs.push(p);
      }
      changed = this.clean(ifd, entries, index === 1) || changed;
      for (const sub of subs) {
        if (seen.has(sub)) continue;
        seen.add(sub);
        const subEntries = this.entries(sub);
        if (subEntries !== null) changed = this.clean(sub, subEntries, false) || changed;
      }
      if (index + 1 >= MAX_CHAINED_IFDS) break;
      const next = this.next(ifd);
      if (next === null || next === 0 || seen.has(next)) break;
      seen.add(next);
      const nextEntries = this.entries(next);
      if (nextEntries === null) break;
      ifd = next;
      entries = nextEntries;
    }
    return changed;
  }

  /** The IFD at [at]'s entries, or null if its table isn't inside the block. */
  private entries(at: number): TiffEntry[] | null {
    const b = this.b;
    if (at < 8 || at + 2 > b.length) return null;
    const count = this.u16(at);
    if (at + 2 + count * 12 > b.length) return null;
    const out: TiffEntry[] = [];
    for (let n = 0; n < count; n++) {
      const position = at + 2 + n * 12;
      out.push({
        position,
        tag: this.u16(position),
        type: this.u16(position + 2),
        count: this.u32(position + 4),
      });
    }
    return out;
  }

  /** The next-IFD offset after the IFD at [at], or null if it's missing. */
  private next(at: number): number | null {
    const end = at + 2 + this.u16(at) * 12;
    return end + 4 <= this.b.length ? this.u32(end) : null;
  }

  /** The offset a pointer entry (LONG or IFD) holds, or null. */
  private pointer(e: TiffEntry): number | null {
    if (e.count !== 1 || !(e.type === 4 || e.type === 13)) return null;
    return this.u32(e.position + 8);
  }

  /**
   * Where [e]'s value is, inline or not, or null if its type is unknown or
   * it starts past the end. With [clamp], a value that runs past the end is
   * cut there (a cut-off XMP or IPTC block still gets cleaned); without, it
   * gives null.
   */
  private value(e: TiffEntry, clamp = false): [number, number] | null {
    const size = TYPE_SIZES.get(e.type);
    if (size === undefined) return null;
    const length = size * e.count;
    const start = length <= 4 ? e.position + 8 : this.u32(e.position + 8);
    if (start < 0 || start >= this.b.length) return null;
    if (start + length > this.b.length) return clamp ? [start, this.b.length] : null;
    return [start, start + length];
  }

  /**
   * Cleans the IFD at [at]: removes its GPS pointer and the GPS IFD, and
   * the location in its XMP, IPTC and (IFD1) thumbnail.
   */
  private clean(at: number, entries: TiffEntry[], isIfd1: boolean): boolean {
    const b = this.b;
    let changed = false;
    let thumbnailStart: number | null = null;
    let thumbnailLength: number | null = null;
    for (const e of entries) {
      if (e.tag === TAG_XMP) {
        const v = this.value(e, true);
        if (v !== null) changed = stripXmpLocation(b.subarray(v[0], v[1])) || changed;
      } else if (e.tag === TAG_IPTC) {
        const v = this.value(e, true);
        if (v !== null) changed = stripIimLocation(b.subarray(v[0], v[1])) || changed;
      } else if (e.tag === TAG_THUMBNAIL_OFFSET && isIfd1) {
        thumbnailStart = this.pointer(e);
      } else if (e.tag === TAG_THUMBNAIL_LENGTH && isIfd1) {
        thumbnailLength =
          e.count === 1 && e.type === 3 ? this.u16(e.position + 8) : this.pointer(e);
      }
    }
    if (
      thumbnailStart !== null &&
      thumbnailLength !== null &&
      thumbnailStart + thumbnailLength <= b.length
    ) {
      changed =
        stripJpegLocation(b.subarray(thumbnailStart, thumbnailStart + thumbnailLength), true) ||
        changed;
    }

    // Remove every GPS pointer, last first so earlier positions hold.
    const gps = entries.filter((e) => e.tag === TAG_GPS_IFD);
    for (const e of gps.reverse()) {
      const target = this.pointer(e) ?? this.u32(e.position + 8);
      this.removeEntry(at, e);
      this.zeroGpsIfd(target);
      changed = true;
    }
    return changed;
  }

  /**
   * Removes the entry [e] from the IFD at [at]: the later entries and the
   * next-IFD offset move up 12 bytes, and the freed bytes are zeroed.
   */
  private removeEntry(at: number, e: TiffEntry): void {
    const b = this.b;
    const count = this.u16(at);
    const end = at + 2 + count * 12;
    // The next-IFD offset moves too, when it's there.
    const tail = end + 4 <= b.length ? end + 4 : end;
    b.copyWithin(e.position, e.position + 12, tail);
    b.fill(0, tail - 12, tail);
    this.d.setUint16(at, count - 1, this.little);
  }

  /**
   * Zeroes the GPS IFD at [at] and its values, as far as they're inside
   * the block. Nothing points to them any more.
   */
  private zeroGpsIfd(at: number): void {
    const b = this.b;
    if (at < 8 || at + 2 > b.length) return;
    const entries = this.entries(at);
    if (entries !== null) {
      for (const e of entries) {
        const v = this.value(e);
        if (v !== null && v[1] - v[0] > 4) b.fill(0, v[0], v[1]);
      }
    }
    const end = at + 2 + this.u16(at) * 12 + 4;
    b.fill(0, at, end < b.length ? end : b.length);
  }
}

// ---------------------------------------------------------------------------
// JPEG

/** Whether [b] starts like a JPEG (SOI, then a marker). */
export function isJpeg(b: Uint8Array): boolean {
  return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

/** `Exif` then NUL (and usually a second NUL or 0xFF, skipped too). */
const JPEG_EXIF = 'Exif\x00';
const JPEG_XMP = 'http://ns.adobe.com/xap/1.0/\x00';
const JPEG_EXTENDED_XMP = 'http://ns.adobe.com/xmp/extension/\x00';
const JPEG_PHOTOSHOP = 'Photoshop 3.0\x00';
const JPEG_MPF = 'MPF\x00';

/** Largest extended XMP put back together (they are a few MB at most). */
const MAX_EXTENDED_XMP = 64 * 1024 * 1024;

/** One extended XMP chunk: full length, offset, data start and end in the JPEG. */
type XmpChunk = [number, number, number, number];

/**
 * Removes the location metadata from a JPEG, in place, without changing
 * its length or any byte of the image data:
 *
 * - APP1 Exif: the GPS IFD (stripTiffLocation); an Exif block that can't
 *   be read becomes an empty one.
 * - APP1 XMP, and extended XMP split over several APP1 segments: the
 *   location properties (stripXmpLocation).
 * - APP13 Photoshop resources: the IPTC location (stripPhotoshopLocation).
 * - With [followMpf], the other images an APP2 MPF segment lists (a
 *   phone's HDR gain map, a 3D camera's second view) are cleaned the same
 *   way.
 *
 * Only the segments before the image data (SOS) are read, the way a
 * decoder reads them, resynchronising past stray bytes. A segment cut off
 * by the end of the file has its remaining bytes zeroed when it's a
 * metadata segment. Returns whether anything changed.
 */
function stripJpegLocation(jpeg: Uint8Array, followMpf: boolean): boolean {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return false;
  let changed = false;
  let mpfHeader: number | null = null;
  const extendedXmp = new Map<string, XmpChunk[]>();
  let i = 2;
  while (i < jpeg.length) {
    // The next marker: 0xFF, any fill bytes, then a marker code.
    if (jpeg[i] !== 0xff) {
      i++;
      continue;
    }
    while (i < jpeg.length && jpeg[i] === 0xff) i++;
    if (i >= jpeg.length) break;
    const marker = byte(jpeg, i++);
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      continue; // no length
    }
    if (marker === 0xd9 || marker === 0xda) break; // EOI, or the image data
    if (i + 2 > jpeg.length) break;
    const length = (byte(jpeg, i) << 8) | byte(jpeg, i + 1);
    if (length < 2) continue; // not a real segment; resynchronise
    const start = i + 2;
    const end = i + length;
    const metadata = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
    if (end > jpeg.length) {
      if (metadata && jpeg.subarray(start).some((c) => c !== 0)) {
        jpeg.fill(0, start, jpeg.length);
        changed = true;
      }
      break;
    }
    const payload = jpeg.subarray(start, end);
    if (marker === 0xe1 && startsWith(payload, JPEG_EXIF) && payload.length > JPEG_EXIF.length) {
      changed = stripTiffLocation(payload.subarray(JPEG_EXIF.length + 1), true) || changed;
    } else if (marker === 0xe1 && startsWith(payload, JPEG_XMP)) {
      changed = stripXmpLocation(payload.subarray(JPEG_XMP.length)) || changed;
    } else if (marker === 0xe1 && startsWith(payload, JPEG_EXTENDED_XMP)) {
      const h = JPEG_EXTENDED_XMP.length;
      if (payload.length >= h + 40) {
        const d = view(payload);
        const guid = latin1(payload, h, h + 32);
        let chunks = extendedXmp.get(guid);
        if (chunks === undefined) {
          chunks = [];
          extendedXmp.set(guid, chunks);
        }
        chunks.push([d.getUint32(h + 32), d.getUint32(h + 36), start + h + 40, end]);
      }
    } else if (marker === 0xed && startsWith(payload, JPEG_PHOTOSHOP)) {
      changed = stripPhotoshopLocation(payload.subarray(JPEG_PHOTOSHOP.length)) || changed;
    } else if (marker === 0xe2 && startsWith(payload, JPEG_MPF)) {
      mpfHeader ??= start + JPEG_MPF.length;
    }
    i = end;
  }

  for (const chunks of extendedXmp.values()) {
    changed = stripExtendedXmp(jpeg, chunks) || changed;
  }
  if (followMpf && mpfHeader !== null) {
    for (const [offset, size] of mpfImages(jpeg, mpfHeader)) {
      const at = mpfHeader + offset;
      if (offset <= 0 || at + size > jpeg.length) continue;
      changed = stripJpegLocation(jpeg.subarray(at, at + size), false) || changed;
    }
  }
  return changed;
}

/**
 * Puts one extended XMP (its [chunks]) back together, strips it, and
 * writes it back. Chunks that don't fit together are blanked.
 */
function stripExtendedXmp(jpeg: Uint8Array, chunks: XmpChunk[]): boolean {
  const firstChunk = chunks[0];
  if (firstChunk === undefined) return false;
  const full = firstChunk[0];
  const fits =
    full <= MAX_EXTENDED_XMP && chunks.every((c) => c[0] === full && c[1] + (c[3] - c[2]) <= full);
  if (!fits) {
    let changed = false;
    for (const [, , start, end] of chunks) {
      changed = blankSpaces(jpeg.subarray(start, end)) || changed;
    }
    return changed;
  }
  const packet = new Uint8Array(full).fill(SPACE);
  for (const [, offset, start, end] of chunks) packet.set(jpeg.subarray(start, end), offset);
  if (!stripXmpLocation(packet)) return false;
  for (const [, offset, start, end] of chunks) {
    jpeg.set(packet.subarray(offset, offset + end - start), start);
  }
  return true;
}

/** Fills [bytes] with spaces; whether anything changed. */
function blankSpaces(bytes: Uint8Array): boolean {
  if (bytes.every((c) => c === SPACE)) return false;
  bytes.fill(SPACE);
  return true;
}

/**
 * The (offset, size) of each image an MPF segment's MP Index IFD lists,
 * offsets relative to [header] (its byte-order mark). Empty if it can't be
 * read.
 */
function mpfImages(jpeg: Uint8Array, header: number): [number, number][] {
  if (header + 8 > jpeg.length) return [];
  const d = view(jpeg, header);
  let little: boolean;
  if (jpeg[header] === 0x49 && jpeg[header + 1] === 0x49) {
    little = true;
  } else if (jpeg[header] === 0x4d && jpeg[header + 1] === 0x4d) {
    little = false;
  } else {
    return [];
  }
  const ifd = d.getUint32(4, little);
  if (ifd + 2 > d.byteLength) return [];
  const count = d.getUint16(ifd, little);
  for (let n = 0; n < count; n++) {
    const entry = ifd + 2 + n * 12;
    if (entry + 12 > d.byteLength) return [];
    if (d.getUint16(entry, little) !== 0xb002) continue; // MPEntry
    const length = d.getUint32(entry + 4, little);
    const at = d.getUint32(entry + 8, little);
    if (length % 16 !== 0 || at + length > d.byteLength) return [];
    const images: [number, number][] = [];
    for (let e = at; e < at + length; e += 16) {
      images.push([d.getUint32(e + 8, little), d.getUint32(e + 4, little)]);
    }
    return images;
  }
  return [];
}

// ---------------------------------------------------------------------------
// PNG

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Whether [b] starts with the PNG signature. */
export function isPng(b: Uint8Array): boolean {
  if (b.length < 8) return false;
  return PNG_SIGNATURE.every((c, k) => b[k] === c);
}

const PNG_METADATA = new Set(['eXIf', 'iTXt', 'tEXt', 'zTXt']);

/**
 * [png] without its location metadata, or null if it has none. The image
 * chunks are copied as they are.
 *
 * - `eXIf`: the GPS IFD is removed in place (stripTiffLocation) and the
 *   chunk's CRC recomputed.
 * - XMP in an uncompressed `iTXt` (`XML:com.adobe.xmp`): the location
 *   properties are blanked (stripXmpLocation) and the CRC recomputed. A
 *   compressed one is dropped, since inflating it isn't worth a codec.
 * - ImageMagick's `Raw profile type ...` text chunks (hex-encoded Exif,
 *   IPTC or XMP) are dropped.
 * - A metadata chunk cut off by the end of the file is dropped.
 */
function stripPngLocation(png: Uint8Array): Uint8Array | null {
  const out = copyOf(png);
  const d = view(out);
  const keep: [number, number][] = [];
  let changed = false;
  let i = 8;
  let keptFrom = 0;
  while (i + 8 <= out.length) {
    const length = d.getUint32(i);
    const type = latin1(out, i + 4, i + 8);
    const start = i + 8;
    const end = start + length;
    const metadata = PNG_METADATA.has(type);
    if (end + 4 > out.length) {
      if (metadata) {
        keep.push([keptFrom, i]);
        keptFrom = out.length;
        changed = true;
      }
      break;
    }
    const data = out.subarray(start, end);
    let edited = false;
    let drop = false;
    if (type === 'eXIf') {
      const tiffAt = startsWithExif(data) ? 6 : 0;
      edited = stripTiffLocation(data.subarray(tiffAt), true);
    } else if (metadata) {
      const keyword = pngKeyword(data);
      if (keyword.startsWith('Raw profile type ')) {
        drop = true;
      } else if (type === 'iTXt' && keyword === 'XML:com.adobe.xmp') {
        const text = iTxtText(data);
        if (text === null) {
          drop = true;
        } else {
          edited = stripXmpLocation(data.subarray(text));
        }
      }
    }
    if (edited) {
      d.setUint32(end, crc32(out.subarray(i + 4, end)));
      changed = true;
    }
    if (drop) {
      keep.push([keptFrom, i]);
      keptFrom = end + 4;
      changed = true;
    }
    i = end + 4;
  }
  if (!changed) return null;
  keep.push([keptFrom, out.length]);
  let total = 0;
  for (const [from, to] of keep) if (to > from) total += to - from;
  const result = new Uint8Array(total);
  let at = 0;
  for (const [from, to] of keep) {
    if (to > from) {
      result.set(out.subarray(from, to), at);
      at += to - from;
    }
  }
  return result;
}

function startsWithExif(b: Uint8Array): boolean {
  return (
    b.length >= 6 && b[0] === 0x45 && b[1] === 0x78 && b[2] === 0x69 && b[3] === 0x66 && b[4] === 0
  );
}

/** A text chunk's keyword (Latin-1, up to the first NUL). */
function pngKeyword(data: Uint8Array): string {
  const nul = data.indexOf(0);
  return latin1(data, 0, nul < 0 ? data.length : nul);
}

/**
 * Where an uncompressed iTXt chunk's text starts, or null if it's
 * compressed or can't be read: keyword NUL, compression flag, method,
 * language tag NUL, translated keyword NUL, text.
 */
function iTxtText(data: Uint8Array): number | null {
  let i = data.indexOf(0);
  if (i < 0 || i + 2 >= data.length) return null;
  if (data[i + 1] !== 0) return null; // compressed
  i += 3;
  for (let field = 0; field < 2; field++) {
    const nul = data.indexOf(0, i);
    if (nul < 0) return null;
    i = nul + 1;
  }
  return i;
}

const CRC_TABLE: number[] = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
  return c;
});

/** The CRC-32 PNG uses (ISO 3309), over [bytes]. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = ((CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// WebP

/** Whether [b] is a RIFF WebP file. */
export function isWebp(b: Uint8Array): boolean {
  return b.length >= 12 && latin1(b, 0, 4) === 'RIFF' && latin1(b, 8, 12) === 'WEBP';
}

/**
 * Removes the location metadata from a WebP, in place, without changing
 * its length: the `EXIF` chunk's GPS IFD (stripTiffLocation) and the
 * `XMP ` chunk's location properties (stripXmpLocation). RIFF has no
 * checksums, and the VP8X flags stay true. A metadata chunk cut off by the
 * end of the file has its remaining bytes zeroed. Returns whether anything
 * changed.
 */
function stripWebpLocation(webp: Uint8Array): boolean {
  const d = view(webp);
  let changed = false;
  let i = 12;
  while (i + 8 <= webp.length) {
    const type = latin1(webp, i, i + 4);
    const size = d.getUint32(i + 4, true);
    const start = i + 8;
    const end = start + size;
    const metadata = type === 'EXIF' || type === 'XMP ';
    if (end > webp.length) {
      if (metadata && webp.subarray(start).some((c) => c !== 0)) {
        webp.fill(0, start, webp.length);
        changed = true;
      }
      break;
    }
    const data = webp.subarray(start, end);
    if (type === 'EXIF') {
      // Some writers keep the JPEG-style "Exif\0\0" prefix.
      const prefixed = data.length >= 6 && latin1(data, 0, 4) === 'Exif' && data[4] === 0;
      changed = stripTiffLocation(data.subarray(prefixed ? 6 : 0), true) || changed;
    } else if (type === 'XMP ') {
      changed = stripXmpLocation(data) || changed;
    }
    i = end + (size & 1);
  }
  return changed;
}

// ---------------------------------------------------------------------------
// HEIF (HEIC, AVIF)

/**
 * `ftyp` brands of HEIF still images and sequences, HEIC and AVIF alike
 * (ISO/IEC 23008-12, AV1 Image File Format).
 */
const HEIF_BRANDS = new Set([
  'heic',
  'heix',
  'heim',
  'heis',
  'hevc',
  'hevx',
  'hevm',
  'hevs',
  'mif1',
  'mif2',
  'msf1',
  'avif',
  'avis',
]);

/**
 * Whether [b] is a HEIF file (HEIC, HEIF or AVIF), by the `ftyp` box's
 * major or compatible brands.
 */
export function isHeifContainer(b: Uint8Array): boolean {
  if (b.length < 16 || latin1(b, 4, 8) !== 'ftyp') return false;
  const size = view(b).getUint32(0);
  if (size < 16 || size > b.length) return false;
  if (HEIF_BRANDS.has(latin1(b, 8, 12))) return true;
  for (let i = 16; i + 4 <= size; i += 4) {
    if (HEIF_BRANDS.has(latin1(b, i, i + 4))) return true;
  }
  return false;
}

type HeifKind = 'exif' | 'xmp' | 'encodedXmp';

interface HeifBox {
  type: string;
  /** Where the box's content starts, after its header. */
  content: number;
  end: number;
}

/**
 * Removes the location metadata from a HEIF file, in place, without
 * changing its length: the `Exif` item's GPS IFD (stripTiffLocation) and
 * the XMP item's location properties (stripXmpLocation), found through the
 * `meta` box's `iinf` and `iloc`. The image items aren't touched.
 *
 * Throws LocationUnreadableError when the `meta` box can't be read, since
 * the metadata can't be found then. Returns whether anything changed.
 */
function stripHeifLocation(heif: Uint8Array): boolean {
  const reader = new HeifReader(heif);
  let meta: HeifBox | undefined;
  for (const box of reader.boxes(0, heif.length)) {
    if (box.type === 'meta') {
      meta = box;
      break;
    }
  }
  if (meta === undefined) return false;

  const children = [...reader.boxes(meta.content + 4, meta.end)];
  const iinf = children.find((b) => b.type === 'iinf');
  const iloc = children.find((b) => b.type === 'iloc');
  const idat = children.find((b) => b.type === 'idat');
  if (iinf === undefined) return false;
  const items = reader.metadataItems(iinf);
  if (items.size === 0) return false;
  if (iloc === undefined) throw new LocationUnreadableError('HEIF: no iloc');
  const locations = reader.locations(iloc, new Set(items.keys()), idat);

  let changed = false;
  for (const [id, kind] of items) {
    const extents = locations.get(id);
    if (extents === undefined) continue;
    const payload = gather(heif, extents);
    let edited: boolean;
    switch (kind) {
      case 'exif':
        edited = stripExifItem(payload);
        break;
      case 'xmp':
        edited = stripXmpLocation(payload);
        break;
      case 'encodedXmp':
        edited = zero(payload);
        break;
    }
    if (edited) {
      scatter(heif, extents, payload);
      changed = true;
    }
  }
  return changed;
}

/** An Exif item: a 4-byte offset to the TIFF header, then the TIFF. */
function stripExifItem(payload: Uint8Array): boolean {
  if (payload.length < 4) return zero(payload);
  const offset = view(payload).getUint32(0);
  if (4 + offset >= payload.length) return zero(payload);
  return stripTiffLocation(payload.subarray(4 + offset), true);
}

/** A copy of the bytes of [extents] (start, end), one after the other. */
function gather(b: Uint8Array, extents: [number, number][]): Uint8Array {
  let total = 0;
  for (const [start, end] of extents) total += end - start;
  const out = new Uint8Array(total);
  let at = 0;
  for (const [start, end] of extents) {
    out.set(b.subarray(start, end), at);
    at += end - start;
  }
  return out;
}

function scatter(b: Uint8Array, extents: [number, number][], payload: Uint8Array): void {
  let at = 0;
  for (const [start, end] of extents) {
    b.set(payload.subarray(at, at + end - start), start);
    at += end - start;
  }
}

class HeifReader {
  private readonly d: DataView;

  constructor(private readonly b: Uint8Array) {
    this.d = view(b);
  }

  private static bad(what: string): never {
    throw new LocationUnreadableError(`HEIF: ${what}`);
  }

  private need(end: number, limit: number): void {
    if (end > limit) HeifReader.bad('truncated box');
  }

  u8(at: number, limit: number): number {
    this.need(at + 1, limit);
    return byte(this.b, at);
  }

  u16(at: number, limit: number): number {
    this.need(at + 2, limit);
    return this.d.getUint16(at);
  }

  u32(at: number, limit: number): number {
    this.need(at + 4, limit);
    return this.d.getUint32(at);
  }

  /** An unsigned [size]-byte number (0, 4 or 8); 64-bit numbers as two 32-bit halves. */
  uN(at: number, size: number, limit: number): number {
    switch (size) {
      case 0:
        return 0;
      case 4:
        return this.u32(at, limit);
      case 8:
        return this.u32(at, limit) * 0x100000000 + this.u32(at + 4, limit);
      default:
        return HeifReader.bad(`field size ${size}`);
    }
  }

  /** The boxes from [from] to [to]. Throws at a box that runs past [to]. */
  *boxes(from: number, to: number): Generator<HeifBox> {
    let i = from;
    while (i + 8 <= to) {
      let size = this.d.getUint32(i);
      const type = latin1(this.b, i + 4, i + 8);
      let header = 8;
      if (size === 1) {
        size = this.uN(i + 8, 8, to);
        header = 16;
      } else if (size === 0) {
        size = to - i;
      }
      if (size < header || i + size > to) HeifReader.bad(`box ${type} size`);
      yield { type, content: i + header, end: i + size };
      i += size;
    }
  }

  /** A NUL-terminated string at [at]; returns it and where it ends. */
  cString(at: number, limit: number): [string, number] {
    let i = at;
    while (i < limit && this.b[i] !== 0) i++;
    return [latin1(this.b, at, i), i < limit ? i + 1 : i];
  }

  /** The Exif and XMP items `iinf` lists, by item ID. */
  metadataItems(iinf: HeifBox): Map<number, HeifKind> {
    const version = this.u8(iinf.content, iinf.end);
    const first = iinf.content + 4 + (version === 0 ? 2 : 4);
    this.need(first, iinf.end);
    const items = new Map<number, HeifKind>();
    for (const infe of this.boxes(first, iinf.end)) {
      if (infe.type !== 'infe') continue;
      const v = this.u8(infe.content, infe.end);
      if (v < 2) continue; // versions 0 and 1 have no item type
      let p = infe.content + 4;
      const id = v === 2 ? this.u16(p, infe.end) : this.u32(p, infe.end);
      p += (v === 2 ? 2 : 4) + 2; // item ID, protection index
      this.need(p + 4, infe.end);
      const type = latin1(this.b, p, p + 4);
      p += 4;
      if (type === 'Exif') {
        items.set(id, 'exif');
      } else if (type === 'mime') {
        const [, afterName] = this.cString(p, infe.end);
        const [contentType, afterType] = this.cString(afterName, infe.end);
        const [encoding] = this.cString(afterType, infe.end);
        if (contentType === 'application/rdf+xml') {
          items.set(id, encoding.length === 0 ? 'xmp' : 'encodedXmp');
        }
      }
    }
    return items;
  }

  /**
   * Where each of [wanted]'s items is in the file, as (start, end) extents,
   * from `iloc`. Extents are cut at the end of the file.
   */
  locations(
    iloc: HeifBox,
    wanted: Set<number>,
    idat: HeifBox | undefined,
  ): Map<number, [number, number][]> {
    const end = iloc.end;
    const version = this.u8(iloc.content, end);
    let p = iloc.content + 4;
    const sizes = this.u16(p, end);
    const offsetSize = sizes >> 12;
    const lengthSize = (sizes >> 8) & 0xf;
    const baseSize = (sizes >> 4) & 0xf;
    const indexSize = version === 1 || version === 2 ? sizes & 0xf : 0;
    p += 2;
    const count = version < 2 ? this.u16(p, end) : this.u32(p, end);
    p += version < 2 ? 2 : 4;
    const result = new Map<number, [number, number][]>();
    for (let n = 0; n < count; n++) {
      const id = version < 2 ? this.u16(p, end) : this.u32(p, end);
      p += version < 2 ? 2 : 4;
      let method = 0;
      if (version === 1 || version === 2) {
        method = this.u16(p, end) & 0xf;
        p += 2;
      }
      const reference = this.u16(p, end);
      p += 2;
      const base = this.uN(p, baseSize, end);
      p += baseSize;
      const extentCount = this.u16(p, end);
      p += 2;
      const extents: [number, number][] = [];
      for (let e = 0; e < extentCount; e++) {
        p += indexSize;
        const offset = this.uN(p, offsetSize, end);
        p += offsetSize;
        const length = this.uN(p, lengthSize, end);
        p += lengthSize;
        extents.push([offset, length]);
      }
      if (!wanted.has(id)) continue;
      if (reference !== 0) HeifReader.bad(`item ${id} in another file`);
      let origin: number;
      let limit: number;
      switch (method) {
        case 0:
          origin = base;
          limit = this.b.length;
          break;
        case 1:
          if (idat === undefined) return HeifReader.bad('no idat');
          origin = idat.content + base;
          limit = idat.end;
          break;
        default:
          return HeifReader.bad(`construction method ${method}`);
      }
      const spans: [number, number][] = [];
      for (const [offset, length] of extents) {
        if (origin + offset >= limit) continue;
        spans.push([
          origin + offset,
          length === 0 || origin + offset + length > limit ? limit : origin + offset + length,
        ]);
      }
      result.set(id, spans);
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Movies (QuickTime, ISO BMFF)

/**
 * Box types a QuickTime movie or an ISO BMFF file (MP4, M4V, M4A, 3GP)
 * starts with. HEIF images start with `ftyp` too, and are told apart first
 * (isHeifContainer).
 */
const FIRST_BOXES = new Set(['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot']);

/** The `uuid` of an XMP box (XMP Specification Part 3). */
const XMP_UUID = [
  0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8, 0x9c, 0x71, 0x99, 0x94, 0x91, 0xe3, 0xaf, 0xac,
];

/** The QuickTime location atom's type, `©xyz` (0xA9 then "xyz"). */
const ATOM_XYZ = '©xyz';

const FREE = [0x66, 0x72, 0x65, 0x65];

/** Whether [b] is a QuickTime movie or an ISO BMFF file, by its first box. */
export function isMovie(b: Uint8Array): boolean {
  if (b.length < 8 || !FIRST_BOXES.has(latin1(b, 4, 8))) return false;
  const size = view(b, 0, 4).getUint32(0);
  return size <= 1 || size >= 8;
}

/**
 * Whether a HEIF file also holds a movie (an image sequence's `moov`).
 * Lenient: stops at the first box it can't read.
 */
function hasMovieBox(b: Uint8Array): boolean {
  const d = view(b);
  for (let i = 0; i + 8 <= b.length;) {
    if (latin1(b, i + 4, i + 8) === 'moov') return true;
    const size = d.getUint32(i);
    if (size < 8) return false;
    i += size;
  }
  return false;
}

/**
 * [movie] without its location metadata, or null if it has none. [movie]
 * is never modified, and is only copied when something changes.
 *
 * Lossless and in place: no box moves or changes size, so the chunk
 * offsets (`stco`, `co64`) stay valid, and the media is never re-encoded.
 * What goes, in `moov`, its `trak`s, and their `udta` and `meta` boxes:
 * - `©xyz` (QuickTime and Android) and 3GPP `loci` atoms become `free`
 *   boxes of the same size, zeroed;
 * - in a `meta` box's `ilst`, location items (by their `keys` name, such
 *   as `com.apple.quicktime.location.ISO6709`, or a `©xyz` item) become
 *   zeroed `free` boxes, which readers skip; their key stays in `keys`;
 * - XMP location properties (stripXmpLocation) in `udta/XMP_` and in XMP
 *   `uuid` boxes, at the top level too.
 *
 * A `udta` or `meta` box that can't be read becomes a zeroed `free` box
 * whole. Throws LocationUnreadableError when the location can't be looked
 * for: the top-level boxes, or the `moov` and `trak` boxes, can't be
 * walked. The last top-level box may be cut off by the end of the file (a
 * truncated `mdat`); a file cut before its `moov` has no location left.
 */
function stripMovieLocation(movie: Uint8Array): Uint8Array | null {
  const scan = new MovieScanner(movie);
  scan.scan();
  if (scan.frees.length === 0 && scan.writes.length === 0) return null;
  const out = copyOf(movie);
  for (const [at, bytes] of scan.writes) out.set(bytes, at);
  for (const box of scan.frees) {
    out.set(FREE, box.start + 4);
    out.fill(0, box.content, box.end);
  }
  return out;
}

/**
 * Whether the key of a QuickTime metadata item names a location: Apple's
 * `com.apple.quicktime.location.*`, ffmpeg's `location`, and anything
 * naming GPS, a latitude or a longitude.
 */
function isMovieLocationKey(key: string): boolean {
  const k = key.toLowerCase();
  return (
    k.includes('location') ||
    k.includes('iso6709') ||
    k.includes('gps') ||
    k.includes('latitude') ||
    k.includes('longitude')
  );
}

interface MovieBox {
  type: string;
  start: number;
  /** Where the box's content starts, after its header. */
  content: number;
  end: number;
}

class MovieScanner {
  private readonly d: DataView;

  /** Boxes to turn into zeroed `free` boxes. */
  readonly frees: MovieBox[] = [];

  /** Bytes to write over the file, at an offset. */
  readonly writes: [number, Uint8Array][] = [];

  constructor(private readonly b: Uint8Array) {
    this.d = view(b);
  }

  private static bad(what: string): never {
    throw new LocationUnreadableError(`Movie: ${what}`);
  }

  scan(): void {
    for (const box of this.boxes(0, this.b.length, true)) {
      switch (box.type) {
        case 'moov':
          this.container(box, true);
          break;
        case 'udta':
          this.udta(box);
          break;
        case 'meta':
          this.meta(box);
          break;
        case 'uuid':
          this.uuid(box);
          break;
      }
    }
  }

  /** `moov` or a `trak`, which must be readable. */
  private container(parent: MovieBox, moov: boolean): void {
    for (const box of this.boxes(parent.content, parent.end)) {
      if (box.type === 'trak' && moov) this.container(box, false);
      else if (box.type === 'udta') this.udta(box);
      else if (box.type === 'meta') this.meta(box);
      else if (box.type === 'uuid') this.uuid(box);
    }
  }

  private udta(udta: MovieBox): void {
    this.orFree(udta, () => {
      for (const box of this.boxes(udta.content, udta.end)) {
        if (box.type === ATOM_XYZ || box.type === 'loci') this.frees.push(box);
        else if (box.type === 'XMP_') this.xmp(box.content, box.end);
        else if (box.type === 'meta') this.meta(box);
        else if (box.type === 'uuid') this.uuid(box);
      }
    });
  }

  /** A QuickTime `meta` (no version) or an ISO one (a full box), with `keys` and `ilst`. */
  private meta(meta: MovieBox): void {
    this.orFree(meta, () => {
      let from = meta.content;
      // An ISO full box's version and flags are zero; a QuickTime box's
      // first child (`hdlr`) has a size there.
      if (this.u32(from, meta.end) === 0) from += 4;
      let keys: string[] | null = null;
      const ilsts: MovieBox[] = [];
      for (const box of this.boxes(from, meta.end)) {
        if (box.type === 'keys') keys = this.keys(box);
        else if (box.type === 'ilst') ilsts.push(box);
        else if (box.type === 'uuid') this.uuid(box);
      }
      for (const ilst of ilsts) {
        for (const item of this.boxes(ilst.content, ilst.end)) {
          if (this.isLocationItem(item, keys)) this.frees.push(item);
        }
      }
    });
  }

  private isLocationItem(item: MovieBox, keys: string[] | null): boolean {
    if (item.type === ATOM_XYZ) return true;
    if (keys === null) return false;
    // In a `keys` list's `ilst`, an item's type is its 1-based key index.
    const index = this.d.getUint32(item.start + 4);
    const key = index >= 1 && index <= keys.length ? keys[index - 1] : undefined;
    return key !== undefined && isMovieLocationKey(key);
  }

  /** A `keys` box's key names, without their namespace (`mdta`). */
  private keys(keys: MovieBox): string[] {
    const count = this.u32(keys.content + 4, keys.end);
    const names: string[] = [];
    let p = keys.content + 8;
    for (let n = 0; n < count; n++) {
      const size = this.u32(p, keys.end);
      if (size < 8 || p + size > keys.end) MovieScanner.bad('key size');
      names.push(latin1(this.b, p + 8, p + size));
      p += size;
    }
    return names;
  }

  private uuid(box: MovieBox): void {
    if (box.end - box.content < 16) return;
    for (let k = 0; k < 16; k++) {
      if (this.b[box.content + k] !== XMP_UUID[k]) return;
    }
    this.xmp(box.content + 16, box.end);
  }

  private xmp(from: number, to: number): void {
    const packet = copyOf(this.b.subarray(from, to));
    if (stripXmpLocation(packet)) this.writes.push([from, packet]);
  }

  /**
   * Runs [scan] over [box]; if [box] can't be read, it's freed whole
   * instead, and whatever [scan] found inside it is dropped.
   */
  private orFree(box: MovieBox, scan: () => void): void {
    const f = this.frees.length;
    const w = this.writes.length;
    try {
      scan();
    } catch (e) {
      if (!(e instanceof LocationUnreadableError)) throw e;
      this.frees.length = f;
      this.writes.length = w;
      this.frees.push(box);
    }
  }

  private u32(at: number, limit: number): number {
    if (at + 4 > limit) MovieScanner.bad('truncated box');
    return this.d.getUint32(at);
  }

  /**
   * The boxes from [from] to [to]. A box that runs past [to] is an error,
   * except at the [topLevel], where the file may be cut off: the last box
   * then ends with the file. Top-level types must be printable, so a walk
   * that strays into media data stops instead of skipping over `moov`.
   */
  private *boxes(from: number, to: number, topLevel = false): Generator<MovieBox> {
    const b = this.b;
    const d = this.d;
    let i = from;
    while (i + 8 <= to) {
      const type = latin1(b, i + 4, i + 8);
      if (topLevel && !this.printable(i + 4)) MovieScanner.bad('box type');
      let size = d.getUint32(i);
      let header = 8;
      if (size === 1) {
        if (i + 16 > to) {
          if (topLevel) return;
          MovieScanner.bad(`box ${type} size`);
        }
        // As two 32-bit halves.
        size = d.getUint32(i + 8) * 0x100000000 + d.getUint32(i + 12);
        header = 16;
      } else if (size === 0) {
        size = to - i;
      }
      if (size < header) MovieScanner.bad(`box ${type} size`);
      if (size > to - i) {
        if (!topLevel) MovieScanner.bad(`box ${type} size`);
        size = to - i;
      }
      yield { type, start: i, content: i + header, end: i + size };
      i += size;
    }
  }

  private printable(at: number): boolean {
    for (let k = at; k < at + 4; k++) {
      const c = byte(this.b, k);
      if (c < 0x20 || c > 0x7e) return false;
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// A video kept as a file

/**
 * The largest top-level box read into memory to look for a location: 256
 * MiB. A `moov` that large would need hours of video; a larger one is
 * refused rather than sent with its location.
 */
export const maxLocationBoxBytes = 256 * 1024 * 1024;

/** The top-level boxes a location can be in (as stripMovieLocation looks). */
const BOXES_WITH_LOCATION = new Set(['moov', 'udta', 'meta', 'uuid']);

/** Bytes to write over a file at [offset]: a change that removes a video's location. */
export interface FilePatch {
  offset: number;
  bytes: Uint8Array;
}

/**
 * The patches that remove the location from the video file at [path], as
 * stripLocation removes it from a video in memory: the file is never read
 * whole. The top-level boxes are walked by their headers (`mdat` skipped
 * by its size), and only `moov`, `udta`, `meta` and `uuid` boxes are read,
 * one at a time, and scanned the same way. Empty when there's no location,
 * or when the file isn't a QuickTime or ISO BMFF movie (WebM, Matroska and
 * AVI go as they are).
 *
 * Throws LocationUnreadableError when the location can't be looked for
 * (the top-level boxes, or a `moov` or `trak`, can't be walked, or a box is
 * over [maxBoxBytes]): the video should then be refused, never sent with
 * its location. A file that can't be read rejects with the file system's
 * own error.
 */
export async function videoLocationPatches(
  path: string,
  opts: { maxBoxBytes?: number } = {},
): Promise<FilePatch[]> {
  const maxBoxBytes = opts.maxBoxBytes ?? maxLocationBoxBytes;
  const file = await open(path, 'r');
  try {
    const length = (await file.stat()).size;
    const head = await readAt(file, 0, Math.min(64, length));
    if (isHeifContainer(head) || !isMovie(head)) return [];
    const patches: FilePatch[] = [];
    let i = 0;
    while (i + 8 <= length) {
      const header = await readAt(file, i, Math.min(16, length - i));
      const type = latin1(header, 4, 8);
      for (let k = 4; k < 8; k++) {
        const c = byte(header, k);
        if (c < 0x20 || c > 0x7e) throw new LocationUnreadableError('Movie: box type');
      }
      const d = view(header);
      let size = d.getUint32(0);
      let headerSize = 8;
      if (size === 1) {
        // The file is cut off in the middle of a 64-bit size: nothing more.
        if (header.length < 16) break;
        // As two 32-bit halves.
        size = d.getUint32(8) * 0x100000000 + d.getUint32(12);
        headerSize = 16;
      } else if (size === 0) {
        size = length - i;
      }
      if (size < headerSize) throw new LocationUnreadableError(`Movie: box ${type} size`);
      // The last box may be cut off by the end of the file.
      if (size > length - i) size = length - i;
      if (BOXES_WITH_LOCATION.has(type)) {
        if (size > maxBoxBytes) throw new LocationUnreadableError(`Movie: ${type} too large`);
        const box = await readAt(file, i, size);
        const stripped = stripMovieLocation(box);
        if (stripped !== null) {
          const patch = diffPatch(i, box, stripped);
          if (patch !== null) patches.push(patch);
        }
      }
      i += size;
    }
    return patches;
  } finally {
    await file.close();
  }
}

/**
 * Copies the file at [src] to a new file at [dest] (created with mode 0600,
 * and never over an existing file), chunk by chunk, with [patches] written
 * over it as it's read: a copy without the location, never in memory
 * whole. [src] isn't changed. If the copy fails, the partial [dest] is
 * removed.
 */
export async function copyWithPatches(
  src: string,
  dest: string,
  patches: FilePatch[],
): Promise<void> {
  const out = await open(dest, 'wx', 0o600);
  let done = false;
  try {
    let offset = 0;
    for await (const chunk of createReadStream(src) as AsyncIterable<Buffer>) {
      const bytes = patches.length === 0 ? chunk : patchChunk(chunk, offset, patches);
      await writeAll(out, bytes);
      offset += chunk.length;
    }
    if (patches.some((p) => p.offset + p.bytes.length > offset)) {
      throw new RangeError('patch past the end of the file');
    }
    done = true;
  } finally {
    await out.close();
    if (!done) await rm(dest, { force: true });
  }
}

async function writeAll(file: FileHandle, bytes: Uint8Array): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    const { bytesWritten } = await file.write(bytes, written, bytes.length - written);
    written += bytesWritten;
  }
}

/**
 * [chunk], which starts at [start] in its file, with the parts of
 * [patches] that fall in it written over it: the same array when none
 * does, else a copy.
 */
export function patchChunk(chunk: Uint8Array, start: number, patches: FilePatch[]): Uint8Array {
  const end = start + chunk.length;
  let out: Uint8Array | null = null;
  for (const p of patches) {
    const pEnd = p.offset + p.bytes.length;
    if (pEnd <= start || p.offset >= end) continue;
    out ??= copyOf(chunk);
    const from = p.offset > start ? p.offset : start;
    const to = pEnd < end ? pEnd : end;
    out.set(p.bytes.subarray(from - p.offset, to - p.offset), from - start);
  }
  return out ?? chunk;
}

/**
 * The one range where [before] and [after] (the same length) differ, as a
 * patch at [offset] plus its start; null when they're the same.
 */
export function diffPatch(offset: number, before: Uint8Array, after: Uint8Array): FilePatch | null {
  if (before.length !== after.length) throw new RangeError('diffPatch: lengths differ');
  let first = 0;
  while (first < before.length && before[first] === after[first]) first++;
  if (first === before.length) return null;
  let last = before.length - 1;
  while (last > first && before[last] === after[last]) last--;
  return { offset: offset + first, bytes: copyOf(after.subarray(first, last + 1)) };
}

/** [count] bytes of [file] from [at]; LocationUnreadableError if the file is shorter. */
async function readAt(file: FileHandle, at: number, count: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(count);
  let got = 0;
  while (got < count) {
    const { bytesRead } = await file.read(bytes, got, count - got, at + got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  if (got < count) throw new LocationUnreadableError('Movie: truncated');
  return bytes;
}
