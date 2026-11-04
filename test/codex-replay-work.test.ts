/**
 * The bridge against the recorded streams of the real Codex 0.166.0 runs
 * of work items, questions and requests (`codex-smoke --only threads`,
 * `--only questions` and `--only requests`; fixtures written by
 * scripts/codex-fixture.ts), played back by test/support/codex-replay.ts:
 * the bridge must send what it sent then, in the same order. Codex's calls
 * to the hosted tools are made again from the recorded `mcpToolCall` items,
 * each on the URL the bridge gave that thread.
 *
 * - items: two items' mentions at once, each in its own worktree (the
 *   turns overlapped), then a slow count in one, unassigned: turn/interrupt
 *   and thread/unsubscribe, as recorded;
 * - questions: `ask` through the hosted tool, answered on its card; then a
 *   plan-mode turn in which Codex asked its question as an async message
 *   (`delivery: "async"`), which now becomes a question card;
 * - requests: a catch-up and a thread to items, each in its own read-only
 *   thread with its skills, the results in their places, each thread
 *   unsubscribed after its turn.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { runCodex } from '../src/cli/codex.js';
import type { CommandIO } from '../src/cli/commands.js';
import type { CodexBridge } from '../src/codex/bridge.js';
import { WORKTREES_DIR } from '../src/codex/worktrees.js';
import { createLogger } from '../src/log.js';
import { FileTokenStore, sessionKey } from '../src/secrets/keychain.js';
import {
  inputText,
  loadReplay,
  ReplayAppServer,
  type FixtureRecord,
} from './support/codex-replay.js';
import { CHANNELS, FakeApi, MESSAGES } from './support/fake-api.js';
import { SESSION_TOKENS } from './support/fake-sessions.js';

let api: FakeApi;
let dir: string;
const token = SESSION_TOKENS.first;

beforeAll(async () => {
  api = await new FakeApi().start();
});
afterAll(async () => {
  await api.close();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, ms = 8000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The run's folder (as the recording's, a git repository with one commit) and its saved session. */
async function bench(): Promise<{ folder: string; store: FileTokenStore }> {
  api.reset();
  dir = mkdtempSync(join(tmpdir(), 'buildit-mcp-replay-'));
  const folder = join(dir, 'codex-smoke-work');
  mkdirSync(folder);
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=codex smoke', '-c', 'user.email=smoke@example.com', ...args],
      {
        cwd: folder,
        stdio: 'ignore',
      },
    );
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'smoke');
  const store = new FileTokenStore(join(dir, 'sessions.json'));
  await store.set(sessionKey(folder, api.url), token);
  return { folder, store };
}

async function run(
  replay: ReplayAppServer,
  folder: string,
  store: FileTokenStore,
  planItems = false,
): Promise<{ bridge: () => CodexBridge; stop: () => Promise<number> }> {
  let release!: () => void;
  const stopped = new Promise<void>((r) => (release = r));
  let bridge: CodexBridge | undefined;
  const io: CommandIO = {
    out: () => undefined,
    err: () => undefined,
    store,
    logger: createLogger({ level: 'error' }),
  };
  const done = runCodex(
    {
      apiUrl: api.url,
      apiUrlFlag: true,
      folder,
      projects: [],
      label: 'codex-smoke',
      yes: false,
      capabilities: [],
      codexConfig: [],
      logLevel: 'error',
      planItems,
    },
    io,
    {
      stop: stopped,
      spawn: replay.spawn,
      lockDir: join(dir, 'locks'),
      intervalMs: 20,
      logSink: () => undefined,
      onReady: (b: CodexBridge) => {
        bridge = b;
      },
    },
  );
  await waitFor(() => bridge !== undefined);
  return {
    bridge: () => bridge!,
    stop: () => {
      release();
      return done;
    },
  };
}

