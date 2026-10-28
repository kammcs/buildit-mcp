/**
 * One channel server per folder.
 *
 * Claude Code may start more than one buildit server for the same folder
 * (the plugin's and one added with `claude mcp add`, or two Claude Code
 * windows). Only one of them may read the session's events, or each would
 * see only some of the messages and answers. The server that reads them
 * holds a lock file keyed like the folder's saved session (the SHA-256 of
 * the folder and the API's origin), next to the token file, created
 * exclusively (folder 0700, file 0600), holding `{"pid": n, "started_at":
 * "…Z", "plugin": bool}`. It is held for the process's life and removed
 * when the process exits. A lock whose process is gone (a crash) is taken
 * over.
 *
 * A server started by the buildit plugin (`--from-plugin`, which the
 * plugin's manifest passes) comes first, since Claude Code shows channel
 * messages only from a server it registered as a channel, which the plugin
 * is: plugin servers take `<key>.plugin.lock`, the others `<key>.lock`.
 * The first plugin server wins over later plugin servers. A server without
 * the plugin is the channel only while no plugin server holds its lock: it
 * checks before each poll and before handing on what it fetched
 * (`ChannelLock.owns`), and once a plugin server holds it, it releases its
 * own lock and stops polling for good. The two files make this race-free:
 * each is created exclusively, and only the non-plugin server ever gives
 * way. A plugin server that found a non-plugin server holding the folder
 * waits a moment before its first poll (`PREEMPT_WAIT_MS`), so a poll the
 * other server had already started ends first.
 *
 * The others serve their tools without the channel: no loop, and `reply`,
 * `ask` and `whoami` say another server receives the messages.
 */
import {
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  rmSync,
  writeSync,
  chmodSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { defaultTokenFile, sessionKey } from '../secrets/keychain.js';

export interface ChannelLock {
  /** The lock file's path. */
  readonly path: string;
  /** Whether a server started by the plugin holds it. */
  readonly plugin: boolean;
  /**
   * A plugin server's lock taken while a server without the plugin held
   * the folder (its process id): that one gives way at its next check.
   */
  readonly preempted: number | undefined;
  /**
   * Whether this server is still the folder's channel: its lock is still
   * its own and, for a server without the plugin, no plugin server holds
   * the folder (then its own lock is released, for good).
   */
  owns(): boolean;
  /** Removes the lock (once); also done when the process exits. */
  release(): void;
}

export interface LockOptions {
  /** Started by the buildit plugin (it takes precedence). */
  plugin?: boolean;
  /** The folder for lock files (default: `locks` next to the token file). */
  dir?: string;
  /** This process's id (tests). */
  pid?: number;
  /** Whether a process is running (tests); default `process.kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean;
  /** The clock (tests). */
  now?: () => Date;
  /** Remove the lock when the process exits (default true; tests turn it off). */
  releaseOnExit?: boolean;
}

/** How long a plugin server that took the folder over waits before its first poll. */
export const PREEMPT_WAIT_MS = 3000;

/** The text `reply` and `ask` give in a server that isn't the folder's channel. */
export const NOT_THE_CHANNEL =
  'Another buildIt server in this folder receives the messages from buildIt.Social (it is the channel), so this one can\'t answer there. Remove the extra one with `claude mcp remove <name>` ("buildit-mcp status" in the folder names them), then restart Claude Code.';

/** The default folder for lock files. */
export function defaultLockDir(): string {
  return join(dirname(defaultTokenFile()), 'locks');
}

/** Whether the process with this id is running (EPERM: it is, under another user). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** What a lock file says about its holder. */
export interface LockHolder {
  pid: number;
  started_at: string | undefined;
  plugin: boolean;
}

function readHolder(path: string): LockHolder | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      pid?: unknown;
      started_at?: unknown;
      plugin?: unknown;
    };
    if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      return undefined;
    }
    return {
      pid: parsed.pid,
      started_at: typeof parsed.started_at === 'string' ? parsed.started_at : undefined,
      plugin: parsed.plugin === true,
    };
  } catch {
    return undefined;
  }
}

/** The two lock files of a folder: the plugin servers', and the others'. */
export function lockPaths(
  folder: string,
  apiUrl: string,
  dir: string = defaultLockDir(),
): { plugin: string; server: string } {
  const key = sessionKey(folder, apiUrl);
  return { plugin: join(dir, `${key}.plugin.lock`), server: join(dir, `${key}.lock`) };
}

/** The live holders of a folder's locks (for status), by kind. */
export function lockHolders(
  folder: string,
  apiUrl: string,
  options: Pick<LockOptions, 'dir' | 'isAlive'> = {},
): { plugin: LockHolder | undefined; server: LockHolder | undefined } {
  const isAlive = options.isAlive ?? processAlive;
  const paths = lockPaths(folder, apiUrl, options.dir);
  const live = (path: string): LockHolder | undefined => {
    const h = readHolder(path);
    return h !== undefined && isAlive(h.pid) ? h : undefined;
  };
  return { plugin: live(paths.plugin), server: live(paths.server) };
}

/**
 * Creates a lock file exclusively, or returns undefined when another
 * running process holds it. A lock left by a process that is gone, or
 * one that can't be read, is taken over (once: two servers racing for it
 * can't both win, since the file is created exclusively).
 */
function take(
  path: string,
  pid: number,
  plugin: boolean,
  isAlive: (pid: number) => boolean,
  now: () => Date,
): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = openSync(path, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = readHolder(path)?.pid;
      if (holder !== undefined && holder !== pid && isAlive(holder)) return false;
      // The holder is gone (or the file is unreadable, or it is this process): take it over.
      rmSync(path, { force: true });
      continue;
    }
    try {
      writeSync(fd, JSON.stringify({ pid, started_at: now().toISOString(), plugin }) + '\n');
    } finally {
      closeSync(fd);
    }
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best effort (Windows has no mode bits).
    }
    return true;
  }
  return false;
}

/**
 * Takes the folder's channel lock, or returns undefined when another
 * server is the channel: a running plugin server (for any server), or a
 * running server without the plugin (for another one without it).
 */
export function acquireChannelLock(
  folder: string,
  apiUrl: string,
  options: LockOptions = {},
): ChannelLock | undefined {
  const dir = options.dir ?? defaultLockDir();
  const paths = lockPaths(folder, apiUrl, dir);
  const plugin = options.plugin === true;
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? processAlive;
  const now = options.now ?? (() => new Date());
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pluginHolder = (): number | undefined => {
    const h = readHolder(paths.plugin)?.pid;
    return h !== undefined && h !== pid && isAlive(h) ? h : undefined;
  };
  let preempted: number | undefined;
  if (plugin) {
    if (!take(paths.plugin, pid, true, isAlive, now)) return undefined;
    const other = readHolder(paths.server)?.pid;
    if (other !== undefined && other !== pid && isAlive(other)) preempted = other;
  } else {
    if (pluginHolder() !== undefined) return undefined;
    if (!take(paths.server, pid, false, isAlive, now)) return undefined;
  }
  const path = plugin ? paths.plugin : paths.server;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    process.removeListener('exit', release);
    // Only our own lock: a later holder's file stays.
    if (readHolder(path)?.pid === pid) rmSync(path, { force: true });
  };
  if (options.releaseOnExit !== false) process.once('exit', release);
  return {
    path,
    plugin,
    preempted,
    owns() {
      if (released || readHolder(path)?.pid !== pid) return false;
      if (!plugin && pluginHolder() !== undefined) {
        release();
        return false;
      }
      return true;
    },
    release,
  };
}
