/**
 * The Codex bridge's smoke test against the REAL `codex app-server`: it
 * runs model turns on the person's Codex plan, so a maintainer runs it by
 * hand, only with the plan owner's yes. buildIt.Social's side is the
 * in-process fake API (nothing reaches a real buildIt.Social server).
 *
 *   npx tsx scripts/codex-smoke.ts --approved --model <id> --cwd <empty folder>
 *   npx tsx scripts/codex-smoke.ts --preflight-only --model <id> --cwd <empty folder>
 *                                   (the free checks below, then stop: no turn)
 *   npx tsx scripts/codex-smoke.ts --dry-run --model x --cwd <empty folder>
 *                                   (everything against the fake app-server: no Codex, no turn)
 *   npx tsx scripts/codex-smoke.ts --approved --only steer --model <id> --cwd <empty folder>
 *                                   (step 2 alone: 1 turn, at most 2)
 *   npx tsx scripts/codex-smoke.ts --approved --only parity --model <id> --cwd <empty folder>
 *                                   (the hosted tools, approvals and files: 4 turns, at most 5;
 *                                   see "Parity" below)
 *
 * Four turns, at most five (the script stops before a sixth):
 *   1. reply      "Reply with the single word pong."  -> a post
 *   2. steer      a slow count and "reply steered", posted at once: the second is
 *                 steered into the turn the first started -> one post, "steered"
 *   3. interrupt  a slow count, interrupted -> no post
 *   4. resume     the bridge restarts (a new app-server); a question about turn 1 ->
 *                 thread/resume {excludeTurns: true}, then a post
 *
 * Lean threads: `-c model=<id>`, `model_reasoning_effort="low"`,
 * `model_reasoning_summary="none"`, `features.plugins=false`,
 * `features.apps=false`, and `mcp_servers.<name>.enabled=false` for each
 * MCP server still configured. Before any turn it checks, for free
 * (initialize, model/list, an ephemeral thread/start, mcpServerStatus/list
 * and skills/list), that the model exists and no MCP tool is left; it
 * stops otherwise. Each step checks what the wire shows (the steer named
 * the running turn, the interrupted status, the resume) and the report says
 * OK or FAIL (exit 1 on a failure). The folder must be
 * empty and stay so (the turns ask for nothing that writes). The JSON-RPC
 * transcript and a report go to --out (default <tmp>/codex-smoke), never
 * into the repository.
 *
 * Parity (--only parity): four turns, at most five, with Codex asking
 * before anything that writes (`approval_policy="on-request"`,
 * `approvals_reviewer="user"`, `sandbox_mode="read-only"`: a write needs
 * the sandbox lifted, which Codex asks for; Codex 0.166 refuses to start
 * with the old `untrusted` policy). The in-process owner answers every
 * approval card itself (no one taps):
 *   A. tools + image  an image attached; "call whoami, then post with reply" ->
 *                     a localImage input, whoami and reply over the hosted tools,
 *                     the reply in the message's own thread, no second post
 *   B. approve + file a shell command that writes out.txt, approved on its card ->
 *                     out.txt written, then shared with reply's files
 *   C. deny           a command, denied on its card -> declined, nothing written
 *   D. file change    a file made with Codex's edit tool -> a file_change card
 *                     with its diff, approved -> the file written
 * This one writes in the folder (out.txt, hello.txt): give it a throwaway one.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

import { ApiClient } from '../src/api/client.js';
import { getSession } from '../src/channel/api.js';
import { ChannelState } from '../src/channel/loop.js';
import { runCodex } from '../src/cli/codex.js';
import type { CommandIO } from '../src/cli/commands.js';
import { findCodex } from '../src/codex/binary.js';
import type { CodexBridge } from '../src/codex/bridge.js';
import { spawnAppServer, type SpawnAppServer } from '../src/codex/process.js';
import { AppServerConnection } from '../src/codex/rpc.js';
import { BRIDGE_MCP_SERVER, BridgeToolServer } from '../src/codex/tool-server.js';
import { createLogger } from '../src/log.js';
import { FileTokenStore, sessionKey } from '../src/secrets/keychain.js';
import { FakeApi } from '../test/support/fake-api.js';
import { CodexHome, FakeAppServer } from '../test/support/fake-codex.js';
import { SESSION_TOKENS } from '../test/support/fake-sessions.js';

const { values } = parseArgs({
  options: {
    approved: { type: 'boolean' },
    model: { type: 'string' },
    cwd: { type: 'string' },
    out: { type: 'string' },
    'codex-path': { type: 'string' },
    'preflight-only': { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    only: { type: 'string' },
  },
});

const preflightOnly = values['preflight-only'] === true;
if (values.only !== undefined && values.only !== 'steer' && values.only !== 'parity') {
  console.error(
    '--only takes "steer" (the steer step alone: 1 turn) or "parity" (tools, approvals, files: 4 turns).',
  );
  process.exit(2);
}
const only = values.only === 'steer';
const parity = values.only === 'parity';
/** Turns allowed: the 4 steps' turns plus one spare (1 plus one spare for --only steer). */
const maxTurns = only ? 2 : 5;
if (
  (values.approved !== true && !preflightOnly && values['dry-run'] !== true) ||
  values.model === undefined ||
  values.cwd === undefined
) {
  console.error(
    "This runs real Codex model turns (4, at most 5) on your plan. Run it only with the plan owner's yes:\n  npx tsx scripts/codex-smoke.ts --approved --model <id from model/list> --cwd <empty folder>",
  );
  process.exit(2);
}
const work = resolve(values.cwd);
if (readdirSync(work).length > 0) {
  console.error(`${work} is not empty; give an empty throwaway folder.`);
  process.exit(2);
}
const out = resolve(values.out ?? join(tmpdir(), 'codex-smoke'));
mkdirSync(out, { recursive: true });
const transcript = join(out, `transcript-${Date.now()}.jsonl`);
/**
 * --dry-run: the whole script against the scripted fake app-server, with
 * no Codex at all (no turn): it checks the script's own steps and checks.
 */
