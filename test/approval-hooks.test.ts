/**
 * The hooks around tool approvals: tool_seen's ring and how an approval
 * names its tool call (two identical calls at once too), every way an open
 * approval ends without a verdict (tool_done, agent_done, turn_ended,
 * prompt_typed, the server shutting down), the journal that lets the next
 * server close what a dead one left open, and answers to an approval card
 * that are never verdicts.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { CallToolResult } from '@modelcontextprotocol/client';

import { canonicalJson, inputHash, RING_SIZE, ToolRing } from '../src/channel/tool-ring.js';
import { approvalIdForToolUse, permissionAllow, typedByPerson } from '../src/tools/approve.js';
import {
  channelConfig,
  channelNotes,
  startChannel,
  waitFor,
  type ChannelClient,
} from './support/channel-harness.js';
import { FakeApi } from './support/fake-api.js';
import { SESSION_TOKENS } from './support/fake-sessions.js';

const TOKEN = SESSION_TOKENS.first;

let api: FakeApi;
const stops: (() => Promise<void>)[] = [];
let dir: string;

beforeAll(async () => {
  api = await new FakeApi().start();
});
afterAll(async () => {
  await api.close();
});
beforeEach(() => {
  api.reset();
  dir = mkdtempSync(join(tmpdir(), 'buildit-mcp-approvals-'));
});
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
  rmSync(dir, { recursive: true, force: true });
  expect(api.violations).toEqual([]);
});

const session = () => api.sessions.session(TOKEN);
const approvals = () => api.sessions.approvals(TOKEN);
const textOf = (r: CallToolResult): string =>
  (r.content as { type: string; text: string }[]).map((c) => c.text).join('\n');
const journalPath = (): string => join(dir, 'session.approvals.json');

async function start(options: { journal?: boolean } = {}): Promise<ChannelClient> {
  return startChannel(api, stops, {
    config: channelConfig(api),
    stdio: {
      approve: { msPerSecond: 2 },
      typing: { everyMs: 60_000 },
      ...(options.journal === true ? { approvalJournal: journalPath() } : {}),
    },
  });
}

async function started(options: { journal?: boolean } = {}): Promise<ChannelClient> {
  api.sessions.open(TOKEN);
  const c = await start(options);
  await waitFor(() => session().heartbeats.includes('online'));
  api.sessions.postFrom(TOKEN, 'Go on.');
  await waitFor(() => channelNotes(c.notes).length === 1);
  return c;
}

const BASH = { command: 'npm test', description: 'Run the tests' };

const call = (c: ChannelClient, name: string, args: Record<string, unknown>) =>
  c.client.callTool({ name, arguments: args });

/** approve without a tool_use_id, as Claude Code calls it (the id is "" on PermissionRequest). */
const approve = (c: ChannelClient, init: { agent_id?: string; input?: unknown } = {}) =>
  call(c, 'approve', {
    tool_name: 'Bash',
    tool_input: JSON.stringify(init.input ?? BASH),
    tool_use_id: '',
    agent_id: init.agent_id ?? '',
    agent_type: init.agent_id === undefined ? '' : 'Explore',
    session_id: 'claude-session-1',
    prompt_id: 'prompt-1',
  });

const seen = (
  c: ChannelClient,
  toolUseId: string,
  init: { agent_id?: string; input?: unknown } = {},
) =>
  call(c, 'tool_seen', {
    tool_name: 'Bash',
    tool_input: JSON.stringify(init.input ?? BASH),
    tool_use_id: toolUseId,
    agent_id: init.agent_id ?? '',
  });

async function posted(n = 1) {
  await waitFor(() => approvals().length >= n);
  return approvals()[n - 1]!;
}

