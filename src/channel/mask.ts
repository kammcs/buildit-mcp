/**
 * What a tool approval card's details hold, and how they are made safe to
 * show.
 *
 * Claude Code's PermissionRequest hook passes the tool call's raw input.
 * Before any of it leaves this process, every value is cleaned (control and
 * bidi characters removed), credential-shaped text in it is replaced with
 * `[REDACTED]`, and long values are cut. buildIt.Social cleans and masks the
 * stored details again with the same rules, so a second pass changes nothing
 * this one already did (the rules are idempotent).
 *
 * The rules are a list of known shapes: private key blocks, Authorization
 * headers and bearer tokens, passwords in URLs, password and token options
 * and assignments, the prefixes of well-known API keys, and JSON Web Tokens;
 * plus any field whose name says it is a secret. A secret without a known
 * shape is not caught.
 */

/* eslint-disable no-control-regex, no-misleading-character-class -- removing control, combining and variation characters is the point */
/**
 * Removed from every value: control characters but the line feed and tab,
 * the soft hyphen, bidi controls, zero-width and invisible joiners and
 * separators, variation selectors, the byte order mark and tag characters.
 */
const STRIP =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFE00-\uFE0F\uFEFF\u{E0000}-\u{E007F}]/gu;
/* eslint-enable no-control-regex, no-misleading-character-class */

/** What replaces a secret. */
export const REDACTED = '[REDACTED]';

/**
 * A value as it may be shown: CR LF, CR, and the Unicode line and paragraph
 * separators become line feeds; the other control characters, bidi controls,
 * zero-width characters and the byte order mark go. Line feeds and tabs stay.
 */
export function cleanApprovalText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2028\u2029]/g, '\n')
    .replace(STRIP, '');
}

/** A field's name: cleaned, its line feeds and tabs folded to spaces, trimmed. */
export function cleanApprovalKey(text: string): string {
  return cleanApprovalText(text)
    .replace(/[\n\t]/g, ' ')
    .trim();
}

/**
 * The masking rules, in the order they apply. Each replaces only the secret.
 *
 * They are written so that no input makes them slow: a match may start only
 * where a lookbehind allows it (the start of a name, a token or an option,
 * never inside a run of letters), names are at most 64 characters and
 * spaces 16, and every alternative of a value starts differently, so the
 * same rules behave the same in a regular expression engine that takes the
 * longest match as here (which takes the first alternative). A value that is already
 * `[REDACTED]` is matched as a whole, so masking twice gives what masking
 * once gave.
 */
