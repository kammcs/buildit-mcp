/**
 * What a file is, for sharing it: its type from its name, whether it is a
 * program (refused, as for a person's upload), whether it is a secret store
 * (refused for a session), whether it is text (scanned for credentials),
 * the size caps, and its name made safe to save.
 *
 * The lists mirror the agent API's own rules, which it checks again: the
 * blocked extensions and types, the program headers, and the secret-store
 * names it publishes in openapi.json (`x-buildit-secret-file-names`, which a
 * test keeps this copy equal to).
 */
import { extname } from 'node:path';

import { STRIP } from '../channel/mask.js';
import { neutralize } from '../untrusted.js';

/** The cap for a video/* file. */
export const VIDEO_MAX_BYTES = 250 * 1024 * 1024;
/** The cap for any other file. */
export const FILE_MAX_BYTES = 100 * 1024 * 1024;

/** The largest file of this (normalized) type the API takes. */
export function maxBytesFor(contentType: string): number {
  return contentType.startsWith('video/') ? VIDEO_MAX_BYTES : FILE_MAX_BYTES;
}

/** Programs and installers that run on a double-click (lower case, without the dot). */
export const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
  'exe',
  'msi',
  'msix',
  'msixbundle',
  'appx',
  'appxbundle',
  'com',
  'scr',
  'pif',
  'cpl',
  'hta',
  'application',
  'lnk',
  'reg',
  'pkg',
  'mpkg',
  'dmg',
  'app',
  'apk',
  'xapk',
  'aab',
  'ipa',
]);

/** Types refused whatever the file's name. */
export const BLOCKED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'application/x-msdownload',
  'application/x-msi',
  'application/vnd.microsoft.portable-executable',
  'application/vnd.android.package-archive',
  'application/x-apple-diskimage',
]);

/**
 * Secret stores' names a session may not share: patterns over the whole
 * name in lower case, its trailing dots and spaces dropped; `*` is any run
 * of characters. The same list as the contract's x-buildit-secret-file-names.
 */
export const SECRET_FILE_PATTERNS: readonly string[] = [
  '.env*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.kdbx',
  'id_rsa*',
  'id_ed25519*',
  'id_ecdsa*',
  '.npmrc',
  '.netrc',
  '.pgpass',
];

const SECRET_NAME_RES: readonly RegExp[] = SECRET_FILE_PATTERNS.map(
  (pattern) =>
    new RegExp(
      `^${pattern
        .split('*')
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}$`,
      's',
    ),
);

/** A name as the rules read it: trailing dots and spaces dropped (Windows drops them too). */
function ruleName(fileName: string): string {
  return fileName.replace(/[. ]+$/, '');
}

/** Whether a file of this name is a secret store (SECRET_FILE_PATTERNS). */
export function isSecretName(fileName: string): boolean {
  const name = ruleName(fileName).toLowerCase();
  return SECRET_NAME_RES.some((re) => re.test(name));
}

/** The extension, lower case and without the dot, or undefined. */
export function fileExtension(fileName: string): string | undefined {
  const name = ruleName(fileName);
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return undefined;
  return name.slice(dot + 1).toLowerCase();
}

/** Whether a name or (normalized) type is a program or an installer. */
export function isBlockedFile(fileName: string, contentType: string): boolean {
  const ext = fileExtension(fileName);
  return (
    (ext !== undefined && BLOCKED_EXTENSIONS.has(ext)) || BLOCKED_CONTENT_TYPES.has(contentType)
  );
}

/**
 * Whether a file's first bytes start a Windows program (an MZ header whose
 * e_lfanew points at "PE\0\0") or a macOS one (Mach-O, thin or universal;
 * a Java class file shares the universal magic and is told apart by the
 * count that follows).
 */
export function isProgramHeader(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 64 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    const pe = view.getUint32(0x3c, true);
    if (
      pe >= 64 &&
      pe + 4 <= bytes.length &&
      bytes[pe] === 0x50 &&
      bytes[pe + 1] === 0x45 &&
      bytes[pe + 2] === 0 &&
      bytes[pe + 3] === 0
    ) {
      return true;
    }
  }
  if (bytes.length < 8) return false;
  const magic = view.getUint32(0, false);
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) return true;
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const count = view.getUint32(4, false);
    return count >= 1 && count <= 20;
  }
  return false;
}

/** How many first bytes decide whether a file is text (no NUL in them). */
export const TEXT_SNIFF_BYTES = 8 * 1024;

const TEXT_APPLICATION_TYPES: ReadonlySet<string> = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/ecmascript',
  'application/x-javascript',
  'application/typescript',
  'application/x-sh',
  'application/x-csh',
  'application/sql',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/x-httpd-php',
  'application/graphql',
  'application/x-powershell',
  'application/x-bat',
]);

/** Whether a (normalized) type is text: source, data, scripts and markup. */
export function isTextType(contentType: string): boolean {
  return (
    contentType.startsWith('text/') ||
    contentType.endsWith('+xml') ||
    contentType.endsWith('+json') ||
    TEXT_APPLICATION_TYPES.has(contentType)
  );
}

/** Whether these bytes hold a NUL. */
export function hasNul(bytes: Uint8Array): boolean {
  return bytes.includes(0);
}

