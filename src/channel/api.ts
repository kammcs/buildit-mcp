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
import type { ApiClient, ApiRequestOptions } from '../api/client.js';
import type {
  ConnectPollResponse,
  ConnectStartResponse,
  PostSessionMessageResponse,
  SessionEvent,
  SessionEventsResponse,
  SessionResponse,
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

/** GET /v1/session/events */
export function listSessionEvents(
  api: ApiClient,
  query: OperationIO['list_session_events']['query'],
  options: Options = {},
): Promise<SessionEventsResponse> {
  return callOperation(api, 'list_session_events', { query }, options);
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

/** POST /v1/session/heartbeat */
export function sessionHeartbeat(
  api: ApiClient,
  state: 'online' | 'offline',
  options: Options = {},
) {
  return callOperation(api, 'session_heartbeat', { body: { state } }, options);
}