describe('the ring of tool calls', () => {
  it('hashes inputs by canonical JSON (keys sorted at every level)', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[1,{"x":1,"y":2}]},"b":1}',
    );
    expect(inputHash({ a: 1, b: 2 })).toBe(inputHash({ b: 2, a: 1 }));
    expect(inputHash({ a: 1 })).not.toBe(inputHash({ a: 2 }));
  });

  it('claims the newest unclaimed match at most 5 s old, forgets after 10 s, keeps 256', () => {
    let now = 0;
    const ring = new ToolRing(() => now);
    const h = inputHash(BASH);
    ring.record({ agentId: '', toolName: 'Bash', hash: h, toolUseId: 'toolu_1' });
    now = 1000;
    ring.record({ agentId: '', toolName: 'Bash', hash: h, toolUseId: 'toolu_2' });
    expect(ring.claim('', 'Bash', h)).toBe('toolu_2');
    expect(ring.claim('', 'Bash', h)).toBe('toolu_1');
    expect(ring.claim('', 'Bash', h)).toBeUndefined();
    ring.record({ agentId: 'a1', toolName: 'Bash', hash: h, toolUseId: 'toolu_3' });
    expect(ring.claim('', 'Bash', h)).toBeUndefined();
    expect(ring.claim('a1', 'Write', h)).toBeUndefined();
    now = 6500;
    expect(ring.claim('a1', 'Bash', h)).toBeUndefined();
    now = 20_000;
    expect(ring.size).toBe(0);
    for (let i = 0; i < RING_SIZE + 10; i++) {
      ring.record({ agentId: '', toolName: 'Bash', hash: h, toolUseId: `toolu_${i}` });
    }
    expect(ring.size).toBe(RING_SIZE);
  });

  it('waits a moment for the PreToolUse that comes just before', async () => {
    const ring = new ToolRing();
    const h = inputHash(BASH);
    const pending = ring.claimSoon('', 'Bash', h, 300);
    setTimeout(() => {
      ring.record({ agentId: '', toolName: 'Bash', hash: h, toolUseId: 'toolu_late' });
    }, 20);
    expect(await pending).toBe('toolu_late');
    expect(await ring.claimSoon('', 'Bash', h, 20)).toBeUndefined();
  });
});

describe('correlation', () => {
  it("names the call from tool_seen: the card's id is the tool call's", async () => {
    const c = await started();
    expect(textOf(await seen(c, 'toolu_seen1'))).toBe('{}');
    const pending = approve(c);
    const a = await posted();
    expect(a.id).toBe(approvalIdForToolUse('toolu_seen1'));
    expect(a.posted.tool_use_id).toBe('toolu_seen1');
    api.sessions.decideApproval(TOKEN, a.id, 'approve');
    expect(textOf(await pending)).toBe(permissionAllow());
  });

  it('two identical calls at once each claim their own; without a match, each gets a new card', async () => {
    const c = await started();
    await seen(c, 'toolu_twin1');
    await seen(c, 'toolu_twin2');
    const one = approve(c);
    const two = approve(c);
    await posted(2);
    expect(
      approvals()
        .map((a) => a.posted.tool_use_id)
        .sort(),
    ).toEqual(['toolu_twin1', 'toolu_twin2']);
    // No PreToolUse seen: fallback ids, one per call.
    const three = approve(c);
    const four = approve(c);
    await posted(4);
    const fallback = approvals().slice(2);
    expect(fallback.map((a) => a.posted.tool_use_id)).toEqual([undefined, undefined]);
    expect(new Set(approvals().map((a) => a.id)).size).toBe(4);
    for (const a of approvals()) api.sessions.decideApproval(TOKEN, a.id, 'approve');
    for (const p of [one, two, three, four]) expect(textOf(await p)).toBe(permissionAllow());
  });
});

