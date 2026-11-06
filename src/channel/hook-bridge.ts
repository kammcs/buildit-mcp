/**
 * The plugin's hooks, over a local endpoint instead of MCP.
 *
 * Claude Code runs an `mcp_tool` hook even when its server is off for the
 * project (disabled in /mcp, or not connected), and each such call shows a
 * "hook error" in the terminal: on every tool call, for the PreToolUse and
 * PostToolUse hooks. So the plugin's hooks are `command` hooks that run
 * `plugin/hooks/forward.mjs`, which hands the hook's input to this server
 * over a local endpoint, and exits at once, silently, when no server
 * listens.
 *
 * The rendezvous: the folder's channel server opens an endpoint with a
 * random name (a named pipe on Windows, a Unix socket in a 0700 folder
 * elsewhere) and writes its name to `<sessions folder>/hooks/<folder key>.json`
 * (0600 in a 0700 folder: the user's own, next to the lock files), where
 * the folder key is a hash of Claude Code's project folder. The forwarder
 * computes the same path, reads the name and connects. A name nobody can
 * guess, in a file only the user can read and write, means no other user
 * can stand in for the server (and the pipe's default ACL gives other users
 * read access at most, so they can't send to it either).
 *
 * Which Claude Code it is for: two Claude Code windows in one folder share
 * the folder's file, but only one of them runs the channel. A forwarder
 * sends its Claude Code's process id (`CLAUDE_PID`, and its own parent's,
 * since Claude Code spawns it directly), and the server takes a message only
 * when that process is one of its own ancestors (Claude Code started it,
 * through npx). The nearest such ancestor wins once seen. When the server
 * can't read its ancestors (no /proc, no ps, no PowerShell), it takes every
 * message, as one server per folder did before.
 *
 * What it takes: one JSON line, at most `MAX_MESSAGE_BYTES` (approvals carry
 * the tool's input), `{v: 1, hook, pids, args}`, with `hook` one of the
 * plugin's hook tools; it answers one JSON line, `{ok, text?}`, where `text`
 * is the hook's output for the hooks that decide something (approve, ask).
 * Nothing secret travels over it: the hook's input, as Claude Code passed it
 * to the MCP hooks before, and the hook's answer.
 */
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';

import { z } from 'zod';

import type { Logger } from '../log.js';
import { defaultTokenFile } from '../secrets/keychain.js';

/** The plugin's hooks that the bridge serves (each the name of the tool it calls). */
export const HOOK_NAMES = [
  'approve',
  'ask',
  'tool_seen',
  'tool_done',
  'agent_done',
  'prompt_typed',
  'turn_ended',
] as const;
export type HookName = (typeof HOOK_NAMES)[number];

/** The largest message taken (an approval's tool input may be up to 2,000,000 characters). */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
/** How long a connection may take to send its message. */
export const READ_TIMEOUT_MS = 10_000;
/** At most this many connections at once (approvals and questions wait for an answer). */
export const MAX_CONNECTIONS = 64;
/** How often the server checks that it is still the folder's channel. */
export const OWNERSHIP_CHECK_MS = 2_000;
/** How long a hook waits for the server's process list at its start (then it is refused). */
export const GATE_WAIT_MS = 2_000;
/** The longest Unix socket path used (macOS allows 104 bytes). */
const MAX_SOCKET_PATH = 100;

// ---------------------------------------------------------------------------
// Where (the forwarder computes the same: plugin/hooks/forward.mjs)
// ---------------------------------------------------------------------------

/** The folder of the rendezvous files: `hooks` next to the token file (this platform's paths). */
export function hookDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return join(dirname(defaultTokenFile(env, platform)), 'hooks');
}

/** A folder's key: the first 32 hex digits of the SHA-256 of its normalized path. */
export function folderKey(folder: string, platform: NodeJS.Platform = process.platform): string {
  const lib = platform === 'win32' ? win32 : posix;
  let normalized = lib.resolve(folder);
  // Windows and macOS folders are case-insensitive (Claude Code may name the drive either way).
  if (platform === 'win32' || platform === 'darwin') normalized = normalized.toLowerCase();
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 32);
}

