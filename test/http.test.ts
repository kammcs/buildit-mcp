import { request as httpRequest } from 'node:http';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { parseCli, type Config } from '../src/config.js';
import { createLogger } from '../src/log.js';
import { startHttp, type HttpServerHandle } from '../src/transports/http.js';
import { CHANNELS, FakeApi, sampleIdentity, TOKENS } from './support/fake-api.js';
import { TEST_CATALOG } from './support/test-tools.js';

let api: FakeApi;
let server: HttpServerHandle;
const logs: string[] = [];
const clients: Client[] = [];

function httpConfig(argv: string[] = [], env: Record<string, string> = {}): Config {
  const action = parseCli(['--http', '--port', '0', '--api-url', api.url, ...argv], env);
  if (action.kind !== 'run') throw new Error('expected a run config');
  return action.config;
}

beforeAll(async () => {
  api = await new FakeApi().start();
  server = await startHttp(
    httpConfig(['--toolsets', 'all']),
    createLogger({ level: 'debug', sink: (l) => logs.push(l) }),
    { catalog: TEST_CATALOG },
  );
});

afterAll(async () => {
  await server.close();
  await api.close();
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A raw request, so Host and Origin can be set freely. */
function raw(
  method: string,
  headers: Record<string, string>,
  body?: unknown,
  path = '/mcp',
): Promise<RawResponse> {
  const url = new URL(server.url);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        method,
        path,
        headers: {
          Accept: 'application/json, text/event-stream',
          ...(payload ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (data += c));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'raw-test', version: '1.0.0' },
  },
};

async function connect(
  token: string,
  options: { modern?: boolean; headers?: Record<string, string> } = {},
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, ...options.headers } },
  });
  const client = new Client(
    { name: 'http-test', version: '1.0.0' },
    options.modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  );
  await client.connect(transport);
  clients.push(client);
  return client;
}

const toolNames = async (client: Client): Promise<string[]> =>
  (await client.listTools()).tools.map((t) => t.name);

describe('HTTP mode: access checks', () => {
  it('answers 401 without a bearer token', async () => {
    const res = await raw('POST', {}, INITIALIZE);
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/^Bearer/);
    expect(JSON.parse(res.body)).toMatchObject({ jsonrpc: '2.0', error: { code: -32001 } });
  });

  it('answers 401 for a malformed Authorization header', async () => {
    for (const value of ['Basic abc', 'Bearer', `Bearer ${TOKENS.full} extra`]) {
      expect((await raw('POST', { Authorization: value }, INITIALIZE)).status).toBe(401);
    }
  });

  it('answers 403 for a foreign Origin, before checking the token', async () => {
    const withToken = await raw(
      'POST',
      { Authorization: `Bearer ${TOKENS.full}`, Origin: 'https://evil.example' },
      INITIALIZE,
    );
    expect(withToken.status).toBe(403);
    const withoutToken = await raw('POST', { Origin: 'https://evil.example' }, INITIALIZE);
    expect(withoutToken.status).toBe(403);
  });

  it('accepts a localhost Origin', async () => {
    const res = await raw(
      'POST',
      { Authorization: `Bearer ${TOKENS.full}`, Origin: 'http://localhost:6274' },
      INITIALIZE,
    );
    expect(res.status).toBe(200);
  });

  it('answers 403 for a foreign Host (DNS rebinding)', async () => {
    const res = await raw(
      'POST',
      { Authorization: `Bearer ${TOKENS.full}`, Host: 'attacker.example:8765' },
      INITIALIZE,
    );
    expect(res.status).toBe(403);
  });

  it('answers 405 to GET and DELETE', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await raw(method, { Authorization: `Bearer ${TOKENS.full}` });
      expect(res.status).toBe(405);
      expect(res.headers.allow).toBe('POST');
    }
  });

  it('answers 400 for an unknown toolset in X-Buildit-Toolsets', async () => {
    const res = await raw(
      'POST',
      { Authorization: `Bearer ${TOKENS.full}`, 'X-Buildit-Toolsets': 'items,wiki' },
      INITIALIZE,
    );
    expect(res.status).toBe(400);
    expect(res.body).toContain('wiki');
  });

  it('answers 400 for a body that is not JSON', async () => {
    const res = await raw('POST', {
      Authorization: `Bearer ${TOKENS.full}`,
      'Content-Type': 'application/json',
    });
    expect(res.status).toBe(400);
  });

  it('serves a health check without a token', async () => {
    const res = await raw('GET', {}, undefined, '/healthz');
    expect(res.status).toBe(200);
  });
});