/** Codex's recorded calls to the hosted tools, made again on each thread's own URL. */
function replayToolCalls(p: ReplayAppServer, calls: string[]): void {
  p.onRecord = async (msg) => {
    const params = msg.params as { threadId?: string; item?: Record<string, unknown> } | undefined;
    const item = params?.item;
    if (msg.method !== 'item/started' || item?.type !== 'mcpToolCall') return;
    if (item.server !== 'buildit') return;
    // The bridge has taken the turn's start by now.
    await new Promise((r) => setTimeout(r, 30));
    const result = (await p.mcpCall(
      String(item.tool),
      { ...(item.arguments as Record<string, unknown>) },
      params?.threadId,
    )) as { isError?: boolean };
    calls.push(`${String(item.tool)}${result.isError === true ? ':error' : ''}`);
  };
}

/** The recorded turn/starts, in order. */
const turnStarts = (records: readonly FixtureRecord[]) =>
  records.filter((r) => r.dir === 'out' && r.msg.method === 'turn/start');

/** The person's message inside a recorded mention ("Their message:" and the line after it). */
const mentionText = (record: FixtureRecord): string =>
  /Their message:\n([^\n]+)/.exec(inputText(record.msg) ?? '')?.[1] ?? '';

/** A fake API item by number (the made-up DEMO project), as the run's events named it. */
const stored = (n: number) => {
  const i = api.store.items.find((x) => x.project === 'DEMO' && x.number === n)!;
  return { id: i.id, key: `DEMO-${n}`, title: i.title };
};

const textsIn = (thread: string | null) => {
  const s = api.sessions.session(token);
  const cards = new Set(api.sessions.approvals(token).map((c) => c.id));
  return s.messages
    .filter((m) => m.thread_id === thread && !cards.has(m.id) && (m.card ?? null) === null)
    .map((m) => m.text);
};

