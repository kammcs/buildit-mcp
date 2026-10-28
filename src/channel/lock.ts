/**
 * One channel server per folder.
 *
 * Claude Code may start more than one buildit server for the same folder
 * (the plugin's and one added with `claude mcp add`, or two Claude Code
 * windows). Only one of them may read the session's events, or each would
 * see only some of the messages and answers. The first to start takes a
 * lock file keyed like the folder's saved session (the SHA-256 of the
 * folder and the API's origin), next to the token file:
 * `<sessions folder>/locks/<key>.lock`, created exclusively (folder 0700,
 * file 0600), holding `{"pid": n, "started_at": "…Z"}`. It is held for the
 * process's life and removed when the process exits. A lock whose process
 * is gone (a crash) is taken over.
 *
 * The others serve their tools without the channel: no loop, and `reply`
 * and `ask` say which server is the channel.
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
  /** Removes the lock (once); also done when the process exits. */
  release(): void;
}

export interface LockOptions {
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

/** The text `reply` and `ask` give in a server that isn't the folder's channel. */
export const NOT_THE_CHANNEL =
  'Another buildit server in this folder is the buildIt.Social channel.';

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

function holderPid(path: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown };
    return typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0
      ? parsed.pid
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Takes the folder's channel lock, or returns undefined when a running
 * process holds it. A lock left by a process that is gone, or one that
 * can't be read, is taken over (once: two servers racing for it can't
 * both win, since the file is created exclusively).
 */
export function acquireChannelLock(
  folder: string,
  apiUrl: string,
  options: LockOptions = {},
): ChannelLock | undefined {
  const dir = options.dir ?? defaultLockDir();
  const path = join(dir, `${sessionKey(folder, apiUrl)}.lock`);
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? processAlive;
  const now = options.now ?? (() => new Date());
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = openSync(path, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = holderPid(path);
      if (holder !== undefined && holder !== pid && isAlive(holder)) return undefined;
      // The holder is gone (or the file is unreadable, or it is this process): take it over.
      rmSync(path, { force: true });
      continue;
    }
    try {
      writeSync(fd, JSON.stringify({ pid, started_at: now().toISOString() }) + '\n');
    } finally {
      closeSync(fd);
    }
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best effort (Windows has no mode bits).
    }
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      process.removeListener('exit', release);
      // Only our own lock: a later holder's file stays.
      if (holderPid(path) === pid) rmSync(path, { force: true });
    };
    if (options.releaseOnExit !== false) process.once('exit', release);
    return { path, release };
  }
  return undefined;
}