describe('HTTP mode: tools per request', () => {
  it('lists the tools the token scopes allow (2025-11-25 client)', async () => {
    const client = await connect(TOKENS.read);
    expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
    expect(await toolNames(client)).toEqual(['search_items', 'whoami', 'list_comments']);
  });

  it('serves a 2026-07-28 client statelessly', async () => {
    const client = await connect(TOKENS.full, { modern: true });
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    expect(await toolNames(client)).toEqual([
      'create_item',
      'search_items',
      'whoami',
      'add_comment',
      'list_comments',
      'read_channel',
      'propose_delete_item',
    ]);
    const result = await client.callTool({ name: 'whoami', arguments: {} });
    expect(result.structuredContent).toMatchObject({
      scopes: expect.arrayContaining(['chat:read']) as unknown,
    });
    expect(client.getInstructions()).toContain('apply_plan');
  });

  it('uses each request token for its own API calls', async () => {
    api.requests.length = 0;
    const reader = await connect(TOKENS.read);
    const writer = await connect(TOKENS.full);
    const [a, b] = await Promise.all([
      reader.callTool({ name: 'whoami', arguments: {} }),
      writer.callTool({ name: 'whoami', arguments: {} }),
    ]);
    expect(a.structuredContent).toMatchObject({ scopes: ['projects:read'] });
    expect((b.structuredContent as { scopes: string[] }).scopes).toContain('projects:write');
    const used = new Set(api.requests.map((r) => r.headers.authorization));
    expect(used).toEqual(new Set([`Bearer ${TOKENS.read}`, `Bearer ${TOKENS.full}`]));
  });

  it('narrows toolsets with the X-Buildit-Toolsets header', async () => {
    const client = await connect(TOKENS.full, { headers: { 'X-Buildit-Toolsets': 'comments' } });
    expect(await toolNames(client)).toEqual(['add_comment', 'list_comments']);
  });

  it('lists only whoami when the API refuses the token, and whoami says why', async () => {
    const client = await connect(TOKENS.unknown, { modern: true });
    expect(await toolNames(client)).toEqual(['whoami']);
    const result = await client.callTool({ name: 'whoami', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('token_invalid');
  });

  it('applies read-only mode and the exclude list from the server config', async () => {
    const strict = await startHttp(
      httpConfig(['--toolsets', 'all', '--read-only'], { BUILDIT_EXCLUDE_TOOLS: 'list_comments' }),
      createLogger({ sink: () => undefined }),
      { catalog: TEST_CATALOG },
    );
    try {
      const transport = new StreamableHTTPClientTransport(new URL(strict.url), {
        requestInit: { headers: { Authorization: `Bearer ${TOKENS.full}` } },
      });
      const client = new Client({ name: 'http-test', version: '1.0.0' });
      await client.connect(transport);
      expect(await toolNames(client)).toEqual(['search_items', 'whoami', 'read_channel']);
      // The header can choose toolsets but can't lift read-only mode.
      await expect(client.callTool({ name: 'create_item', arguments: {} })).rejects.toThrow();
      await client.close();
    } finally {
      await strict.close();
    }
  });
});

describe('HTTP mode: the real tools', () => {
  it('lists the item and comment tools per token, and serves them', async () => {
    const real = await startHttp(httpConfig(), createLogger({ sink: () => undefined }));
    const open = async (token: string, modern: boolean): Promise<Client> => {
      const transport = new StreamableHTTPClientTransport(new URL(real.url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      });
      const client = new Client(
        { name: 'http-test', version: '1.0.0' },
        modern ? { versionNegotiation: { mode: 'auto' } } : {},
      );
      await client.connect(transport);
      return client;
    };
    try {
      const reader = await open(TOKENS.read, false);
      expect(await toolNames(reader)).toEqual([
        'describe_project',
        'find_users',
        'get_item',
        'list_projects',
        'search_items',
        'whoami',
        'list_comments',
      ]);
      const item = await reader.callTool({ name: 'get_item', arguments: { item: 'DEMO-42' } });
      expect(item.structuredContent).toMatchObject({ item: { key: 'DEMO-42' } });
      await reader.close();

      const writer = await open(TOKENS.full, true);
      const names = await toolNames(writer);
      expect(names).toHaveLength(15);
      expect(names).toContain('transition_item');
      expect(names).toContain('unlink_items');
      expect(names.some((n) => n.startsWith('propose_'))).toBe(false);
      const moved = await writer.callTool({
        name: 'transition_item',
        arguments: { item: 'DEMO-43', status: 'In progress' },
      });
      expect(moved.structuredContent).toMatchObject({ item: { status: 'In progress' } });
      await writer.close();
      expect(api.violations).toEqual([]);
    } finally {
      await real.close();
    }
  });
});

describe('HTTP mode: every toolset', () => {
  it('lists the right tools per toolset header, and applies a plan across requests', async () => {
    const real = await startHttp(httpConfig(), createLogger({ sink: () => undefined }));
    const open = async (token: string, toolsets: string, modern: boolean): Promise<Client> => {
      const transport = new StreamableHTTPClientTransport(new URL(real.url), {
        requestInit: {
          headers: { Authorization: `Bearer ${token}`, 'X-Buildit-Toolsets': toolsets },
        },
      });
      const client = new Client(
        { name: 'http-test', version: '1.0.0' },
        modern ? { versionNegotiation: { mode: 'auto' } } : {},
      );
      await client.connect(transport);
      clients.push(client);
      return client;
    };
    try {
      const all = await open(TOKENS.full, 'all', true);
      expect(await toolNames(all)).toHaveLength(40);
      expect(all.getInstructions()).toContain('apply_plan');
      const templates = (await all.listResourceTemplates()).resourceTemplates;
      expect(templates.map((t) => t.uriTemplate)).toEqual([
        'buildit://items/{key}',
        'buildit://pages/{id}',
      ]);
      expect((await all.listPrompts()).prompts.map((p) => p.name)).toEqual([
        'plan_epic',
        'triage',
        'standup',
      ]);

      const perToolset: Record<string, string[]> = {
        planning: [
          'list_releases',
          'list_sprints',
          'plan_release',
          'plan_sprint',
          'write_release_notes',
        ],
        pages: ['create_page', 'get_page', 'list_pages', 'update_page'],
        chat: ['list_channels', 'read_channel', 'read_thread'],
        admin: [
          'create_channel',
          'create_project',
          'get_workflow',
          'list_work_types',
          'propose_field_change',
          'propose_label_change',
          'propose_work_type_change',
          'propose_workflow_change',
          'apply_plan',
        ],
        destructive: [
          'apply_plan',
          'propose_archive_status',
          'propose_bulk_update',
          'propose_delete_item',
          'propose_move_item',
        ],
      };
      for (const [toolset, expected] of Object.entries(perToolset)) {
        const c = await open(TOKENS.full, toolset, false);
        expect(await toolNames(c), toolset).toEqual(expected);
      }
      // A token limited to some channels doesn't see the tools that create them (cached as such).
      const limited = 'buildit_pat_test_http_limited';
      api.identities[limited] = sampleIdentity(['projects:admin']);
      api.identities[limited].token.limits.channels = [{ id: CHANNELS.general, name: 'general' }];
      for (let i = 0; i < 2; i++) {
        const c = await open(limited, 'admin', false);
        expect(await toolNames(c)).toEqual(perToolset.admin?.slice(2));
      }
      // A reader sees no planning writes and nothing of the other toolsets.
      const reader = await open(TOKENS.read, 'all', false);
      expect(await toolNames(reader)).toEqual([
        'describe_project',
        'find_users',
        'get_item',
        'list_projects',
        'search_items',
        'whoami',
        'list_comments',
        'list_releases',
        'list_sprints',
      ]);
      expect((await reader.listPrompts()).prompts.map((p) => p.name)).toEqual(['standup']);

      // Stateless: the plan is proposed in one request and applied in another.
      const deleter = await open(TOKENS.full, 'destructive', true);
      const proposed = await deleter.callTool({
        name: 'propose_delete_item',
        arguments: { item: 'DEMO-43' },
      });
      const handle = (proposed.structuredContent as { handle: string }).handle;
      expect(api.store.items.some((i) => i.number === 43)).toBe(true);
      const applied = await deleter.callTool({ name: 'apply_plan', arguments: { handle } });
      expect(applied.isError).toBeFalsy();
      expect(api.store.items.some((i) => i.project === 'DEMO' && i.number === 43)).toBe(false);
      const item = await all.readResource({ uri: 'buildit://items/DEMO-42' });
      expect(JSON.stringify(item.contents)).toContain('DEMO-42');
      expect(api.violations).toEqual([]);
    } finally {
      await Promise.all(clients.splice(0).map((c) => c.close()));
      await real.close();
      api.reset();
    }
  });
});

describe('HTTP mode: logs', () => {
  it('never contain a token', () => {
    // Every request above carried a token; some failed. None may appear in the logs.
    const all = logs.join('\n');
    expect(logs.length).toBeGreaterThan(10);
    for (const token of Object.values(TOKENS)) expect(all).not.toContain(token);
    expect(all).not.toMatch(/Bearer\s+buildit/);
    // Each line is JSON.
    for (const line of logs) expect(() => JSON.parse(line) as unknown).not.toThrow();
  });
});