const dryRun = values['dry-run'] === true;
const binary = dryRun
  ? { path: 'codex', via: 'option' as const, env: {} }
  : findCodex(values['codex-path']);
const fakeHome = new CodexHome();
const fakeSpawn: SpawnAppServer = (args, env) => {
  const fake = new FakeAppServer(fakeHome);
  fake.onTurn = async (ctx) => {
    const said = (ctx.inputs[0]?.[0] as { text?: unknown } | undefined)?.text;
    const first = typeof said === 'string' ? said : '';
    if (await fakeParityTurn(fake, ctx, first)) return;
    if (first.startsWith('Count slowly from 1 to 30')) {
      await ctx.inputsReach(2);
      ctx.agentMessage('steered', 'final_answer');
    } else if (first.startsWith('Count slowly from 1 to 200')) {
      await ctx.interrupted();
      return;
    } else {
      ctx.agentMessage('pong', 'final_answer');
    }
    ctx.complete();
  };
  return fake.spawn(args, env);
};

/** The parity prompts (the dry run's fake plays a turn for each). */
const PARITY = {
  a: 'Call the buildit whoami tool. Then post one short message with the buildit reply tool, without thread_id or item: the word pong, and in three words or fewer what the attached image shows. Do nothing else; your final answer can be empty.',
  b: 'Your sandbox here is read-only, so run exactly this shell command once, in this folder, with escalated permissions (ask for approval to run it outside the sandbox): echo smoke > out.txt . Then share out.txt with the buildit reply tool (its files parameter), with the text "out.txt". Do nothing else.',
  c: 'Your sandbox here is read-only, so run exactly this shell command once, in this folder, with escalated permissions (ask for approval to run it outside the sandbox): echo declined > denied.txt . If it is not allowed, reply only with the word declined. Do nothing else.',
  d: 'Create a file named hello.txt in this folder, containing the single line hi, with your file editing tool (apply_patch), not a shell command. Then reply only with the word done.',
} as const;