const RULES: { pattern: RegExp; replacement: string }[] = [
  // R1: a PEM or PGP private key block, to its END line or the end of the text.
  {
    pattern:
      /-----BEGIN [A-Z0-9 ]{0,64}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,64}PRIVATE KEY(?: BLOCK)?-----|$)/g,
    replacement: REDACTED,
  },
  // R2: an Authorization header's credentials (its quotes may be JSON-escaped).
  {
    pattern:
      /(authorization(?:\\?["'])?\s{0,16}[:=]\s{0,16}(?:\\?["'])?(?:bearer|basic|token|bot)\s{1,16})[^\s"'\\]+/gi,
    replacement: `$1${REDACTED}`,
  },
  // R3: a bearer token anywhere.
  {
    pattern: /(?<![A-Za-z0-9_])(bearer\s{1,16})[A-Za-z0-9._~+/=-]{16,}/gi,
    replacement: `$1${REDACTED}`,
  },
  // R4: the password in a URL's user info, up to the last @ of the URL (it may hold / and @).
  {
    pattern: /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/[^/\s:@]{1,64}:)\S+@/gi,
    replacement: `$1${REDACTED}@`,
  },
  // R5: a password, secret, token or API key option's value (--password x, --token=x),
  // also on the next line after a backslash.
  {
    pattern:
      /(?<!\S)(--?[A-Za-z0-9-]{0,64}(?:password|passwd|secret|token|api-?key)(?:\s{1,16}|=)(?:\\\n[ \t]{0,64})?)(?:\[REDACTED\]|"[^"\n]*"|'[^'\n]*'|(?!\[REDACTED\])[^\s"']+)/gi,
    replacement: `$1${REDACTED}`,
  },
  // R6: an assignment or JSON member whose name says it holds a secret: the value
  // plain, quoted, a JSON string (with escaped quotes), a JSON-escaped string
  // inside a shell string, or on the next line after a backslash.
  {
    pattern:
      /(?<![A-Za-z0-9_-])([A-Za-z0-9_-]{0,64}(?:password|passwd|secret|token|api[_-]?key|apikey|private[_-]?key|access[_-]?key)(?:\\?["'])?\s{0,16}[:=]\s{0,16}(?:\\\n[ \t]{0,64})?)(?:\[REDACTED\]|\\"(?:[^\\"\n]|\\\\\\"|\\\\)*\\"|"(?:[^"\\\n]|\\[^\n])*"|'[^'\n]*'|(?!\[REDACTED\])[^\s"'&;,]+)/gi,
    replacement: `$1${REDACTED}`,
  },
  // R7: well-known API key and token prefixes.
  {
    pattern:
      /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,}|[sr]k_(?:live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{10,}|buildit_(?:pat|ags|app)_[A-Za-z0-9]{10,}|buildit_whsec_[0-9a-f]{10,})/g,
    replacement: REDACTED,
  },
  // R8: a JSON Web Token.
  {
    pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/g,
    replacement: REDACTED,
  },
];

/** R9: a field whose name says its whole value is a secret. */
const SECRET_KEY =
  /^[A-Za-z0-9_-]{0,64}(?:password|passwd|secret|token|api[_-]?key|apikey|private[_-]?key|access[_-]?key|authorization|credentials?)$/i;

/** Replaces every credential-shaped part of a text with `[REDACTED]` (rules R1 to R8). */
export function maskCredentials(text: string): string {
  let out = text;
  for (const rule of RULES) out = out.replace(rule.pattern, rule.replacement);
  return out;
}

/** A field's value masked: R1 to R8, then the whole value when the field's name is a secret's (R9). */
export function maskField(key: string, value: string): string {
  const masked = maskCredentials(value);
  return SECRET_KEY.test(key) && masked !== '' ? REDACTED : masked;
}

// ---------------------------------------------------------------------------
// Cutting
// ---------------------------------------------------------------------------

/** The longest value kept whole, in code points. */
export const VALUE_MAX = 3500;
/** What a cut value keeps: its first and last code points around the marker. */
export const VALUE_HEAD = 2400;
export const VALUE_TAIL = 1000;
/** Marks where a value was cut. */
export const CUT_MARKER = '\n⋯\n';
const MARKER_LENGTH = Array.from(CUT_MARKER).length;
/** The longest description, in code points. */
export const DESCRIPTION_MAX = 1000;
/** The longest field name, in code points. */
export const KEY_MAX = 100;
/** At most this many fields; the rest are counted in more_fields. */
export const FIELDS_MAX = 20;
/** The details' JSON, in UTF-8 bytes, at most. */
export const DETAILS_MAX_BYTES = 12_288;
/** A value is never cut below this many code points to fit the details' size; fields go instead. */
const VALUE_FLOOR = 200;
/**
 * Before masking, a value over this many code points keeps only its first
 * and last PRECUT_KEEP (so masking a huge input stays fast; it is cut far
 * below this afterwards anyway).
 */
export const PRECUT_MAX = 16_384;
export const PRECUT_KEEP = 8_192;

/** One field of the details. */
export interface ApprovalField {
  key: string;
  value: string;
  /** The code points left out of the value, when it was cut. */
  cut?: number;
}

/** What the owner sees of a tool call: its description (Bash, PowerShell) and its input's fields. */
export interface ApprovalDetails {
  description?: string;
  fields: ApprovalField[];
  /** Fields left out (past 20, or to fit the size). */
  more_fields?: number;
}

/** The text cut to `max` code points with "…", only when it is longer. */
function cutWithEllipsis(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max - 1).join('') + '…';
}

/** A value cleaned, pre-cut and masked: its code points, and what the pre-cut left out. */
interface Prepared {
  chars: string[];
  /** Code points the pre-cut left out (0: none). */
  base: number;
  /** Where the pre-cut's marker is in `chars` (-1: none). */
  markerAt: number;
}

/** The pre-cut marker's place: the marker nearest the middle. */
function markerIndex(chars: readonly string[]): number {
  let best = -1;
  const middle = chars.length / 2;
  for (let i = 0; i + 2 < chars.length; i++) {
    if (chars[i] === '\n' && chars[i + 1] === '⋯' && chars[i + 2] === '\n') {
      if (best < 0 || Math.abs(i - middle) < Math.abs(best - middle)) best = i;
    }
  }
  return best;
}

/** Cleans a value, cuts it to its ends when it is huge, and masks it. */
function prepare(text: string, mask: (value: string) => string): Prepared {
  const cleaned = Array.from(cleanApprovalText(text));
  if (cleaned.length <= PRECUT_MAX) {
    return { chars: Array.from(mask(cleaned.join(''))), base: 0, markerAt: -1 };
  }
  const pre =
    cleaned.slice(0, PRECUT_KEEP).join('') +
    CUT_MARKER +
    cleaned.slice(cleaned.length - PRECUT_KEEP).join('');
  const chars = Array.from(mask(pre));
  return { chars, base: cleaned.length - 2 * PRECUT_KEEP, markerAt: markerIndex(chars) };
}

/**
 * A value cut to its first `head` and last `tail` code points around the
 * marker, and how many of the original code points were left out (the
 * pre-cut's too, but not its marker).
 */
function keepEnds(p: Prepared, head: number, tail: number): { value: string; cut: number } {
  const n = p.chars.length;
  if (head + tail >= n) return { value: p.chars.join(''), cut: p.base };
  const removedMarker =
    p.markerAt < 0
      ? 0
      : Math.max(0, Math.min(p.markerAt + MARKER_LENGTH, n - tail) - Math.max(p.markerAt, head));
  return {
    value: p.chars.slice(0, head).join('') + CUT_MARKER + p.chars.slice(n - tail).join(''),
    cut: p.base + (n - head - tail) - removedMarker,
  };
}

/** A value over 3,500 code points: its first 2,400 and last 1,000, with the marker between. */
export function cutValue(value: string): { value: string; cut: number } {
  const chars = Array.from(value);
  if (chars.length <= VALUE_MAX) return { value, cut: 0 };
  return keepEnds({ chars, base: 0, markerAt: -1 }, VALUE_HEAD, VALUE_TAIL);
}

/** One field before the size check: its whole (masked) value, and the cut shown. */
interface Pending {
  key: string;
  /** The masked value, whole. */
  full: Prepared;
  value: string;
  cut: number;
}

const bytesOf = (details: ApprovalDetails): number =>
  Buffer.byteLength(JSON.stringify(details), 'utf8');

function assemble(
  description: string | undefined,
  fields: readonly Pending[],
  more: number,
): ApprovalDetails {
  return {
    ...(description === undefined ? {} : { description }),
    fields: fields.map((f) => ({
      key: f.key,
      value: f.value,
      ...(f.cut > 0 ? { cut: f.cut } : {}),
    })),
    ...(more > 0 ? { more_fields: more } : {}),
  };
}

/**
 * The details of a tool call, cleaned, masked and cut: for Bash and
 * PowerShell a string `description` is the description; every other
 * top-level key of the input, in order, is a field (a string as it is,
 * anything else as indented JSON). Each value is cleaned, cut to its first
 * and last 8,192 code points when it is over 16,384 (so masking stays
 * fast), masked, then cut past 3,500 code points; at most 20 fields; then, while the JSON is over
 * 12 KB, the longest value is cut to half (never below 200 code points),
 * and once none is longer than that, fields are dropped from the end.
 */
export function buildDetails(toolName: string, input: Record<string, unknown>): ApprovalDetails {
  let description: string | undefined;
  const entries = Object.entries(input);
  const pending: Pending[] = [];
  let more = 0;
  for (const [rawKey, raw] of entries) {
    if (
      (toolName === 'Bash' || toolName === 'PowerShell') &&
      rawKey === 'description' &&
      typeof raw === 'string'
    ) {
      const text = prepare(raw, maskCredentials).chars.join('').trim();
      if (text !== '') description = cutWithEllipsis(text, DESCRIPTION_MAX);
      continue;
    }
    if (pending.length >= FIELDS_MAX) {
      more++;
      continue;
    }
    const cleanedKey = cleanApprovalKey(rawKey);
    const key = cutWithEllipsis(cleanedKey === '' ? '_' : cleanedKey, KEY_MAX);
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
    const full = prepare(text, (value) => maskField(cleanedKey, value));
    const first =
      full.chars.length > VALUE_MAX
        ? keepEnds(full, VALUE_HEAD, VALUE_TAIL)
        : { value: full.chars.join(''), cut: full.base };
    pending.push({ key, full, value: first.value, cut: first.cut });
  }
  let details = assemble(description, pending, more);
  while (bytesOf(details) > DETAILS_MAX_BYTES && pending.length > 0) {
    const lengths = pending.map((f) => Array.from(f.value).length);
    const longest = lengths.indexOf(Math.max(...lengths));
    const field = pending[longest];
    const kept = lengths[longest] ?? 0;
    if (field !== undefined && kept > VALUE_FLOOR) {
      // Cut again from the whole value: what is kept, the marker counted in.
      const target = Math.max(VALUE_FLOOR, Math.floor(kept / 2)) - MARKER_LENGTH;
      const head = Math.ceil((target * 2) / 3);
      const again = keepEnds(field.full, head, target - head);
      field.value = again.value;
      field.cut = again.cut;
    } else {
      pending.pop();
      more++;
    }
    details = assemble(description, pending, more);
  }
  return details;
}

// ---------------------------------------------------------------------------
// The session rule ("Allow for this session")
// ---------------------------------------------------------------------------

/** One rule of a session rule: a tool, and optionally what its calls must match. */
export interface RuleValue {
  toolName: string;
  ruleContent?: string;
}

/** A permission update the owner may grant for the rest of the session, as Claude Code takes it. */
export type SessionRule =
  | { type: 'addRules'; rules: RuleValue[]; behavior: 'allow'; destination: 'session' }
  | { type: 'setMode'; mode: 'acceptEdits'; destination: 'session' };

const TOOL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const RULE_FORBIDDEN =
  // eslint-disable-next-line no-control-regex -- control characters disqualify a rule
  /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/;
const RULE_CONTENT_MAX = 500;
const RULES_MAX = 5;
const RULE_MAX_BYTES = 2048;

const isPlain = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const hasOnly = (o: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(o).every((k) => keys.includes(k));

/** One suggestion as a session rule, or undefined when it isn't exactly one. */
function asSessionRule(entry: unknown, toolName: string): SessionRule | undefined {
  if (!isPlain(entry) || entry.destination !== 'session') return undefined;
  if (entry.type === 'setMode') {
    if (!hasOnly(entry, ['type', 'mode', 'destination']) || entry.mode !== 'acceptEdits') {
      return undefined;
    }
    return { type: 'setMode', mode: 'acceptEdits', destination: 'session' };
  }
  if (entry.type !== 'addRules' || entry.behavior !== 'allow') return undefined;
  if (!hasOnly(entry, ['type', 'rules', 'behavior', 'destination'])) return undefined;
  const rules = entry.rules;
  if (!Array.isArray(rules) || rules.length < 1 || rules.length > RULES_MAX) return undefined;
  const out: RuleValue[] = [];
  for (const r of rules) {
    if (!isPlain(r) || !hasOnly(r, ['toolName', 'ruleContent'])) return undefined;
    if (typeof r.toolName !== 'string' || !TOOL_NAME_RE.test(r.toolName)) return undefined;
    // A rule only for the tool that asks: never another tool's.
    if (r.toolName !== toolName) return undefined;
    if (r.ruleContent === undefined) {
      out.push({ toolName: r.toolName });
      continue;
    }
    if (typeof r.ruleContent !== 'string') return undefined;
    // Cleaned by the strip rules only; a line feed or tab left in it disqualifies it.
    const content = cleanApprovalText(r.ruleContent);
    const chars = Array.from(content).length;
    if (chars < 1 || chars > RULE_CONTENT_MAX || RULE_FORBIDDEN.test(content)) return undefined;
    out.push({ toolName: r.toolName, ruleContent: content });
  }
  const rule: SessionRule = {
    type: 'addRules',
    rules: out,
    behavior: 'allow',
    destination: 'session',
  };
  return Buffer.byteLength(JSON.stringify(rule), 'utf8') <= RULE_MAX_BYTES ? rule : undefined;
}

/**
 * The session rule to offer, from Claude Code's permission_suggestions (an
 * array, or its JSON text): the first entry that is exactly a session-scoped
 * allow rule (1 to 5 rules, each for the tool that asks) or "accept edits
 * for the session". Anything else (another destination, a directory grant,
 * another mode, a rule for another tool) is never offered.
 */
export function sessionRuleFrom(suggestions: unknown, toolName: string): SessionRule | undefined {
  let list = suggestions;
  if (typeof list === 'string') {
    if (list.trim() === '' || list.startsWith('${')) return undefined;
    try {
      list = JSON.parse(list) as unknown;
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(list)) return undefined;
  for (const entry of list) {
    const rule = asSessionRule(entry, toolName);
    if (rule !== undefined) return rule;
  }
  return undefined;
}
