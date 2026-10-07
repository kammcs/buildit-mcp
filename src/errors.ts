/**
 * Turning failures into tool results an agent can act on.
 *
 * An API refusal (an ApiError) is a normal outcome of a tool call, so it
 * becomes a tool result with `isError: true` whose text gives the code, the
 * API's message, what to do next, and the details (allowed transitions,
 * candidates, the missing scope, ...). Protocol problems (unknown tool,
 * invalid arguments) are left to the SDK, which answers them as JSON-RPC
 * errors.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';

import { ApiError, LOCAL_ERROR_CODES } from './api/client.js';
import { neutralize } from './untrusted.js';

const MAX_DETAILS_CHARS = 4000;

/** What the agent can do about common codes. Other codes rely on the API's message. */
const HINTS: Record<string, string> = {
  unauthorized:
    'The token is missing, invalid, expired or revoked, or the org has turned agent access off. Ask the person to check the token in buildIt.Social.',
  invalid_token:
    'The token is invalid, expired or revoked. Ask the person to create a new one in buildIt.Social.',
  http_401:
    'The token was refused. Ask the person to check it in buildIt.Social (it may be expired, revoked, or suspended by the org).',
  forbidden: 'The token or its owner may not do this. Do not retry the same call.',
  http_403: 'The token or its owner may not do this. Do not retry the same call.',
  scope_missing:
    'The token lacks a scope this needs. Ask the person to create a token with that scope; do not retry.',
  projects_off: 'Projects is turned off for this org. Nothing in Projects can be used.',
  rate_limited: 'Too many calls. Wait for the time given, then retry.',
  http_429: 'Too many calls. Wait a little, then retry.',
  conflict:
    'Someone changed it since you read it. Read it again, re-apply your change to the current version, then retry.',
  [LOCAL_ERROR_CODES.timeout]: 'The API was slow to answer. Retry once; if it fails again, stop.',
  [LOCAL_ERROR_CODES.network]: 'The API could not be reached. Retry later.',
  [LOCAL_ERROR_CODES.invalidResponse]:
    'This server may be older than the API. Ask the person to update buildit-mcp.',
};

function formatValue(value: unknown): string {
  if (Array.isArray(value) && value.every((v) => typeof v === 'string' || typeof v === 'number')) {
    return value.join(', ');
  }
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** Renders the details object as "key: value" lines, defused and capped. */
function formatDetails(details: unknown): string | undefined {
  if (details === undefined || details === null) return undefined;
  let text: string;
  if (typeof details === 'object' && !Array.isArray(details)) {
    const lines = Object.entries(details as Record<string, unknown>).map(
      ([key, value]) => `- ${key}: ${formatValue(value)}`,
    );
    if (lines.length === 0) return undefined;
    text = lines.join('\n');
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
  const hint = HINTS[err.code];
  if (hint) lines.push(`What to do: ${hint}`);
  if (err.retryAfterSeconds !== undefined) {
    lines.push(`Retry after: ${Math.ceil(err.retryAfterSeconds)} s`);
  }
  const details = formatDetails(err.details);
  if (details) lines.push('Details:', details);
  lines.push(`Request id: ${err.requestId}`);
  return lines.join('\n');
}

/** A tool result for any failure inside a tool handler. */
export function toolErrorResult(err: unknown, requestId?: string): CallToolResult {
  if (err instanceof ApiError) {
    return { isError: true, content: [{ type: 'text', text: describeApiError(err) }] };
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