/** The dry run's stand-in for Codex in the parity turns; false: not a parity prompt. */
async function fakeParityTurn(
  fake: FakeAppServer,
  ctx: Parameters<FakeAppServer['onTurn']>[0],
  first: string,
): Promise<boolean> {
  const approval = (command: string) =>
    ctx.request('item/commandExecution/requestApproval', {
      itemId: `exec-${Date.now()}`,
      startedAtMs: Date.now(),
      environmentId: 'local',
      command,
      cwd: work,
      commandActions: [{ type: 'unknown', command }],
    });
  const accepted = (r: { result?: unknown }): boolean =>
    JSON.stringify(r.result).includes('"accept"');
  if (first.startsWith(PARITY.a)) {
    const client = await fake.mcp(ctx.threadId);
    await client.callTool({ name: 'whoami', arguments: {} });
    await client.callTool({ name: 'reply', arguments: { text: 'pong, a picture' } });
    ctx.agentMessage('', 'final_answer');
  } else if (first === PARITY.b) {
    if (accepted(await approval('echo smoke > out.txt'))) {
      writeFileSync(join(work, 'out.txt'), 'smoke\n');
      const client = await fake.mcp(ctx.threadId);
      await client.callTool({ name: 'reply', arguments: { text: 'out.txt', files: ['out.txt'] } });
    }
    ctx.agentMessage('', 'final_answer');
  } else if (first === PARITY.c) {
    const r = await approval('echo declined > denied.txt');
    ctx.agentMessage(accepted(r) ? 'ran it' : 'declined', 'final_answer');
  } else if (first === PARITY.d) {
    fake.notify('item/started', {
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      startedAtMs: Date.now(),
      item: {
        type: 'fileChange',
        id: 'patch-hello',
        status: 'inProgress',
        changes: [{ path: join(work, 'hello.txt'), kind: { type: 'add' }, diff: '+hi\n' }],
      },
    });
    const r = await ctx.request('item/fileChange/requestApproval', {
      itemId: 'patch-hello',
      startedAtMs: Date.now(),
    });
    if (accepted(r)) writeFileSync(join(work, 'hello.txt'), 'hi\n');
    ctx.agentMessage('done', 'final_answer');
  } else {
    return false;
  }
  ctx.complete();
  return true;
}
const logger = createLogger({ level: 'info' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The parity run is over (its steps reported): the main steps are skipped. */
class ParityDone extends Error {}

/** Lean threads: the cheap model at low effort, and none of the person's plugins, apps or MCP servers. */
const config = [
  `model="${values.model}"`,
  'model_reasoning_effort="low"',
  'model_reasoning_summary="none"',
  'features.plugins=false',
  'features.apps=false',
];

/** A TOML key for -c: bare when it can be, else quoted. */
const tomlKey = (name: string): string =>
  /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);

interface McpStatus {
  name: string;
  tools?: Record<string, unknown>;
}

/** A free app-server session (no turn): initialize, then `use`, then it ends. */
async function freeSession<T>(
  args: string[],
  use: (conn: AppServerConnection) => Promise<T>,
): Promise<T> {
  const proc = spawnAppServer(binary, { cwd: work, logger })(args.flatMap((c) => ['-c', c]));
  const conn = new AppServerConnection(proc.stdout, proc.stdin, { logger });
  try {
    await conn.request('initialize', {
      clientInfo: { name: 'buildit_mcp_smoke', title: null, version: '0.0.0' },
      capabilities: { experimentalApi: true },
    });
    conn.notify('initialized');
    return await use(conn);
  } finally {
    conn.close();
    await proc.stop();
  }
}

/** The MCP servers a thread would load, with their tools (an ephemeral thread: never saved). */
async function mcpServers(conn: AppServerConnection): Promise<McpStatus[]> {
  await conn.request('thread/start', { cwd: work, ephemeral: true });
  let servers: McpStatus[] = [];
  for (let i = 0; i < 10; i++) {
    await sleep(1000);
    servers = (await conn.request<{ data?: McpStatus[] }>('mcpServerStatus/list', {})).data ?? [];
    if (servers.every((m) => m.tools !== undefined)) break;
  }
  return servers;
}

const toolCount = (servers: McpStatus[]): number =>
  servers.reduce((n, m) => n + Object.keys(m.tools ?? {}).length, 0);

// Free (no turn): the model exists, and the person's own MCP servers are turned off too.
if (!dryRun) {
  const before = await freeSession([], async (conn) => {
    const list = await conn.request<{ data: { id: string }[] }>('model/list', {});
    if (!list.data.some((m) => m.id === values.model)) {
      console.error(`No model ${values.model}: ${list.data.map((m) => m.id).join(', ')}`);
      process.exit(2);
    }
    return mcpServers(conn);
  });
  const leftOn = await freeSession(config, mcpServers);
  for (const m of leftOn) config.push(`mcp_servers.${tomlKey(m.name)}.enabled=false`);
  const after = await freeSession(config, async (conn) => {
    const servers = await mcpServers(conn);
    const skills = await conn.request<{ data?: { skills?: unknown[] }[] }>('skills/list', {
      cwds: [work],
    });
    return {
      servers,
      skills: (skills.data ?? []).reduce((n, e) => n + (e.skills ?? []).length, 0),
    };
  });
  console.log(
    `Lean threads: MCP tools ${toolCount(before)} -> ${toolCount(after.servers)}, skills ${after.skills}; sending ${config.map((c) => `-c ${c}`).join(' ')}`,
  );
  if (toolCount(after.servers) > 0) {
    console.error('MCP tools are still loaded; not running any turn.');
    process.exit(2);
  }
}
/**
 * Free (no turn): the bridge's hosted tools reach a Codex thread. A tool
 * server on loopback (buildIt.Social's side is the in-process fake), an
 * app-server started with its secret, an ephemeral thread started with
 * the thread's config, then mcpServerStatus/list for that thread: the
 * buildit server must be connected, with its tools.
 */
async function hostedToolsCheck(): Promise<string> {
  const fake = await new FakeApi().start();
  fake.sessions.open(SESSION_TOKENS.first, 'codex-smoke-tools');
  const api = new ApiClient({ baseUrl: fake.url, token: SESSION_TOKENS.first, logger });
  await api.getMeta().catch(() => undefined);
  const state = new ChannelState();
  state.folder = work;
  state.session = await getSession(api);
  const tools = new BridgeToolServer({
    api,
    state,
    logger,
    ask: { questionsInApp: true, hookWaitS: 60 },
  });
  await tools.start();
  const proc = spawnAppServer(binary, { cwd: work, logger })(
    config.flatMap((c) => ['-c', c]),
    tools.env,
  );
  const conn = new AppServerConnection(proc.stdout, proc.stdin, { logger });
  try {
    await conn.request('initialize', {
      clientInfo: { name: 'buildit_mcp_smoke', title: null, version: '0.0.0' },
      capabilities: { experimentalApi: true },
    });
    conn.notify('initialized');
    const started = await conn.request<{ thread: { id: string } }>('thread/start', {
      cwd: work,
      ephemeral: true,
      config: tools.threadConfig('dm'),
    });
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      const list = await conn.request<{ data?: McpStatus[] }>('mcpServerStatus/list', {
        threadId: started.thread.id,
        serverName: BRIDGE_MCP_SERVER,
      });
      const entry = (list.data ?? []).find((m) => m.name === BRIDGE_MCP_SERVER);
      const names = Object.keys(entry?.tools ?? {});
      if (names.length > 0) {
        const want = ['reply', 'whoami', 'ask', 'get_attachment'];
        const missing = want.filter((n) => !names.includes(n));
        return missing.length === 0
          ? `OK, ${names.length} tools over loopback`
          : `FAIL, missing ${missing.join(', ')}`;
      }
    }
    return 'FAIL, the buildit server listed no tools';
  } finally {
    conn.close();
    await proc.stop();
    await tools.close();
    await fake.close();
  }
}