/** The folder whose hooks this server takes: Claude Code's project folder, else its own. */
export function hookFolder(
  folder: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const project = env.CLAUDE_PROJECT_DIR?.trim();
  return project !== undefined && project !== '' ? project : folder;
}

/** The rendezvous file's content. */
export const RendezvousSchema = z.object({
  v: z.literal(1),
  endpoint: z.string().min(1).max(300),
  pid: z.number().int().positive(),
});
export type Rendezvous = z.infer<typeof RendezvousSchema>;

// ---------------------------------------------------------------------------
// The messages
// ---------------------------------------------------------------------------

export const HookMessageSchema = z.strictObject({
  v: z.literal(1),
  hook: z.enum(HOOK_NAMES),
  /** The forwarder's Claude Code: its CLAUDE_PID and its own parent's id. */
  pids: z
    .array(
      z
        .number()
        .int()
        .positive()
        .max(2 ** 32),
    )
    .max(4),
  /** A hash of the forwarder's Claude Code messaging socket (CLAUDE_CODE_MESSAGING_SOCKET), if set. */
  tag: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  /** The hook's Claude Code session id. */
  session_id: z.string().max(200).optional(),
  args: z.record(z.string(), z.unknown()),
});
export type HookMessage = z.infer<typeof HookMessageSchema>;

/** A message's line, parsed and checked; undefined when it isn't one. */
export function parseHookMessage(line: string): HookMessage | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  const parsed = HookMessageSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

// ---------------------------------------------------------------------------
// Whose: the server's ancestors
// ---------------------------------------------------------------------------

/** pid -> parent pid (and, on Windows, the creation time, to stop at a reused pid). */
interface ProcEntry {
  ppid: number;
  created?: bigint;
}

/** The chain of ancestors from a process (nearest first, itself left out). */
export function ancestorChain(start: number, table: ReadonlyMap<number, ProcEntry>): number[] {
  const chain: number[] = [];
  const seen = new Set<number>([start]);
  let entry = table.get(start);
  for (let depth = 0; depth < 64 && entry !== undefined; depth++) {
    const parent = entry.ppid;
    if (parent <= 1 || seen.has(parent)) break;
    const up = table.get(parent);
    // Windows keeps a dead parent's id, which may now be another process: one started later.
    if (up?.created !== undefined && entry.created !== undefined && up.created > entry.created) {
      break;
    }
    chain.push(parent);
    seen.add(parent);
    entry = up;
  }
  return chain;
}

/** A promise's value, or undefined once `ms` have passed. */
function waitAtMost<T>(promise: Promise<T> | undefined, ms: number): Promise<T | undefined> {
  if (promise === undefined) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(undefined);
    }, ms);
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

function run(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(new Error('the process list could not be read'));
        else resolve(stdout);
      },
    );
  });
}

/** This process's ancestors, nearest first; undefined when they can't be read. */
export async function readAncestors(
  platform: NodeJS.Platform = process.platform,
): Promise<number[] | undefined> {
  const table = new Map<number, ProcEntry>();
  try {
    if (platform === 'linux') {
      let pid = process.pid;
      for (let i = 0; i < 64 && pid > 1; i++) {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        // pid (comm) state ppid ...: comm may hold spaces and parentheses.
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const ppid = Number(fields[1]);
        if (!Number.isInteger(ppid)) break;
        table.set(pid, { ppid });
        pid = ppid;
      }
    } else if (platform === 'win32') {
      const root = process.env.SystemRoot ?? 'C:\\Windows';
      const out = await run(
        join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId,$_.ParentProcessId,$(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }) }",
        ],
        15_000,
      );
      for (const line of out.split(/\r?\n/)) {
        const [pid, ppid, created] = line.trim().split(' ');
        if (pid === undefined || ppid === undefined) continue;
        const p = Number(pid);
        const pp = Number(ppid);
        if (!Number.isInteger(p) || !Number.isInteger(pp)) continue;
        const c = created !== undefined && /^\d+$/.test(created) ? BigInt(created) : undefined;
        table.set(p, { ppid: pp, ...(c === undefined || c === 0n ? {} : { created: c }) });
      }
    } else {
      const out = await run('ps', ['-A', '-o', 'pid=,ppid='], 5_000);
      for (const line of out.split('\n')) {
        const [pid, ppid] = line.trim().split(/\s+/);
        const p = Number(pid);
        const pp = Number(ppid);
        if (Number.isInteger(p) && Number.isInteger(pp)) table.set(p, { ppid: pp });
      }
    }
  } catch {
    return undefined;
  }
  if (!table.has(process.pid)) return undefined;
  return ancestorChain(process.pid, table);
}

