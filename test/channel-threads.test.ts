/**
 * Several threads at once (the lead and its item workers), end to end in
 * process: an explicit thread once more than one is active, list_threads,
 * "is writing" per item thread, and the lead's instructions.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { CallToolResult } from '@modelcontextprotocol/client';

import { buildInstructions, ITEM_WORKER_AGENT } from '../src/server.js';
import { uuidV5 } from '../src/tools/ask.js';
import {
  channelConfig,
  channelNotes,
  startChannel,
  waitFor,
  type ChannelClient,
} from './support/channel-harness.js';
import { FakeApi } from './support/fake-api.js';
import { demoItem, SESSION_IDS, SESSION_TOKENS } from './support/fake-sessions.js';
import { HOSTILE, injectionIsInsideBlocks } from './support/harness.js';

const TOKEN = SESSION_TOKENS.first;

let api: FakeApi;
const stops: (() => Promise<void>)[] = [];

beforeAll(async () => {
  api = await new FakeApi().start();
});
afterAll(async () => {
  await api.close();
});
beforeEach(() => {
  api.reset();
});
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
  expect(api.violations).toEqual([]);
});

const session = () => api.sessions.session(TOKEN);
const textOf = (r: CallToolResult): string =>
  (r.content as { type: string; text: string }[]).map((c) => c.text).join('\n');

async function start(env: Record<string, string> = {}): Promise<ChannelClient> {
  api.sessions.open(TOKEN);
  const c = await startChannel(api, stops, {
    config: channelConfig(api, env),
    stdio: { ask: { msPerSecond: 10 }, typing: { everyMs: 60_000 } },
  });
  await waitFor(() => session().heartbeats.includes('online'));
  return c;
}

async function notes(c: ChannelClient, n: number) {
  await waitFor(() => channelNotes(c.notes).length >= n);
  return channelNotes(c.notes);
}

const one = demoItem(12, { title: 'Fix the login redirect' });
const two = demoItem(13, { title: 'Export reports as CSV' });

describe('several threads at once', () => {
  it('keeps the default with one thread, and asks for a thread with two', async () => {
    const c = await start();
    api.sessions.assignItem(TOKEN, one);
    await notes(c, 1);
    // One thread: reply goes there by default.
    const first = await c.client.callTool({ name: 'reply', arguments: { text: 'Started.' } });
    expect(first.structuredContent).toMatchObject({ message: { thread_id: one.id } });

    api.sessions.assignItem(TOKEN, two);
    const dm = api.sessions.postFrom(TOKEN, 'How is it going?');
    await notes(c, 3);
    const posted = session().messages.length;
    const r = await c.client.callTool({ name: 'reply', arguments: { text: 'Fine.' } });
    expect(r.isError).toBe(true);
    const why = textOf(r);
    expect(why).toContain('works in several threads now, so reply needs thread_id or item');
    expect(why).toContain(`DEMO-12 (thread_id ${one.id})`);
    expect(why).toContain(`DEMO-13 (thread_id ${two.id})`);
    expect(why).toContain(`your direct message (thread_id ${dm})`);
    expect(session().messages).toHaveLength(posted);

    // Named, each goes where it says.
    const inTwo = await c.client.callTool({
      name: 'reply',
      arguments: { text: 'On it.', item: 'DEMO-13' },
    });
    expect(inTwo.structuredContent).toMatchObject({ message: { thread_id: two.id } });
    const inDm = await c.client.callTool({
      name: 'reply',
      arguments: { text: 'Fine.', thread_id: dm },
    });
    expect(inDm.structuredContent).toMatchObject({
      message: { thread_id: dm, conversation_id: SESSION_IDS.dm },
    });

    // Taken off both items: the direct message is the only thread again.
    api.sessions.unassignItem(TOKEN, one);
    api.sessions.unassignItem(TOKEN, two);
    await notes(c, 5);
    const back = await c.client.callTool({ name: 'reply', arguments: { text: 'Done.' } });
    expect(back.isError).toBeFalsy();
  });

  it('asks for a thread in ask too; the hook is told to use the tool', async () => {
    const c = await start();
    api.sessions.assignItem(TOKEN, one);
    api.sessions.assignItem(TOKEN, two);
    await notes(c, 2);
    const questions = [
      { question: 'Which?', header: 'Pick', options: [{ label: 'A' }, { label: 'B' }] },
    ];
    const tool = await c.client.callTool({ name: 'ask', arguments: { questions } });
    expect(tool.isError).toBe(true);
    expect(textOf(tool)).toContain('so ask needs thread_id or item');
    const hook = await c.client.callTool({
      name: 'ask',
      arguments: { questions: JSON.stringify(questions), tool_use_id: 'toolu_1', format: 'hook' },
    });
    const out = JSON.parse(textOf(hook)) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('Ask with the ask tool');
    expect(session().cards.size).toBe(0);

    // With the item named, the card goes to its thread.
    const asking = c.client.callTool({ name: 'ask', arguments: { questions, item: 'DEMO-13' } });
    await waitFor(() => session().cards.size === 1);
    expect([...session().cards.values()][0]?.threadId).toBe(two.id);
    api.sessions.unassignItem(TOKEN, two);
    expect((await asking).structuredContent).toMatchObject({ status: 'no_answer' });
  });

  it("puts an approval card in the thread named, and makes no plan when it can't tell", async () => {
    api.identities[TOKEN]!.token.scopes = ['projects:write', 'projects:delete', 'chat:read'];
    const c = await start({ BUILDIT_TOOLSETS: 'items,destructive' });
    api.sessions.assignItem(TOKEN, one);
    api.sessions.assignItem(TOKEN, two);
    await notes(c, 2);
    const plans = api.store.plans.length;
    const refused = await c.client.callTool({
      name: 'propose_delete_item',
      arguments: { item: 'DEMO-42' },
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('needs card_thread');
    expect(api.store.plans).toHaveLength(plans);

    const r = await c.client.callTool({
      name: 'propose_delete_item',
      arguments: { item: 'DEMO-42', card_thread: 'DEMO-12' },
    });
    expect(r.isError).toBeFalsy();
    const handle = (r.structuredContent as { handle: string }).handle;
    expect(session().cards.get(uuidV5(`plan:${handle}`))).toMatchObject({
      kind: 'plan',
      threadId: one.id,
    });
  });
});

describe('list_threads', () => {
  it("lists the session's threads, titles as data, and knows them after a restart", async () => {
    const c = await start();
    api.sessions.assignItem(TOKEN, demoItem(14, { title: HOSTILE }));
    api.sessions.assignItem(TOKEN, one);
    const dm = api.sessions.postFrom(TOKEN, 'Hello');
    await notes(c, 3);
    await c.close();

    // A fresh server knows no thread until it asks.
    const again = await startChannel(api, stops, {
      config: channelConfig(api),
      stdio: { typing: { everyMs: 60_000 } },
    });
    const r = await again.client.callTool({ name: 'list_threads', arguments: {} });
    expect(r.isError).toBeFalsy();
    const text = textOf(r);
    expect(text).toContain('This session works in 3 threads, newest activity first:');
    expect(text).toContain(`DEMO-12 · To do · thread_id ${one.id} · 0 open cards`);
    expect(text).toContain(`your direct message · thread_id ${dm}`);
    expect(injectionIsInsideBlocks(text)).toBe(true);
    expect(r.structuredContent).toMatchObject({
      threads: [
        { kind: 'item', item: { key: 'DEMO-12', title: 'Fix the login redirect' } },
        { kind: 'item', item: { key: 'DEMO-14' } },
        { kind: 'dm', item: null, thread_id: dm },
      ],
    });
    const reply = await again.client.callTool({ name: 'reply', arguments: { text: 'Hi' } });
    expect(reply.isError).toBe(true);
    expect(textOf(reply)).toContain('works in several threads now');
  });
});

describe('"is writing" per item thread', () => {
  it('shows it again while a worker works on its item, and only there', async () => {
    const c = await start();
    api.sessions.assignItem(TOKEN, one);
    api.sessions.assignItem(TOKEN, two);
    await notes(c, 2);
    const typings = (id: string) => session().typings.filter((t) => t.thread_id === id);
    await waitFor(() => typings(one.id).length === 1 && typings(two.id).length === 1);
    await c.client.callTool({ name: 'reply', arguments: { text: 'Progress.', item: 'DEMO-12' } });
    await waitFor(() => typings(one.id).at(-1)?.typing === false);
    // The worker goes on with its item: its thread shows it again; the other is untouched.
    await c.client.callTool({ name: 'get_item', arguments: { item: 'DEMO-12' } });
    await waitFor(() => typings(one.id).at(-1)?.typing === true);
    expect(typings(two.id)).toHaveLength(1);
  });
});

describe("the lead's instructions", () => {
  it('come with the plugin, with the limit; every channel server asks for explicit threads', () => {
    const lead = buildInstructions([], true, { maxParallelItems: 2 });
    expect(lead).toContain(ITEM_WORKER_AGENT);
    expect(lead).toContain('At most 2 workers run at once');
    expect(lead).toContain('"Queued — I\'ll start this after');
    expect(lead).toContain('you do no item work yourself');
    const plain = buildInstructions([], true);
    expect(plain).not.toContain(ITEM_WORKER_AGENT);
    expect(plain).toContain('must name its thread');
    expect(buildInstructions([], false)).not.toContain('must name its thread');
  });

  it('reach Claude from a plugin server, with its setting', async () => {
    api.sessions.open(TOKEN);
    const c = await startChannel(api, stops, {
      config: channelConfig(api, {
        CLAUDE_PLUGIN_ROOT: '/plugins/buildit',
        BUILDIT_MAX_PARALLEL_ITEMS: '4',
      }),
    });
    expect(c.client.getInstructions()).toContain('At most 4 workers run at once');
  });
});
