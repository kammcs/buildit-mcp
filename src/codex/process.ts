/**
 * The `codex app-server` child: started over stdio, ended by closing its
 * stdin (it exits cleanly then), killed if it hasn't after a grace period.
 * Its stderr is its own log; the bridge keeps it out of its output and
 * counts the lines only (they may carry what people wrote). Until the
 * handshake is done, its first lines are kept too (bounded), so a start
 * that fails can say why in the terminal (startup.ts); then they go.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import type { Logger } from '../log.js';
import type { CodexBinary } from './binary.js';
import { STARTUP_LINE_CHARS, STARTUP_LINES_MAX } from './startup.js';

/** The app-server's two streams and how to end it: a real child, or a fake in tests. */
export interface AppServerProcess {
  stdout: Readable;
  stdin: Writable;
  /** Settles with the exit code when the process has ended. */
  exited: Promise<number | null>;
  /** Ends it: stdin closed, then a kill after `graceMs`. */
  stop(graceMs?: number): Promise<number | null>;
  /**
   * What it wrote to stderr while starting (its first lines), once it has
   * exited or after at most a second; for the terminal only.
   */
  startupStderr?(): Promise<readonly string[]>;
  /** The handshake is done: stderr's lines are no longer kept. */
  started?(): void;
}

/**
 * Starts the app-server with these arguments and these environment
 * variables added to the bridge's own (the hosted tools' secret).
 */
export type SpawnAppServer = (
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
) => AppServerProcess;

/** How long the app-server gets to exit after its stdin closes. */
export const STOP_GRACE_MS = 5000;

/** Starts `<codex> app-server <args>` with the bridge's working folder. */
export function spawnAppServer(
  binary: CodexBinary,
  options: { cwd: string; logger: Logger },
): SpawnAppServer {
  return (args, env = {}) => {
    const child = spawn(binary.path, ['app-server', ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...binary.env, ...env },
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
    let startup: string[] | undefined = [];
    const stderrClosed = new Promise<void>((resolve) => {
      child.stderr.once('close', () => {
        resolve();
      });
    });
    createInterface({ input: child.stderr }).on('line', (line) => {
      stderrLines++;
      if (startup !== undefined && startup.length < STARTUP_LINES_MAX) {
        startup.push(line.slice(0, STARTUP_LINE_CHARS));
      }
    });
    void exited.then((code) => {
      options.logger.info('codex app-server exited', { code, stderr_lines: stderrLines });
    });
    return {
      stdout: child.stdout,
      stdin: child.stdin,
      exited,
      async startupStderr() {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          Promise.all([exited, stderrClosed]),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 1000);
          }),
        ]);
        clearTimeout(timer);
        return [...(startup ?? [])];
      },
      started() {
        startup = undefined;
      },
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
