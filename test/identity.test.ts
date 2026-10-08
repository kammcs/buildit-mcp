/**
 * The token's identity: what is listed when /v1/me fails, the per-token
 * cache of HTTP mode, and the refreshes of stdio mode.
 */
import { PassThrough } from 'node:stream';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioServerTransport, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ApiClient, ApiError, LOCAL_ERROR_CODES } from '../src/api/client.js';
import { parseCli, type Config } from '../src/config.js';
import {
  IdentityCache,
  invalidatesIdentity,
  isTokenRefused,
  isTransientFailure,
} from '../src/identity.js';
import { createLogger } from '../src/log.js';
import { resolveListedTools, identityFromApi } from '../src/server.js';
import { CATALOG } from '../src/toolsets/catalog.js';
import { startHttp, type HttpServerHandle } from '../src/transports/http.js';
import { IDENTITY_REFRESH_MS, startStdio } from '../src/transports/stdio.js';
import { FakeApi, sampleIdentity, TOKENS } from './support/fake-api.js';

const quiet = createLogger({ sink: () => undefined });

/** The default toolsets' tools, in the order they are listed. */
const DEFAULT_TOOLS = [
  'assign_item',
  'create_item',
  'describe_project',
  'find_users',
  'get_item',
  'link_items',
  'list_projects',
  'rank_item',
  'search_items',
  'transition_item',
  'unlink_items',
  'update_item',
  'whoami',
  'add_comment',
  'list_comments',
];
const READ_TOOLS = [
  'describe_project',
  'find_users',
  'get_item',
  'list_projects',
  'search_items',
  'whoami',
  'list_comments',
];

let api: FakeApi;

beforeAll(async () => {
  api = await new FakeApi().start();
});
afterAll(async () => {
  await api.close();
});
beforeEach(() => {
  api.reset();
});
afterEach(() => {
  expect(api.violations).toEqual([]);
});

const err = (code: string, status: number): ApiError =>
  new ApiError({ code, status, message: code, requestId: 'r' });

/** The fake no longer knows the token (as if it were revoked). */
function forget(token: string): void {
  api.identities = Object.fromEntries(Object.entries(api.identities).filter(([t]) => t !== token));
}

/** A rate limit on the next /v1/me, longer than the client waits out. */
function rateLimitMe(retryAfter = 60): void {
  api.enqueueError(
    '/v1/me',
    'rate_limited',
    { retry_after: retryAfter, bucket: 'token_requests_per_minute' },
    { headers: { 'Retry-After': String(retryAfter) } },
  );
}

