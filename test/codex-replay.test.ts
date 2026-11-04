/**
 * The bridge against a real app-server's recorded stream: the first smoke
 * run on Codex 0.166.0 (test/fixtures/codex/smoke-0.166.0.jsonl), played
 * back by test/support/codex-replay.ts. The bridge must send what it sent
 * then, in the same order, from the same server messages.
 *
 * It pins the order of two close messages: in that run, a message ("Stop
 * counting...") arrived after the previous turn had already completed, so
 * it started a new turn, and the next one ("Count slowly from 1 to
 * 200...") came in the same poll and was steered into that new turn, which
 * was then interrupted. A message never lands in a later turn than one
 * sent after it.
 *
 * The parity run (test/fixtures/codex/parity-0.166.0.jsonl, `codex-smoke
 * --only parity`): an image the model described, its whoami and reply
 * over the hosted tools, an approved command and the file it wrote shared
 * with reply, a denied command, and a file change approved on its card.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { ChannelState } from '../src/channel/loop.js';
import { runCodex } from '../src/cli/codex.js';
import type { CommandIO } from '../src/cli/commands.js';
import type { CodexBridge } from '../src/codex/bridge.js';
import { createLogger } from '../src/log.js';
import { FileTokenStore, sessionKey } from '../src/secrets/keychain.js';
import { inputText, loadReplay, promptOf, ReplayAppServer } from './support/codex-replay.js';
import { FakeApi } from './support/fake-api.js';
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

async function waitFor(check: () => boolean, ms = 4000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function run(
  replay: ReplayAppServer,
  folder: string,
  store: FileTokenStore,
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
    },
    io,
    {
      stop: stopped,
      spawn: replay.spawn,
      lockDir: join(dir, 'locks'),
      intervalMs: 20,
      logSink: () => undefined,
      onReady: (b: CodexBridge, _s: ChannelState) => {
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

describe('the bridge against a recorded Codex 0.166.0 run', () => {
  it('makes the same decisions from the same stream: reply, a close pair of messages, interrupt, resume', async () => {
    dir = mkdtempSync(join(tmpdir(), 'buildit-mcp-replay-'));
    const folder = join(dir, 'codex-smoke-work');
    mkdirSync(folder);
    const store = new FileTokenStore(join(dir, 'sessions.json'));
    await store.set(sessionKey(folder, api.url), token);
    const s = api.sessions.open(token, 'codex-smoke');
    const [first, second] = loadReplay('smoke-0.166.0.jsonl');
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const texts = (records: typeof first) =>
      records!
        .filter((r) => r.dir === 'out')
        .map((r) => inputText(r.msg))
        .filter((t) => t !== undefined);
    const [pong, count, stop, longCount] = texts(first);
    const [question] = texts(second);
    const say = (text: string | undefined): void => {
      api.sessions.postFrom(token, text!);
    };
    const posts = () => s.messages.map((m) => m.text);

    const a = new ReplayAppServer(first!);
    const r1 = await run(a, folder, store);
    await waitFor(
      () => a.expecting?.msg.method === 'thread/start' || a.expecting?.msg.method === 'turn/start',
    );
    say(pong);
    await waitFor(() => posts().length === 1);
    expect(posts()[0]).toBe('pong');
    say(count);
    await waitFor(() => posts().length === 2);
    expect(posts()[1]).toMatch(/^1\n2\n3/);
    // The close pair, in one poll: the first starts a turn, the second joins it.
    expect(a.expecting?.msg.method).toBe('turn/start');
    say(stop);
    say(longCount);
    await waitFor(() => a.expecting?.msg.method === 'turn/interrupt');
    expect(await r1.bridge().interrupt()).toBe(true);
    await waitFor(() => a.done);
    await r1.bridge().idle();
    expect(posts()).toHaveLength(2);
    expect(await r1.stop()).toBe(0);
    expect(a.violations).toEqual([]);
    expect(a.serverViolations).toEqual([]);

    // The restart: the thread is resumed, and the answer comes from its history.
    const b = new ReplayAppServer(second!);
    const r2 = await run(b, folder, store);
    await waitFor(() => s.heartbeats.filter((h) => h === 'online').length === 2);
    say(question);
    await waitFor(() => posts().length === 3);
    expect(posts()[2]).toBe('pong');
    await waitFor(() => b.done);
    await r2.stop();
    expect(b.violations).toEqual([]);
    expect(b.serverViolations).toEqual([]);
    await waitFor(() => s.typings.at(-1)?.typing === false);
    expect(api.violations).toEqual([]);
  });

  it('replays the parity run: an image, the hosted tools, approvals accepted and declined, a file change', async () => {
    dir = mkdtempSync(join(tmpdir(), 'buildit-mcp-replay-'));
    const folder = join(dir, 'codex-smoke-work');
    mkdirSync(folder);
    const store = new FileTokenStore(join(dir, 'sessions.json'));
    await store.set(sessionKey(folder, api.url), token);
    const s = api.sessions.open(token, 'codex-smoke');
    const [records] = loadReplay('parity-0.166.0.jsonl');
    const starts = records!.filter((r) => r.dir === 'out' && r.msg.method === 'turn/start');
    expect(starts).toHaveLength(4);
    const prompts = starts.map((r) => promptOf(r.msg)!);
    const p = new ReplayAppServer(records!);
    // What Codex did outside the stream: its calls to the hosted tools, as recorded in its items.
    const calls: string[] = [];
    p.onRecord = async (msg) => {
      const item = (msg.params as { item?: Record<string, unknown> } | undefined)?.item;
      if (msg.method !== 'item/started' || item?.type !== 'mcpToolCall') return;
      if (item.server !== 'buildit') return;
      // The bridge has taken the turn's start by now.
      await new Promise((r) => setTimeout(r, 30));
      const args = { ...(item.arguments as Record<string, unknown>) };
      if (Array.isArray(args.files)) {
        // Codex's own command wrote the file in the run: here it is made in the test's folder.
        args.files = (args.files as string[]).map((f) => {
          const local = join(folder, basename(f.replace(/[\\]/g, '/')));
          if (!existsSync(local)) writeFileSync(local, 'smoke\n');
          return local;
        });
      }
      const result = (await p.mcpCall(String(item.tool), args)) as { isError?: boolean };
      calls.push(`${String(item.tool)}${result.isError === true ? ':error' : ''}`);
    };
    // The owner's taps, in the run's order.
    const taps: ('approve' | 'deny')[] = ['approve', 'deny', 'approve'];
    const decided = new Set<string>();
    const owner = setInterval(() => {
      for (const card of api.sessions.approvals(token)) {
        if (card.status !== 'open' || decided.has(card.id)) continue;
        decided.add(card.id);
        api.sessions.decideApproval(token, card.id, taps.shift() ?? 'deny');
      }
    }, 10);
    try {
      const r = await run(p, folder, store);
      await waitFor(() => p.expecting === starts[0] || p.expecting?.msg.method === 'thread/start');
      const png = readFileSync(new URL('./fixtures/location/plain.png', import.meta.url));
      api.sessions.postFrom(token, prompts[0]!, {
        files: [{ name: 'plain.png', type: 'image/png', bytes: png, kind: 'image' }],
      });
      for (let k = 1; k < 4; k++) {
        await waitFor(() => p.expecting === starts[k], 8000);
        await r.bridge().idle();
        api.sessions.postFrom(token, prompts[k]!);
      }
      await waitFor(() => p.done, 8000);
      await r.bridge().idle();
      expect(calls).toEqual(['whoami', 'reply', 'reply']);
      const texts = s.messages.filter((m) => (m.card ?? null) === null).map((m) => m.text);
      expect(texts).toEqual(['pong rainbow gradient', 'out.txt', 'declined', 'done']);
      expect(api.sessions.filePosts).toHaveLength(1);
      const cards = api.sessions.approvals(token);
      expect(cards.map((c) => `${c.toolName}:${c.status}`)).toEqual([
        'command:approved',
        'command:denied',
        'file_change:approved',
      ]);
      const fields = cards[2]!.posted.fields as { key: string; value: string }[];
      expect(fields.some((f) => f.key.endsWith('hello.txt') && f.value.includes('hello.txt'))).toBe(
        true,
      );
      expect(await r.stop()).toBe(0);
    } finally {
      clearInterval(owner);
    }
    expect(p.violations).toEqual([]);
    expect(p.serverViolations).toEqual([]);
    expect(api.violations).toEqual([]);
  });

  it('pins the order: the recorded steer names the turn the message before it started', () => {
    const [first] = loadReplay('smoke-0.166.0.jsonl');
    const outs = first!.filter((r) => r.dir === 'out');
    const steer = outs.find((r) => r.msg.method === 'turn/steer')!;
    const before = outs[outs.indexOf(steer) - 1]!;
    expect(before.msg.method).toBe('turn/start');
    const started = first!.find(
      (r) => r.dir === 'in' && r.msg.id === before.msg.id && r.msg.result !== undefined,
    )!;
    const turnId = (started.msg.result as { turn: { id: string } }).turn.id;
    expect((steer.msg.params as { expectedTurnId: string }).expectedTurnId).toBe(turnId);
    expect(inputText(before.msg)).toMatch(/^Stop counting/);
    expect(inputText(steer.msg)).toMatch(/^Count slowly from 1 to 200/);
  });

  it('reports a bridge that decides differently from the recording', async () => {
    const player = new ReplayAppServer([
      {
        dir: 'out',
        ms: 0,
        msg: {
          id: 1,
          method: 'turn/start',
          params: { threadId: 't', input: [{ type: 'text', text: 'B', text_elements: [] }] },
        },
      },
      {
        dir: 'in',
        ms: 1,
        msg: { id: 1, result: { turn: { id: 'x', items: [], status: 'inProgress' } } },
      },
    ]);
    player.process.stdin.write(
      JSON.stringify({
        id: 7,
        method: 'turn/steer',
        params: {
          threadId: 't',
          expectedTurnId: 'y',
          input: [{ type: 'text', text: 'A', text_elements: [] }],
        },
      }) + `\n`,
    );
    await waitFor(() => player.violations.length > 0);
    expect(player.violations[0]).toBe('the bridge sent turn/steer, the recording has turn/start');
    await player.process.stop();
  });
});
