/**
 * The Codex bridge's smoke test against the REAL `codex app-server`: it
 * runs model turns on the person's Codex plan, so a maintainer runs it by
 * hand, only with the plan owner's yes. buildIt.Social's side is the
 * in-process fake API (nothing reaches a real buildIt.Social server).
 *
 *   npx tsx scripts/codex-smoke.ts --approved --model <id> --cwd <empty folder>
 *   npx tsx scripts/codex-smoke.ts --preflight-only --model <id> --cwd <empty folder>
 *                                   (the free checks below, then stop: no turn)
 *
 * Four turns, at most five (the script stops before a sixth):
 *   1. reply      "Reply with the single word pong."  -> a post
 *   2. steer      a slow count, then a message that joins the running turn -> one post
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
 * stops otherwise. The folder must be
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

import { runCodex } from '../src/cli/codex.js';
import type { CommandIO } from '../src/cli/commands.js';
import { findCodex } from '../src/codex/binary.js';
import type { CodexBridge } from '../src/codex/bridge.js';
import { spawnAppServer, type SpawnAppServer } from '../src/codex/process.js';
import { AppServerConnection } from '../src/codex/rpc.js';
import { createLogger } from '../src/log.js';
import { FileTokenStore, sessionKey } from '../src/secrets/keychain.js';
import { FakeApi } from '../test/support/fake-api.js';
import { SESSION_TOKENS } from '../test/support/fake-sessions.js';

const MAX_TURNS = 5;

const { values } = parseArgs({
  options: {
    approved: { type: 'boolean' },
    model: { type: 'string' },
    cwd: { type: 'string' },
    out: { type: 'string' },
    'codex-path': { type: 'string' },
    'preflight-only': { type: 'boolean' },
  },
});

const preflightOnly = values['preflight-only'] === true;
if (
  (values.approved !== true && !preflightOnly) ||
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
const binary = findCodex(values['codex-path']);
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
  return { servers, skills: (skills.data ?? []).reduce((n, e) => n + (e.skills ?? []).length, 0) };
});
console.log(
  `Lean threads: MCP tools ${toolCount(before)} -> ${toolCount(after.servers)}, skills ${after.skills}; sending ${config.map((c) => `-c ${c}`).join(' ')}`,
);
if (toolCount(after.servers) > 0) {
  console.error('MCP tools are still loaded; not running any turn.');
  process.exit(2);
}
if (preflightOnly) process.exit(0);

// The turn ledger, from the wire: new turns started, and their token usage.
let turns = 0;
const usage: unknown[] = [];
const tapped =
  (inner: SpawnAppServer): SpawnAppServer =>
  (args) => {
    const proc = inner(args);
    const fromServer = new PassThrough();
    const toServer = new PassThrough();
    createInterface({ input: proc.stdout }).on('line', (line) => {
      appendFileSync(transcript, JSON.stringify({ t: Date.now(), dir: 'in', line }) + '\n');
      try {
        const m = JSON.parse(line) as { method?: string; params?: { tokenUsage?: unknown } };
        if (m.method === 'turn/started') turns++;
        if (m.method === 'thread/tokenUsage/updated') usage.push(m.params?.tokenUsage);
      } catch {
        // Not JSON: the bridge logs it.
      }
      fromServer.write(line + '\n');
    });
    proc.stdout.on('end', () => fromServer.end());
    createInterface({ input: toServer }).on('line', (line) => {
      appendFileSync(transcript, JSON.stringify({ t: Date.now(), dir: 'out', line }) + '\n');
      if (turns >= MAX_TURNS && line.includes('"turn/start"')) {
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
      spawn: tapped(spawnAppServer(binary, { cwd: work, logger })),
      lockDir: join(state, 'locks'),
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
const posts = () => s.messages.map((m) => m.text);
try {
  let run = await bridgeRun();
  await until(() => s.heartbeats.includes('online'), 30_000, 'online');

  // 1. reply
  api.sessions.postFrom(SESSION_TOKENS.first, 'Reply with the single word pong.');
  await until(() => posts().length === 1, 180_000, 'turn 1 answer');
  report.push(`1 reply: ${JSON.stringify(posts()[0])}`);

  // 2. steer
  api.sessions.postFrom(
    SESSION_TOKENS.first,
    'Count slowly from 1 to 30, one number per line, then stop.',
  );
  await until(() => run.bridge.runningTurn() !== undefined, 60_000, 'turn 2 running');
  await sleep(1500);
  api.sessions.postFrom(SESSION_TOKENS.first, 'Stop counting. Reply with the single word steered.');
  await until(
    () => posts().length === 2 && run.bridge.runningTurn() === undefined,
    180_000,
    'turn 2 answer',
  );
  report.push(`2 steer: ${JSON.stringify(posts()[1])}`);

  // 3. interrupt
  api.sessions.postFrom(SESSION_TOKENS.first, 'Count slowly from 1 to 200, one number per line.');
  await until(() => run.bridge.runningTurn() !== undefined, 60_000, 'turn 3 running');
  await sleep(2000);
  await run.bridge.interrupt();
  await until(() => run.bridge.runningTurn() === undefined, 60_000, 'turn 3 interrupted');
  await sleep(1000);
  report.push(`3 interrupt: posts after = ${posts().length} (expected 2)`);

  // 4. resume after a restart
  report.push(`restart: exit ${await run.stop()}`);
  run = await bridgeRun();
  api.sessions.postFrom(
    SESSION_TOKENS.first,
    'What single word did you reply to my first message? Reply with that word only.',
  );
  await until(() => posts().length === 3, 180_000, 'turn 4 answer');
  report.push(`4 resume: ${JSON.stringify(posts()[2])}`);
  await run.stop();
} catch (err) {
  report.push(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  report.push(
    `turns: ${turns} (cap ${MAX_TURNS})`,
    `token usage: ${JSON.stringify(usage.at(-1) ?? null)}`,
  );
  report.push(`folder still empty: ${readdirSync(work).length === 0}`, `transcript: ${transcript}`);
  console.log(report.join('\n'));
  appendFileSync(join(out, 'report.txt'), report.join('\n') + '\n');
  await api.close();
  rmSync(state, { recursive: true, force: true });
}
