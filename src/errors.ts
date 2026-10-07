/**
 * Turning failures into tool results an agent can act on.
 *
 * An API refusal (an ApiError) is a normal outcome of a tool call, so it
 * becomes a tool result with `isError: true` whose text gives the code, the
 * API's message, what to do next (the API's hint, with a note in this
 * server's terms), and the details (allowed moves, candidates, the missing
 * scope, ...), formatted per code. A tool may add a
 * note that applies its own arguments to the error (for example the
 * transitions allowed from the item's current status, read from the
 * project). Arguments a tool can't use (a ToolInputError) become an
 * isError result too. Protocol problems (unknown tool, arguments that fail
 * the input schema) are left to the SDK, which answers them as JSON-RPC
 * errors.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';

import { ApiError, LOCAL_ERROR_CODES } from './api/client.js';
import { ERROR_HINTS } from './api/generated/operations.js';
import { neutralize, sanitizeLabel } from './untrusted.js';

const MAX_DETAILS_CHARS = 4000;

/**
 * Arguments that pass the input schema but can't make a valid call (for
 * example two options that exclude each other). The text says how to fix
 * the call; nothing was sent to the API.
 */
export class ToolInputError extends Error {
  override name = 'ToolInputError';
  readonly code = 'invalid_arguments';
}

/**
 * What to do, for the codes this server makes itself. The API's own codes
 * come with a hint (the error envelope's `hint`); for an older API that
 * sends none, the contract's wording (ERROR_HINTS, generated) is used.
 */
const LOCAL_HINTS: Record<string, string> = {
  http_401:
    'The token was refused. Ask the person to check it in buildIt.Social (it may be expired, revoked, or suspended by the org).',
  http_403: 'The token or its owner may not do this. Do not retry the same call.',
  http_429: 'Too many calls. Wait a little, then retry.',
  invalid_arguments: 'Fix the arguments as described, then call the tool again.',
  [LOCAL_ERROR_CODES.timeout]: 'The API was slow to answer. Retry once; if it fails again, stop.',
  [LOCAL_ERROR_CODES.network]: 'The API could not be reached. Retry later.',
  [LOCAL_ERROR_CODES.invalidResponse]:
    'This server may be older than the API. Ask the person to update buildit-mcp.',
};

/**
 * Notes that put the API's advice in this server's terms (its tools and
 * settings), shown after the hint, only where they add something: none when
 * the hint or the details already say it.
 */
const TOOL_NOTES: Record<string, (details: Record<string, unknown>) => string | undefined> = {
  token_invalid: () =>
    'In this server the token comes from BUILDIT_TOKEN (or the Authorization header in HTTP mode).',
  // The details list the token's scopes; without them, whoami does.
  scope_missing: (d) =>
    Array.isArray(d.granted) ? undefined : 'whoami lists the scopes this token has.',
  validation: () =>
    'describe_project lists the allowed statuses, types, labels, fields and estimates.',
  conflict: (d) =>
    d.kind === 'page'
      ? 'get_page reads the current text and version.'
      : d.kind === 'item' || d.kind === 'description'
        ? 'get_item reads the current item, version and description_version.'
        : undefined,
  plan_stale: () => 'In this server, that means calling the same propose_* tool again.',
  plan_expired: () => 'In this server, that means calling the same propose_* tool again.',
};

/**
 * What to do about a not_found, by the kind of thing that wasn't found, in
 * this server's tools. The API's own hint names the item and project tools
 * whatever the kind.
 */
const NOT_FOUND_HINTS: Record<string, string> = {
  project: 'whoami lists the project keys in reach (list_projects too); check the key, then retry.',
  item: 'Check the key with search_items (the item may have moved or been deleted), then retry.',
  initiative: 'Check the key with search_items, then retry.',
  status: "describe_project lists the project's statuses by workflow; use one of those names.",
  type: "describe_project lists the project's types; use one of those names.",
  label: "describe_project lists the project's labels; use one of those names.",
  field: "describe_project lists the project's fields; use one of those names.",
  option: "describe_project lists each field's options; use one of those.",
  workflow: "describe_project lists the project's workflows; use one of those names.",
  user: 'find_users lists the people of the project; use an email or "me".',
  sprint: 'list_sprints lists the project\'s sprints; name one by number, name or "active".',
  release: "list_releases lists the project's releases; use one of those names.",
  link: "get_item lists the item's links; unlink only one that is listed.",
  comment: "list_comments lists the item's comments and their ids.",
  page: "list_pages lists a channel's pages and their ids.",
  channel: 'list_channels lists the channels in reach; use one of those names.',
  message: 'read_channel lists the messages of a channel and their ids.',
  plan: 'Use a handle a propose_* tool returned in this conversation, or propose the change again.',
  route:
    'The API does not serve this call: it may be older than this buildit-mcp. Check BUILDIT_API_URL, or use another tool.',
};

