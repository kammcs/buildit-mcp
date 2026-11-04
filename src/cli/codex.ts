/**
 * `buildit-mcp codex` (preview): the folder's buildIt.Social session,
 * driving a `codex app-server` child.
 *
 * It runs in a terminal. The folder's saved session is used (connect
 * first, with --project, when there is none); the folder's channel lock is
 * taken as the plugin's server takes it, so no Claude Code channel in the
 * same folder reads the session's events meanwhile. Then the channel loop
 * reads the events as in channel mode and hands them to the bridge
 * (src/codex/bridge.ts). The tool approval and request journals, and the
 * Codex thread map, sit next to the lock files.
 *
 * It stops on Ctrl+C (the session goes offline, the app-server's stdin is
 * closed), when the app-server exits (exit code 1), or when the session
 * ends for good (revoked or expired: its saved token is cleared).
 */
import { join } from 'node:path';

import { ApiClient } from '../api/client.js';
import { suggestedCapabilities } from '../capabilities.js';
import { ToolApprovals } from '../channel/approvals.js';
import { BRIDGE_ATTACHMENTS_DIR } from '../channel/attachments.js';
import { acquireChannelLock, defaultLockDir, type ChannelLock } from '../channel/lock.js';
import { ChannelLoop, ChannelState } from '../channel/loop.js';
import { TypingIndicator } from '../channel/typing.js';
import { findCodex, CodexNotFoundError, type BinaryHost } from '../codex/binary.js';
import { CodexBridge, CodexVersionError } from '../codex/bridge.js';
import { spawnAppServer, type SpawnAppServer } from '../codex/process.js';
import { AppServerConnection } from '../codex/rpc.js';
import { ThreadMap } from '../codex/thread-map.js';
import type { Worktrees } from '../codex/worktrees.js';
import { BridgeToolServer, newBridgeSecret } from '../codex/tool-server.js';
import {
  DEFAULT_APPROVAL_TIMEOUT_MINUTES,
  DEFAULT_ASK_TIMEOUT_MINUTES,
  DEFAULT_MAX_PARALLEL_ITEMS,
  parseApiUrl,
  type CodexOptions,
} from '../config.js';
import { policyNotePath, writePolicyNote } from '../codex/policy.js';
import { likelyCause, usefulLine } from '../codex/startup.js';
import { createLogger, scrubString } from '../log.js';
import { forgetSession, savedApiUrl, sessionKey } from '../secrets/keychain.js';
import { hookWaitSeconds } from '../transports/stdio.js';
import { compareVersions, SERVER_VERSION } from '../version.js';
import { runConnect, type CommandIO } from './commands.js';

export interface CodexDeps {
  /** Resolves when the person stops it (index.ts: SIGINT or SIGTERM). */
  stop: Promise<void>;
  /** For tests: starts the app-server (default: the codex program found). */
  spawn?: SpawnAppServer;
  /** For tests: where the codex program is looked for. */
  binaryHost?: BinaryHost;
  /** For tests: the lock files' folder. */
  lockDir?: string;
  /** For tests: the logs' sink (default stderr). */
  logSink?: (line: string) => void;
  /** For tests: the channel loop's poll interval. */
  intervalMs?: number;
  /** For tests: the typing beat. */
  typingEveryMs?: number;
  /** Told once the bridge runs (tests, and the smoke script). */
  onReady?: (bridge: CodexBridge, state: ChannelState) => void;
  /** For tests: the approval cards' timing (a wait in seconds, and milliseconds per second). */
  approvals?: { msPerSecond?: number; now?: () => number; waitS?: number };
  /** For tests: the items' worktrees (false: items work in the folder). */
  worktrees?: Worktrees | false;
}