/** Codex asks before anything that writes, and the owner answers: the parity turns' settings. */
const PARITY_CONFIG = [
  'approval_policy="on-request"',
  'approvals_reviewer="user"',
  'sandbox_mode="read-only"',
];

if (!dryRun) console.log(`Hosted tools (no turn): ${await hostedToolsCheck()}`);

// Free (no turn): the parity settings start, and a thread shows them.
if (!dryRun && parity) {
  const shown = await freeSession([...config, ...PARITY_CONFIG], async (conn) => {
    const r = await conn.request<{
      approvalPolicy?: unknown;
      approvalsReviewer?: unknown;
      sandbox?: { type?: unknown };
    }>('thread/start', { cwd: work, ephemeral: true });
    return { policy: r.approvalPolicy, reviewer: r.approvalsReviewer, sandbox: r.sandbox?.type };
  }).catch((err: unknown) => {
    console.error(
      `The parity settings don't start: ${err instanceof Error ? err.message : String(err)}; not running any turn.`,
    );
    process.exit(2);
  });
  console.log(`Parity settings (no turn): ${JSON.stringify(shown)}`);
  if (shown.policy !== 'on-request' || shown.reviewer !== 'user' || shown.sandbox !== 'readOnly') {
    console.error('The parity settings did not apply; not running any turn.');
    process.exit(2);
  }
}
if (preflightOnly) process.exit(0);