/** The hash of a Claude Code messaging socket's name, as the forwarder sends it. */
export function socketTag(socket: string | undefined): string | undefined {
  const s = socket?.trim();
  if (s === undefined || s === '') return undefined;
  return createHash('sha256').update(`buildit-mcp:${s}`, 'utf8').digest('hex');
}

/** What the server knows about its own Claude Code. */
export interface OwnClaude {
  /** Its ancestors, nearest first (undefined: they couldn't be read). */
  ancestors: readonly number[] | undefined;
  /** socketTag of its CLAUDE_CODE_MESSAGING_SOCKET, when Claude Code set it. */
  tag?: string | undefined;
  /** Its CLAUDE_CODE_SESSION_ID at startup, when Claude Code set it (a resumed session has another). */
  sessionId?: string | undefined;
}

/**
 * Which messages are this server's, from the forwarder's Claude Code:
 *
 * - its process id is one of the server's ancestors (Claude Code started
 *   the server, through npx); the nearest ancestor a message named wins
 *   from then on, so a Claude Code that started another one (whose server
 *   this is) isn't taken for it;
 * - or the same messaging socket, or the session id the server started
 *   with: then its process ids are this server's from then on (on Windows a
 *   chain of parents breaks where a process in it has exited);
 * - and when the server knows none of these, every message is.
 */
export class AncestorGate {
  private nearest = Number.POSITIVE_INFINITY;
  private readonly learned = new Set<number>();

  constructor(private readonly own: OwnClaude) {}

  /** Whether the server knows anything to tell its own Claude Code by. */
  get known(): boolean {
    return (
      this.own.ancestors !== undefined ||
      this.own.tag !== undefined ||
      this.own.sessionId !== undefined
    );
  }

  accepts(message: Pick<HookMessage, 'pids' | 'tag' | 'session_id'>): boolean {
    if (!this.known) return true;
    const { pids } = message;
    if (pids.some((pid) => this.learned.has(pid))) return true;
    const ancestors = this.own.ancestors;
    if (ancestors !== undefined) {
      let depth = Number.POSITIVE_INFINITY;
      for (const pid of pids) {
        const at = ancestors.indexOf(pid);
        if (at >= 0 && at < depth) depth = at;
      }
      if (depth !== Number.POSITIVE_INFINITY) {
        if (depth > this.nearest) return false;
        this.nearest = depth;
        return true;
      }
    }
    const sameSocket = this.own.tag !== undefined && message.tag === this.own.tag;
    const sameSession =
      this.own.sessionId !== undefined && message.session_id === this.own.sessionId;
    if (!sameSocket && !sameSession) return false;
    for (const pid of pids) this.learned.add(pid);
    return true;
  }
}

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

/** Runs one hook; resolves to the hook's output text, or undefined for none. */
export type HookDispatch = (
  hook: HookName,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<string | undefined>;

export interface HookBridgeOptions {
  /** The folder whose hooks are taken (Claude Code's project folder). */
  folder: string;
  dispatch: HookDispatch;
  logger: Logger;
  /** Whether this server is still the folder's channel (default: always). */
  owns?: () => boolean;
  /** The rendezvous folder (default hookDir()). */
  dir?: string;
  /** The folder for Unix sockets whose path in `dir` would be too long (default: the temp folder). */
  socketDir?: string;
  /** The server's ancestors (tests); default readAncestors(). */
  ancestors?: () => Promise<number[] | undefined>;
  /** For tests: the messaging socket tag and session id (default: from the environment). */
  own?: Partial<Pick<OwnClaude, 'tag' | 'sessionId'>>;
  platform?: NodeJS.Platform;
  /** How often ownership is checked (tests). */
  checkEveryMs?: number;
}

/** A private folder: created 0700, and refused when it is a link, another user's, or open to others. */
export function privateDir(path: string, platform: NodeJS.Platform = process.platform): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (platform === 'win32') return;
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('not a folder');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error("another user's folder");
  }
  if ((st.mode & 0o077) !== 0) chmodSync(path, 0o700);
}

