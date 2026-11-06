/**
 * The plugin's hooks over the hooks bridge: the forwarder
 * (plugin/hooks/forward.mjs) and the server's endpoint
 * (src/channel/hook-bridge.ts). The forwarder exits at once and silently
 * when nothing listens; a listening server gets the hook's input, takes
 * only its own Claude Code's hooks and only the shapes it expects, and
 * cleans up after itself. Then the real hook tools through the bridge.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  AncestorGate,
  ancestorChain,
  folderKey,
  HookBridge,
  hookDir,
  hookFolder,
  MAX_MESSAGE_BYTES,
  parseHookMessage,
  readAncestors,
  readRendezvous,
  rendezvousFile,
  socketTag,
  type HookDispatch,
} from '../src/channel/hook-bridge.js';
import { inputHash } from '../src/channel/tool-ring.js';
import { createLogger } from '../src/log.js';
import { defaultTokenFile } from '../src/secrets/keychain.js';
import { approvalIdForToolUse, permissionAllow } from '../src/tools/approve.js';
import { channelConfig, channelNotes, startChannel, waitFor } from './support/channel-harness.js';
import { FakeApi } from './support/fake-api.js';
import { SESSION_TOKENS } from './support/fake-sessions.js';

const FORWARD = resolve('plugin/hooks/forward.mjs');

interface ForwardModule {
  hookDir(env: Record<string, string | undefined>, platform: string): string;
  folderKey(folder: string, platform: string): string;
  socketTag(socket: string | undefined): string | undefined;
  hookArgs(hook: string, input: unknown): Record<string, unknown>;
  claudePids(env: Record<string, string | undefined>, ppid: number): number[];
  forward(
    hook: string,
    raw: string | undefined,
    env: Record<string, string | undefined>,
    options?: { dir?: string; ppid?: number; connectTimeoutMs?: number },
  ): Promise<string | undefined>;
}

let fwd: ForwardModule;
let home: string;
const logs: string[] = [];
const logger = createLogger({ level: 'debug', sink: (l) => logs.push(l) });
const bridges: HookBridge[] = [];

beforeAll(async () => {
  fwd = (await import(pathToFileURL(FORWARD).href)) as ForwardModule;
});
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'buildit-mcp-hooks-'));
  logs.length = 0;
});
afterEach(async () => {
  await Promise.all(bridges.splice(0).map((b) => b.close()));
  rmSync(home, { recursive: true, force: true });
});

const PROJECT = (): string => join(home, 'project');
const DIR = (): string => join(home, 'hooks');
/** The environment a hook gets from Claude Code (made-up values). */
const hookEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  CLAUDE_PROJECT_DIR: PROJECT(),
  CLAUDE_PID: '4242',
  ...extra,
});

async function bridge(
  dispatch: HookDispatch,
  init: {
    ancestors?: number[] | undefined;
    own?: { tag?: string; sessionId?: string };
    owns?: () => boolean;
    checkEveryMs?: number;
    dir?: string;
  } = {},
): Promise<HookBridge> {
  const b = new HookBridge({
    folder: PROJECT(),
    dir: init.dir ?? DIR(),
    socketDir: join(home, 's'),
    logger,
    dispatch,
    ancestors: () => Promise.resolve('ancestors' in init ? init.ancestors : [4242, 1000]),
    own: { tag: undefined, sessionId: undefined, ...init.own },
    ...(init.owns === undefined ? {} : { owns: init.owns }),
    ...(init.checkEveryMs === undefined ? {} : { checkEveryMs: init.checkEveryMs }),
  });
  bridges.push(b);
  expect(await b.start()).toBe(true);
  return b;
}

/** Runs the forwarder as Claude Code does: node forward.mjs <hook>, the input on stdin. */
function runForwarder(
  hook: string,
  input: unknown,
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn(process.execPath, [FORWARD, hook], {
      env: {
        PATH: process.env.PATH ?? '',
        SystemRoot: process.env.SystemRoot ?? '',
        APPDATA: home,
        HOME: home,
        XDG_CONFIG_HOME: home,
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => {
      done({ code, stdout, stderr, ms: Date.now() - started });
    });
    child.stdin.end(JSON.stringify(input));
  });
}

