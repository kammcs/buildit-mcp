/**
 * buildit-mcp codex, end to end in process: runCodex against the fake
 * agent API's sessions (the person) and the fake app-server (Codex),
 * which validates every message the bridge sends against the protocol
 * subset vendored from Codex. Covers turns, steering, interrupts, the
 * final-answer rules, "is writing", the declined server requests,
 * restarts and resume, unknown messages, the version gate, and the
 * process's ends.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { acquireChannelLock } from '../src/channel/lock.js';
import type { ChannelState } from '../src/channel/loop.js';
import { runCodex, type CodexDeps } from '../src/cli/codex.js';
import type { CommandIO } from '../src/cli/commands.js';
import {
  answerOf,
  noticeFor,
  REQUESTS_NOTICE,
  splitText,
  stableUuid,
  type CodexBridge,
} from '../src/codex/bridge.js';
import { SessionRouter } from '../src/codex/router.js';
import type { CodexOptions } from '../src/config.js';
import { createLogger } from '../src/log.js';
import { FileTokenStore, sessionKey } from '../src/secrets/keychain.js';
import { FakeApi } from './support/fake-api.js';
import { CodexHome, FakeAppServer, replyWith, type Received } from './support/fake-codex.js';
import { SESSION_TOKENS } from './support/fake-sessions.js';

let api: FakeApi;
let dir: string;
let folder: string;
let lockDir: string;
const running: { stop: () => Promise<number> }[] = [];
const fakes: FakeAppServer[] = [];

beforeAll(async () => {
  api = await new FakeApi().start();
});
afterAll(async () => {
  await api.close();
});
beforeEach(() => {
  api.reset();
  dir = mkdtempSync(join(tmpdir(), 'buildit-mcp-codex-'));
  folder = join(dir, 'work');
  mkdirSync(folder);
  lockDir = join(dir, 'locks');
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((r) => r.stop()));
  for (const f of fakes.splice(0)) {
    expect(f.violations).toEqual([]);
    expect(f.selfViolations).toEqual([]);
  }
  expect(api.violations).toEqual([]);
  rmSync(dir, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, ms = 4000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function fake(
  options: ConstructorParameters<typeof FakeAppServer>[1] = {},
  home?: CodexHome,
): FakeAppServer {
  const f = new FakeAppServer(home, options);
  fakes.push(f);
  return f;
}

interface Running {
  done: Promise<number>;
  stop: () => Promise<number>;
  bridge: () => CodexBridge;
  state: () => ChannelState;
  logs: string[];
  out: string[];
  err: string[];
}

async function start(
  codex: FakeAppServer,
  options: Partial<CodexOptions> = {},
  deps: Partial<CodexDeps> = {},
  saveToken = true,
): Promise<Running> {
  const store = new FileTokenStore(join(dir, 'sessions.json'));
  if (saveToken) await store.set(sessionKey(folder, api.url), SESSION_TOKENS.first);
  let release!: () => void;
  const stopped = new Promise<void>((r) => (release = r));
  let bridge: CodexBridge | undefined;
  let state: ChannelState | undefined;
  const logs: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const io: CommandIO = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    store,
    logger: createLogger({ level: 'error' }),
  };
  const done = runCodex(
    {
      apiUrl: api.url,
      apiUrlFlag: true,
      folder,
      projects: [],
      label: 'demo-folder',
      yes: false,
      capabilities: [],
      codexConfig: [],
      logLevel: 'debug',
      ...options,
    },
    io,
    {
      stop: stopped,
      spawn: codex.spawn,
      lockDir,
      logSink: (l) => logs.push(l),
      intervalMs: 20,
      onReady: (b, s) => {
        bridge = b;
        state = s;
      },
      ...deps,
    },
  );
  const r: Running = {
    done,
    stop: () => {
      release();
      return done;
    },
    bridge: () => bridge!,
    state: () => state!,
    logs,
    out,
    err,
  };
  running.push(r);
  return r;
}

const token = SESSION_TOKENS.first;
const readMap = (path: string) =>
  JSON.parse(readFileSync(path, 'utf8')) as {
    threads: Record<string, { codex_thread_id: string; has_turn: boolean }>;
  };
const session = () => api.sessions.session(token);
const posts = () => session().messages;
const logged = (r: Running, msg: string) => r.logs.some((l) => l.includes(msg));
const text = (input: unknown): string => (input as { text?: string }[])[0]?.text ?? '';

describe('buildit-mcp codex: turns and answers', () => {
  it("turns the owner's message into a turn and posts the final answer in its thread", async () => {
    const s = api.sessions.open(token, 'demo-folder');
    const codex = fake();
    const r = await start(codex, { codexConfig: ['model="test-model"'] });
    await waitFor(() => s.heartbeats.includes('online'));
    expect(codex.args).toEqual(['-c', 'model="test-model"']);
    const init = codex.requests('initialize')[0]!;
    expect(init.capabilities).toMatchObject({ experimentalApi: true });
    expect(
      (init.capabilities as { optOutNotificationMethods: string[] }).optOutNotificationMethods,
    ).toContain('item/agentMessage/delta');
    expect(codex.notifications('initialized')).toHaveLength(1);

    const id = api.sessions.postFrom(token, 'Hello there');
    await waitFor(() => posts().length === 1);
    expect(posts()[0]).toMatchObject({ text: 'ok', thread_id: id });
    const startParams = codex.requests('thread/start')[0]!;
    expect(startParams.cwd).toBe(folder);
    expect(startParams.developerInstructions).toContain('buildIt.Social');
    expect(text(codex.requests('turn/start')[0]!.input)).toBe('Hello there');
    await waitFor(() => s.acked === 1);
    // "is writing" from the turn's start to the post.
    await waitFor(() => s.typings.at(-1)?.typing === false);
    expect(s.typings[0]).toEqual({ thread_id: id, typing: true });
    expect(r.out.join('')).toContain('now go to Codex');
  });

  it('steers a message sent during a turn into it, and answers once, in the latest thread', async () => {
    const s = api.sessions.open(token, 'demo-folder');
    const codex = fake();
    codex.onTurn = async (ctx) => {
      ctx.reasoning();
      await ctx.inputsReach(2);
      ctx.agentMessage(`answered ${ctx.inputs.length}`, 'final_answer');
      ctx.complete();
    };
    await start(codex);
    await waitFor(() => s.heartbeats.includes('online'));
    const first = api.sessions.postFrom(token, 'Count the files');
    await waitFor(() => codex.requests('turn/start').length === 1);
    const second = api.sessions.postFrom(token, 'Only the .ts ones');
    await waitFor(() => posts().length === 1);
    const steer = codex.requests('turn/steer')[0]!;
    expect(text(steer.input)).toBe('Only the .ts ones');
    expect(codex.requests('turn/start')).toHaveLength(1);
    expect(posts()[0]).toMatchObject({ text: 'answered 2', thread_id: second });
    await waitFor(() => s.typings.filter((t) => !t.typing).length >= 2);
    expect(s.typings.filter((t) => t.typing).map((t) => t.thread_id)).toEqual(
      expect.arrayContaining([first, second]),
    );
  });

  it('keeps the order of two close messages after a turn has ended: the first starts a turn, the second joins it', async () => {
    const s = api.sessions.open(token, 'demo-folder');
    const codex = fake();
    codex.onTurn = replyWith('first done');
    await start(codex);
    await waitFor(() => s.heartbeats.includes('online'));
    api.sessions.postFrom(token, 'Count to 30');
    await waitFor(() => posts().length === 1);
    codex.onTurn = async (ctx) => {
      await ctx.inputsReach(2);
      ctx.agentMessage(`saw ${ctx.inputs.map((i) => text(i)).join(' then ')}`, 'final_answer');
      ctx.complete();
    };
    // Both arrive in one poll, after the first turn completed.
    api.sessions.postFrom(token, 'Stop counting');
    const later = api.sessions.postFrom(token, 'Count to 200');
    await waitFor(() => posts().length === 2);
    const starts = codex.requests('turn/start');
    const steers = codex.requests('turn/steer');
    expect(starts.map((p) => text(p.input))).toEqual(['Count to 30', 'Stop counting']);
    expect(steers.map((p) => text(p.input))).toEqual(['Count to 200']);
    const second = codex.received.find(
      (m) =>
        m.method === 'turn/steer' &&
        (m.params as { expectedTurnId?: string }).expectedTurnId !== undefined,
    );
    expect(second).toBeDefined();
    expect(posts()[1]?.text).toBe('saw Stop counting then Count to 200');
    expect(s.messages[1]).toMatchObject({ thread_id: later });
  });

  it('starts a turn when the steer is refused, and the server joins it to the running turn', async () => {
    const s = api.sessions.open(token, 'demo-folder');
    const codex = fake();
    codex.failSteer.push({ code: -32600, message: 'no active turn to steer' });
    codex.onTurn = async (ctx) => {
      await ctx.inputsReach(2);
      ctx.agentMessage('joined', 'final_answer');
      ctx.complete();
    };
    await start(codex);
    await waitFor(() => s.heartbeats.includes('online'));
    api.sessions.postFrom(token, 'One');
    await waitFor(() => codex.requests('turn/start').length === 1);
    const second = api.sessions.postFrom(token, 'Two');
    await waitFor(() => posts().length === 1);
    expect(codex.requests('turn/steer')).toHaveLength(1);
    expect(codex.requests('turn/start')).toHaveLength(2);
    expect(posts()[0]).toMatchObject({ text: 'joined', thread_id: second });
  });

  it('interrupts the running turn: nothing is posted and "is writing" stops', async () => {
    const s = api.sessions.open(token, 'demo-folder');
    const codex = fake();
    codex.onTurn = async (ctx) => {
      ctx.reasoning();
      await ctx.interrupted();
    };
    const r = await start(codex);
    await waitFor(() => s.heartbeats.includes('online'));
    api.sessions.postFrom(token, 'Run the whole suite');
    await waitFor(() => r.bridge().runningTurn() !== undefined && s.typings.length > 0);
    const turn = r.bridge().runningTurn();
    expect(await r.bridge().interrupt()).toBe(true);
    expect(codex.requests('turn/interrupt')[0]).toEqual({
      threadId: codex.requests('turn/start')[0]!.threadId,
      turnId: turn,
    });
    await waitFor(() => r.bridge().runningTurn() === undefined);
    await r.bridge().idle();
    await waitFor(() => s.typings.at(-1)?.typing === false);
    expect(posts()).toHaveLength(0);
    expect(await r.bridge().interrupt()).toBe(false);
  });

  it("doesn't post the final answer when the model already replied in that thread", async () => {
    const s = api.sessions.open(token, 'demo-folder');
    const codex = fake();
    let go!: () => void;
    const gate = new Promise<void>((resolve) => (go = resolve));
    codex.onTurn = async (ctx) => {
      await gate;
      ctx.agentMessage('Posted it above.', 'final_answer');
      ctx.complete();
    };
    const r = await start(codex);
    await waitFor(() => s.heartbeats.includes('online'));
    const id = api.sessions.postFrom(token, 'Summarise the thread');
    await waitFor(() => r.bridge().runningTurn() !== undefined);
    // What reply does after posting in the thread.
    r.state().notePosted(id);
    go();
    await waitFor(() => logged(r, 'final answer not posted'));
    await r.bridge().idle();
    expect(posts()).toHaveLength(0);
    // A reply elsewhere doesn't count: the next turn's answer is posted.
    codex.onTurn = (ctx) => {
      r.state().notePosted('00000000-0000-4000-8000-000000000001');
      ctx.agentMessage('Here it is.', 'final_answer');
      ctx.complete();
    };
    api.sessions.postFrom(token, 'Again', { threadId: id });
    await waitFor(() => posts().length === 1);
    expect(posts()[0]).toMatchObject({ text: 'Here it is.', thread_id: id });
  });

  it('falls back to a message without a phase, then to the items of turn/completed; never posts commentary', async () => {
    const s = api.sessions.open(token, 'demo-folder');
    const codex = fake();
    codex.onTurn = (ctx) => {
      ctx.agentMessage('Thinking out loud.', 'commentary');
      ctx.agentMessage('An answer without a phase.', null);
      ctx.complete();
    };
    await start(codex);
    await waitFor(() => s.heartbeats.includes('online'));
    api.sessions.postFrom(token, 'First');
    await waitFor(() => posts().length === 1);
    expect(posts()[0]!.text).toBe('An answer without a phase.');

    codex.onTurn = (ctx) => {
      ctx.completeWithItems([
        {
          type: 'agentMessage',
          id: 'msg_items',
          text: 'From the turn itself.',
          phase: 'final_answer',
        },
      ]);
    };
    api.sessions.postFrom(token, 'Second');
    await waitFor(() => posts().length === 2);
    expect(posts()[1]!.text).toBe('From the turn itself.');

    codex.onTurn = (ctx) => {
      ctx.agentMessage('Only a note.', 'commentary');
      ctx.complete();
    };
    api.sessions.postFrom(token, 'Third');
    await waitFor(() => codex.requests('turn/start').length === 3);
    await waitFor(() => s.typings.at(-1)?.typing === false && s.acked === 3);
    expect(posts()).toHaveLength(2);
  });

  it('splits a long answer into posts of at most 4,000 characters', async () => {
    const s = api.sessions.open(token, 'demo-folder');
    const codex = fake();
    const long = Array.from({ length: 400 }, (_, i) => `Line ${i} of a long answer.`).join('\n');
    codex.onTurn = replyWith(long);
    const r = await start(codex);
    await waitFor(() => s.heartbeats.includes('online'));
    api.sessions.postFrom(token, 'Tell me everything');
    const parts = splitText(long).length;
    expect(parts).toBe(3);
    await waitFor(() => posts().length === parts);
    expect(logged(r, '"parts":3')).toBe(true);
    expect(posts().every((p) => p.text.length <= 4000)).toBe(true);
    expect(
      posts()
        .map((p) => p.text)
        .join('\n'),
    ).toBe(long);
  });

  it("doesn't post anything for a failed turn, and logs no content", async () => {
    const s = api.sessions.open(token, 'demo-folder');
    const codex = fake();
    codex.onTurn = (ctx) => {
      ctx.complete('failed', { message: 'Secret-looking model error text' });
    };
    const r = await start(codex);
    await waitFor(() => s.heartbeats.includes('online'));
    api.sessions.postFrom(token, 'Private words here');
    await waitFor(() => logged(r, 'codex turn failed'));
    await r.bridge().idle();
    await waitFor(() => s.typings.at(-1)?.typing === false);
    expect(posts()).toHaveLength(0);
    expect(r.logs.join('\n')).not.toContain('Private words here');
    expect(r.logs.join('\n')).not.toContain('Secret-looking');
  });
});

describe('buildit-mcp codex: "is writing" and server requests', () => {
  it('pauses "is writing" while Codex waits on an approval, and declines what the owner denies', async () => {
    const s = api.sessions.open(token, 'demo-folder');
    const codex = fake();
    let answer: Received | undefined;
    codex.onTurn = async (ctx) => {
      ctx.status(['waitingOnApproval']);
      answer = await ctx.request('item/commandExecution/requestApproval', {
        itemId: 'exec-1',
        startedAtMs: Date.now(),
        environmentId: 'local',
        command: 'echo hi',
        cwd: '/tmp/work',
        commandActions: [{ type: 'unknown', command: 'echo hi' }],
        availableDecisions: ['accept', 'cancel'],
      });
      ctx.status([]);
      ctx.agentMessage('The command was declined.', 'final_answer');
      ctx.complete();
    };
    const r = await start(codex);
    await waitFor(() => s.heartbeats.includes('online'));
    const id = api.sessions.postFrom(token, 'Run echo hi');
    await waitFor(() => api.sessions.approvals(token).length === 1);
    api.sessions.decideApproval(token, api.sessions.approvals(token)[0]!.id, 'deny');
    await waitFor(() => posts().some((m) => m.text === 'The command was declined.'));
    expect(answer).toMatchObject({ result: { decision: 'decline' } });
    // Start, pause, resume, stop. The indicator's notices are separate requests, so the first
    // three may reach the server in any order; the stop comes after the post.
    await waitFor(() => s.typings.length === 4);
    expect(s.typings.filter((t) => t.typing)).toHaveLength(2);
    expect(s.typings[3]?.typing).toBe(false);
    expect(s.typings.every((t) => t.thread_id === id)).toBe(true);
    expect(logged(r, 'codex approval answered')).toBe(true);
    expect(r.logs.join('\n')).not.toContain('echo hi');
  });

  it('answers every server request safely with approvals in the app off, and unknown ones with "method not found"', async () => {
    const s = api.sessions.open(token, 'demo-folder');
    const codex = fake();
    const answers: Record<string, Received> = {};
    codex.onTurn = async (ctx) => {
      const base = { itemId: 'item-1', startedAtMs: Date.now() };
      answers.fileChange = await ctx.request('item/fileChange/requestApproval', {
        ...base,
        reason: null,
      });
      answers.permissions = await ctx.request('item/permissions/requestApproval', {
        ...base,
        environmentId: null,
        cwd: '/tmp/work',
        reason: 'network',
        permissions: {},
      });
      answers.elicitation = await ctx.request('mcpServer/elicitation/request', {
        serverName: 'some_server',
        mode: 'form',
        _meta: null,
        message: 'Allow the tool?',
        requestedSchema: { type: 'object', properties: {} },
      });
      answers.input = await ctx.request('item/tool/requestUserInput', {
        itemId: 'call-1',
        questions: [],
        isBlocking: true,
        autoResolutionMs: null,
      });
      answers.dynamic = await ctx.request('item/tool/call', {
        callId: 'call-2',
        namespace: null,
        tool: 'nothing',
        arguments: {},
      });
      answers.clock = await ctx.request('currentTime/read', {});
      answers.attestation = await ctx.request('attestation/generate', {});
      answers.unknown = await ctx.request('something/brandNew', {});
      ctx.agentMessage('done', 'final_answer');
      ctx.complete();
    };
    await start(codex, { approvals: { inApp: false, timeoutMinutes: 60 } });
    await waitFor(() => s.heartbeats.includes('online'));
    api.sessions.postFrom(token, 'Do things');
    await waitFor(() => posts().length === 1);
    expect(answers.fileChange?.result).toEqual({ decision: 'decline' });
    expect(answers.permissions?.result).toEqual({ permissions: {}, scope: 'turn' });
    expect(answers.elicitation?.result).toMatchObject({ action: 'decline' });
    expect(answers.input?.result).toEqual({ answers: {} });
    expect(answers.dynamic?.result).toEqual({ contentItems: [], success: false });
    const now = Math.floor(Date.now() / 1000);
    const clock = (answers.clock?.result as { currentTimeAt: number }).currentTimeAt;
    expect(Math.abs(clock - now)).toBeLessThan(5);
    expect(answers.attestation?.error).toMatchObject({ code: -32601 });
    expect(answers.unknown?.error).toMatchObject({ code: -32601 });
  });

  it('tolerates unknown notifications, unknown fields and lines that are not JSON', async () => {
    const s = api.sessions.open(token, 'demo-folder');
    const codex = fake();
    codex.onTurn = (ctx) => {
      codex.sendLine('this is not json');
      codex.sendLine('[1, 2, 3]');
      codex.sendRaw({ method: 'thread/somethingNew', params: { threadId: ctx.threadId, x: 1 } });
      codex.sendRaw({ method: 'item/completed', params: { threadId: ctx.threadId } });
      codex.sendRaw({
        method: 'item/completed',
        params: {
          threadId: ctx.threadId,
          turnId: ctx.turnId,
          completedAtMs: Date.now(),
          brandNewField: { nested: true },
          item: {
            type: 'agentMessage',
            id: 'msg_new',
            text: 'Still understood.',
            phase: 'final_answer',
            futureField: 42,
          },
        },
      });
      codex.sendRaw({
        method: 'item/completed',
        params: {
          threadId: ctx.threadId,
          turnId: ctx.turnId,
          item: { type: 'brandNewItem', id: 'x' },
        },
      });
      ctx.complete();
    };
    const r = await start(codex);
    await waitFor(() => s.heartbeats.includes('online'));
    api.sessions.postFrom(token, 'Go');
    await waitFor(() => posts().length === 1);
    expect(posts()[0]!.text).toBe('Still understood.');
    expect(logged(r, 'not JSON')).toBe(true);
    expect(r.logs.join('\n')).not.toContain('this is not json');
  });

  it("tells the owner once, in the direct message, that it can't take requests yet", async () => {
    const s = api.sessions.open(token, 'demo-folder');
    const codex = fake();
    await start(codex);
    await waitFor(() => s.heartbeats.includes('online'));
    api.sessions.pushRequest(token, { kind: 'catch_up' });
    api.sessions.pushRequest(token, { kind: 'catch_up' });
    await waitFor(() => s.acked === 2);
    await waitFor(() => posts().length === 1);
    // A new message of the direct message: a note about the request, not its result.
    expect(posts()[0]).toMatchObject({ text: REQUESTS_NOTICE, thread_id: null });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(posts()).toHaveLength(1);
    expect(codex.requests('turn/start')).toHaveLength(0);
  });

  it('gives events no conversation takes no post and no turn', async () => {
    const s = api.sessions.open(token, 'demo-folder');
    const codex = fake();
    const r = await start(codex);
    await waitFor(() => s.heartbeats.includes('online'));
    const elsewhere = '00000000-0000-4000-8000-000000000004';
    const metas: Record<string, string>[] = [
      { event: 'plan_resolved', thread_id: elsewhere, outcome: 'applied' },
      { event: 'item_unassigned', thread_id: elsewhere, item: 'DEMO-9' },
      { event: 'child_done', thread_id: elsewhere },
      { event: 'something_new', thread_id: elsewhere },
    ];
    for (const meta of metas) {
      await r.bridge().handle({ content: 'x', meta });
    }
    expect(posts()).toHaveLength(0);
    expect(codex.requests('turn/start')).toHaveLength(0);
    expect(logged(r, 'not handled by the Codex bridge')).toBe(true);
  });

  it('routes notices: requests to the direct message, nothing else', () => {
    expect(noticeFor({ content: '', meta: { event: 'mention', thread_id: 't' } })).toBe(undefined);
    expect(noticeFor({ content: '', meta: { event: 'request', thread_id: 't' } })).toEqual({
      key: 'requests',
      text: REQUESTS_NOTICE,
      threadId: undefined,
    });
    expect(noticeFor({ content: '', meta: { event: 'item_unassigned', thread_id: 't' } })).toBe(
      undefined,
    );
    expect(noticeFor({ content: '', meta: { event: 'message' } })).toBe(undefined);
  });
});

describe('buildit-mcp codex: restarts', () => {
  it("resumes the conversation's thread after a restart, without its turns", async () => {
    const home = new CodexHome();
    const s = api.sessions.open(token, 'demo-folder');
    const first = fake({}, home);
    const r1 = await start(first);
    await waitFor(() => s.heartbeats.includes('online'));
    api.sessions.postFrom(token, 'Remember 42');
    await waitFor(() => posts().length === 1);
    const threadId = first.requests('turn/start')[0]!.threadId as string;
    expect(await r1.stop()).toBe(0);
    expect(s.heartbeats.at(-1)).toBe('offline');
    await first.process.exited;
    const map = readMap(join(lockDir, `${sessionKey(folder, api.url)}.codex-threads.json`));
    expect(map.threads.dm).toMatchObject({ codex_thread_id: threadId, has_turn: true });

    const second = fake({}, home);
    second.onTurn = replyWith('42');
    await start(second);
    await waitFor(() => s.heartbeats.filter((h) => h === 'online').length === 2);
    api.sessions.postFrom(token, 'What was it?');
    await waitFor(() => posts().length === 2);
    expect(second.requests('thread/resume')).toEqual([
      { threadId, excludeTurns: true, config: expect.any(Object) as unknown },
    ]);
    expect(second.requests('thread/start')).toHaveLength(0);
    expect(second.requests('turn/start')[0]!.threadId).toBe(threadId);
    expect(posts()[1]!.text).toBe('42');
  });

  it('starts a fresh thread when the saved one never had a turn, or cannot be resumed', async () => {
    const s = api.sessions.open(token, 'demo-folder');
    const mapFile = join(lockDir, `${sessionKey(folder, api.url)}.codex-threads.json`);
    mkdirSync(lockDir, { recursive: true });
    const write = (hasTurn: boolean): void => {
      writeFileSync(
        mapFile,
        JSON.stringify({
          v: 1,
          session_id: s.id,
          threads: {
            dm: {
              codex_thread_id: 'never-saved',
              has_turn: hasTurn,
              updated_at: '2026-11-01T00:00:00Z',
            },
          },
        }),
      );
    };
    write(false);
    const a = fake();
    const r1 = await start(a);
    await waitFor(() => s.heartbeats.includes('online'));
    api.sessions.postFrom(token, 'One');
    await waitFor(() => posts().length === 1);
    expect(a.requests('thread/resume')).toHaveLength(0);
    expect(a.requests('thread/start')).toHaveLength(1);
    await r1.stop();

    write(true);
    const b = fake();
    await start(b);
    await waitFor(() => s.heartbeats.filter((h) => h === 'online').length === 2);
    api.sessions.postFrom(token, 'Two');
    await waitFor(() => posts().length === 2);
    expect(b.requests('thread/resume')).toEqual([
      { threadId: 'never-saved', excludeTurns: true, config: expect.any(Object) as unknown },
    ]);
    expect(b.requests('thread/start')).toHaveLength(1);
    const map = readMap(mapFile);
    expect(map.threads.dm?.codex_thread_id).not.toBe('never-saved');
  });

  it("ignores another session's thread map", async () => {
    const s = api.sessions.open(token, 'demo-folder');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, `${sessionKey(folder, api.url)}.codex-threads.json`),
      JSON.stringify({
        v: 1,
        session_id: 'another-session',
        threads: { dm: { codex_thread_id: 't', has_turn: true } },
      }),
    );
    const codex = fake();
    await start(codex);
    await waitFor(() => s.heartbeats.includes('online'));
    api.sessions.postFrom(token, 'Hi');
    await waitFor(() => posts().length === 1);
    expect(codex.requests('thread/resume')).toHaveLength(0);
  });
});

describe('buildit-mcp codex: the process', () => {
  it('stops with exit code 1 when the app-server exits', async () => {
    const s = api.sessions.open(token, 'demo-folder');
    const codex = fake();
    const r = await start(codex);
    await waitFor(() => s.heartbeats.includes('online'));
    codex.exit(1);
    expect(await r.done).toBe(1);
    expect(s.heartbeats.at(-1)).toBe('offline');
  });

  it('leaves an event unacknowledged when the app-server is gone before it took it', async () => {
    const s = api.sessions.open(token, 'demo-folder');
    const codex = fake();
    codex.hangTurnStart = true;
    const r = await start(codex);
    await waitFor(() => s.heartbeats.includes('online'));
    api.sessions.postFrom(token, 'Hello');
    await waitFor(() => codex.requests('turn/start').length === 1);
    codex.exit(1);
    expect(await r.done).toBe(1);
    expect(s.acked).toBe(0);
  });

  it('refuses a Codex older than it supports, and warns about one newer than it was tested on', async () => {
    api.sessions.open(token, 'demo-folder');
    const old = fake({ version: '0.150.0' });
    const r = await start(old);
    expect(await r.done).toBe(2);
    expect(r.err.join('')).toContain('older than this bridge supports');
    // initialized is never sent to a Codex it won't use.
    expect(old.notifications('initialized')).toHaveLength(0);
    running.splice(0);

    const s = session();
    const newer = fake({ version: '0.170.1' });
    const r2 = await start(newer);
    await waitFor(() => s.heartbeats.includes('online'));
    expect(logged(r2, 'newer than the ones the bridge was tested on')).toBe(true);
  });

  it('needs a saved session, or --project to connect first', async () => {
    const codex = fake();
    const r = await start(codex, {}, {}, false);
    expect(await r.done).toBe(2);
    expect(r.err.join('')).toContain('--project <KEY>');
    expect(codex.args).toBeUndefined();
  });

  it("refuses to start when another server holds the folder's channel", async () => {
    api.sessions.open(token, 'demo-folder');
    const held = acquireChannelLock(folder, api.url, {
      plugin: true,
      dir: lockDir,
      // Another live process holds it.
      pid: process.ppid,
      releaseOnExit: false,
    });
    expect(held).toBeDefined();
    try {
      const codex = fake();
      const r = await start(codex);
      expect(await r.done).toBe(2);
      expect(r.err.join('')).toContain('receives this folder');
    } finally {
      held?.release();
    }
  });
});

describe('the bridge parts', () => {
  it('splits text at paragraphs, lines or words, and cuts what has no break', () => {
    expect(splitText('short', 10)).toEqual(['short']);
    expect(splitText('aaaa bbbb cccc', 10)).toEqual(['aaaa bbbb', 'cccc']);
    expect(splitText('aaaaaa\n\nbbbbbb', 10)).toEqual(['aaaaaa', 'bbbbbb']);
    expect(splitText('x'.repeat(25), 10)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
    expect(splitText('   ', 10)).toEqual([]);
  });

  it('makes the same UUID from the same name', () => {
    const a = stableUuid('s:t:i:0');
    expect(a).toBe(stableUuid('s:t:i:0'));
    expect(a).not.toBe(stableUuid('s:t:i:1'));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('picks the last final answer, else the last message without a phase', () => {
    expect(
      answerOf([
        { id: '1', phase: 'final_answer', text: 'first' },
        { id: '2', phase: 'commentary', text: 'note' },
        { id: '3', phase: 'final_answer', text: 'last' },
      ])?.text,
    ).toBe('last');
    expect(
      answerOf([
        { id: '1', phase: null, text: 'plain' },
        { id: '2', phase: 'commentary', text: 'n' },
      ])?.text,
    ).toBe('plain');
    expect(answerOf([{ id: '1', phase: 'commentary', text: 'n' }])).toBeUndefined();
    expect(answerOf([{ id: '1', phase: 'final_answer', text: '  ' }])).toBeUndefined();
  });

  it('routes plain direct messages to the direct message', async () => {
    const router = new SessionRouter({
      has: () => false,
      parentOf: () => Promise.resolve(null),
      isItemThread: () => false,
    });
    expect(await router.route({ content: 'x', meta: { thread_id: 't', message_id: 'm' } })).toEqual(
      { key: 'dm', place: { kind: 'dm' }, threadId: 't', messageId: 'm', event: undefined },
    );
    expect(await router.route({ content: 'x', meta: {} })).toEqual({ dropped: 'no_thread' });
  });
});