// What the wire shows: new turns, their ends, the steers, the resumes, and the token usage.
const wire = {
  turns: 0,
  started: [] as string[],
  completed: new Map<string, string>(),
  steers: [] as { expected: string; turnId: string | undefined }[],
  steersRefused: 0,
  resumes: 0,
  usage: [] as unknown[],
  /** Each turn/start's input item types, and the server requests with the bridge's answers. */
  inputs: [] as string[][],
  serverRequests: new Map<unknown, { method: string; answer: string | undefined }>(),
  /** The MCP tool calls Codex made (server/tool), from the items. */
  toolCalls: [] as string[],
};
const tapped =
  (inner: SpawnAppServer): SpawnAppServer =>
  (args, env) => {
    const proc = inner(args, env);
    const fromServer = new PassThrough();
    const toServer = new PassThrough();
    const sent = new Map<unknown, { method: string; params: Record<string, unknown> }>();
    createInterface({ input: proc.stdout }).on('line', (line) => {
      appendFileSync(transcript, JSON.stringify({ t: Date.now(), dir: 'in', line }) + '\n');
      try {
        const m = JSON.parse(line) as {
          id?: unknown;
          method?: string;
          result?: { turn?: { id?: string }; turnId?: string };
          error?: unknown;
          params?: { tokenUsage?: unknown; turn?: { id?: string; status?: string } };
        };
        if (m.method === 'turn/started') wire.turns++;
        if (m.method === 'turn/completed' && m.params?.turn?.id !== undefined) {
          wire.completed.set(m.params.turn.id, m.params.turn.status ?? 'unknown');
        }
        if (m.method === 'thread/tokenUsage/updated') wire.usage.push(m.params?.tokenUsage);
        if (m.method !== undefined && m.id !== undefined) {
          wire.serverRequests.set(m.id, { method: m.method, answer: undefined });
        }
        const item = (
          m.params as { item?: { type?: string; server?: string; tool?: string } } | undefined
        )?.item;
        if (m.method === 'item/completed' && item?.type === 'mcpToolCall') {
          wire.toolCalls.push(`${String(item.server)}/${String(item.tool)}`);
        }
        const request = m.method === undefined ? sent.get(m.id) : undefined;
        if (request?.method === 'turn/start' && m.result?.turn?.id !== undefined) {
          if (!wire.started.includes(m.result.turn.id)) wire.started.push(m.result.turn.id);
        }
        if (request?.method === 'turn/steer') {
          if (m.error === undefined) {
            wire.steers.push({
              expected: String(request.params.expectedTurnId),
              turnId: m.result?.turnId,
            });
          } else {
            wire.steersRefused++;
          }
        }
        if (request?.method === 'thread/resume' && m.error === undefined) wire.resumes++;
      } catch {
        // Not JSON: the bridge logs it.
      }
      fromServer.write(line + '\n');
    });
    proc.stdout.on('end', () => fromServer.end());
    createInterface({ input: toServer }).on('line', (line) => {
      appendFileSync(transcript, JSON.stringify({ t: Date.now(), dir: 'out', line }) + '\n');
      const m = JSON.parse(line) as {
        id?: unknown;
        method?: string;
        params?: Record<string, unknown>;
      };
      if (m.method !== undefined && m.id !== undefined) {
        sent.set(m.id, { method: m.method, params: m.params ?? {} });
      }
      if (m.method === 'turn/start') {
        const input = (m.params?.input ?? []) as { type?: string }[];
        wire.inputs.push(input.map((i) => String(i.type)));
      }
      const asked = m.method === undefined ? wire.serverRequests.get(m.id) : undefined;
      if (asked !== undefined) {
        const r = (m as { result?: unknown }).result;
        asked.answer = JSON.stringify(r ?? null);
      }
      if (wire.turns >= maxTurns && m.method === 'turn/start') {
        console.error('Turn cap reached; stopping.');
        process.exit(3);
      }
      proc.stdin.write(line + '\n');
    });
    toServer.on('end', () => proc.stdin.end());
    return { ...proc, stdout: fromServer, stdin: toServer };
  };

