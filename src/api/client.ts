/**
 * A small fetch wrapper for the buildIt.Social agent API.
 *
 * - Every call sends `Authorization: Bearer <token>`, a fresh `X-Request-Id`
 *   (also logged, so a call can be traced across the two systems),
 *   `X-Buildit-Client` (the MCP client's name and version when known, and
 *   this server's) and, when made on behalf of a tool, `X-Buildit-Tool`.
 * - The API's error envelope `{error: {code, message, hint, details}}`
 *   becomes an ApiError.
 * - A 429 is retried once after `retry_after`, when that wait is within the
 *   cap; a longer wait comes back to the agent as an error to act on. A 429
 *   that gives no wait (a limit in front of the API hides Retry-After) means
 *   a minute, as the contract says.
 * - get_meta and get_me (the contract's discovery operations) carry no
 *   RateLimit-* headers; nothing here reads those headers.
 * - Each attempt has a timeout.
 *
 * The client holds the token of one caller and is created per caller (once
 * in stdio mode, per HTTP request in HTTP mode). It never logs the token,
 * request bodies, query strings or response bodies.
 */
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { silentLogger, type Logger } from '../log.js';
import { SERVER_NAME, SERVER_VERSION } from '../version.js';
import {
  MeResponseSchema,
  MetaResponseSchema,
  type MeResponse,
  type MetaResponse,
} from './generated/schemas.js';

/**
 * The API's error envelope, read tolerantly. The contract lists each code
 * with its own details, but v1 may add codes, so any code is accepted here
 * and the details are kept as they come.
 */
const ErrorEnvelopeSchema = z.object({
  error: z.looseObject({
    code: z.string(),
    message: z.string().optional(),
    hint: z.string().optional(),
    details: z.unknown().optional(),
  }),
});

/** Codes produced by this client rather than by the API. */
export const LOCAL_ERROR_CODES = {
  timeout: 'timeout',
  network: 'network_error',
  invalidResponse: 'invalid_response',
} as const;

export class ApiError extends Error {
  override name = 'ApiError';
  /** A stable code from the API (for example `transition_not_allowed`) or a local one. */
  readonly code: string;
  /** The HTTP status, or 0 when no response arrived. */
  readonly status: number;
  readonly details: unknown;
  /** The API's one-line next step for this code, when it sent one. */
  readonly hint: string | undefined;
  readonly requestId: string;
  /** Seconds to wait before retrying, when the API said so. */
  readonly retryAfterSeconds: number | undefined;
  /** Extra guidance a tool adds for its own arguments (shown after the details). */
  readonly note: string | undefined;

  constructor(init: {
    code: string;
    message: string;
    status: number;
    requestId: string;
    details?: unknown;
    hint?: string | undefined;
    retryAfterSeconds?: number | undefined;
    note?: string | undefined;
  }) {
    super(init.message);
    this.code = init.code;
    this.status = init.status;
    this.details = init.details;
    this.hint = init.hint;
    this.requestId = init.requestId;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.note = init.note;
  }

  /** The same error with a tool's note added. */
  withNote(note: string): ApiError {
    return new ApiError({
      code: this.code,
      message: this.message,
      status: this.status,
      requestId: this.requestId,
      details: this.details,
      hint: this.hint,
      retryAfterSeconds: this.retryAfterSeconds,
      note: this.note ? [this.note, note].join('\n') : note,
    });
  }
}

export type QueryValue = string | number | boolean | undefined;

export interface ApiRequestOptions {
  query?: Record<string, QueryValue | readonly string[]>;
  body?: unknown;
  /** The MCP tool this call is made for; sent as X-Buildit-Tool. */
  tool?: string;
  /** The MCP client's name and version, when known; sent in X-Buildit-Client. */
  client?: { name: string; version?: string | undefined } | undefined;
  signal?: AbortSignal;
}

export interface ApiClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  /** Per-attempt timeout. Default 30 s. */
  timeoutMs?: number;
  /** The longest retry_after the client waits out before its one retry. Default 10 s. */
  maxRetryAfterMs?: number;
  logger?: Logger;
  /** Injected in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Told about every API error before it is thrown (to drop a cached identity after an auth error). */
  onError?: (err: ApiError) => void;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRY_AFTER_MS = 10_000;