/** The endpoint's name: a pipe on Windows, else a socket path (random either way). */
export function endpointName(
  dir: string,
  socketDir: string,
  platform: NodeJS.Platform = process.platform,
): { endpoint: string; folder: string | undefined } {
  const id = randomBytes(platform === 'win32' ? 16 : 8).toString('hex');
  if (platform === 'win32')
    return { endpoint: `\\\\.\\pipe\\buildit-mcp-hooks-${id}`, folder: undefined };
  const inDir = posix.join(dir, `${id}.sock`);
  if (Buffer.byteLength(inDir) <= MAX_SOCKET_PATH) return { endpoint: inDir, folder: undefined };
  return { endpoint: posix.join(socketDir, `${id}.sock`), folder: socketDir };
}

export class HookBridge {
  private server: Server | undefined;
  private endpoint: string | undefined;
  private gate: AncestorGate | undefined;
  private gateReady: Promise<AncestorGate> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly sockets = new Set<Socket>();
  private readonly platform: NodeJS.Platform;
  private readonly dir: string;
  private readonly file: string;
  private closed = false;
  private readonly onExit = (): void => {
    this.cleanupSync();
  };

  constructor(private readonly options: HookBridgeOptions) {
    this.platform = options.platform ?? process.platform;
    this.dir = options.dir ?? hookDir(process.env, this.platform);
    this.file = join(this.dir, `${folderKey(options.folder, this.platform)}.json`);
  }

  /** The rendezvous file (tests). */
  get rendezvousFile(): string {
    return this.file;
  }

  /** The endpoint while it listens (tests). */
  get listening(): string | undefined {
    return this.server === undefined ? undefined : this.endpoint;
  }