describe('failures of /v1/me', () => {
  it('tells a refused token from a passing failure', () => {
    for (const code of [
      'token_invalid',
      'token_revoked',
      'token_expired',
      'token_suspended',
      'agent_access_off',
    ]) {
      expect(isTokenRefused(err(code, 401)), code).toBe(true);
      expect(isTransientFailure(err(code, 401)), code).toBe(false);
    }
    expect(isTokenRefused(err('http_401', 401))).toBe(true);
    for (const e of [
      err('rate_limited', 429),
      err('http_429', 429),
      err(LOCAL_ERROR_CODES.network, 0),
      err(LOCAL_ERROR_CODES.timeout, 0),
      err('internal', 500),
      err('unavailable', 503),
      err('http_502', 502),
    ]) {
      expect(isTransientFailure(e), e.code).toBe(true);
      expect(isTokenRefused(e), e.code).toBe(false);
    }
    expect(isTransientFailure(err(LOCAL_ERROR_CODES.invalidResponse, 200))).toBe(false);
    expect(isTransientFailure(new Error('boom'))).toBe(false);
    expect(invalidatesIdentity(err('token_revoked', 401))).toBe(true);
    expect(invalidatesIdentity(err('scope_missing', 403))).toBe(true);
    expect(invalidatesIdentity(err('rate_limited', 429))).toBe(false);
    expect(invalidatesIdentity(err('not_found', 404))).toBe(false);
  });

  const policy = {
    toolsets: ['items' as const, 'comments' as const],
    readOnly: false,
    excludeTools: [],
  };
  const client = (token: string) =>
    new ApiClient({ baseUrl: api.url, token, sleep: () => Promise.resolve() });

  it('lists the tools the configuration allows when /v1/me is rate limited', async () => {
    rateLimitMe();
    const listed = await resolveListedTools(
      identityFromApi(client(TOKENS.read)),
      CATALOG,
      { ...policy, excludeTools: ['rank_item'] },
      quiet,
    );
    expect(listed.identity).toBe('unverified');
    expect(listed.error).toEqual({ code: 'rate_limited', retryAfterMs: 60_000 });
    // Every configured tool, write tools too: the API checks scopes on each call.
    expect(listed.tools.map((t) => t.name)).toEqual(DEFAULT_TOOLS.filter((n) => n !== 'rank_item'));
    expect(listed.resources.map((r) => r.name)).toContain('item');
  });

  it('lists the configured tools when the API is down or failing', async () => {
    api.enqueue('/v1/me', {
      status: 503,
      body: { error: { code: 'unavailable', message: 'Down.', details: {} } },
    });
    const down = await resolveListedTools(
      identityFromApi(client(TOKENS.read)),
      CATALOG,
      policy,
      quiet,
    );
    expect(down.identity).toBe('unverified');
    expect(down.tools).toHaveLength(DEFAULT_TOOLS.length);
    const unreachable = await resolveListedTools(
      identityFromApi(
        new ApiClient({ baseUrl: 'http://127.0.0.1:9/agent-api', token: TOKENS.read }),
      ),
      CATALOG,
      policy,
      quiet,
    );
    expect(unreachable.identity).toBe('unverified');
    expect(unreachable.error?.code).toBe(LOCAL_ERROR_CODES.network);
  });

  it('keeps read-only mode when listing without scopes', async () => {
    rateLimitMe();
    const listed = await resolveListedTools(
      identityFromApi(client(TOKENS.full)),
      CATALOG,
      { ...policy, readOnly: true },
      quiet,
    );
    expect(listed.tools.map((t) => t.name)).toEqual(READ_TOOLS);
  });

  it('lists only whoami for a refused token', async () => {
    for (const code of [
      'token_revoked',
      'token_expired',
      'token_suspended',
      'agent_access_off',
    ] as const) {
      const details =
        code === 'token_revoked'
          ? { revoked_at: '2026-10-01T00:00:00Z' }
          : code === 'token_expired'
            ? { expired_at: '2026-10-01T00:00:00Z' }
            : {};
      api.enqueueError('/v1/me', code, details);
      const listed = await resolveListedTools(
        identityFromApi(client(TOKENS.full)),
        CATALOG,
        policy,
        quiet,
      );
      expect(listed.identity, code).toBe('refused');
      expect(
        listed.tools.map((t) => t.name),
        code,
      ).toEqual(['whoami']);
    }
    const unknown = await resolveListedTools(
      identityFromApi(client(TOKENS.unknown)),
      CATALOG,
      policy,
      quiet,
    );
    expect(unknown.identity).toBe('refused');
    expect(unknown.error?.code).toBe('token_invalid');
  });
});

describe('the identity cache', () => {
  it('keeps scopes for a short time, keyed without the token', async () => {
    let now = 0;
    const cache = new IdentityCache({ ttlMs: 30_000, now: () => now });
    let loads = 0;
    const load = () => {
      loads++;
      return Promise.resolve({ scopes: ['projects:read'], limited: false });
    };
    expect(await cache.get(TOKENS.read, load)).toEqual({
      scopes: ['projects:read'],
      limited: false,
    });
    expect(await cache.get(TOKENS.read, load)).toEqual({
      scopes: ['projects:read'],
      limited: false,
    });
    expect(loads).toBe(1);
    now += 29_999;
    await cache.get(TOKENS.read, load);
    expect(loads).toBe(1);
    now += 1;
    await cache.get(TOKENS.read, load);
    expect(loads).toBe(2);
    // The keys are keyed hashes, never the token.
    const internals = cache as unknown as { entries: Map<string, unknown> };
    for (const key of internals.entries.keys()) {
      expect(key).not.toContain(TOKENS.read);
      expect(key).not.toContain('buildit_pat');
    }
    expect(JSON.stringify([...internals.entries])).not.toContain(TOKENS.read);
  });

  it('shares one load between concurrent reads, and never caches a failure', async () => {
    const cache = new IdentityCache();
    let loads = 0;
    let release: (v: { scopes: string[]; limited: boolean }) => void = () => undefined;
    const slow = () => {
      loads++;
      return new Promise<{ scopes: string[]; limited: boolean }>((resolve) => (release = resolve));
    };
    const both = Promise.all([cache.get('a', slow), cache.get('a', slow)]);
    release({ scopes: ['chat:read'], limited: false });
    expect(await both).toEqual([
      { scopes: ['chat:read'], limited: false },
      { scopes: ['chat:read'], limited: false },
    ]);
    expect(loads).toBe(1);

    const failing = () => Promise.reject(err('rate_limited', 429));
    await expect(cache.get('b', failing)).rejects.toThrow('rate_limited');
    expect(cache.size).toBe(1);
    expect(await cache.get('b', () => Promise.resolve({ scopes: [], limited: false }))).toEqual({
      scopes: [],
      limited: false,
    });
  });

  it('forgets a token on eviction, including a load in flight', async () => {
    const cache = new IdentityCache();
    await cache.get('a', () => Promise.resolve({ scopes: ['projects:read'], limited: false }));
    cache.evict('a');
    expect(cache.size).toBe(0);

    let release: (v: { scopes: string[]; limited: boolean }) => void = () => undefined;
    const pending = cache.get('b', () => new Promise((resolve) => (release = resolve)));
    cache.evict('b');
    release({ scopes: ['projects:write'], limited: false });
    await pending;
    expect(cache.size).toBe(0);
  });

  it('holds at most maxEntries tokens, dropping the oldest', async () => {
    const cache = new IdentityCache({ maxEntries: 3 });
    for (const t of ['a', 'b', 'c', 'd'])
      await cache.get(t, () => Promise.resolve({ scopes: [t], limited: false }));
    expect(cache.size).toBe(3);
    let loaded = false;
    await cache.get('a', () => {
      loaded = true;
      return Promise.resolve({ scopes: ['a'], limited: false });
    });
    expect(loaded).toBe(true);
    loaded = false;
    await cache.get('d', () => {
      loaded = true;
      return Promise.resolve({ scopes: ['d'], limited: false });
    });
    expect(loaded).toBe(false);
  });
});

