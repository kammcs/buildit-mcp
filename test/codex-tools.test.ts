/**
 * The Codex bridge's hosted tools: buildit's tools served to the Codex
 * child over loopback Streamable HTTP, with a per-run secret and a URL per
 * Codex thread. The fake app-server connects as Codex does, from each
 * thread's config and the environment the bridge started it with.
 */
import { request as httpRequest } from 'node:http';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ApiClient } from '../src/api/client.js';
import { getSession } from '../src/channel/api.js';
import { ChannelState } from '../src/channel/loop.js';
import {
  BRIDGE_SECRET_ENV,
  BridgeToolServer,
  bridgeChannelTools,
  hasSecret,
} from '../src/codex/tool-server.js';
import { createLogger } from '../src/log.js';
import { CodexBench, waitFor } from './support/codex-run.js';
import { FakeApi } from './support/fake-api.js';
import { CodexHome } from './support/fake-codex.js';
import { SESSION_TOKENS } from './support/fake-sessions.js';

let api: FakeApi;
let bench: CodexBench;

beforeAll(async () => {
  api = await new FakeApi().start();
});
afterAll(async () => {
  await api.close();
});
beforeEach(() => {
  api.reset();
  bench = new CodexBench(api);
});
afterEach(async () => {
  expect(await bench.cleanup()).toEqual([]);
  expect(api.violations).toEqual([]);
});

const token = SESSION_TOKENS.first;
const posts = () => api.sessions.session(token).messages;
type Entry = {
  url: string;
  bearer_token_env_var: string;
  default_tools_approval_mode: string;
  tool_timeout_sec: number;
};
const entryOf = (config: unknown): Entry =>
  (config as Record<string, unknown>)['mcp_servers.buildit'] as Entry;

const ask = { questionsInApp: true, hookWaitS: 60 };

describe('codex bridge: the hosted tools', () => {
  it('gives each thread its own loopback endpoint, and the secret only in the environment', async () => {
    api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    const r = await bench.start(codex);
    api.sessions.postFrom(token, 'Hello');
    await waitFor(() => posts().length === 1);
    const config = codex.requests('thread/start')[0]!.config;
    const entry = entryOf(config);
    expect(entry.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[A-Za-z0-9_-]{20,}$/);
    expect(entry).toMatchObject({
      bearer_token_env_var: BRIDGE_SECRET_ENV,
      default_tools_approval_mode: 'approve',
      tool_timeout_sec: 3600,
    });
    const secret = codex.env[BRIDGE_SECRET_ENV]!;
    expect(secret.length).toBeGreaterThanOrEqual(32);
    // Never on the command line, in the thread's config or in a log.
    expect(codex.args?.join(' ')).not.toContain(secret);
    expect(JSON.stringify(config)).not.toContain(secret);
    expect(r.logs.join('\n')).not.toContain(secret);
  });

  it('lists the catalog and the channel tools, never the plugin hooks', async () => {
    api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    let names: string[] = [];
    codex.onTurn = async (ctx) => {
      const client = await codex.mcp(ctx.threadId);
      names = (await client.listTools()).tools.map((t) => t.name);
      ctx.agentMessage('ok', 'final_answer');
      ctx.complete();
    };
    await bench.start(codex);
    api.sessions.postFrom(token, 'List your tools');
    await waitFor(() => posts().length === 1);
    expect(names).toEqual(
      expect.arrayContaining(['whoami', 'get_item', 'reply', 'ask', 'list_threads']),
    );
    for (const hook of ['approve', 'tool_seen', 'tool_done', 'agent_done', 'prompt_typed']) {
      expect(names).not.toContain(hook);
    }
    expect(names).not.toContain('turn_ended');
  });

  it("posts a reply in the calling turn's thread, and doesn't post the final answer again", async () => {
    api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    let whoami = '';
    codex.onTurn = async (ctx) => {
      const client = await codex.mcp(ctx.threadId);
      const who = await client.callTool({ name: 'whoami', arguments: {} });
      whoami = JSON.stringify(who.structuredContent ?? {});
      const sent = await client.callTool({ name: 'reply', arguments: { text: 'From the tool.' } });
      expect(sent.isError).not.toBe(true);
      ctx.agentMessage('The same, as the final answer.', 'final_answer');
      ctx.complete();
    };
    const r = await bench.start(codex);
    const thread = api.sessions.postFrom(token, 'Answer with the reply tool');
    await waitFor(() => posts().length === 1);
    await r.bridge().idle();
    expect(posts()).toHaveLength(1);
    expect(posts()[0]).toMatchObject({ text: 'From the tool.', thread_id: thread });
    expect(whoami).toContain('scopes');
  });

  it('gives a resumed thread a fresh endpoint after a restart', async () => {
    api.sessions.open(token, 'demo-folder');
    const home = new CodexHome();
    const first = bench.fake({}, home);
    const r1 = await bench.start(first);
    api.sessions.postFrom(token, 'One');
    await waitFor(() => posts().length === 1);
    const before = entryOf(first.requests('thread/start')[0]!.config).url;
    await r1.stop();

    const second = bench.fake({}, home);
    await bench.start(second);
    api.sessions.postFrom(token, 'Two');
    await waitFor(() => posts().length === 2);
    const resumed = second.requests('thread/resume')[0]!;
    const after = entryOf(resumed.config).url;
    expect(after).not.toBe(before);
    expect(second.env[BRIDGE_SECRET_ENV]).not.toBe(first.env[BRIDGE_SECRET_ENV]);
  });
});