/** The rendezvous folder the forwarder computes for `home`, for this platform. */
const childDir = (): string =>
  hookDir({ APPDATA: home, XDG_CONFIG_HOME: home }, process.platform).replace(
    /^.*Library[\\/]Application Support/,
    join(home, 'Library', 'Application Support'),
  );

/** Sends raw bytes to an endpoint and reads the answer. */
function rawSend(endpoint: string, data: string | Buffer): Promise<string> {
  return new Promise((done) => {
    const socket = connect(endpoint);
    let out = '';
    socket.on('data', (d: Buffer) => (out += d.toString()));
    socket.on('error', () => {
      done(out);
    });
    socket.on('close', () => {
      done(out);
    });
    socket.write(data);
  });
}

const PRE_TOOL_USE = {
  session_id: 'claude-session-1',
  transcript_path: '/tmp/t.jsonl',
  cwd: '/tmp/elsewhere',
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'npm test', description: 'Run the tests' },
  tool_use_id: 'toolu_01',
};

describe('the forwarder and the server agree', () => {
  it('on the rendezvous folder and the folder key, on every platform', () => {
    const envs = [
      {},
      { APPDATA: 'D:\\Profiles\\Test User\\Roaming' },
      { XDG_CONFIG_HOME: '/srv/test/.cfg' },
    ];
    for (const env of envs) {
      expect(fwd.hookDir(env, process.platform)).toBe(hookDir(env));
      expect(hookDir(env)).toBe(join(dirname(defaultTokenFile(env)), 'hooks'));
    }
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      for (const folder of ['C:\\Work\\Demo', 'c:\\work\\demo\\', '/srv/test/demo', '/w/a b/']) {
        expect(fwd.folderKey(folder, platform)).toBe(folderKey(folder, platform));
      }
    }
    expect(folderKey('C:\\Work\\Demo', 'win32')).toBe(folderKey('c:\\work\\demo\\', 'win32'));
    expect(folderKey('/w/Demo', 'linux')).not.toBe(folderKey('/w/demo', 'linux'));
    expect(fwd.socketTag('\\\\.\\pipe\\LOCAL\\x')).toBe(socketTag('\\\\.\\pipe\\LOCAL\\x'));
    expect(socketTag('')).toBeUndefined();
    expect(fwd.socketTag(undefined)).toBeUndefined();
  });

  it("takes Claude Code's project folder over its own", () => {
    expect(hookFolder('/srv/x', { CLAUDE_PROJECT_DIR: '/w/demo' })).toBe('/w/demo');
    expect(hookFolder('/srv/x', { CLAUDE_PROJECT_DIR: ' ' })).toBe('/srv/x');
    expect(hookFolder('/srv/x', {})).toBe('/srv/x');
  });

  it("passes each hook tool the fields the plugin's MCP hooks passed", () => {
    expect(fwd.hookArgs('tool_seen', PRE_TOOL_USE)).toEqual({
      tool_name: 'Bash',
      tool_input: PRE_TOOL_USE.tool_input,
      tool_use_id: 'toolu_01',
    });
    expect(fwd.hookArgs('tool_done', { tool_use_id: 't', agent_id: 'a' })).toEqual({
      tool_use_id: 't',
      agent_id: 'a',
    });
    expect(fwd.hookArgs('agent_done', { agent_id: 'a', agent_type: 'Explore' })).toEqual({
      agent_id: 'a',
      agent_type: 'Explore',
    });
    // Only the prompt's start: whether the person typed it.
    expect(
      fwd.hookArgs('prompt_typed', { prompt: `   <channel source="x">${'y'.repeat(500)}` }),
    ).toEqual({
      prompt: `<channel source="x">${'y'.repeat(44)}`,
    });
    expect(fwd.hookArgs('turn_ended', { stop_hook_active: false })).toEqual({});
    expect(
      fwd.hookArgs('approve', {
        ...PRE_TOOL_USE,
        hook_event_name: 'PermissionRequest',
        agent_id: 'agent-1',
        agent_type: 'Explore',
        prompt_id: 'p-1',
        permission_suggestions: [{ type: 'addRules' }],
        permission_mode: 'default',
      }),
    ).toEqual({
      tool_name: 'Bash',
      tool_input: PRE_TOOL_USE.tool_input,
      tool_use_id: 'toolu_01',
      agent_id: 'agent-1',
      agent_type: 'Explore',
      session_id: 'claude-session-1',
      prompt_id: 'p-1',
      suggestions: [{ type: 'addRules' }],
      mode: 'default',
    });
    const questions = [{ question: 'Which?', header: 'Pick', options: [] }];
    expect(
      fwd.hookArgs('ask', {
        ...PRE_TOOL_USE,
        tool_name: 'AskUserQuestion',
        tool_input: { questions },
      }),
    ).toEqual({
      questions,
      tool_use_id: 'toolu_01',
      session_id: 'claude-session-1',
      format: 'hook',
    });
    expect(fwd.claudePids({ CLAUDE_PID: '4242' }, 4242)).toEqual([4242]);
    expect(fwd.claudePids({ CLAUDE_PID: 'x' }, 77)).toEqual([77]);
    expect(fwd.claudePids({ CLAUDE_PID: '1' }, 1)).toEqual([]);
  });
});