const api = await new FakeApi().start();
const state = mkdtempSync(join(tmpdir(), 'codex-smoke-state-'));
const store = new FileTokenStore(join(state, 'sessions.json'));
await store.set(sessionKey(work, api.url), SESSION_TOKENS.first);
const s = api.sessions.open(SESSION_TOKENS.first, 'codex-smoke');
const io: CommandIO = {
  out: (t) => process.stdout.write(t),
  err: (t) => process.stderr.write(t),
  store,
  logger,
};
async function until(check: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(100);
  }
}

async function bridgeRun(): Promise<{ bridge: CodexBridge; stop: () => Promise<number> }> {
  let release!: () => void;
  const stop = new Promise<void>((r) => (release = r));
  let bridge: CodexBridge | undefined;
  const done = runCodex(
    {
      apiUrl: api.url,
      apiUrlFlag: true,
      folder: work,
      projects: [],
      label: 'codex-smoke',
      yes: false,
      capabilities: [],
      codexConfig: parity ? [...config, ...PARITY_CONFIG] : config,
      // Parity: debug, for the `_meta` keys of Codex's tool calls (names only; the report lists them).
      logLevel: parity ? 'debug' : 'info',
    },
    io,
    {
      stop,
      spawn: tapped(dryRun ? fakeSpawn : spawnAppServer(binary, { cwd: work, logger })),
      lockDir: join(state, 'locks'),
      // Polls the in-process fake often, so a message reaches Codex quickly.
      intervalMs: 250,
      ...(parity
        ? {
            logSink: (line: string) => {
              if (line.includes('bridge tools: tools/call')) {
                const keys = (JSON.parse(line) as { meta_keys?: unknown }).meta_keys;
                metaKeys.add(JSON.stringify(keys ?? []));
              }
              process.stderr.write(`${line}\n`);
            },
          }
        : {}),
      onReady: (b) => (bridge = b),
    },
  );
  await until(() => bridge !== undefined, 60_000, 'the bridge');
  return {
    bridge: bridge!,
    stop: () => {
      release();
      return done;
    },
  };
}

/** The `_meta` keys Codex's tool calls carried (parity), as the bridge logged them. */
const metaKeys = new Set<string>();

const report: string[] = [];
const say = (text: string): void => {
  api.sessions.postFrom(SESSION_TOKENS.first, text);
};
const posts = () => s.messages.map((m) => m.text);
const check = (step: string, ok: boolean, detail: string): void => {
  report.push(`${step}: ${ok ? 'OK' : 'FAIL'} ${detail}`);
  if (!ok) process.exitCode = 1;
};
/** No turn runs: every turn started has completed, and the bridge follows none. */
const idle = (run: { bridge: CodexBridge }) => (): boolean =>
  run.bridge.runningTurn() === undefined && wire.started.every((id) => wire.completed.has(id));

/**
 * The parity turns: the in-process owner answers each approval card as the
 * step says (by the card's tool name; anything else is denied).
 */
