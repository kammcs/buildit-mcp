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
 * settings), shown after the hint.
 */
const TOOL_NOTES: Record<string, string> = {
  token_invalid:
    'In this server the token comes from BUILDIT_TOKEN (or the Authorization header in HTTP mode).',
  outside_limits: 'In this server, whoami lists the projects in reach and the channel limits.',
  scope_missing: 'whoami lists the scopes this token has.',
  not_found:
    'search_items finds items; describe_project lists statuses, types, labels and members; list_channels and list_pages find channels and pages.',
  validation: 'describe_project lists the allowed statuses, types, labels, fields and estimates.',
  conflict:
    'For an item, read it again with get_item; for a page, with get_page. Then reapply your change and retry with the current versions shown below.',
  plan_stale: 'Call the same propose_* tool again and show the person the new preview.',
  plan_expired:
    'Call the same propose_* tool again; apply the new handle only after the person confirms.',
  plan_used: 'The change is already applied; do not apply it again.',
  bulk_too_large: 'propose_bulk_update takes at most 50 items per plan.',
};

/** The next step for an error: the API's hint, else the contract's, else this server's own. */
export function hintFor(code: string, apiHint?: string): string | undefined {
  return apiHint ?? (ERROR_HINTS as Record<string, string | undefined>)[code] ?? LOCAL_HINTS[code];
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
  const lines = [
    `buildIt.Social API error: ${err.code}${err.status ? ` (HTTP ${err.status})` : ''}`,
    neutralize(err.message),
  ];
  const hint = hintFor(err.code, err.hint);
  if (hint) lines.push(`What to do: ${neutralize(hint)}`);
  const toolNote = TOOL_NOTES[err.code];
  if (toolNote) lines.push(toolNote);
  if (err.retryAfterSeconds !== undefined) {
    lines.push(`Retry after: ${Math.ceil(err.retryAfterSeconds)} s`);
  }
  const details = formatDetails(err.code, err.details);
  if (details) lines.push('Details:', details);
  if (err.note) lines.push(err.note);
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
          text: `Invalid arguments: ${neutralize(err.message)}\nWhat to do: ${LOCAL_HINTS.invalid_arguments ?? ''}`,
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
