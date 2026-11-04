/**
 * Requests on Codex: a Codex thread per request (read-only, ephemeral, no
 * shell, the person's plugins off), the request worker's instructions,
 * the lead line, and `buildit-requests` with the kind's skill as skill
 * inputs from the plugin's own files; results where the request says (a
 * catch-up in the direct message, triage in each item's thread), nothing
 * else posted; requests counting toward the slots, with the queued line in
 * the direct message; a kind this version can't take noticed without a
 * turn; and the codex command connecting as Codex.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  PLUGINS_OFF,
  REQUEST_DEVELOPER_INSTRUCTIONS,
  REQUEST_THREAD_CONFIG,
  REQUESTS_NOTICE,
} from '../src/codex/bridge.js';
import { requestPlace } from '../src/codex/router.js';
import { CodexBench, waitFor } from './support/codex-run.js';
import { FakeApi } from './support/fake-api.js';
import type { TurnContext } from './support/fake-codex.js';
import { demoItem, SESSION_TOKENS } from './support/fake-sessions.js';

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
const session = () => api.sessions.session(token);
const posts = () => session().messages;
type Json = Record<string, unknown>;
const texts = (input: unknown): string[] =>
  (input as Json[]).filter((i) => i.type === 'text').map((i) => String(i.text));

describe('codex requests: a thread per request', () => {
  it('runs a catch-up in a read-only thread with its skills, and posts only its result, in the DM', async () => {
    const s = api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    let ctxSeen: TurnContext | undefined;
    codex.onTurn = async (ctx) => {
      ctxSeen = ctx;
      const client = await codex.mcp(ctx.threadId);
      const lead = texts(ctx.inputs[0])[0] ?? '';
      const id = /request="([0-9a-f-]{36})"/.exec(lead)?.[1] ?? '';
      await client.callTool({
        name: 'reply',
        arguments: { text: 'Nothing much happened.', request: id },
      });
      ctx.agentMessage('Posted the catch-up in the DM.', 'final_answer');
      ctx.complete();
    };
    const r = await bench.start(codex);
    await waitFor(() => s.heartbeats.includes('online'));
    const { requestId } = api.sessions.pushRequest(token, { kind: 'catch_up' });
    await waitFor(() => posts().length === 1);
    await waitFor(() => codex.requests('thread/unsubscribe').length === 1);
    const start = codex.requests('thread/start')[0]!;
    expect(start).toMatchObject({
      ephemeral: true,
      sandbox: 'read-only',
      developerInstructions: REQUEST_DEVELOPER_INSTRUCTIONS,
      cwd: bench.folder,
    });
    expect(start.config).toMatchObject({ ...PLUGINS_OFF, ...REQUEST_THREAD_CONFIG });
    expect(start.config).toHaveProperty(['mcp_servers.buildit']);
    const input = codex.requests('turn/start')[0]!.input as Json[];
    expect(texts(input)[0]).toContain('Use the buildit-catch-up skill.');
    const skills = input.filter((i) => i.type === 'skill');
    expect(skills.map((i) => i.name)).toEqual([
      'buildit:buildit-requests',
      'buildit:buildit-catch-up',
    ]);
    for (const sk of skills) expect(String(sk.path)).toMatch(/plugin[\\/]skills[\\/].+SKILL\.md$/);
    // The result only: in the direct message, with its request; the final answer isn't posted.
    expect(posts()[0]).toMatchObject({ text: 'Nothing much happened.', thread_id: null });
    expect(api.sessions.requestPosts).toEqual([{ token, request: requestId, thread_id: null }]);
    await r.bridge().idle();
    expect(posts()).toHaveLength(1);
    // The conversation ended with its turn: unsubscribed, and gone.
    expect(codex.requests('thread/unsubscribe')[0]!.threadId).toBe(ctxSeen!.threadId);
    expect(
      r
        .bridge()
        .places()
        .map((p) => p.key),
    ).not.toContain(requestPlace(requestId));
    expect(codex.requests('thread/resume')).toHaveLength(0);
  });

  it("posts a triage's results in each item's own thread", async () => {
    const s = api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    const one = demoItem(12);
    const two = demoItem(13);
    codex.onTurn = async (ctx) => {
      const client = await codex.mcp(ctx.threadId);
      const lead = texts(ctx.inputs[0])[0] ?? '';
      const id = /request="([0-9a-f-]{36})"/.exec(lead)?.[1] ?? '';
      for (const key of ['DEMO-12', 'DEMO-13']) {
        await client.callTool({
          name: 'reply',
          arguments: { text: `No duplicates for ${key}.`, request: id, item: key },
        });
      }
      ctx.agentMessage('done', 'final_answer');
      ctx.complete();
    };
    await bench.start(codex);
    await waitFor(() => s.heartbeats.includes('online'));
    api.sessions.pushRequest(token, {
      kind: 'triage',
      place: 'item_thread',
      context: {
        type: 'items',
        items: [
          { id: one.id, key: one.key },
          { id: two.id, key: two.key },
        ],
      },
    });
    await waitFor(() => posts().length === 2);
    expect(posts().map((m) => [m.thread_id, m.text])).toEqual([
      [one.id, 'No duplicates for DEMO-12.'],
      [two.id, 'No duplicates for DEMO-13.'],
    ]);
    const input = codex.requests('turn/start')[0]!.input as Json[];
    expect(input.filter((i) => i.type === 'skill').map((i) => i.name)).toContain(
      'buildit:buildit-triage',
    );
  });

  it('counts requests toward the slots, with the queued line in the direct message', async () => {
    const s = api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    let releaseItem!: () => void;
    const itemDone = new Promise<void>((r) => (releaseItem = r));
    codex.onTurn = async (ctx) => {
      if (texts(ctx.inputs[0])[0]?.includes('DEMO-1') === true) await itemDone;
      ctx.agentMessage('ok', 'final_answer');
      ctx.complete();
    };
    await bench.start(codex, {
      ask: { questionsInApp: true, timeoutMinutes: 60, maxParallelItems: 1 },
    });
    await waitFor(() => s.heartbeats.includes('online'));
    const dm = api.sessions.postFrom(token, 'Hello');
    await waitFor(() => posts().some((m) => m.thread_id === dm && m.text === 'ok'));
    api.sessions.assignItem(token, demoItem(1));
    await waitFor(() => codex.requests('turn/start').length === 2);
    api.sessions.pushRequest(token, { kind: 'catch_up' });
    await waitFor(() => posts().some((m) => m.text.startsWith('Queued')));
    const line = posts().find((m) => m.text.startsWith('Queued'))!;
    // In the direct message's latest thread, naming what runs.
    expect(line).toMatchObject({ text: "Queued — I'll start this after DEMO-1.", thread_id: dm });
    expect(codex.requests('turn/start')).toHaveLength(2);
    releaseItem();
    await waitFor(() => codex.requests('turn/start').length === 3);
    expect(texts(codex.requests('turn/start')[2]!.input)[0]).toContain('catch-up');
  });

  it("tells the owner once when a kind is one this version can't take, with no turn", async () => {
    const s = api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    const r = await bench.start(codex);
    await waitFor(() => s.heartbeats.includes('online'));
    for (const id of [
      '00000000-0000-4000-8000-00000000a001',
      '00000000-0000-4000-8000-00000000a002',
    ]) {
      await r.bridge().handle({
        content: 'x',
        meta: { event: 'request', kind: 'future_kind', request_id: id, result: 'dm' },
      });
    }
    await waitFor(() => posts().length === 1);
    expect(posts()[0]).toMatchObject({ text: REQUESTS_NOTICE, thread_id: null });
    expect(codex.requests('turn/start')).toHaveLength(0);
  });
});
