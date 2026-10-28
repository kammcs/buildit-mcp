/**
 * The agent API's session operations, typed from the contract: the
 * device-code connect flow (`connect_start`, `connect_poll`, which take no
 * token) and a Claude Code session's own conversation with its owner
 * (`get_session`, `list_session_events`, `ack_session_events`,
 * `post_session_message`, `session_heartbeat`, which take a session token).
 *
 * Each goes through callOperation, like the tools' calls: request ids,
 * timeouts, the error envelope, the one 429 retry, and tolerant parsing with
 * the generated schemas.
 */
import { z } from 'zod';

import type { ApiClient, ApiRequestOptions, QueryValue } from '../api/client.js';
import { OPERATIONS } from '../api/generated/operations.js';
import {
  SessionEventSchema,
  type ConnectPollResponse,
  type ConnectStartResponse,
  type PostSessionMessageResponse,
  type SessionEvent,
  type SessionEventsResponse,
  type SessionResponse,
} from '../api/generated/schemas.js';
import type { OperationIO } from '../api/generated/strict.js';
import { callOperation } from '../api/operations.js';

export type {
  ConnectPollResponse,
  ConnectStartResponse,
  SessionEvent,
  SessionResponse as SessionInfo,
};

type Options = Omit<ApiRequestOptions, 'query' | 'body'>;

/** The codes connect_poll answers while the person hasn't approved (RFC 8628, in the API's envelope). */
export const POLL_CODES = {
  pending: 'authorization_pending',
  slowDown: 'slow_down',
  denied: 'access_denied',
  expired: 'expired_token',
} as const;

/** Codes that end a session for good: the token is no longer accepted. */
export const SESSION_ENDED_CODES: ReadonlySet<string> = new Set(['token_revoked', 'token_expired']);

/** POST /v1/connect/start (no token). */
export function connectStart(
  api: ApiClient,
  body: OperationIO['connect_start']['body'],
  options: Options = {},
): Promise<ConnectStartResponse> {
  return callOperation(api, 'connect_start', { body }, options);
}

/** POST /v1/connect/poll (no token). The codes of POLL_CODES arrive as ApiErrors. */
export function connectPoll(
  api: ApiClient,
  deviceCode: string,
  options: Options = {},
): Promise<ConnectPollResponse> {
  return callOperation(api, 'connect_poll', { body: { device_code: deviceCode } }, options);
}

/** GET /v1/session */
export function getSession(api: ApiClient, options: Options = {}): Promise<SessionResponse> {
  return callOperation(api, 'get_session', {}, options);
}

/** A page of events, each checked on its own (see listSessionEvents). */
const EventsPageSchema = z.looseObject({
  events: z.array(z.unknown()),
  cursor: z.number(),
  more: z.boolean(),
});

/**
 * GET /v1/session/events. The contract may add event types, so the page is
 * read with each event checked on its own: one this version doesn't know
 * (or can't read) is left out, and `skipped` counts it. The cursor still
 * covers it, so it is acknowledged with the page.
 */
export async function listSessionEvents(
  api: ApiClient,
  query: OperationIO['list_session_events']['query'],
  options: Options = {},
): Promise<SessionEventsResponse & { skipped: number }> {
  const op = OPERATIONS.list_session_events;
  if (api.served?.operations !== undefined && !api.served.operations.has('list_session_events')) {
    // callOperation's answer for an operation the deployment doesn't serve.
    return callOperation(api, 'list_session_events', { query }, options).then((page) => ({
      ...page,
      skipped: 0,
    }));
  }
  const page = await api.requestParsed(op.method, op.path, EventsPageSchema, {
    ...options,
    operation: 'list_session_events',
    pathTemplate: op.path,
    query: query as Record<string, QueryValue>,
  });
  const events: SessionEvent[] = [];
  for (const raw of page.events) {
    const parsed = SessionEventSchema.safeParse(raw);
    if (parsed.success) events.push(parsed.data);
  }
  return { ...page, events, skipped: page.events.length - events.length };
}

/** POST /v1/session/events/ack */
export function ackSessionEvents(api: ApiClient, cursor: number, options: Options = {}) {
  return callOperation(api, 'ack_session_events', { body: { cursor } }, options);
}

/** POST /v1/session/messages, in the agent's own direct message with its owner. */
export function postSessionMessage(
  api: ApiClient,
  body: OperationIO['post_session_message']['body'],
  options: Options = {},
): Promise<PostSessionMessageResponse> {
  return callOperation(api, 'post_session_message', { body }, options);
}

/** DELETE /v1/session: the session ends itself (its token stops working at once). 204, no body. */
export async function revokeSession(api: ApiClient, options: Options = {}): Promise<void> {
  await callOperation(api, 'revoke_session', {}, options);
}

/** POST /v1/session/heartbeat */
export function sessionHeartbeat(
  api: ApiClient,
  state: 'online' | 'offline',
  options: Options = {},
) {
  return callOperation(api, 'session_heartbeat', { body: { state } }, options);
}

/** PATCH /v1/session/messages/{id}: changes the session's own message (its text, or its card). */
export function updateSessionMessage(
  api: ApiClient,
  messageId: string,
  body: OperationIO['update_session_message']['body'],
  options: Options = {},
) {
  return callOperation(api, 'update_session_message', { path: { id: messageId }, body }, options);
}

/** POST /v1/session/messages/{id}/card/close: closes the session's own card to answers. */
export function closeSessionCard(api: ApiClient, messageId: string, options: Options = {}) {
  return callOperation(api, 'close_session_card', { path: { id: messageId }, body: {} }, options);
}

/** PATCH /v1/session/responses/{id}: accepts or rejects an answer to the session's own card. */
export function answerSessionResponse(
  api: ApiClient,
  responseId: string,
  body: OperationIO['answer_session_response']['body'],
  options: Options = {},
) {
  return callOperation(api, 'answer_session_response', { path: { id: responseId }, body }, options);
}

/** POST /v1/session/plan-cards: posts a plan's preview as a card the owner applies or cancels. */
export function postPlanCard(
  api: ApiClient,
  body: OperationIO['post_plan_card']['body'],
  options: Options = {},
) {
  return callOperation(api, 'post_plan_card', { body }, options);
}

/** POST /v1/session/typing: "<agent> is writing…" in a thread (204, no body). */
export async function sessionTyping(
  api: ApiClient,
  body: OperationIO['session_typing']['body'],
  options: Options = {},
): Promise<void> {
  await callOperation(api, 'session_typing', { body }, options);
}

/** GET /v1/session/threads: the session's threads, newest activity first (at most 50). */
export function listSessionThreads(api: ApiClient, options: Options = {}) {
  return callOperation(api, 'list_session_threads', {}, options);
}