describe('how an open approval ends without a verdict', () => {
  it('tool_done: the call ran (answered in the terminal); {} at once, then closed', async () => {
    const c = await started();
    await seen(c, 'toolu_t1');
    const pending = approve(c);
    await posted();
    expect(textOf(await call(c, 'tool_done', { tool_use_id: 'toolu_other' }))).toBe('{}');
    await call(c, 'tool_done', { tool_use_id: 'toolu_t1', agent_id: '' });
    const r = await pending;
    expect(textOf(r)).toBe('{}');
    expect(r.structuredContent).toMatchObject({ status: 'passed', reason: 'answered_elsewhere' });
    await waitFor(() => approvals()[0]?.closes.length === 1);
    expect(approvals()[0]).toMatchObject({
      closes: ['answered_elsewhere'],
      status: 'answered_elsewhere',
    });
    // Its card.closed then finds no waiter, and is dropped.
    await waitFor(() => c.logs.some((l) => l.includes('no_waiter')));
  });

  it("agent_done: that subagent's approvals only", async () => {
    const c = await started();
    const sub = approve(c, { agent_id: 'agent-x' });
    await posted(1);
    const lead = approve(c, { input: { command: 'npm run lint' } });
    await posted(2);
    await call(c, 'agent_done', { agent_id: '' });
    await call(c, 'agent_done', { agent_id: 'agent-y', agent_type: 'Explore' });
    await call(c, 'agent_done', { agent_id: 'agent-x', agent_type: 'Explore' });
    expect(textOf(await sub)).toBe('{}');
    await waitFor(() => approvals()[0]?.closes.length === 1);
    expect(approvals()[0]?.closes).toEqual(['stale']);
    expect(approvals()[1]?.closes).toEqual([]);
    api.sessions.decideApproval(TOKEN, approvals()[1]!.id, 'approve');
    expect(textOf(await lead)).toBe(permissionAllow());
  });

  it("turn_ended: the main agent's approvals close as stale, a subagent's stay", async () => {
    const c = await started();
    const lead = approve(c);
    await posted(1);
    const sub = approve(c, { agent_id: 'agent-z', input: { command: 'ls' } });
    await posted(2);
    expect(textOf(await call(c, 'turn_ended', {}))).toBe('{}');
    expect(textOf(await lead)).toBe('{}');
    await waitFor(() => approvals()[0]?.closes.length === 1);
    expect(approvals()[0]?.closes).toEqual(['stale']);
    expect(approvals()[1]?.status).toBe('open');
    api.sessions.decideApproval(TOKEN, approvals()[1]!.id, 'deny');
    expect(textOf(await sub)).toContain('"behavior":"deny"');
  });

  it("prompt_typed: a typed prompt ends the main agent's; a channel message or a task report doesn't", async () => {
    expect(typedByPerson('do it')).toBe(true);
    expect(typedByPerson(undefined)).toBe(true);
    expect(typedByPerson('<channel source="plugin:buildit:buildit">hi</channel>')).toBe(false);
    expect(typedByPerson('\n<task-notification>\n<task-id>a1</task-id>')).toBe(false);
    const c = await started();
    const lead = approve(c);
    await posted();
    await call(c, 'prompt_typed', { prompt: '<channel source="buildit">more</channel>' });
    await call(c, 'prompt_typed', { prompt: '<task-notification>done</task-notification>' });
    expect(approvals()[0]?.status).toBe('open');
    await call(c, 'prompt_typed', { prompt: 'never mind, do something else' });
    expect(textOf(await lead)).toBe('{}');
    await waitFor(() => approvals()[0]?.closes.length === 1);
    expect(approvals()[0]?.closes).toEqual(['stale']);
  });

  it('the hook tools never fail, whatever they get', async () => {
    const c = await started();
    for (const [name, args] of [
      ['tool_seen', { tool_name: 123, tool_input: { a: 1 }, tool_use_id: null }],
      ['tool_seen', { tool_name: '${tool_name}', tool_input: '${tool_input}' }],
      ['tool_done', {}],
      ['agent_done', { agent_id: ['x'] }],
      ['prompt_typed', { prompt: 42 }],
    ] as const) {
      const r = await call(c, name, args);
      expect(r.isError, name).toBeFalsy();
      expect(textOf(r), name).toBe('{}');
    }
  });

  it('shutdown closes every open approval as the session ending', async () => {
    const c = await started();
    const pending = approve(c).catch(() => 'gone');
    await posted();
    await c.close();
    await pending;
    expect(approvals()[0]).toMatchObject({ closes: ['session_ended'], status: 'closed' });
    expect(session().heartbeats.at(-1)).toBe('offline');
  });
});