async function parityRun(): Promise<void> {
  const token = SESSION_TOKENS.first;
  const run = await bridgeRun();
  await until(() => s.heartbeats.includes('online'), 30_000, 'online');
  let answers: Record<string, 'approve' | 'deny'> = {};
  const decided = new Set<string>();
  const owner = setInterval(() => {
    for (const card of api.sessions.approvals(token)) {
      if (card.status !== 'open' || decided.has(card.id)) continue;
      decided.add(card.id);
      api.sessions.decideApproval(token, card.id, answers[card.toolName] ?? 'deny');
    }
  }, 100);
  // The reply tool posts with a random (v4) id; the bridge's own posts with a v5 id made
  // from the turn, so a v4 post in a thread came through the hosted tool.
  const viaTool = () =>
    s.messages.filter((m) => /^[0-9a-f]{8}-[0-9a-f]{4}-4/i.test(m.id) && (m.card ?? null) === null);
  const cardsSince = (n: number) => api.sessions.approvals(token).slice(n);
  const turn = async (n: number, what: string): Promise<void> => {
    await until(() => wire.started.length >= n && idle(run)(), 180_000, what);
    await run.bridge.idle();
  };
  try {
    // A. the hosted tools and an image
    answers = {};
    const png = readFileSync(new URL('../test/fixtures/location/plain.png', import.meta.url));
    const threadA = api.sessions.postFrom(token, PARITY.a, {
      files: [{ name: 'plain.png', type: 'image/png', bytes: png, kind: 'image' }],
    });
    await turn(1, 'turn A');
    const whoami = api.requests.some((r) => r.headers['x-buildit-tool'] === 'whoami');
    const replies = viaTool();
    const inA = s.messages.filter((m) => m.thread_id === threadA);
    check(
      'A tools + image',
      (wire.inputs[0] ?? []).includes('localImage') &&
        whoami &&
        replies.length >= 1 &&
        inA.length === 1,
      `inputs ${JSON.stringify(wire.inputs[0])}, whoami ${String(whoami)}, replies via the tool ${replies.length}, posts in the thread ${inA.length} ${JSON.stringify(inA.map((m) => m.text))}, tool calls ${JSON.stringify(wire.toolCalls)}, their _meta keys ${[...metaKeys].join(' ')}`,
    );

    // B. an approved command, then a file shared
    answers = { command: 'approve' };
    const beforeB = api.sessions.approvals(token).length;
    say(PARITY.b);
    await turn(2, 'turn B');
    const cardsB = cardsSince(beforeB);
    check(
      'B approve + file',
      cardsB.some((c) => c.toolName === 'command' && c.status === 'approved') &&
        existsSync(join(work, 'out.txt')) &&
        api.sessions.filePosts.length >= 1,
      `cards ${JSON.stringify(cardsB.map((c) => `${c.toolName}:${c.status}`))}, out.txt ${String(existsSync(join(work, 'out.txt')))}, file posts ${api.sessions.filePosts.length}`,
    );

    // C. a denied command
    answers = {};
    const beforeC = api.sessions.approvals(token).length;
    say(PARITY.c);
    await turn(3, 'turn C');
    const cardsC = cardsSince(beforeC);
    const declined = [...wire.serverRequests.values()].some((r) =>
      (r.answer ?? '').includes('"decline"'),
    );
    check(
      'C deny',
      cardsC.length >= 1 &&
        cardsC.every((c) => c.status === 'denied') &&
        declined &&
        !existsSync(join(work, 'denied.txt')),
      `cards ${JSON.stringify(cardsC.map((c) => `${c.toolName}:${c.status}`))}, denied.txt ${String(existsSync(join(work, 'denied.txt')))}`,
    );

    // D. a file change, shown with its diff, approved
    answers = { file_change: 'approve' };
    const beforeD = api.sessions.approvals(token).length;
    say(PARITY.d);
    await turn(4, 'turn D');
    const cardsD = cardsSince(beforeD);
    const change = cardsD.find((c) => c.toolName === 'file_change');
    const fields = (change?.posted.fields ?? []) as { key: string; value: string }[];
    const shown = fields.some(
      (f) => f.key.endsWith('hello.txt') && f.value.includes('hello.txt') && f.value.includes('hi'),
    );
    check(
      'D file change',
      change?.status === 'approved' && shown && existsSync(join(work, 'hello.txt')),
      `cards ${JSON.stringify(cardsD.map((c) => `${c.toolName}:${c.status}`))}, diff shown ${String(shown)}, hello.txt ${String(existsSync(join(work, 'hello.txt')))}`,
    );
  } finally {
    clearInterval(owner);
    await run.stop();
  }
}

