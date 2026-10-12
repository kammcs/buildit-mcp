/**
 * Marking text that people wrote.
 *
 * Titles, descriptions, comments, pages, chat messages and names are written
 * by people (guests among them) and read by an agent, so they can carry text
 * aimed at the agent ("ignore previous instructions and ..."). Every tool that
 * returns such text wraps it:
 *
 *   <untrusted_content id="3f9c0a7d21" source="comment" author="Ana">
 *   ...
 *   </untrusted_content id="3f9c0a7d21">
 *
 * and the server's instructions tell the agent that anything inside is data,
 * never instructions, and that a block ends only at a closing tag with its
 * id. The id is random for each tool result (or resource read), so text
 * written before the call can't know it. This is a best-effort signal, not a
 * security boundary; the boundaries are the token's scopes and limits, the
 * API's permission checks, and preview-then-confirm for destructive changes.
 *
 * So that the content can't end the block early, or fake a new one, the
 * block's name is also defused wherever it appears inside, look-alikes
 * included (see neutralize).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

export const UNTRUSTED_TAG = 'untrusted_content';

/** Where the text came from. New tools may add values; keep them short and lowercase. */
export type UntrustedSource =
  'title' | 'description' | 'comment' | 'page' | 'message' | 'name' | (string & {});

export interface WrapOptions {
  source: UntrustedSource;
  /** Display name of the person who wrote it. */
  author?: string | undefined;
  /** More attributes, such as via_agent or file. Keys are fixed by the caller; values are people-written. */
  attributes?: Record<string, string | null | undefined>;
  /** Longest content kept, in characters. Default 8000. */
  maxChars?: number;
  /** How the agent can read the rest when the text is cut. */
  moreHint?: string;
}

export const DEFAULT_MAX_CHARS = 8000;
const MAX_ATTRIBUTE_CHARS = 120;
const DEFAULT_MORE_HINT =
  'Ask for the full text (for example with detail="full") to read the rest.';
const ATTRIBUTE_NAME = /^[a-z][a-z_]{0,30}$/;

// ---------------------------------------------------------------------------
// Block ids
// ---------------------------------------------------------------------------

const blockIds = new AsyncLocalStorage<string>();

/** A fresh random block id: 10 hex characters. */
export function newBlockId(): string {
  return randomBytes(5).toString('hex');
}

/**
 * Runs `fn` with one block id for every block it wraps, so one tool result
 * (or resource read) uses one id. Outside such a run, each block gets its
 * own random id.
 */
export function withBlockId<T>(fn: () => T, id: string = newBlockId()): T {
  return blockIds.run(id, fn);
}

function currentBlockId(): string {
  return blockIds.getStore() ?? newBlockId();
}

// ---------------------------------------------------------------------------
// Defusing the block's name
// ---------------------------------------------------------------------------

/**
 * Cyrillic, Greek and other letters that look like the Latin letters of
 * "untrusted" and "content" (lower case; text is lower-cased first).
 */
const LOOK_ALIKES: Record<string, string> = {
  '\u{3C5}': 'u', // Greek upsilon
  '\u{57D}': 'u', // Armenian seh
  '\u{1D1C}': 'u', // small capital U
  '\u{3BD}': 'n', // Greek nu (from upper-case N)
  '\u{3B7}': 'n', // Greek eta
  '\u{43F}': 'n', // Cyrillic pe
  '\u{274}': 'n', // small capital N
  '\u{3C4}': 't', // Greek tau
  '\u{442}': 't', // Cyrillic te
  '\u{1D1B}': 't', // small capital T
  '\u{433}': 'r', // Cyrillic ghe
  '\u{280}': 'r', // small capital R
  '\u{455}': 's', // Cyrillic dze
  '\u{A731}': 's', // small capital S
  '\u{435}': 'e', // Cyrillic ie
  '\u{3B5}': 'e', // Greek epsilon
  '\u{1D07}': 'e', // small capital E
  '\u{501}': 'd', // Cyrillic komi de
  '\u{1D05}': 'd', // small capital D
  '\u{441}': 'c', // Cyrillic es
  '\u{3F2}': 'c', // Greek lunate sigma
  '\u{1D04}': 'c', // small capital C
  '\u{43E}': 'o', // Cyrillic o
  '\u{3BF}': 'o', // Greek omicron
  '\u{3C3}': 'o', // Greek sigma
  '\u{1D0F}': 'o', // small capital O
};

