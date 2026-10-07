/**
 * A small fetch wrapper for the buildIt.Social agent API.
 *
 * - Every call sends `Authorization: Bearer <token>`, a fresh `X-Request-Id`
 *   (also logged, so a call can be traced across the two systems) and, when
 *   made on behalf of a tool, `X-Buildit-Tool`.
 * - The API's error envelope `{error: {code, message, details}}` becomes an
 *   ApiError.
 * - A 429 is retried once after `retry_after`, when that wait is within the
 *   cap; a longer wait comes back to the agent as an error to act on.
 * - Each attempt has a timeout.
 *
 * The client holds the token of one caller and is created per caller (once
 * in stdio mode, per HTTP request in HTTP mode). It never logs the token,
 * request bodies, query strings or response bodies.
 */
import { randomUUID } from 'node:crypto';

import type { z } from 'zod';

import { silentLogger, type Logger } from '../log.js';
import { SERVER_NAME, SERVER_VERSION } from '../version.js';
import { ErrorEnvelopeSchema, MeSchema, MetaSchema, type Me, type Meta } from './types.js';

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
  readonly requestId: string;
  /** Seconds to wait before retrying, when the API said so. */
  readonly retryAfterSeconds: number | undefined;

  constructor(init: {
    code: string;
    message: string;
    status: number;
    requestId: string;
    details?: unknown;
    retryAfterSeconds?: number | undefined;
  }) {
    super(init.message);
    this.code = init.code;
    this.status = init.status;
    this.details = init.details;
    this.requestId = init.requestId;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

export type QueryValue = string | number | boolean | undefined;

export interface ApiRequestOptions {
  query?: Record<string, QueryValue | readonly string[]>;
  body?: unknown;
  /** The MCP tool this call is made for; sent as X-Buildit-Tool. */
  tool?: string;
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
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRY_AFTER_MS = 10_000;
/** Wait used when a 429 carries no retry_after. */
const DEFAULT_RETRY_AFTER_SECONDS = 1;

const USER_AGENT = `${SERVER_NAME}/${SERVER_VERSION}`;

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

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
    this.logger = options.logger ?? silentLogger;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** GET /v1/meta */
  async getMeta(options: ApiRequestOptions = {}): Promise<Meta> {
    return this.requestParsed('GET', '/v1/meta', MetaSchema, options);
  }

  /** GET /v1/me */
  async getMe(options: ApiRequestOptions = {}): Promise<Me> {
    return this.requestParsed('GET', '/v1/me', MeSchema, options);
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
        const retryAfter = readRetryAfter(body, response.headers) ?? DEFAULT_RETRY_AFTER_SECONDS;
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
      response.status === 429 ? readRetryAfter(body, response.headers) : undefined;
    const envelope = ErrorEnvelopeSchema.safeParse(body);
    if (envelope.success) {
      const { code, message, details } = envelope.data.error;
      return new ApiError({
        code,
        message: message ?? `The API refused the request (${code}).`,
        status: response.status,
        requestId,
        details,
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