/** Runs the bridge until it is stopped; the exit code. */
export async function runCodex(
  options: CodexOptions,
  io: CommandIO,
  deps: CodexDeps,
): Promise<number> {
  let apiUrl = options.apiUrl;
  if (options.apiUrlFlag !== true) {
    const saved = await savedApiUrl(io.store, options.folder);
    if (saved !== undefined) {
      try {
        apiUrl = parseApiUrl(saved);
      } catch {
        io.err(
          'The API saved for this folder is not valid; using BUILDIT_API_URL or the default.\n',
        );
      }
    }
  }
  const key = sessionKey(options.folder, apiUrl);
  let token = await io.store.get(key);
  if (token === undefined) {
    if (options.projects.length === 0) {
      io.err(
        `No buildIt.Social session is saved for ${options.folder}. Connect it first: buildit-mcp codex --project <KEY> (or buildit-mcp connect --project <KEY>).\n`,
      );
      return 2;
    }
    const code = await runConnect(
      {
        apiUrl,
        folder: options.folder,
        projects: options.projects,
        label: options.label,
        yes: options.yes,
        ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
      },
      io,
    );
    if (code !== 0) return code;
    token = await io.store.get(key);
    if (token === undefined) return 1;
  }

  // The hosted tools' secret for this run, made first so the logs scrub it too.
  const bridgeSecret = newBridgeSecret();
  const logger = createLogger({
    level: options.logLevel,
    secrets: [token, bridgeSecret],
    ...(deps.logSink === undefined ? {} : { sink: deps.logSink }),
  });

  let spawn = deps.spawn;
  if (spawn === undefined) {
    try {
      const binary = findCodex(options.codexPath, deps.binaryHost);
      logger.info('codex found', { via: binary.via });
      spawn = spawnAppServer(binary, {
        cwd: options.folder,
        logger: logger.child({ component: 'codex' }),
      });
    } catch (err) {
      if (err instanceof CodexNotFoundError) {
        io.err(`${err.message}\n`);
        return 2;
      }
      throw err;
    }
  }

  const lockDir = deps.lockDir ?? defaultLockDir();
  let lock: ChannelLock | undefined;
  try {
    lock = acquireChannelLock(options.folder, apiUrl, { plugin: true, dir: lockDir });
  } catch (err) {
    logger.warn('could not take the channel lock', { error: err });
  }
  if (lock === undefined) {
    io.err(
      'Another buildit server (Claude Code\'s plugin, or another "buildit-mcp codex") receives this folder\'s messages. Stop it first, or run Codex in another folder.\n',
    );
    return 2;
  }

  const api = new ApiClient({
    baseUrl: apiUrl,
    token,
    logger,
    ...(io.fetch ? { fetch: io.fetch } : {}),
  });
  await api
    .getMeta()
    .then((meta) => {
      if (meta.min_mcp_version && compareVersions(SERVER_VERSION, meta.min_mcp_version) < 0) {
        logger.warn('this buildit-mcp is older than the API supports; update it', {
          version: SERVER_VERSION,
          min_version: meta.min_mcp_version,
        });
      }
    })
    .catch(() => undefined);

  const state = new ChannelState();
  state.folder = options.folder;
  state.approvals = new ToolApprovals({
    logger: logger.child({ component: 'approvals' }),
    journal: join(lockDir, `${key}.approvals.json`),
  });
  state.requestJournal = join(lockDir, `${key}.requests.json`);
  state.loadRequestJournal();
  // Attachments go to a folder of no client's own (.buildit/attachments), not Claude Code's.
  state.attachmentsDir = BRIDGE_ATTACHMENTS_DIR;

  // The bridge's tools, for its Codex child only (loopback, a secret for this run).
  const tools = new BridgeToolServer({
    api,
    state,
    logger: logger.child({ component: 'codex_tools' }),
    ask: { questionsInApp: true, hookWaitS: hookWaitSeconds(DEFAULT_ASK_TIMEOUT_MINUTES) },
    secret: bridgeSecret,
  });
  try {
    await tools.start();
  } catch (err) {
    io.err(
      `The bridge could not serve its tools on this computer's loopback address: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    lock.release();
    return 1;
  }

  const proc = spawn(
    options.codexConfig.flatMap((c) => ['-c', c]),
    tools.env,
  );
  const connection = new AppServerConnection(proc.stdout, proc.stdin, {
    logger: logger.child({ component: 'codex_rpc' }),
  });
  const bridge = new CodexBridge({
    connection,
    api,
    state,
    logger: logger.child({ component: 'codex_bridge' }),
    threads: new ThreadMap(join(lockDir, `${key}.codex-threads.json`), logger),
    folder: options.folder,
    toolServer: tools,
    maxParallel: options.ask?.maxParallelItems ?? DEFAULT_MAX_PARALLEL_ITEMS,
    keepPlugins: options.keepPlugins === true,
    ...(deps.worktrees === undefined ? {} : { worktrees: deps.worktrees }),
    approvals: {
      inApp: options.approvals?.inApp ?? true,
      waitS: hookWaitSeconds(options.approvals?.timeoutMinutes ?? DEFAULT_APPROVAL_TIMEOUT_MINUTES),
      ...deps.approvals,
    },
    onPolicy: (policy) => {
      writePolicyNote(policyNotePath(lockDir, key), policy);
    },
    typing: new TypingIndicator({
      api,
      logger: logger.child({ component: 'typing' }),
      ...(deps.typingEveryMs === undefined ? {} : { everyMs: deps.typingEveryMs }),
    }),
  });

  const shutdown = async (): Promise<void> => {
    await bridge.close();
    connection.close();
    await proc.stop();
    await tools.close();
    lock.release();
  };

  try {
    await bridge.initialize();
    proc.started?.();
  } catch (err) {
    if (err instanceof CodexVersionError) {
      io.err(`${err.message}\n`);
    } else {
      // What it said while starting, to the terminal only (scrubbed), with the likely cause.
      const said = usefulLine((await proc.startupStderr?.()) ?? []);
      const line = said === undefined ? undefined : scrubString(said, [token, bridgeSecret]);
      io.err(
        [
          `The Codex app-server did not start: ${err instanceof Error ? err.message : String(err)}`,
          ...(line === undefined ? [] : [`It said: ${line}`]),
          likelyCause(line, options.codexConfig),
        ].join('\n') + '\n',
      );
      logger.error('the codex app-server did not start', { said_something: line !== undefined });
    }
    await shutdown();
    return err instanceof CodexVersionError ? 2 : 1;
  }

  const status = { ended: false };
  const loop = new ChannelLoop({
    api,
    logger: logger.child({ component: 'channel' }),
    state,
    notify: (params, extra) => bridge.handle(params, extra),
    capabilities: () => suggestedCapabilities(options.capabilities),
    owns: () => lock.owns(),
    ...(deps.intervalMs === undefined ? {} : { intervalMs: deps.intervalMs }),
    onEnded: async (reason) => {
      status.ended = true;
      if (reason === 'token_revoked' || reason === 'token_expired') {
        await forgetSession(io.store, options.folder, apiUrl).catch(() => undefined);
        io.err(
          'The session was revoked or has expired, so its saved token is cleared; run "buildit-mcp codex --project <KEY>" to connect again.\n',
        );
      }
    },
  });
  const running = loop.start();
  // Once the session is known, items whose work a restart cut short carry on.
  const restoring = (async () => {
    while (state.session === undefined && !loop.isStopped()) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (state.session !== undefined) bridge.restore();
  })();
  deps.onReady?.(bridge, state);
  io.out(
    'buildit-mcp codex (preview): messages to your agent in buildIt.Social now go to Codex in this folder. Press Ctrl+C to stop.\n',
  );

  const outcome = await Promise.race([
    deps.stop.then(() => 'stopped' as const),
    proc.exited.then(() => 'exited' as const),
    running.then(() => 'loop' as const),
  ]);
  if (outcome === 'exited') logger.error('the codex app-server exited; stopping');
  await loop.stop();
  await restoring;
  await shutdown();
  if (outcome === 'stopped') return 0;
  if (outcome === 'loop' && !status.ended && !connection.closed) return 0;
  return 1;
}