/**
 * Characters that render as nothing or only change the one before them,
 * dropped from the shadow copy: default ignorable code points (invisible
 * formatting characters, tag characters U+E0000 to U+E007F, and the
 * variation selectors, including the supplementary U+E0100 to U+E01EF and
 * the Mongolian U+180B to U+180F) and combining marks.
 */
const STRIPPED = /[\p{Default_Ignorable_Code_Point}\p{M}]/u;

/** The name in the shadow copy: the two words with any punctuation, spaces or controls between. */
const NAME_IN_SHADOW = /untrusted[\p{P}\p{Z}\p{Cc}\s]*content/gu;

/** What may sit between a bracket and the name: spaces, controls and the stripped characters. */
const GAP = /[\s\p{Cc}\p{Default_Ignorable_Code_Point}\p{M}]/u;
/** Slashes and their look-alikes. */
const SLASH = /[/\\\u{2044}\u{2215}\u{29F8}\u{2571}\u{FF0F}\u{FF3C}\u{27CB}]/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
// eslint-disable-next-line no-control-regex -- ASCII is the fast path
const ASCII_ONLY = /^[\u0000-\u007F]*$/;

/** What one code point contributes to the shadow copy. */
function shadowOf(ch: string, cache: Map<string, string>): string {
  const cached = cache.get(ch);
  if (cached !== undefined) return cached;
  let out = '';
  if (!STRIPPED.test(ch)) {
    for (const c of ch.normalize('NFKD').toLowerCase()) {
      if (STRIPPED.test(c)) continue;
      out += LOOK_ALIKES[c] ?? c;
    }
  }
  cache.set(ch, out);
  return out;
}

/** Where the name appears in `text`, as [start, end) spans of `text`, in order. */
function nameSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  if (ASCII_ONLY.test(text)) {
    // One shadow character per character: the indexes are the same.
    for (const m of text.toLowerCase().matchAll(NAME_IN_SHADOW)) {
      spans.push([m.index, m.index + m[0].length]);
    }
    return spans;
  }
  // The shadow copy: NFKD, lower case, without invisible characters and
  // marks, look-alikes folded to Latin. Each of its UTF-16 units remembers
  // the code point of `text` it came from (start and length).
  let shadow = '';
  const from: number[] = [];
  const size: number[] = [];
  const cache = new Map<string, string>();
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i) ?? 0;
    const len = cp > 0xffff ? 2 : 1;
    const piece =
      cp < 0x80 ? text.charAt(i).toLowerCase() : shadowOf(text.slice(i, i + len), cache);
    shadow += piece;
    for (let k = 0; k < piece.length; k++) {
      from.push(i);
      size.push(len);
    }
    i += len;
  }
  for (const m of shadow.matchAll(NAME_IN_SHADOW)) {
    const last = m.index + m[0].length - 1;
    spans.push([from[m.index] ?? 0, (from[last] ?? 0) + (size[last] ?? 1)]);
  }
  return spans;
}

/** The code point that ends just before `index`, and its length in UTF-16 units. */
function before(text: string, index: number): { ch: string; len: number } | undefined {
  if (index <= 0) return undefined;
  const low = text.charCodeAt(index - 1);
  if (index >= 2 && low >= 0xdc00 && low <= 0xdfff) {
    const high = text.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return { ch: text.slice(index - 2, index), len: 2 };
  }
  return { ch: text.charAt(index - 1), len: 1 };
}

/**
 * Defuses anything in `text` that could open or close an untrusted_content
 * block, wherever the name appears: in any case, with any punctuation or
 * spaces between its two words, in full-width, mathematical or other
 * compatibility forms, with Cyrillic or Greek look-alike letters, and with
 * invisible characters, combining marks or variation selectors anywhere in
 * it.
 *
 * The name is found in a shadow copy of the text (NFKD, lower case, those
 * characters dropped, look-alikes folded to Latin) and mapped back. Then
 * whatever stands before it as a bracket (after spaces and an optional
 * slash) becomes `[`, so `</untrusted_content>` reads as
 * `[/untrusted_content>`: still legible, no longer a tag. A bracket is `<`
 * or any character outside ASCII that is not a letter or digit (˂, 〈, ‹,
 * ＜, ...). When a letter or another character is glued to it instead, `[`
 * is put just before the name. A name after a space and a word, as in "the
 * untrusted content", is left as it is.
 *
 * Linear in the length of the text.
 */