describe('"is writing" from tool_seen', () => {
  it("keeps the main agent's thread going, and starts an item worker's again", async () => {
    const folder = mkdtempSync(join(tmpdir(), 'buildit-mcp-seen-'));
    try {
      const { demoItem } = await import('./support/fake-sessions.js');
      const item = demoItem(21);
      mkdirSync(join(folder, '.claude'), { recursive: true });
      writeFileSync(
        join(folder, '.claude', 'buildit-workers.json'),
        JSON.stringify({ workers: [{ agent_id: 'agent-w', item: item.key, thread_id: item.id }] }),
      );
      api.sessions.open(TOKEN);
      const c = await startChannel(api, stops, {
        config: channelConfig(api, { BUILDIT_FOLDER: folder }),
        stdio: { typing: { everyMs: 60_000 } },
      });
      await waitFor(() => session().heartbeats.includes('online'));
      api.sessions.assignItem(TOKEN, item);
      await waitFor(() => channelNotes(c.notes).length === 1);
      await waitFor(() => session().typings.some((t) => t.thread_id === item.id && t.typing));
      await call(c, 'reply', { text: 'On it.', item: item.key });
      await waitFor(() => session().typings.some((t) => t.thread_id === item.id && !t.typing));
      const before = session().typings.length;
      // The worker's next tool call: its item's thread shows it at work again.
      await seen(c, 'toolu_w1', { agent_id: 'agent-w' });
      await waitFor(() =>
        session()
          .typings.slice(before)
          .some((t) => t.thread_id === item.id && t.typing),
      );
      // A subagent the table doesn't name changes nothing.
      const after = session().typings.length;
      await seen(c, 'toolu_w2', { agent_id: 'agent-other' });
      expect(session().typings.length).toBe(after);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe('the journal', () => {
  it('lists the open approvals while they wait, and none once they end', async () => {
    const c = await started({ journal: true });
    const pending = approve(c);
    const a = await posted();
    const file = JSON.parse(readFileSync(journalPath(), 'utf8')) as {
      v: number;
      open: { id: string; posted_at: string }[];
    };
    expect(file.v).toBe(1);
    expect(file.open.map((e) => e.id)).toEqual([a.id]);
    api.sessions.decideApproval(TOKEN, a.id, 'approve');
    await pending;
    expect(JSON.parse(readFileSync(journalPath(), 'utf8'))).toEqual({ v: 1, open: [] });
  });

  it('closes what a server that died left open, once the session is known', async () => {
    const c = await started();
    const pending = approve(c);
    const a = await posted();
    void pending.catch(() => undefined);
    // A server that died with the card open left its id in the journal.
    writeFileSync(
      journalPath(),
      JSON.stringify({ v: 1, open: [{ id: a.id, posted_at: '2026-10-29T10:00:00.000Z' }] }),
    );
    await start({ journal: true });
    await waitFor(() => approvals()[0]?.closes.includes('interrupted') === true);
    expect(approvals()[0]?.status).toBe('closed');
    await waitFor(() => readFileSync(journalPath(), 'utf8').includes('"open":[]'));
    // The first server's waiting call gets the verdict the close made.
    expect(textOf(await pending)).toContain('closed in buildIt.Social before anyone answered');
  });

  it('is not written without a path, and an unreadable one is ignored', async () => {
    writeFileSync(journalPath(), 'not json');
    const c = await started({ journal: true });
    const pending = approve(c);
    const a = await posted();
    api.sessions.decideApproval(TOKEN, a.id, 'approve');
    await pending;
    expect(JSON.parse(readFileSync(journalPath(), 'utf8'))).toEqual({ v: 1, open: [] });
    rmSync(journalPath());
    await Promise.all(stops.splice(0).map((stop) => stop()));
    const c2 = await start();
    await waitFor(() => session().heartbeats.filter((h) => h === 'online').length >= 2);
    const p2 = approve(c2, { input: { command: 'ls' } });
    const b = await posted(2);
    api.sessions.decideApproval(TOKEN, b.id, 'approve');
    await p2;
    expect(existsSync(journalPath())).toBe(false);
  });
});

describe('answers to an approval card', () => {
  it('are dropped: only card.closed carries a verdict', async () => {
    const c = await started();
    await seen(c, 'toolu_ans');
    const pending = approve(c);
    const a = await posted();
    // A response on the approval card (from a client that tried): never a verdict.
    api.sessions.answerCard(TOKEN, a.id, { action: 'approve' });
    await waitFor(() => c.logs.join('\n').includes('approval_answer'));
    expect(approvals()[0]?.status).toBe('open');
    api.sessions.decideApproval(TOKEN, a.id, 'deny');
    expect(textOf(await pending)).toContain('"behavior":"deny"');
  });
});