/** The image formats the API reads (and checks for location): by their magic bytes. */
export function sniffImage(b: Uint8Array): 'jpeg' | 'png' | 'webp' | 'gif' | undefined {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  )
    return 'png';
  const ascii = (from: number, n: number): string =>
    b.length >= from + n ? String.fromCharCode(...b.subarray(from, from + n)) : '';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'webp';
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'gif';
  return undefined;
}

/**
 * Whether the API reads a file as text (and scans it for credentials): a
 * text type, or no NUL in its first 8 KiB, unless it is an image the API
 * reads. The same rule as the API's, so a file this server lets through
 * is never refused there for a credential it could have found.
 */
export function readsAsText(contentType: string, head: Uint8Array): boolean {
  if (contentType.startsWith('image/') && !contentType.endsWith('+xml') && sniffImage(head)) {
    return false;
  }
  return isTextType(contentType) || !hasNul(head.subarray(0, TEXT_SNIFF_BYTES));
}

/** Types by extension, for the ones worth naming; anything else is application/octet-stream. */
const TYPES: Readonly<Record<string, string>> = {
  // Images
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  // Video
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  '3gp': 'video/3gpp',
  // Audio
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
  // Documents and archives
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  rtf: 'application/rtf',
  // Text, data and code
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  xml: 'application/xml',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  ts: 'text/plain',
  tsx: 'text/plain',
  jsx: 'text/plain',
  py: 'text/x-python',
  rb: 'text/plain',
  go: 'text/plain',
  rs: 'text/plain',
  java: 'text/plain',
  kt: 'text/plain',
  swift: 'text/plain',
  dart: 'text/plain',
  c: 'text/plain',
  h: 'text/plain',
  cpp: 'text/plain',
  cs: 'text/plain',
  sh: 'application/x-sh',
  ps1: 'application/x-powershell',
  bat: 'application/x-bat',
  sql: 'application/sql',
  diff: 'text/plain',
  patch: 'text/plain',
};

export const FALLBACK_CONTENT_TYPE = 'application/octet-stream';

/** A file's type from its name. */
export function contentTypeFor(fileName: string): string {
  const ext = fileExtension(fileName);
  return (ext === undefined ? undefined : TYPES[ext]) ?? FALLBACK_CONTENT_TYPE;
}

/** The longest name a saved file keeps, its extension included. */
export const NAME_MAX_CHARS = 120;

/** Line feeds, tabs and the Unicode line and paragraph separators, by code point. */
const NAME_BREAKS = new Set([0x09, 0x0a, 0x2028, 0x2029]);

/** A name without control, bidi or invisible characters (mask.ts's STRIP) or line breaks. */
function visibleName(name: string): string {
  return Array.from(name.replace(STRIP, ''))
    .filter((c) => !NAME_BREAKS.has(c.codePointAt(0) ?? 0))
    .join('');
}

/** Characters no file system takes (Windows' set), and path separators. */
const NAME_UNSAFE = /[<>:"/\\|?*]/g;

/** Windows' reserved device names, with any extension. */
const RESERVED = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(?:\.|$)/i;

/**
 * A people-written file name made safe to save: no path separators or `..`,
 * no control, bidi or invisible characters, no characters a file system
 * refuses, no reserved Windows device name, no trailing dots or spaces; at
 * most NAME_MAX_CHARS characters, keeping the extension. Never empty.
 */
export function cleanFileName(name: string, fallback = 'file'): string {
  let out = visibleName(name.normalize('NFC')).replace(NAME_UNSAFE, '_');
  out = out.replace(/\.{2,}/g, '_').trim();
  out = out.replace(/[. ]+$/, '');
  if (out === '' || out === '.') out = fallback;
  if (RESERVED.test(out)) out = `_${out}`;
  // A name that reads like a block's tag would be shown changed (untrusted.ts): plain ASCII instead,
  // so the path Claude reads is the path on disk.
  if (neutralize(out) !== out) out = out.replace(/[^A-Za-z0-9 ._()-]/g, '_');
  const chars = Array.from(out);
  if (chars.length > NAME_MAX_CHARS) {
    const ext = extname(out);
    const extChars = Array.from(ext);
    if (ext !== '' && extChars.length <= 20) {
      out = chars.slice(0, NAME_MAX_CHARS - extChars.length).join('') + ext;
    } else {
      out = chars.slice(0, NAME_MAX_CHARS).join('');
    }
    out = out.replace(/[. ]+$/, '');
    if (out === '') out = fallback;
  }
  return out;
}

/** `name (n).ext`: the nth other name for a file whose name is taken. */
export function numberedName(name: string, n: number): string {
  const ext = extname(name);
  const base = ext === '' || ext === name ? name : name.slice(0, -ext.length);
  const suffix = ` (${n})`;
  const room = NAME_MAX_CHARS - Array.from(suffix).length - Array.from(ext).length;
  return Array.from(base).slice(0, Math.max(1, room)).join('') + suffix + ext;
}

/** A size in MiB, as the limits are stated ("100 MiB"). */
export function formatMiB(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return `${mib >= 10 ? Math.round(mib) : Math.round(mib * 10) / 10} MiB`;
}
