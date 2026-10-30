/**
 * The credential scan of a text file a session is about to share: the whole
 * file, streamed in pieces of whole lines, through the tool approvals'
 * credential rules (mask.ts, R1 to R8), before anything is uploaded. The
 * agent API checks the first MiB again with the same rules.
 *
 * It names the lines and the rules' kinds, never a value.
 */
import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

import { findCredentials, type CredentialFinding } from '../channel/mask.js';

/** The most lines a finding names. */
export const FINDING_MAX_LINES = 20;
/** How much text is scanned at once (whole lines; one longer line is scanned on its own). */
const PIECE_CHARS = 1024 * 1024;
/** A line longer than this is scanned in pieces (a minified file). */
const LINE_MAX_CHARS = 8 * 1024 * 1024;

/** What a piece of text adds to the finding, and how many lines it held. */
function scanPiece(
  text: string,
  firstLine: number,
  into: { lines: Set<number>; kinds: Set<string> },
): number {
  const found = findCredentials(text, firstLine);
  if (found !== undefined) {
    for (const line of found.lines) into.lines.add(line);
    for (const kind of found.kinds) into.kinds.add(kind);
  }
  // Lines as the rules count them: CR LF, CR and the Unicode separators end a line.
  return lineBreaks(text);
}

/** How many line breaks a text holds: LF, CR LF and CR, and U+2028 and U+2029. */
export function lineBreaks(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10 || c === 0x2028 || c === 0x2029) n++;
    else if (c === 13 && text.charCodeAt(i + 1) !== 10) n++;
  }
  return n;
}
/** Scans the file at `path` whole; undefined when nothing looks like a credential. */
export async function scanFileForCredentials(
  path: string,
  signal?: AbortSignal,
): Promise<CredentialFinding | undefined> {
  const decoder = new StringDecoder('utf8');
  const found = { lines: new Set<number>(), kinds: new Set<string>() };
  let pending = '';
  let line = 1;
  /** Scans the whole lines waiting (all of it at the end), keeping a partial last line. */
  const flush = (end: boolean): void => {
    let cut = end ? pending.length : pending.lastIndexOf('\n') + 1;
    if (!end && cut === 0) {
      // One very long line: scanned in pieces, never cutting a CR LF in two.
      if (pending.length <= LINE_MAX_CHARS) return;
      cut = pending.charCodeAt(LINE_MAX_CHARS - 1) === 13 ? LINE_MAX_CHARS - 1 : LINE_MAX_CHARS;
    }
    if (cut === 0) return;
    line += scanPiece(pending.slice(0, cut), line, found);
    pending = pending.slice(cut);
  };
  const stream = createReadStream(path, {
    highWaterMark: 256 * 1024,
    ...(signal ? { signal } : {}),
  });
  for await (const chunk of stream) {
    pending += decoder.write(chunk as Buffer);
    if (pending.length >= PIECE_CHARS) flush(false);
  }
  pending += decoder.end();
  flush(true);
  if (found.kinds.size === 0) return undefined;
  const order = [
    'private_key',
    'authorization_header',
    'bearer_token',
    'url_password',
    'credential_option',
    'credential_assignment',
    'api_key',
    'jwt',
  ];
  return {
    lines: [...found.lines].sort((a, b) => a - b).slice(0, FINDING_MAX_LINES),
    kinds: order.filter((k) => found.kinds.has(k)) as CredentialFinding['kinds'],
  };
}

/** A finding in plain words: "line 12 looks like an API key". */
export function describeFinding(f: { lines: readonly number[]; kinds: readonly string[] }): string {
  const what = f.kinds.map((k) => KIND_WORDS[k] ?? k.replace(/_/g, ' ')).join(', ');
  if (f.lines.length === 0) return `it looks like it holds ${what}`;
  if (f.lines.length === 1) return `line ${f.lines[0]} looks like ${what}`;
  return `lines ${f.lines.join(', ')} look like ${what}`;
}

const KIND_WORDS: Readonly<Record<string, string>> = {
  private_key: 'a private key',
  authorization_header: 'an Authorization header',
  bearer_token: 'a bearer token',
  url_password: 'a password in a URL',
  credential_option: 'a password or token option',
  credential_assignment: 'a password, secret or token assignment',
  api_key: 'an API key',
  jwt: 'a JSON Web Token',
};