describe('HTTP mode: identity', () => {
  let server: HttpServerHandle;
  let now = 0;
  const clients: Client[] = [];

  beforeAll(async () => {
    const action = parseCli(['--http', '--port', '0', '--api-url', api.url], {});
    if (action.kind !== 'run') throw new Error('expected a run config');
    server = await startHttp(action.config, quiet, { identityCache: { now: () => now } });
  });
  afterAll(async () => {
    await server.close();
  });
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
  });

  async function open(token: string): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: 'identity-test', version: '1.0.0' });
    await client.connect(transport);
    clients.push(client);
    return client;
  }
  const names = async (c: Client): Promise<string[]> =>
    (await c.listTools()).tools.map((t) => t.name);

  it('reads /v1/me once per token while it is fresh', async () => {
    now = 1_000_000;
    const reader = await open(TOKENS.read);
    expect(await names(reader)).toEqual(READ_TOOLS);
    expect(await names(reader)).toEqual(READ_TOOLS);
    await reader.listResourceTemplates();
    await reader.callTool({ name: 'search_items', arguments: { projects: ['DEMO'] } });
    expect(api.count('/v1/me')).toBe(1);
    // Another token has its own entry.
    const writer = await open(TOKENS.full);
    expect(await names(writer)).toEqual(DEFAULT_TOOLS);
    expect(api.count('/v1/me')).toBe(2);
    // After 30 s the token's scopes are read again.
    now += 30_000;
    expect(await names(reader)).toEqual(READ_TOOLS);
    expect(api.count('/v1/me')).toBe(3);
  });

  it('drops the cached identity after an auth error', async () => {
    now = 2_000_000;
    const reader = await open(TOKENS.read);
    expect(await names(reader)).toEqual(READ_TOOLS);
    expect(api.count('/v1/me')).toBe(1);
    // The token is revoked: the next call says so, and the cache forgets it.
    api.enqueueError('/v1/items', 'token_revoked', { revoked_at: '2026-10-07T15:00:00Z' });
    const refused = await reader.callTool({ name: 'search_items', arguments: {} });
    expect(refused.isError).toBe(true);
    forget(TOKENS.read);
    expect(await names(reader)).toEqual(['whoami']);
    expect(api.count('/v1/me')).toBe(2);
    // A refusal is not cached: the next list asks again.
    expect(await names(reader)).toEqual(['whoami']);
    expect(api.count('/v1/me')).toBe(3);
  });

  it('lists the configured tools when /v1/me is rate limited, and calls still work', async () => {
    now = 3_000_000;
    rateLimitMe();
    const reader = await open(TOKENS.read);
    expect(await names(reader)).toEqual(DEFAULT_TOOLS);
    const found = await reader.callTool({
      name: 'search_items',
      arguments: { projects: ['DEMO'] },
    });
    expect(found.isError).toBeFalsy();
    // The API still checks scopes on a write the list could not hide.
    const write = await reader.callTool({
      name: 'add_comment',
      arguments: { item: 'DEMO-42', body: 'Hello.' },
    });
    expect(write.isError).toBe(true);
    expect(JSON.stringify(write.content)).toContain('scope_missing');
    // The failure wasn't cached: the next list reads the scopes.
    expect(await names(reader)).toEqual(READ_TOOLS);
  });
});

