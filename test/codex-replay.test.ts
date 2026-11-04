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
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { ChannelState } from '../src/channel/loop.js';
import { runCodex } from '../src/cli/codex.js';
import type { CommandIO } from '../src/cli/commands.js';
import type { CodexBridge } from '../src/codex/bridge.js';
import { createLogger } from '../src/log.js';
import { FileTokenStore, sessionKey } from '../src/secrets/keychain.js';
import { inputText, loadReplay, ReplayAppServer } from './support/codex-replay.js';
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