try {
  if (parity) {
    await parityRun();
    throw new ParityDone();
  }
  let run = await bridgeRun();
  await until(() => s.heartbeats.includes('online'), 30_000, 'online');

  if (!only) {
    // 1. reply
    say('Reply with the single word pong.');
    await until(() => posts().length === 1 && idle(run)(), 180_000, 'turn 1 answer');
    check('1 reply', /pong/i.test(posts()[0] ?? ''), JSON.stringify(posts()[0]));
  }

  // 2. steer. Both messages are posted at once, so one poll brings them: the
  // first starts a turn, and the second is steered into it a few
  // milliseconds later, long before the model can answer (its first output
  // came after about a second in the first run). Waiting for the turn
  // before posting the second raced the model there: the count finished
  // before the next poll brought the steer.
  const before = posts().length;
  say('Count slowly from 1 to 30, one number per line, then stop.');
  say('Stop counting. Reply with the single word steered.');
  await until(() => wire.steers.length + wire.steersRefused >= 1, 60_000, 'turn 2 steer');
  const turn2 = wire.started.at(-1);
  await until(() => posts().length === before + 1 && idle(run)(), 180_000, 'turn 2 answer');
  const steer = wire.steers.at(-1);
  check(
    '2 steer',
    steer !== undefined &&
      steer.expected === turn2 &&
      steer.turnId === turn2 &&
      wire.completed.get(steer.expected) === 'completed' &&
      /steered/i.test(posts()[before] ?? ''),
    `${JSON.stringify(posts()[before])} (steered into the running turn: ${String(steer?.turnId === turn2)}; refused steers: ${wire.steersRefused})`,
  );

  if (!only) {
    // 3. interrupt
    const count = posts().length;
    say('Count slowly from 1 to 200, one number per line.');
    await until(() => run.bridge.runningTurn() !== undefined, 60_000, 'turn 3 running');
    const turn3 = run.bridge.runningTurn();
    await sleep(1500);
    await run.bridge.interrupt();
    await until(() => idle(run)(), 60_000, 'turn 3 interrupted');
    await sleep(1000);
    check(
      '3 interrupt',
      wire.completed.get(turn3 ?? '') === 'interrupted' && posts().length === count,
      `status ${String(wire.completed.get(turn3 ?? ''))}, posts after = ${posts().length} (expected ${count})`,
    );

    // 4. resume after a restart
    report.push(`restart: exit ${await run.stop()}`);
    run = await bridgeRun();
    say('What single word did you reply to my first message? Reply with that word only.');
    await until(() => posts().length === count + 1 && idle(run)(), 180_000, 'turn 4 answer');
    check(
      '4 resume',
      wire.resumes >= 1 && /pong/i.test(posts()[count] ?? ''),
      `${JSON.stringify(posts()[count])} (thread/resume: ${wire.resumes})`,
    );
  }
  await run.stop();
} catch (err) {
  if (!(err instanceof ParityDone)) {
    report.push(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
} finally {
  report.push(
    `turns: ${wire.turns} (cap ${maxTurns})`,
    `token usage: ${JSON.stringify(wire.usage.at(-1) ?? null)}`,
  );
  report.push(
    parity
      ? `folder now holds: ${readdirSync(work).join(', ') || 'nothing'}`
      : `folder still empty: ${readdirSync(work).length === 0}`,
    `transcript: ${transcript}`,
  );
  console.log(report.join('\n'));
  appendFileSync(join(out, 'report.txt'), report.join('\n') + '\n');
  await api.close();
  rmSync(state, { recursive: true, force: true });
}
