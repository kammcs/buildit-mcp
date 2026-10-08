/**
 * The token's identity (its scopes, and whether it has project or channel
 * limits, from GET /v1/me), which decides the tool list, and what to do when
 * it can't be read.
 *
 * - A definite refusal of the token (invalid, revoked, expired, suspended,
 *   agent access off) lists only whoami, so the agent can call it and tell
 *   the person what is wrong.
 * - A failure that may pass (rate limited, the network, the API's 5xx)
 *   lists every tool the configuration allows, without the scope rule: the
 *   API checks scopes on every call anyway, and a client that already knows
 *   the tools keeps working.
 *
 * In HTTP mode, IdentityCache keeps each token's scopes in memory for a
 * short time, so listing tools doesn't read /v1/me on every request. It is
 * keyed by a keyed hash of the token (never the token itself), holds only
 * the scopes and whether the token is limited, is bounded, and drops an entry on any auth error. It only
 * shapes tool lists; it never authorizes anything.
 */
import { createHmac, randomBytes } from 'node:crypto';

import { ApiError, LOCAL_ERROR_CODES } from './api/client.js';

/** Codes that refuse the token itself: listing falls back to whoami only. */
export const TOKEN_REFUSED_CODES: ReadonlySet<string> = new Set([
  'token_invalid',
  'token_revoked',
  'token_expired',
  'token_suspended',
  'agent_access_off',
]);

/** Whether /v1/me failed because the token is refused (not because of a passing problem). */
export function isTokenRefused(err: unknown): boolean {
  return err instanceof ApiError && (TOKEN_REFUSED_CODES.has(err.code) || err.status === 401);
}

/** Whether a failure may pass on its own: rate limits, the network, the API's 5xx. */
export function isTransientFailure(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  if (err.code === 'rate_limited' || err.status === 429) return true;
  if (err.code === LOCAL_ERROR_CODES.network || err.code === LOCAL_ERROR_CODES.timeout) {
    return true;
  }
  return err.code === 'internal' || err.code === 'unavailable' || err.status >= 500;
}

/** Whether an API error means what is known about the token's reach may be out of date. */
export function invalidatesIdentity(err: ApiError): boolean {
  return isTokenRefused(err) || err.code === 'scope_missing' || err.code === 'outside_limits';
}

/** What is cached per token: only its scopes, and whether it has project or channel limits. */
export interface KnownIdentity {
  scopes: readonly string[];
  /** True when the token is limited to chosen projects or channels. */
  limited: boolean;
}

export interface IdentityCacheOptions {
  /** How long an entry lives. Default 30 s. */
  ttlMs?: number;
  /** At most this many tokens are kept; the oldest goes first. Default 1000. */
  maxEntries?: number;
  /** Injected in tests. */
  now?: () => number;
}

export const IDENTITY_TTL_MS = 30_000;
export const IDENTITY_MAX_ENTRIES = 1000;

export class IdentityCache {
  private readonly entries = new Map<string, { value: KnownIdentity; expires: number }>();
  private readonly inflight = new Map<string, Promise<KnownIdentity>>();
  /** Per process, so a key can't be matched against a token hash from anywhere else. */
  private readonly secret = randomBytes(32);
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: IdentityCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? IDENTITY_TTL_MS;
    this.maxEntries = Math.max(1, options.maxEntries ?? IDENTITY_MAX_ENTRIES);
    this.now = options.now ?? Date.now;
  }

  /** How many tokens are cached (for tests). */
  get size(): number {
    return this.entries.size;
  }

  private key(token: string): string {
    return createHmac('sha256', this.secret).update(token).digest('base64url');
  }

  /**
   * The token's identity: from the cache while fresh, else from `load`.
   * Concurrent reads for one token share one load. A failed load is not
   * cached, so the next read tries again.
   */
  get(token: string, load: () => Promise<KnownIdentity>): Promise<KnownIdentity> {
    const key = this.key(token);
    const hit = this.entries.get(key);
    if (hit) {
      if (hit.expires > this.now()) return Promise.resolve(hit.value);
      this.entries.delete(key);
    }
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const loading: Promise<KnownIdentity> = load().then(
      (value) => {
        // An eviction during the load drops its result.
        if (this.inflight.get(key) === loading) {
          this.inflight.delete(key);
          this.store(key, { scopes: [...value.scopes], limited: value.limited });
        }
        return value;
      },
      (err: unknown) => {
        if (this.inflight.get(key) === loading) this.inflight.delete(key);
        throw err;
      },
    );
    this.inflight.set(key, loading);
    return loading;
  }

  /** Forgets the token (after an auth error). */
  evict(token: string): void {
    const key = this.key(token);
    this.entries.delete(key);
    this.inflight.delete(key);
  }

  private store(key: string, value: KnownIdentity): void {
    const now = this.now();
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      for (const [k, e] of this.entries) if (e.expires <= now) this.entries.delete(k);
    }
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expires: now + this.ttlMs });
  }
}