describe('the bridge against recorded Codex 0.166.0 runs of work', () => {
  it('replays two items at once in their own worktrees, then an unassign that interrupts one', async () => {
    const { folder, store } = await bench();
    api.sessions.open(token, 'codex-smoke');
    const [records] = loadReplay('items-0.166.0.jsonl');
    const starts = turnStarts(records!);
    expect(starts).toHaveLength(3);
    const p = new ReplayAppServer(records!);
    const calls: string[] = [];
    replayToolCalls(p, calls);
    const r = await run(p, folder, store);
    await waitFor(() => p.expecting?.msg.method === 'thread/start');
    const one = stored(44);
    const two = stored(45);
    api.sessions.itemMessage(token, one, mentionText(starts[0]!), { mention: true });
    api.sessions.itemMessage(token, two, mentionText(starts[1]!), { mention: true });
    await waitFor(() => p.expecting === starts[2], 15_000);
    await r.bridge().idle();
    expect(textsIn(one.id)).toEqual(['one']);
    expect(textsIn(two.id)).toEqual(['two']);
    for (const branch of ['demo-44-crash-on-start', 'demo-45-write-the-docs']) {
      expect(existsSync(join(folder, WORKTREES_DIR, branch, '.git'))).toBe(true);
    }
    // The count, then the item unassigned while it runs: interrupted and unsubscribed, nothing posted.
    api.sessions.itemMessage(token, one, mentionText(starts[2]!), { mention: true });
    await waitFor(() => p.expecting?.msg.method === 'turn/interrupt', 15_000);
    api.sessions.unassignItem(token, one);
    await waitFor(() => p.done, 15_000);
    await r.bridge().idle();
    expect(textsIn(one.id)).toEqual(['one']);
    expect(calls).toEqual([
      'get_item:error',
      'list_comments',
      'get_item',
      'list_comments',
      'reply',
      'get_item',
      'reply',
    ]);
    expect(await r.stop()).toBe(0);
    expect(p.violations).toEqual([]);
    expect(p.serverViolations).toEqual([]);
    expect(api.violations).toEqual([]);
  });

  it("replays ask on its card, then plan mode's async question, which becomes a question card", async () => {
    const { folder, store } = await bench();
    const s = api.sessions.open(token, 'codex-smoke');
    const [records] = loadReplay('questions-0.166.0.jsonl');
    const starts = turnStarts(records!);
    expect(starts).toHaveLength(2);
    const p = new ReplayAppServer(records!);
    const calls: string[] = [];
    replayToolCalls(p, calls);
    // The owner answers the ask's card (in the direct message) with its first option, and no other.
    let dmThread: string | undefined;
    const answerer = setInterval(() => {
      for (const m of s.messages) {
        if ((m.card ?? null) === null || m.thread_id !== dmThread) continue;
        api.sessions.answerCard(token, m.id, { inputs: { q1: 'o1' } });
        dmThread = undefined;
      }
    }, 10);
    try {
      const r = await run(p, folder, store, true);
      await waitFor(() => p.expecting?.msg.method === 'thread/start');
      dmThread = api.sessions.postFrom(token, inputText(starts[0]!.msg)!);
      const askThread = dmThread;
      await waitFor(() => textsIn(askThread).length === 1, 15_000);
      expect(textsIn(askThread)).toEqual(['red']);
      // Plan mode in the item: Codex asks without waiting, then ends its turn.
      const item = stored(44);
      api.sessions.itemMessage(token, item, mentionText(starts[1]!), { mention: true });
      await waitFor(() => p.done, 15_000);
      await r.bridge().idle();
      await waitFor(() =>
        s.messages.some((m) => m.thread_id === item.id && (m.card ?? null) !== null),
      );
      const card = s.messages.find((m) => m.thread_id === item.id && (m.card ?? null) !== null)!;
      const body = JSON.stringify(card.card);
      expect(body).toContain('Which word should I use in the DEMO-44 thread?');
      expect(body).toContain('yes');
      expect(body).toContain('no');
      // The question isn't posted as text too; Codex's closing words are.
      expect(textsIn(item.id)).toEqual([
        'I need your answer to the word question before I can propose the one step.',
      ]);
      expect(calls).toEqual(['ask']);
      expect(await r.stop()).toBe(0);
    } finally {
      clearInterval(answerer);
    }
    expect(p.violations).toEqual([]);
    expect(p.serverViolations).toEqual([]);
    expect(api.violations).toEqual([]);
  });

  it('replays a catch-up and a thread to items, each in its own read-only thread, the results in their places', async () => {
    const { folder, store } = await bench();
    api.sessions.open(token, 'codex-smoke');
    const [records] = loadReplay('requests-0.166.0.jsonl');
    const starts = turnStarts(records!);
    expect(starts).toHaveLength(2);
    const idOf = (r: FixtureRecord) =>
      /request="([0-9a-f-]{36})"/.exec(inputText(r.msg) ?? '')![1]!;
    const [catchUp, toItems] = [idOf(starts[0]!), idOf(starts[1]!)];
    const p = new ReplayAppServer(records!);
    const calls: string[] = [];
    replayToolCalls(p, calls);
    const r = await run(p, folder, store);
    await waitFor(() => p.expecting?.msg.method === 'thread/start');
    const general = { id: CHANNELS.general, name: 'general' };
    api.sessions.pushRequest(token, {
      kind: 'catch_up',
      requestId: catchUp,
      project: null,
      context: {
        type: 'channel',
        channel: general,
        from: '2026-10-06T00:00:00.000Z',
        to: '2026-10-08T00:00:00.000Z',
      },
    });
    const secondStart = records!.filter(
      (x) => x.dir === 'out' && x.msg.method === 'thread/start',
    )[1];
    await waitFor(() => p.expecting === secondStart, 15_000);
    await r.bridge().idle();
    api.sessions.pushRequest(token, {
      kind: 'thread_to_items',
      requestId: toItems,
      place: 'thread',
      context: { type: 'thread', channel: { ...general, dm: false }, thread_id: MESSAGES.root },
    });
    await waitFor(() => p.done, 15_000);
    await r.bridge().idle();
    const posts = api.sessions.requestPosts.map((x) => [
      x.request,
      x.thread_id?.toLowerCase() ?? null,
    ]);
    expect(posts).toEqual([
      [catchUp, null],
      [toItems, MESSAGES.root.toLowerCase()],
    ]);
    expect(textsIn(null)[0]).toMatch(/^#general/);
    expect(calls).toEqual([
      'read_channel',
      'read_thread',
      'reply',
      'read_thread:error',
      'read_thread',
      'read_channel',
      'describe_project',
      'search_items',
      'reply',
    ]);
    expect(await r.stop()).toBe(0);
    expect(p.violations).toEqual([]);
    expect(p.serverViolations).toEqual([]);
    expect(api.violations).toEqual([]);
  });
});