describe('stdio mode: identity', () => {
  let handle: StdioServerHandle | undefined;
  let client: Client | undefined;
  let now = 0;

  afterEach(async () => {
    await client?.close();
    await handle?.close();
    client = undefined;
    handle = undefined;
  });

  async function start(token: string, env: Record<string, string> = {}): Promise<Client> {
    const action = parseCli(['--api-url', api.url], { BUILDIT_TOKEN: token, ...env });
    if (action.kind !== 'run') throw new Error('expected a run config');
    const config: Config = action.config;
    const toServer = new PassThrough();
    const fromServer = new PassThrough();
    handle = startStdio(config, quiet, { stdin: toServer, stdout: fromServer, now: () => now });
    client = new Client({ name: 'stdio-identity-test', version: '1.0.0' });
    await client.connect(new StdioServerTransport(fromServer, toServer));
    return client;
  }
  const names = async (c: Client): Promise<string[]> =>
    (await c.listTools()).tools.map((t) => t.name);

  it('lists the configured tools while rate limited, then retries /v1/me lazily', async () => {
    now = 0;
    rateLimitMe(30);
    const c = await start(TOKENS.read);
    expect(await names(c)).toEqual(DEFAULT_TOOLS);
    // A client that knows the tools can call them: no "not found".
    const found = await c.callTool({ name: 'search_items', arguments: { projects: ['DEMO'] } });
    expect(found.isError).toBeFalsy();
    const before = api.count('/v1/me');
    // Until the advised wait has passed, /v1/me is not read again.
    now += 10_000;
    expect(await names(c)).toEqual(DEFAULT_TOOLS);
    expect(api.count('/v1/me')).toBe(before);
    // Then the next list reads it, and narrows the list to the token's scopes.
    now += 20_000;
    expect(await names(c)).toEqual(READ_TOOLS);
    expect(api.count('/v1/me')).toBe(before + 1);
  });

  it('refreshes a known identity at most every 60 s, and after an auth error', async () => {
    now = 0;
    const c = await start(TOKENS.read);
    expect(await names(c)).toEqual(READ_TOOLS);
    expect(api.count('/v1/me')).toBe(1);
    now += IDENTITY_REFRESH_MS - 1;
    expect(await names(c)).toEqual(READ_TOOLS);
    await c.callTool({ name: 'search_items', arguments: {} });
    expect(api.count('/v1/me')).toBe(1);
    // Scopes changed meanwhile: seen on the first list after 60 s.
    api.identities[TOKENS.read] = sampleIdentity(['projects:write']);
    now += 1;
    expect(await names(c)).toEqual(DEFAULT_TOOLS);
    expect(api.count('/v1/me')).toBe(2);
    // An auth error asks for a new read right away.
    api.enqueueError('/v1/items', 'token_revoked', { revoked_at: '2026-10-07T15:00:00Z' });
    await c.callTool({ name: 'search_items', arguments: {} });
    forget(TOKENS.read);
    expect(await names(c)).toEqual(['whoami']);
    expect(api.count('/v1/me')).toBe(3);
  });

  it('does not keep a refusal forever: the next list or call asks again', async () => {
    now = 0;
    const token = 'buildit_pat_test_later_accepted';
    const c = await start(token);
    expect(await names(c)).toEqual(['whoami']);
    // The token works now (for example agent access was turned back on).
    api.identities[token] = sampleIdentity(['projects:read']);
    // A call to a tool that was hidden waits for the new read, then runs.
    const found = await c.callTool({ name: 'search_items', arguments: { projects: ['DEMO'] } });
    expect(found.isError).toBeFalsy();
    expect(await names(c)).toEqual(READ_TOOLS);
  });

  it('keeps the exclude list and toolsets when listing without scopes', async () => {
    now = 0;
    rateLimitMe();
    const c = await start(TOKENS.full, {
      BUILDIT_TOOLSETS: 'items',
      BUILDIT_EXCLUDE_TOOLS: 'create_item',
    });
    expect(await names(c)).toEqual(
      DEFAULT_TOOLS.filter((n) => !['create_item', 'add_comment', 'list_comments'].includes(n)),
    );
  });
});