describe('the forwarder', () => {
  it('exits 0 at once, printing nothing, when no server listens for the folder', async () => {
    for (const hook of ['tool_seen', 'approve', 'turn_ended', 'unknown_hook']) {
      const r = await runForwarder(hook, PRE_TOOL_USE, hookEnv());
      expect(r, hook).toMatchObject({ code: 0, stdout: '', stderr: '' });
      expect(r.ms, hook).toBeLessThan(3000);
    }
  });

  it('exits 0 quickly when the rendezvous file names an endpoint nobody listens on', async () => {
    // The forwarder reads the folder that this platform's paths give for `home`.
    const dir = childDir();
    const file = rendezvousFile(PROJECT(), dir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const endpoint =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\buildit-mcp-hooks-${'0'.repeat(32)}`
        : join(dir, `${'0'.repeat(16)}.sock`);
    writeFileSync(file, JSON.stringify({ v: 1, endpoint, pid: 99999 }), { mode: 0o600 });
    const r = await runForwarder('tool_seen', PRE_TOOL_USE, hookEnv());
    expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(r.ms).toBeLessThan(3000);
  });

  it('exits 0 silently on input that is not JSON, and without a folder', async () => {
    expect(await fwd.forward('tool_seen', 'not json', hookEnv())).toBeUndefined();
    expect(await fwd.forward('tool_seen', '{}', {})).toBeUndefined();
    expect(await fwd.forward('tool_seen', undefined, hookEnv())).toBeUndefined();
  });

  it("delivers the hook to a listening server, and prints only a deciding hook's answer", async () => {
    const got: { hook: string; args: Record<string, unknown> }[] = [];
    await bridge(
      (hook, args) => {
        got.push({ hook, args });
        return Promise.resolve(hook === 'approve' ? permissionAllow() : '{}');
      },
      { dir: childDir(), ancestors: [4242] },
    );
    const seen = await runForwarder('tool_seen', PRE_TOOL_USE, hookEnv());
    expect(seen).toMatchObject({ code: 0, stdout: '', stderr: '' });
    const approved = await runForwarder(
      'approve',
      { ...PRE_TOOL_USE, hook_event_name: 'PermissionRequest' },
      hookEnv(),
    );
    expect(approved).toMatchObject({ code: 0, stdout: permissionAllow(), stderr: '' });
    expect(got.map((g) => g.hook)).toEqual(['tool_seen', 'approve']);
    expect(got[0]?.args).toEqual(fwd.hookArgs('tool_seen', PRE_TOOL_USE));
    // Another Claude Code in the same folder: not this server's.
    const other = await runForwarder('tool_seen', PRE_TOOL_USE, hookEnv({ CLAUDE_PID: '5555' }));
    expect(other).toMatchObject({ code: 0, stdout: '' });
    expect(got).toHaveLength(2);
  });
});

describe('the server side', () => {
  it('opens a private endpoint, names it in a private rendezvous file, and removes both on close', async () => {
    const b = await bridge(() => Promise.resolve(undefined));
    const rendezvous = readRendezvous(b.rendezvousFile);
    expect(rendezvous?.pid).toBe(process.pid);
    expect(rendezvous?.endpoint).toBe(b.listening);
    if (process.platform === 'win32') {
      expect(rendezvous?.endpoint).toMatch(/^\\\\\.\\pipe\\buildit-mcp-hooks-[0-9a-f]{32}$/);
    } else {
      expect(statSync(DIR()).mode & 0o777).toBe(0o700);
      expect(statSync(b.rendezvousFile).mode & 0o777).toBe(0o600);
      expect(statSync(rendezvous!.endpoint).mode & 0o077).toBe(0);
    }
    await b.close();
    expect(existsSync(b.rendezvousFile)).toBe(false);
    if (process.platform !== 'win32') expect(existsSync(rendezvous!.endpoint)).toBe(false);
    expect(await rawSend(rendezvous!.endpoint, '{}\n')).toBe('');
  });

  it("leaves a rendezvous file that names another server's endpoint", async () => {
    const b = await bridge(() => Promise.resolve(undefined));
    const other = { v: 1, endpoint: '\\\\.\\pipe\\buildit-mcp-hooks-other', pid: 1234 };
    writeFileSync(b.rendezvousFile, JSON.stringify(other));
    await b.close();
    expect(readRendezvous(b.rendezvousFile)).toEqual(other);
  });

  it('closes once another server is the channel', async () => {
    let owner = true;
    const b = await bridge(() => Promise.resolve(undefined), {
      owns: () => owner,
      checkEveryMs: 20,
    });
    owner = false;
    await waitFor(() => b.listening === undefined);
    expect(existsSync(b.rendezvousFile)).toBe(false);
  });

  it('takes only the shapes it expects', async () => {
    const calls: string[] = [];
    const b = await bridge((hook) => {
      calls.push(hook);
      return Promise.resolve('{}');
    });
    const endpoint = b.listening!;
    const ok = { v: 1, hook: 'tool_done', pids: [4242], args: { tool_use_id: 't' } };
    expect(JSON.parse(await rawSend(endpoint, `${JSON.stringify(ok)}\n`))).toEqual({
      ok: true,
      text: '{}',
    });
    for (const bad of [
      'not json',
      JSON.stringify({ ...ok, v: 2 }),
      JSON.stringify({ ...ok, hook: 'whoami' }),
      JSON.stringify({ ...ok, extra: true }),
      JSON.stringify({ ...ok, pids: 'x' }),
      JSON.stringify({ ...ok, pids: [1, 2, 3, 4, 5] }),
      JSON.stringify({ ...ok, tag: 'not-a-hash' }),
      JSON.stringify({ ...ok, args: [] }),
    ]) {
      expect(JSON.parse(await rawSend(endpoint, `${bad}\n`)), bad).toEqual({ ok: false });
    }
    // Too large: the connection is dropped without an answer.
    const big = Buffer.alloc(MAX_MESSAGE_BYTES + 1024, 0x20);
    expect(await rawSend(endpoint, big)).toBe('');
    expect(calls).toEqual(['tool_done']);
    expect(parseHookMessage(JSON.stringify(ok))?.hook).toBe('tool_done');
  });

  it('aborts a waiting hook when the forwarder goes away (Claude Code cancelled it)', async () => {
    let aborted = false;
    const b = await bridge(
      (_hook, _args, signal) =>
        new Promise((done) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            done(undefined);
          });
        }),
    );
    const socket = connect(b.listening!);
    socket.on('error', () => undefined);
    socket.write(`${JSON.stringify({ v: 1, hook: 'approve', pids: [4242], args: {} })}\n`);
    await new Promise((r) => setTimeout(r, 100));
    socket.destroy();
    await waitFor(() => aborted);
  });
});

describe("which Claude Code's hooks a server takes", () => {
  it('its ancestors, the nearest named from then on', () => {
    const gate = new AncestorGate({ ancestors: [300, 200, 100] });
    expect(gate.accepts({ pids: [999] })).toBe(false);
    expect(gate.accepts({ pids: [100] })).toBe(true);
    expect(gate.accepts({ pids: [999, 200] })).toBe(true);
    // A nearer one was seen: the farther ancestor is another Claude Code.
    expect(gate.accepts({ pids: [100] })).toBe(false);
    expect(gate.accepts({ pids: [200] })).toBe(true);
  });

  it('the same messaging socket or starting session: those process ids are its own from then on', () => {
    const tag = socketTag('\\\\.\\pipe\\LOCAL\\cc-msg-test')!;
    const gate = new AncestorGate({ ancestors: [100], tag, sessionId: 'session-a' });
    expect(gate.accepts({ pids: [500], tag: socketTag('other') })).toBe(false);
    expect(gate.accepts({ pids: [500], tag })).toBe(true);
    // After /clear: another session id, the same Claude Code.
    expect(gate.accepts({ pids: [500], session_id: 'session-b' })).toBe(true);
    expect(gate.accepts({ pids: [600], session_id: 'session-a' })).toBe(true);
    expect(gate.accepts({ pids: [700], session_id: 'session-c' })).toBe(false);
  });

  it('every hook when it knows nothing to tell them apart by', () => {
    const gate = new AncestorGate({ ancestors: undefined });
    expect(gate.known).toBe(false);
    expect(gate.accepts({ pids: [] })).toBe(true);
  });

  it('reads the chain of parents, stopping at a reused process id', async () => {
    const table = new Map([
      [10, { ppid: 20, created: 5n }],
      [20, { ppid: 30, created: 4n }],
      // 30 was 20's parent once; this 30 started later, so it is another process.
      [30, { ppid: 40, created: 9n }],
      [40, { ppid: 1, created: 1n }],
    ]);
    expect(ancestorChain(10, table)).toEqual([20]);
    expect(
      ancestorChain(
        10,
        new Map([
          [10, { ppid: 20 }],
          [20, { ppid: 10 }],
        ]),
      ),
    ).toEqual([20]);
    expect(ancestorChain(10, new Map([[10, { ppid: 20 }]]))).toEqual([20]);
    // This machine's own chain includes the test runner's parent.
    const own = await readAncestors();
    expect(own).toBeDefined();
    expect(own?.[0]).toBe(process.ppid);
  }, 30_000);
});

describe('the hook tools through the bridge', () => {
  const TOKEN = SESSION_TOKENS.first;
  let api: FakeApi;
  const stops: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    api = await new FakeApi().start();
  });
  afterAll(async () => {
    await api.close();
  });
  afterEach(async () => {
    await Promise.all(stops.splice(0).map((stop) => stop()));
    expect(api.violations).toEqual([]);
  });

  it('tool_seen names the call for approve, and approve answers through the forwarder', async () => {
    api.reset();
    api.sessions.open(TOKEN);
    const c = await startChannel(api, stops, {
      config: channelConfig(api),
      stdio: {
        approve: { msPerSecond: 2 },
        typing: { everyMs: 60_000 },
        hooks: {
          folder: PROJECT(),
          dir: DIR(),
          socketDir: join(home, 's'),
          ancestors: () => Promise.resolve([4242]),
          own: {},
        },
      },
    });
    await waitFor(() => api.sessions.session(TOKEN).heartbeats.includes('online'));
    api.sessions.postFrom(TOKEN, 'Go on.');
    await waitFor(() => channelNotes(c.notes).length === 1);
    await waitFor(() => existsSync(rendezvousFile(PROJECT(), DIR())));
    const env = hookEnv();
    expect(await fwd.forward('tool_seen', JSON.stringify(PRE_TOOL_USE), env, { dir: DIR() })).toBe(
      undefined,
    );
    const permission = {
      ...PRE_TOOL_USE,
      hook_event_name: 'PermissionRequest',
      tool_use_id: undefined,
      permission_mode: 'default',
    };
    const pending = fwd.forward('approve', JSON.stringify(permission), env, { dir: DIR() });
    await waitFor(() => api.sessions.approvals(TOKEN).length === 1);
    const card = api.sessions.approvals(TOKEN)[0]!;
    expect(card.id).toBe(
      approvalIdForToolUse('toolu_01', '', 'Bash', inputHash(PRE_TOOL_USE.tool_input)),
    );
    api.sessions.decideApproval(TOKEN, card.id, 'approve');
    expect(await pending).toBe(permissionAllow());
    // The Stop hook: nothing printed, the turn ends.
    expect(await fwd.forward('turn_ended', '{}', env, { dir: DIR() })).toBeUndefined();
  });
});