describe('codex bridge: the endpoint', () => {
  let server: BridgeToolServer;
  let state: ChannelState;
  let client: ApiClient;

  beforeEach(async () => {
    api.sessions.open(token, 'demo-folder');
    client = new ApiClient({ baseUrl: api.url, token, logger: createLogger({ level: 'error' }) });
    state = new ChannelState();
    state.folder = bench.folder;
    state.session = await getSession(client);
    server = new BridgeToolServer({
      api: client,
      state,
      logger: createLogger({ level: 'error' }),
      ask,
    });
    await server.start();
  });
  afterEach(async () => {
    await server.close();
  });

  const call = (url: string, headers: Record<string, string>, method = 'POST') =>
    fetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      ...(method === 'POST'
        ? {
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'initialize',
              params: {
                protocolVersion: '2025-06-18',
                capabilities: {},
                clientInfo: { name: 'test', version: '1.0.0' },
              },
            }),
          }
        : {}),
    });

  it('refuses a call without the secret or with another one, and says nothing of the paths', async () => {
    const url = server.urlFor('dm');
    const none = await call(url, {});
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toMatch(/^Bearer/);
    const wrong = await call(url, { authorization: `Bearer ${'x'.repeat(server.secret.length)}` });
    expect(wrong.status).toBe(401);
    const other = await call(url.replace(/\/mcp\/.*/, '/mcp/nobody-was-given-this-path'), {});
    expect(other.status).toBe(401);
    const ok = await call(url, { authorization: `Bearer ${server.secret}` });
    expect(ok.status).toBe(200);
  });

  it('answers 404 on a path no thread was given, and 405 to anything but POST', async () => {
    const auth = { authorization: `Bearer ${server.secret}` };
    const url = server.urlFor('dm');
    expect(
      (await call(url.replace(/\/mcp\/.*/, '/mcp/abcdefghijklmnopqrstuvwx'), auth)).status,
    ).toBe(404);
    expect((await call(url.replace(/\/mcp\/.*/, '/elsewhere'), auth)).status).toBe(404);
    expect((await call(url, auth, 'GET')).status).toBe(405);
  });

  it('refuses a Host that is not a loopback name', async () => {
    const url = new URL(server.urlFor('dm'));
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            host: 'attacker.example.com',
            authorization: `Bearer ${server.secret}`,
            'content-type': 'application/json',
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end('{}');
    });
    expect(status).toBe(403);
  });

  it("routes each thread's calls by its path: reply goes to that place's own thread", async () => {
    const t1 = api.sessions.postFrom(token, 'First conversation');
    const t2 = api.sessions.postFrom(token, 'Second conversation');
    const threads: Record<string, string> = { one: t1, two: t2 };
    server.attachThreads((place) => threads[place]);
    const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
    const open = async (place: string) => {
      const c = new Client({ name: 'codex', version: '0.166.0' });
      await c.connect(
        new StreamableHTTPClientTransport(new URL(server.urlFor(place)), {
          requestInit: { headers: { Authorization: `Bearer ${server.secret}` } },
        }),
      );
      return c;
    };
    const one = await open('one');
    const two = await open('two');
    await two.callTool({ name: 'reply', arguments: { text: 'to two' } });
    await one.callTool({ name: 'reply', arguments: { text: 'to one' } });
    const sent = posts().map((m) => ({ text: m.text, thread_id: m.thread_id }));
    expect(sent).toEqual([
      { text: 'to two', thread_id: t2 },
      { text: 'to one', thread_id: t1 },
    ]);
    // A thread named in the arguments still wins (as in channel mode).
    await one.callTool({ name: 'reply', arguments: { text: 'named', thread_id: t2 } });
    expect(posts().at(-1)).toMatchObject({ text: 'named', thread_id: t2 });
    await one.close();
    await two.close();
  });

  it('makes one token per place, and a different one for each place', () => {
    expect(server.tokenFor('a')).toBe(server.tokenFor('a'));
    expect(server.tokenFor('a')).not.toBe(server.tokenFor('b'));
  });

  it('serves no hook tools', () => {
    const names = bridgeChannelTools(state, ask).map((t) => t.name);
    expect(names).not.toContain('approve');
    expect(names).not.toContain('turn_ended');
    expect(names).toContain('reply');
    // The channel tools a session's work needs, as in channel mode.
    for (const name of ['propose_assignment', 'propose_handoff', 'report_to_assigner']) {
      expect(names).toContain(name);
    }
  });
});

describe('hasSecret', () => {
  it('takes only the exact bearer secret', () => {
    expect(hasSecret('Bearer abc', 'abc')).toBe(true);
    expect(hasSecret('bearer   abc ', 'abc')).toBe(true);
    expect(hasSecret('Bearer abcd', 'abc')).toBe(false);
    expect(hasSecret('Basic abc', 'abc')).toBe(false);
    expect(hasSecret(undefined, 'abc')).toBe(false);
    expect(hasSecret('Bearer ', 'abc')).toBe(false);
  });
});