export function neutralize(text: string): string {
  if (text.length < 'untrustedcontent'.length) return text;
  const spans = nameSpans(text);
  if (spans.length === 0) return text;
  // Edits by position: replace the character there (of this width) with "[", or insert "[".
  const edits = new Map<number, number>();
  for (const [start] of spans) {
    let j = start;
    let slash = false;
    let space = false;
    for (;;) {
      const prev = before(text, j);
      if (prev === undefined) break;
      if (GAP.test(prev.ch)) {
        if (/\s/.test(prev.ch)) space = true;
        j -= prev.len;
      } else if (!slash && SLASH.test(prev.ch)) {
        slash = true;
        j -= prev.len;
      } else {
        break;
      }
    }
    const opener = before(text, j);
    if (opener === undefined || opener.ch === '[') continue;
    const bracket =
      opener.ch === '<' || (opener.ch.charCodeAt(0) > 0x7f && !LETTER_OR_DIGIT.test(opener.ch));
    if (bracket) {
      edits.set(j - opener.len, opener.len);
    } else if (!space && !edits.has(start)) {
      edits.set(start, 0);
    }
  }
  let out = '';
  let last = 0;
  for (const pos of [...edits.keys()].sort((a, b) => a - b)) {
    if (pos < last) continue;
    out += text.slice(last, pos) + '[';
    last = pos + (edits.get(pos) ?? 0);
  }
  return out + text.slice(last);
}

// ---------------------------------------------------------------------------
// Wrapping
// ---------------------------------------------------------------------------

/** Cuts `text` to at most `max` characters without splitting a surrogate pair. */
function cut(text: string, max: number): string {
  let end = Math.max(0, max);
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function attribute(value: string): string {
  const flat = neutralize(value)
    // Control characters and line breaks would let a value spill out of its attribute line.
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001F\u007F-\u009F\u{2028}\u{2029}]+/gu, ' ')
    .trim();
  return cut(flat, MAX_ATTRIBUTE_CHARS)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** The opening tag of a block with this id and these attributes. */
function openTag(id: string, options: WrapOptions): string {
  const attrs = [`id="${id}"`, `source="${attribute(options.source)}"`];
  if (options.author !== undefined && options.author !== '') {
    attrs.push(`author="${attribute(options.author)}"`);
  }
  for (const [key, value] of Object.entries(options.attributes ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    if (!ATTRIBUTE_NAME.test(key) || key === 'id' || key === 'source' || key === 'author') {
      throw new Error(`Bad untrusted_content attribute name: ${key}`);
    }
    attrs.push(`${key}="${attribute(value)}"`);
  }
  return `<${UNTRUSTED_TAG} ${attrs.join(' ')}>`;
}

/**
 * Wraps people-written text for an agent. Long text is cut, and a note
 * outside the block (so it is the server speaking, not the author) says how
 * much was cut and how to read the rest.
 */
export function wrapUntrusted(text: string, options: WrapOptions): string {
  const max = options.maxChars ?? DEFAULT_MAX_CHARS;
  const truncated = text.length > max;
  const body = neutralize(truncated ? cut(text, max) : text);
  const id = currentBlockId();
  let out = `${openTag(id, options)}\n${body}\n</${UNTRUSTED_TAG} id="${id}">`;
  if (truncated) {
    out += `\n[Cut at ${max} of ${text.length} characters. ${options.moreHint ?? DEFAULT_MORE_HINT}]`;
  }
  return out;
}

/**
 * Flattens a short people-written label (a person's, project's or org's
 * name) to one defused line of at most `maxChars` characters. In text
 * output, labels go inside a block (wrapLines in the tools); free text
 * (titles, descriptions, comments, pages, messages) uses wrapUntrusted.
 */
export function sanitizeLabel(text: string, maxChars = 200): string {
  const flat = neutralize(text)
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001F\u007F-\u009F\u{2028}\u{2029}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > maxChars ? cut(flat, maxChars - 1) + '…' : flat;
}