/** Rate-limit buckets, in plain words. */
const RATE_BUCKETS: Record<string, string> = {
  token_requests_per_minute: 'calls per minute for this token',
  token_writes_per_minute: 'writes per minute for this token',
  token_writes_per_day: 'writes per day for this token',
  org_requests_per_minute: 'calls per minute for the whole org (all its tokens)',
};

/** The API's own terms, as this server names them. */
function inServerTerms(hint: string): string {
  return hint.replace(/\bget_me\b/g, 'whoami');
}

/** The next step for an error: the API's hint, else the contract's, else this server's own. */
export function hintFor(code: string, apiHint?: string): string | undefined {
  return apiHint ?? (ERROR_HINTS as Record<string, string | undefined>)[code] ?? LOCAL_HINTS[code];
}

/** Lower case letters and digits only, to tell whether one text already says another. */
function squash(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Whether `text` adds nothing to what `shown` already says. */
function alreadySaid(text: string, shown: readonly string[]): boolean {
  const t = squash(text);
  return t === '' || shown.some((s) => squash(s).includes(t));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string {
  if (value === undefined) return 'unknown';
  return typeof value === 'string' ? sanitizeLabel(value, 300) : JSON.stringify(value);
}

function list(value: unknown): string {
  return Array.isArray(value) ? value.map(str).join(', ') || 'none' : str(value);
}

function formatValue(value: unknown): string {
  if (Array.isArray(value) && value.every((v) => typeof v === 'string' || typeof v === 'number')) {
    return value.join(', ');
  }
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** Code-specific renderings of the details, so the agent reads what matters. */
function formatKnownDetails(code: string, d: Record<string, unknown>): string[] | undefined {
  switch (code) {
    case 'ambiguous': {
      const candidates = Array.isArray(d.candidates) ? d.candidates : [];
      return [
        `- ${str(d.kind)} "${str(d.ref)}" matches:`,
        ...candidates.map((c) => {
          const r = record(c);
          return `  - ${str(r?.label)} (id ${str(r?.id)})`;
        }),
      ];
    }
    case 'conflict': {
      const current = record(d.current) ?? {};
      const parts = Object.entries(current).map(([k, v]) => `${k} ${str(v)}`);
      return [`- ${str(d.kind)} changed; current: ${parts.join(', ') || 'unknown'}`];
    }
    case 'transition_not_allowed': {
      const moves = Array.isArray(d.moves) ? d.moves.map(record) : undefined;
      return [
        `- from: ${str(d.from)}`,
        `- asked for: ${str(d.to)}`,
        ...(moves
          ? [
              `- moves allowed from here: ${
                moves
                  .map((m) => {
                    const needs = Array.isArray(m?.required_fields) ? m.required_fields : [];
                    const notes = [
                      ...(needs.length > 0 ? [`needs ${list(needs)}`] : []),
                      ...(m?.admins_only === true ? ['project admins only'] : []),
                    ];
                    return notes.length > 0 ? `${str(m?.to)} (${notes.join('; ')})` : str(m?.to);
                  })
                  .join('; ') || 'none'
              }`,
            ]
          : [`- allowed from here: ${list(d.allowed)}`]),
        ...(Array.isArray(d.required_fields) && d.required_fields.length > 0
          ? [`- the asked-for move needs: ${list(d.required_fields)}`]
          : []),
        ...(d.admins_only === true ? ['- the asked-for move is for project admins only'] : []),
      ];
    }
    case 'field_required':
      return [`- set: ${list(d.fields)}`];
    case 'validation': {
      const fields = Array.isArray(d.fields) ? d.fields : [];
      return fields.map((f) => {
        const r = record(f);
        return `- ${str(r?.path)}: ${str(r?.message)}`;
      });
    }
    case 'scope_missing':
      return [`- needs: ${str(d.scope)}`, `- the token has: ${list(d.granted)}`];
    case 'not_found':
    case 'archived':
    case 'outside_limits':
      return [`- ${str(d.kind)}: ${str(d.ref)}`];
    case 'plan_used':
      return [`- plan ${str(d.handle)} was applied at ${str(d.used_at)}`];
    case 'plan_expired':
      return [`- plan ${str(d.handle)}`];
    case 'plan_stale': {
      const changed = Array.isArray(d.changed) ? d.changed : [];
      return [
        `- plan ${str(d.handle)}; changed since the preview: ${
          changed
            .map((c) => {
              const r = record(c);
              return `${str(r?.kind)} ${str(r?.ref)}`;
            })
            .join(', ') || 'unknown'
        }`,
      ];
    }
    case 'bulk_too_large':
      return [`- ${str(d.count)} items; at most ${str(d.max)}`];
    case 'limit_reached':
      return [`- ${str(d.limit)}: at most ${str(d.max)}`];
    case 'rate_limited':
      // retry_after and bucket are shown above, in words.
      return [];
    default:
      return undefined;
  }
}

/** Renders the details object as lines, defused and capped. */
function formatDetails(code: string, details: unknown): string | undefined {
  if (details === undefined || details === null) return undefined;
  const obj = record(details);
  let text: string;
  if (obj) {
    if (Object.keys(obj).length === 0) return undefined;
    const known = formatKnownDetails(code, obj);
    if (known?.length === 0) return undefined;
    text = (
      known ?? Object.entries(obj).map(([key, value]) => `- ${key}: ${formatValue(value)}`)
    ).join('\n');
  } else {
    text = formatValue(details);
  }
  // Details can echo people-written names (for example candidate users).
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  text = neutralize(text.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' '));
  return text.length > MAX_DETAILS_CHARS ? text.slice(0, MAX_DETAILS_CHARS) + ' …' : text;
}

/** The actionable text for an ApiError. */
export function describeApiError(err: ApiError): string {
  const details = record(err.details) ?? {};
  const message = neutralize(err.message);
  const lines = [
    `buildIt.Social API error: ${err.code}${err.status ? ` (HTTP ${err.status})` : ''}`,
    message,
  ];
  // Each piece of advice once: the message, then the hint, then a note in
  // this server's terms, each left out when what came before says it.
  const said = [message];
  const kindHint =
    err.code === 'not_found' && typeof details.kind === 'string'
      ? NOT_FOUND_HINTS[details.kind]
      : undefined;
  const hint = kindHint ?? hintFor(err.code, err.hint);
  if (hint) {
    const text = neutralize(inServerTerms(hint));
    if (!alreadySaid(text, said)) {
      lines.push(`What to do: ${text}`);
      said.push(text);
    }
  }
  const note = err.note ? neutralize(err.note) : undefined;
  // A tool's own note is more precise than the general one.
  const toolNote = note === undefined ? TOOL_NOTES[err.code]?.(details) : undefined;
  if (toolNote && !alreadySaid(toolNote, said)) {
    lines.push(toolNote);
    said.push(toolNote);
  }
  if (err.retryAfterSeconds !== undefined) {
    lines.push(`Retry after: ${Math.ceil(err.retryAfterSeconds)} s`);
  }
  if (err.code === 'rate_limited' || err.status === 429) {
    const bucket = typeof details.bucket === 'string' ? details.bucket : undefined;
    if (bucket !== undefined) {
      lines.push(`Limit reached: ${RATE_BUCKETS[bucket] ?? sanitizeLabel(bucket, 60)}.`);
    }
  }
  const formatted = formatDetails(err.code, err.details);
  if (formatted) lines.push('Details:', formatted);
  if (note && !alreadySaid(note, said)) lines.push(note);
  lines.push(`Request id: ${err.requestId}`);
  return lines.join('\n');
}

/** A tool result for any failure inside a tool handler. */
export function toolErrorResult(err: unknown, requestId?: string): CallToolResult {
  if (err instanceof ApiError) {
    return { isError: true, content: [{ type: 'text', text: describeApiError(err) }] };
  }
  if (err instanceof ToolInputError) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: [
            `buildit-mcp error: ${err.code} (nothing was sent to buildIt.Social)`,
            neutralize(err.message),
            `What to do: ${LOCAL_HINTS.invalid_arguments ?? ''}`,
          ].join('\n'),
        },
      ],
    };
  }
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `Internal error in buildit-mcp${requestId ? ` (request id ${requestId})` : ''}. This is a bug in the server, not in your call; retrying is unlikely to help.`,
      },
    ],
  };
}
