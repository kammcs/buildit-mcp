/**
 * runCodex in process for tests: the fake agent API's sessions (the
 * person) and the fake app-server (Codex), in a throwaway folder. The same
 * harness as codex-bridge.test.ts's, shared by the hosted tools', the
 * approvals' and the files' tests.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ChannelState } from '../../src/channel/loop.js';
import { runCodex, type CodexDeps } from '../../src/cli/codex.js';
import type { CommandIO } from '../../src/cli/commands.js';
import type { CodexBridge } from '../../src/codex/bridge.js';
import type { CodexOptions } from '../../src/config.js';
import { createLogger } from '../../src/log.js';
import { FileTokenStore, sessionKey } from '../../src/secrets/keychain.js';
import type { FakeApi } from './fake-api.js';
import { CodexHome, FakeAppServer } from './fake-codex.js';
import { SESSION_TOKENS } from './fake-sessions.js';

export interface CodexRun {
  done: Promise<number>;
  stop: () => Promise<number>;
  bridge: () => CodexBridge;
  state: () => ChannelState;
  logs: string[];
  out: string[];
  err: string[];
}

export async function waitFor(check: () => boolean, ms = 4000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A folder, the fakes and the runs of one test; `cleanup()` ends them all. */
export class CodexBench {
  readonly dir: string;
  readonly folder: string;
  readonly lockDir: string;
  readonly fakes: FakeAppServer[] = [];
  private readonly runs: CodexRun[] = [];
  readonly token = SESSION_TOKENS.first;

  constructor(readonly api: FakeApi) {
    this.dir = mkdtempSync(join(tmpdir(), 'buildit-mcp-codex-'));
    this.folder = join(this.dir, 'work');
    mkdirSync(this.folder);
    this.lockDir = join(this.dir, 'locks');
  }

  fake(options: ConstructorParameters<typeof FakeAppServer>[1] = {}, home?: CodexHome) {
    const f = new FakeAppServer(home, options);
    this.fakes.push(f);
    return f;
  }

  async start(
    codex: FakeAppServer,
    options: Partial<CodexOptions> = {},
    deps: Partial<CodexDeps> = {},
  ): Promise<CodexRun> {
    const store = new FileTokenStore(join(this.dir, 'sessions.json'));
    await store.set(sessionKey(this.folder, this.api.url), this.token);
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
        apiUrl: this.api.url,
        apiUrlFlag: true,
        folder: this.folder,
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
        lockDir: this.lockDir,
        logSink: (l) => logs.push(l),
        intervalMs: 20,
        onReady: (b, s) => {
          bridge = b;
          state = s;
        },
        ...deps,
      },
    );
    const r: CodexRun = {
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
    this.runs.push(r);
    return r;
  }

  /** Stops every run and returns the fakes' violations, then removes the folder. */
  async cleanup(): Promise<string[]> {
    await Promise.all(this.runs.splice(0).map((r) => r.stop()));
    const found = this.fakes.flatMap((f) => [...f.violations, ...f.selfViolations]);
    rmSync(this.dir, { recursive: true, force: true });
    return found;
  }
}

export const logged = (r: CodexRun, msg: string): boolean => r.logs.some((l) => l.includes(msg));
