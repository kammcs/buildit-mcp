/**
 * The `codex app-server` child: started over stdio, ended by closing its
 * stdin (it exits cleanly then), killed if it hasn't after a grace period.
 * Its stderr is its own log; the bridge keeps it out of its output and
 * counts the lines only (they may carry what people wrote).
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import type { Logger } from '../log.js';
import type { CodexBinary } from './binary.js';

/** The app-server's two streams and how to end it: a real child, or a fake in tests. */
export interface AppServerProcess {
  stdout: Readable;
  stdin: Writable;
  /** Settles with the exit code when the process has ended. */
  exited: Promise<number | null>;
  /** Ends it: stdin closed, then a kill after `graceMs`. */
  stop(graceMs?: number): Promise<number | null>;
}

export type SpawnAppServer = (args: readonly string[]) => AppServerProcess;

/** How long the app-server gets to exit after its stdin closes. */
export const STOP_GRACE_MS = 5000;

/** Starts `<codex> app-server <args>` with the bridge's working folder. */
export function spawnAppServer(
  binary: CodexBinary,
  options: { cwd: string; logger: Logger },
): SpawnAppServer {
  return (args) => {
    const child = spawn(binary.path, ['app-server', ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...binary.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => {
        resolve(code);
      });
      child.once('error', (err) => {
        options.logger.error('codex app-server could not start', { error: err });
        resolve(null);
      });
    });
    let stderrLines = 0;
    createInterface({ input: child.stderr }).on('line', () => {
      stderrLines++;
    });
    void exited.then((code) => {
      options.logger.info('codex app-server exited', { code, stderr_lines: stderrLines });
    });
    return {
      stdout: child.stdout,
      stdin: child.stdin,
      exited,
      async stop(graceMs = STOP_GRACE_MS) {
        if (child.exitCode !== null) return child.exitCode;
        child.stdin.end();
        const timer = setTimeout(() => {
          child.kill();
        }, graceMs);
        timer.unref();
        const code = await exited;
        clearTimeout(timer);
        return code;
      },
    };
  };
}
