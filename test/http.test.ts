import { request as httpRequest } from 'node:http';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { parseCli, type Config } from '../src/config.js';
import { createLogger } from '../src/log.js';
import { startHttp, type HttpServerHandle } from '../src/transports/http.js';
import { FakeApi, TOKENS } from './support/fake-api.js';
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
    expect(JSON.stringify(result.content)).toContain('unauthorized');
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
