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
 */
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
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
if (values.only !== undefined && values.only !== 'steer') {
  console.error('--only takes "steer" (the steer step alone: 1 turn).');
  process.exit(2);
}
const only = values.only === 'steer';
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
const fakeSpawn: SpawnAppServer = (args) => {
  const fake = new FakeAppServer(fakeHome);
  fake.onTurn = async (ctx) => {
    const said = (ctx.inputs[0]?.[0] as { text?: unknown } | undefined)?.text;
    const first = typeof said === 'string' ? said : '';
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
  return fake.spawn(args);
};
const logger = createLogger({ level: 'info' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

if (!dryRun) console.log(`Hosted tools (no turn): ${await hostedToolsCheck()}`);
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
};
const tapped =
  (inner: SpawnAppServer): SpawnAppServer =>
  (args) => {
    const proc = inner(args);
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
      codexConfig: config,
      logLevel: 'info',
    },
    io,
    {
      stop,
      spawn: tapped(dryRun ? fakeSpawn : spawnAppServer(binary, { cwd: work, logger })),
      lockDir: join(state, 'locks'),
      // Polls the in-process fake often, so a message reaches Codex quickly.
      intervalMs: 250,
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

try {
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
  report.push(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  report.push(
    `turns: ${wire.turns} (cap ${maxTurns})`,
    `token usage: ${JSON.stringify(wire.usage.at(-1) ?? null)}`,
  );
  report.push(`folder still empty: ${readdirSync(work).length === 0}`, `transcript: ${transcript}`);
  console.log(report.join('\n'));
  appendFileSync(join(out, 'report.txt'), report.join('\n') + '\n');
  await api.close();
  rmSync(state, { recursive: true, force: true });
}
