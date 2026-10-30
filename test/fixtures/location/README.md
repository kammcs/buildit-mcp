# Location-stripping fixtures

Small synthetic files for `test/location.test.ts`. None of them is a real
photo or video: the location in them is a public landmark (the old port of
Montréal, at 45.5017, -73.5673), the camera is a made-up "iPhone 17 Pro"
with a "Test Lens 24mm", and the date is 2026-10-03 12:34:56.

- `gps.jpg`, `gps.png`, `gps.tif`, `gps.heic`: a 24 x 16 gradient drawn in
  code and written with ImageIO (macOS) with Make, Model, DateTimeOriginal,
  LensModel and a GPS IFD. exiftool then added XMP location
  (`exif:GPS*`, `photoshop:City/State/Country`, `Iptc4xmpCore:Location`,
  `Iptc4xmpExt:LocationShown`), IPTC-IIM location (JPEG, TIFF), a
  non-location XMP title ("Harbour") and rating, and, in the JPEG, a
  thumbnail with its own GPS IFD.
- `gps.webp`: the same gradient through `cwebp`, with Exif (GPS included)
  and XMP added by exiftool.
- `plain.png`: the gradient with no metadata at all.
- `gps.mov`, `gps-tagged.mov`, `gps.mp4`: 1-second 64 x 48 H.264 clips of
  ffmpeg's `testsrc` pattern with a 440 Hz AAC tone, titled "Harbour", made
  with `-fflags +bitexact`, carrying their location in different places:
  - `gps.mov`: a phone's layout (ftyp, wide, mdat, then moov), written by
    ffmpeg alone: `com.apple.quicktime.location.ISO6709` and
    `location.name` in `udta/meta` keys, next to make, model and creation
    date, plus a 3GPP `loci` box.
  - `gps-tagged.mov`: moov first, rewritten by exiftool:
    `Keys:GPSCoordinates` and `Keys:LocationName` in `moov/meta`, a `©xyz`
    atom, XMP location in `udta/XMP_`, and ffmpeg's own `location` key and
    `loci` in `udta`.
  - `gps.mp4`: moov first (faststart): `©xyz` in `udta/meta/ilst` and in
    `udta`, `loci`, and XMP location in a top-level `uuid` box.

The only other text in them is what the tools write themselves (encoder
and toolkit version strings, the sRGB colour profile).