  /** Opens the endpoint and writes the rendezvous file; false (logged) when it can't. */
  async start(): Promise<boolean> {
    if (this.closed || this.server !== undefined) return this.server !== undefined;
    const logger = this.options.logger;
    this.gateReady = (this.options.ancestors ?? (() => readAncestors(this.platform)))()
      .catch(() => undefined)
      .then((ancestors) => {
        const gate = new AncestorGate({
          ancestors,
          tag: socketTag(process.env.CLAUDE_CODE_MESSAGING_SOCKET),
          sessionId: process.env.CLAUDE_CODE_SESSION_ID?.trim() || undefined,
          ...this.options.own,
        });
        if (!gate.known) {
          logger.warn(
            "the hooks bridge can't tell this server's Claude Code from others; it takes every hook from this folder",
          );
        }
        this.gate = gate;
        return gate;
      });
    try {
      privateDir(this.dir, this.platform);
      const socketDir =
        this.options.socketDir ??
        join(
          tmpdir(),
          `buildit-mcp-${typeof process.getuid === 'function' ? process.getuid() : 'u'}`,
        );
      const { endpoint, folder } = endpointName(this.dir, socketDir, this.platform);
      if (folder !== undefined) privateDir(folder, this.platform);
      const server = createServer((socket) => {
        this.serve(socket);
      });
      server.maxConnections = MAX_CONNECTIONS;
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(endpoint, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      server.on('error', (err) => {
        logger.info('hooks bridge error', { code: (err as NodeJS.ErrnoException).code });
      });
      if (this.platform !== 'win32') chmodSync(endpoint, 0o600);
      server.unref();
      this.server = server;
      this.endpoint = endpoint;
      // close() may have run while it opened.
      if (this.isClosed()) {
        this.cleanupSync();
        return false;
      }
      const tmp = `${this.file}.${process.pid}.tmp`;
      const content: Rendezvous = { v: 1, endpoint, pid: process.pid };
      writeFileSync(tmp, `${JSON.stringify(content)}\n`, { mode: 0o600 });
      renameSync(tmp, this.file);
      process.once('exit', this.onExit);
      this.timer = setInterval(() => {
        this.checkOwnership();
      }, this.options.checkEveryMs ?? OWNERSHIP_CHECK_MS);
      this.timer.unref();
      logger.info('hooks bridge listening');
      return true;
    } catch (err) {
      logger.warn("the hooks bridge didn't start; the plugin's hooks won't reach this server", {
        code: (err as NodeJS.ErrnoException).code ?? 'error',
      });
      this.cleanupSync();
      return false;
    }
  }

  /** Closes the endpoint and removes the rendezvous file (if it still names this server). */
  close(): Promise<void> {
    this.closed = true;
    const server = this.server;
    this.cleanupSync();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server === undefined) return Promise.resolve();
    return new Promise((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }

  private isClosed(): boolean {
    return this.closed;
  }

  private checkOwnership(): void {
    if (this.options.owns === undefined || this.options.owns()) return;
    this.options.logger.info('hooks bridge closed: another server is the channel now');
    void this.close();
  }

  private cleanupSync(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    process.removeListener('exit', this.onExit);
    const endpoint = this.endpoint;
    if (endpoint === undefined) return;
    try {
      const raw = RendezvousSchema.safeParse(JSON.parse(readFileSync(this.file, 'utf8')));
      if (raw.success && raw.data.endpoint === endpoint) rmSync(this.file, { force: true });
    } catch {
      // Gone already, or another server's.
    }
    if (this.platform !== 'win32') rmSync(endpoint, { force: true });
    try {
      this.server?.close();
    } catch {
      // Closed already.
    }
    this.server = undefined;
  }

  private serve(socket: Socket): void {
    this.sockets.add(socket);
    const controller = new AbortController();
    let size = 0;
    const chunks: Buffer[] = [];
    let handled = false;
    // The forwarder keeps its side open while it waits: its end means Claude Code cancelled the hook.
    const done = (): void => {
      this.sockets.delete(socket);
      controller.abort();
    };
    socket.once('end', done);
    socket.once('close', done);
    socket.on('error', () => undefined);
    socket.setTimeout(READ_TIMEOUT_MS, () => {
      if (!handled) socket.destroy();
    });
    const handle = (): void => {
      if (handled) return;
      handled = true;
      socket.setTimeout(0);
      const buf = Buffer.concat(chunks);
      const line = buf.subarray(0, buf.indexOf(0x0a)).toString('utf8');
      void this.answer(line, controller.signal).then(
        (reply) => {
          if (!socket.destroyed) socket.end(`${JSON.stringify(reply)}\n`);
        },
        () => {
          if (!socket.destroyed) socket.end(`${JSON.stringify({ ok: false })}\n`);
        },
      );
    };
    socket.on('data', (chunk: Buffer) => {
      if (handled) return;
      size += chunk.length;
      if (size > MAX_MESSAGE_BYTES) {
        this.options.logger.info('hook refused', { reason: 'too_large' });
        handled = true;
        socket.destroy();
        return;
      }
      chunks.push(chunk);
      if (chunk.includes(0x0a)) handle();
    });
  }

  /** What one message gets back. */
  private async answer(line: string, signal: AbortSignal): Promise<{ ok: boolean; text?: string }> {
    const logger = this.options.logger;
    const message = parseHookMessage(line);
    if (message === undefined) {
      logger.info('hook refused', { reason: 'shape' });
      return { ok: false };
    }
    if (this.options.owns !== undefined && !this.options.owns()) {
      void this.close();
      return { ok: false };
    }
    // A hook holds Claude Code up while it waits: the process list gets a moment at startup, no more.
    const gate = this.gate ?? (await waitAtMost(this.gateReady, GATE_WAIT_MS));
    if (gate === undefined || !gate.accepts(message)) {
      logger.debug('hook from another Claude Code ignored', { hook: message.hook });
      return { ok: false };
    }
    const text = await this.options.dispatch(message.hook, message.args, signal);
    return text === undefined ? { ok: true } : { ok: true, text };
  }
}

/** Reads a rendezvous file (tests and status); undefined when there is none or it isn't one. */
export function readRendezvous(file: string): Rendezvous | undefined {
  try {
    const parsed = RendezvousSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The rendezvous file of a folder (default folder of rendezvous files). */
export function rendezvousFile(
  folder: string,
  dir: string = hookDir(),
  platform: NodeJS.Platform = process.platform,
): string {
  return join(dir, `${folderKey(folder, platform)}.json`);
}
