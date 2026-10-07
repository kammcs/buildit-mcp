/**
 * Marking text that people wrote.
 *
 * Titles, descriptions, comments, pages and chat messages are written by
 * people (guests among them) and read by an agent, so they can carry text
 * aimed at the agent ("ignore previous instructions and ..."). Every tool that
 * returns such text wraps it:
 *
 *   <untrusted_content source="comment" author="Ana">...</untrusted_content>
 *
 * and the server's instructions tell the agent that anything inside is data,
 * never instructions. This is a best-effort signal, not a security boundary;
 * the boundaries are the token's scopes and limits, the API's permission
 * checks, and preview-then-confirm for destructive changes.
 *
 * So that the content can't end the block early, or fake a new one, every
 * opening or closing tag of the same name inside it is defused, including
 * look-alikes: other case, spaces, `-` for `_`, full-width brackets and
 * letters, and invisible characters between the letters.
 */

export const UNTRUSTED_TAG = 'untrusted_content';

/** Where the text came from. New tools may add values; keep them short and lowercase. */
export type UntrustedSource =
  'title' | 'description' | 'comment' | 'page' | 'message' | 'name' | (string & {});

export interface WrapOptions {
  source: UntrustedSource;
  /** Display name of the person who wrote it. */
  author?: string | undefined;
  /** Longest content kept, in characters. Default 8000. */
  maxChars?: number;
  /** How the agent can read the rest when the text is cut. */
  moreHint?: string;
}

export const DEFAULT_MAX_CHARS = 8000;
const MAX_ATTRIBUTE_CHARS = 120;
const DEFAULT_MORE_HINT =
  'Ask for the full text (for example with detail="full") to read the rest.';

// Characters that render as nothing and could hide inside a tag name.
const INVISIBLE =
  '\\u00AD\\u034F\\u061C\\u115F\\u1160\\u17B4\\u17B5\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u206F\\u3164\\uFE00-\\uFE0F\\uFEFF\\uFFA0';

function letterClass(ch: string): string {
  const lower = ch.toLowerCase();
  const upper = ch.toUpperCase();
  // Full-width forms: U+FF01..U+FF5E mirror U+0021..U+007E.
  const fw = (c: string): string => String.fromCharCode(c.charCodeAt(0) + 0xfee0);
  return `[${lower}${upper}${fw(lower)}${fw(upper)}]`;
}

function buildTagPattern(): RegExp {
  const gap = `[${INVISIBLE}]*`;
  // The words are plain ASCII, so splitting them into characters is safe.
  const word = (w: string): string => w.split('').map(letterClass).join(gap);
  const sep = `[\\s_\\-\\uFF3F\\uFF0D\\u2010-\\u2015${INVISIBLE}]*`;
  const open = '[<\\uFF1C\\uFE64\\u2039\\u27E8\\u3008]';
  const slash = '[/\\uFF0F\\u2044\\u2215]';
  return new RegExp(
    `${open}(?:[\\s${INVISIBLE}]*${slash})?[\\s${INVISIBLE}]*${word('untrusted')}${sep}${word('content')}`,
    'g',
  );
}

const TAG_PATTERN = buildTagPattern();

/**
 * Defuses anything in `text` that could open or close an untrusted_content
 * block. The bracket becomes `[`, so `</untrusted_content>` reads as
 * `[/untrusted_content>`: still legible, no longer a tag.
 */
export function neutralize(text: string): string {
  return text.replace(TAG_PATTERN, (match) => '[' + match.slice(1));
}

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

/**
 * Wraps people-written text for an agent. Long text is cut, and a note
 * outside the block (so it is the server speaking, not the author) says how
 * much was cut and how to read the rest.
 */
export function wrapUntrusted(text: string, options: WrapOptions): string {
  const max = options.maxChars ?? DEFAULT_MAX_CHARS;
  const truncated = text.length > max;
  const body = neutralize(truncated ? cut(text, max) : text);
  const attrs = [`source="${attribute(options.source)}"`];
  if (options.author !== undefined && options.author !== '') {
    attrs.push(`author="${attribute(options.author)}"`);
  }
  let out = `<${UNTRUSTED_TAG} ${attrs.join(' ')}>\n${body}\n</${UNTRUSTED_TAG}>`;
  if (truncated) {
    out += `\n[Cut at ${max} of ${text.length} characters. ${options.moreHint ?? DEFAULT_MORE_HINT}]`;
  }
  return out;
}

/**
 * Flattens a short people-written label (a person's, project's or org's
 * name) to one defused line of at most `maxChars` characters, for places
 * where a whole block would be noise. Free text (titles, descriptions,
 * comments, pages, messages) uses wrapUntrusted instead.
 */
export function sanitizeLabel(text: string, maxChars = 200): string {
  const flat = neutralize(text)
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001F\u007F-\u009F\u{2028}\u{2029}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > maxChars ? cut(flat, maxChars - 1) + '…' : flat;
}