/**
 * The wait for a 429 that gives none: a limit in front of the API answers
 * without the error envelope and, behind the gateway, without Retry-After.
 * The contract says to retry after a minute then. Above the default cap, so
 * it goes back to the agent instead of being waited out.
 */
export const DEFAULT_RATE_LIMIT_WAIT_SECONDS = 60;

const USER_AGENT = `${SERVER_NAME}/${SERVER_VERSION}`;
const MAX_CLIENT_HEADER = 200;

/** One `name/version` product token, reduced to visible ASCII without spaces or slashes. */
function productToken(name: string, version: string | undefined): string {
  // "!" to "~" is the visible ASCII range; anything else (spaces too) becomes "_".
  const clean = (s: string, max: number): string =>
    s
      .replace(/[^!-~]+/g, '_')
      .replace(/\//g, '_')
      .slice(0, max);
  const n = clean(name, 60) || 'unknown';
  return version ? `${n}/${clean(version, 30)}` : n;
}

/**
 * The X-Buildit-Client value: "client/version buildit-mcp/version", or just
 * this server's token when the client didn't say who it is.
 */
export function clientHeader(client: ApiRequestOptions['client']): string {
  const server = productToken(SERVER_NAME, SERVER_VERSION);
  if (!client || client.name.trim() === '') return server;
  return `${productToken(client.name, client.version)} ${server}`.slice(0, MAX_CLIENT_HEADER);
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toSeconds(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** retry_after from the error details, the body, or the Retry-After header (seconds or a date). */
function readRetryAfter(body: unknown, headers: Headers): number | undefined {
  const root = asRecord(body);
  const error = asRecord(root?.error);
  const details = asRecord(error?.details);
  const fromBody =
    toSeconds(details?.retry_after) ??
    toSeconds(error?.retry_after) ??
    toSeconds(root?.retry_after);
  if (fromBody !== undefined) return fromBody;
  const header = headers.get('retry-after');
  if (header === null) return undefined;
  const seconds = toSeconds(header.trim());
  if (seconds !== undefined) return seconds;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, (date - Date.now()) / 1000);
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly logger: Logger;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onError: ((err: ApiError) => void) | undefined;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
    this.logger = options.logger ?? silentLogger;
    this.sleep = options.sleep ?? defaultSleep;
    this.onError = options.onError;
  }

  /** GET /v1/meta */
  async getMeta(options: ApiRequestOptions = {}): Promise<MetaResponse> {
    return this.requestParsed('GET', '/v1/meta', MetaResponseSchema, options);
  }

  /** GET /v1/me */
  async getMe(options: ApiRequestOptions = {}): Promise<MeResponse> {
    return this.requestParsed('GET', '/v1/me', MeResponseSchema, options);
  }

  /** A request whose JSON response is validated with `schema`. */
  async requestParsed<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    options: ApiRequestOptions = {},
  ): Promise<T> {
    const { body, requestId } = await this.send(method, path, options);
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError({
        code: LOCAL_ERROR_CODES.invalidResponse,
        message: `The API's response to ${method} ${path} did not have the expected shape. The server and the API may be out of step; check for a newer buildit-mcp.`,
        status: 200,
        requestId,
        details: { issues: parsed.error.issues.slice(0, 5).map((i) => i.path.join('.')) },
      });
    }
    return parsed.data;
  }

  /** A request whose JSON response (or undefined for 204) is returned as is. */
  async request(method: string, path: string, options: ApiRequestOptions = {}): Promise<unknown> {
    return (await this.send(method, path, options)).body;
  }

  private buildUrl(path: string, query: ApiRequestOptions['query']): string {
    const url = new URL(this.baseUrl + (path.startsWith('/') ? path : `/${path}`));
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const v of value as readonly string[]) url.searchParams.append(key, v);
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private async send(
    method: string,
    path: string,
    options: ApiRequestOptions,
  ): Promise<{ body: unknown; requestId: string }> {
    try {
      return await this.sendOnce(method, path, options);
    } catch (err) {
      if (err instanceof ApiError) {
        try {
          this.onError?.(err);
        } catch {
          // A listener's failure must not hide the API's error.
        }
      }
      throw err;
    }
  }

  private async sendOnce(
    method: string,
    path: string,
    options: ApiRequestOptions,
  ): Promise<{ body: unknown; requestId: string }> {
    const url = this.buildUrl(path, options.query);
    let retried = false;
    for (;;) {
      const requestId = randomUUID();
      const started = Date.now();
      const logFields = {
        request_id: requestId,
        method,
        path,
        ...(options.tool ? { tool: options.tool } : {}),
      };
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        'X-Request-Id': requestId,
        'X-Buildit-Client': clientHeader(options.client),
      };
      if (options.tool) headers['X-Buildit-Tool'] = options.tool;
      let payload: string | undefined;
      if (options.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(options.body);
      }

      const timeout = AbortSignal.timeout(this.timeoutMs);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          ...(payload === undefined ? {} : { body: payload }),
          signal,
          redirect: 'error',
        });
      } catch (err) {
        const timedOut = timeout.aborted;
        const aborted = options.signal?.aborted === true;
        this.logger.warn('api call failed', {
          ...logFields,
          error: timedOut ? 'timeout' : aborted ? 'aborted' : 'network_error',
          duration_ms: Date.now() - started,
        });
        if (aborted && !timedOut) throw err;
        throw new ApiError({
          code: timedOut ? LOCAL_ERROR_CODES.timeout : LOCAL_ERROR_CODES.network,
          message: timedOut
            ? `The buildIt.Social API did not answer within ${Math.round(this.timeoutMs / 1000)} s. Try again shortly.`
            : 'Could not reach the buildIt.Social API. Check the network and BUILDIT_API_URL, then try again.',
          status: 0,
          requestId,
        });
      }

      const text = await response.text().catch(() => '');
      let body: unknown = undefined;
      let jsonOk = true;
      if (text.length > 0) {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          jsonOk = false;
        }
      }

      this.logger.info('api call', {
        ...logFields,
        status: response.status,
        duration_ms: Date.now() - started,
      });

      if (response.status === 429 && !retried) {
        const retryAfter =
          readRetryAfter(body, response.headers) ?? DEFAULT_RATE_LIMIT_WAIT_SECONDS;
        const waitMs = Math.ceil(retryAfter * 1000);
        if (waitMs <= this.maxRetryAfterMs) {
          retried = true;
          this.logger.info('rate limited; retrying once', { ...logFields, wait_ms: waitMs });
          await this.sleep(waitMs);
          continue;
        }
      }

      if (response.ok) {
        if (!jsonOk) {
          throw new ApiError({
            code: LOCAL_ERROR_CODES.invalidResponse,
            message: `The API's response to ${method} ${path} was not JSON.`,
            status: response.status,
            requestId,
          });
        }
        return { body, requestId };
      }

      throw this.toApiError(response, body, requestId);
    }
  }

  private toApiError(response: Response, body: unknown, requestId: string): ApiError {
    const retryAfterSeconds =
      response.status === 429
        ? (readRetryAfter(body, response.headers) ?? DEFAULT_RATE_LIMIT_WAIT_SECONDS)
        : undefined;
    const envelope = ErrorEnvelopeSchema.safeParse(body);
    if (envelope.success) {
      const { code, message, hint, details } = envelope.data.error;
      return new ApiError({
        code,
        message: message ?? `The API refused the request (${code}).`,
        status: response.status,
        requestId,
        details,
        hint,
        retryAfterSeconds,
      });
    }
    if (response.status === 429) {
      // A limit in front of the API (per address) answers without the error
      // envelope: it is still a rate limit, with the header's wait, else a minute.
      const root = asRecord(body);
      const said = typeof root?.message === 'string' ? root.message.trim().slice(0, 300) : '';
      return new ApiError({
        code: 'rate_limited',
        message: said
          ? `Too many requests: ${said}`
          : 'Too many requests to the buildIt.Social API.',
        status: 429,
        requestId,
        details: {},
        retryAfterSeconds,
      });
    }
    return new ApiError({
      code: `http_${response.status}`,
      message: `The API answered HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}.`,
      status: response.status,
      requestId,
      retryAfterSeconds,
    });
  }
}
