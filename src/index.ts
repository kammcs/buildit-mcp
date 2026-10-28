#!/usr/bin/env node
/**
 * The buildit-mcp command. stdio by default; Streamable HTTP with --http;
 * a Claude Code channel with --channel; and the session commands
 * (connect, disconnect, status), which run in a terminal.
 */
import { createInterface } from 'node:readline/promises';

import { acquireChannelLock } from './channel/lock.js';
import { runConnect, runDisconnect, runStatus, type CommandIO } from './cli/commands.js';
import { COMMAND_USAGE, ConfigError, parseApiUrl, parseCli, USAGE } from './config.js';
import { createLogger } from './log.js';
import { forgetSession, openTokenStore, savedApiUrl, sessionKey } from './secrets/keychain.js';
import { CATALOG } from './toolsets/catalog.js';
import { unknownToolNames } from './toolsets/registry.js';
import { startHttp } from './transports/http.js';
import { startStdio } from './transports/stdio.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

async function main(): Promise<void> {
  let action;
  try {
    action = parseCli(process.argv.slice(2), process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${SERVER_NAME}: ${err.message}\n`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }

  if (action.kind === 'help') {
    process.stdout.write(action.command ? COMMAND_USAGE[action.command] : USAGE);
    return;
  }
  if (action.kind === 'version') {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  if (action.kind === 'connect' || action.kind === 'disconnect' || action.kind === 'status') {
    if (action.options.apiUrlNote !== undefined) {
      process.stdout.write(`${action.options.apiUrlNote}\n`);
    }
    // A terminal command says what happened in plain text; logs stay quiet.
    const store = await openTokenStore({
      warn: (message) => process.stderr.write(`${SERVER_NAME}: ${message}\n`),
    });
    const io: CommandIO = {
      out: (text) => process.stdout.write(text),
      err: (text) => process.stderr.write(`${SERVER_NAME}: ${text}`),
      store,
      logger: createLogger({ level: 'error' }),
      ask: async (question) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        // Without a terminal or input (stdin closed), the answer is empty: not saved.
        const closed = new Promise<string>((resolve) =>
          rl.once('close', () => {
            resolve('');
          }),
        );
        try {
          return await Promise.race([rl.question(question), closed]);
        } finally {
          rl.close();
        }
      },
    };
    process.exitCode =
      action.kind === 'connect'
        ? await runConnect(action.options, io)
        : action.kind === 'disconnect'
          ? await runDisconnect(action.options, io)
          : await runStatus(action.options, io);
    return;
  }

  let { config } = action;
  const early: string[] = [];
  let clearSaved: (() => Promise<void>) | undefined;
  if (config.channel !== undefined) {
    // Channel mode: the API connect saved for the folder, unless --api-url says otherwise.
    const store = await openTokenStore({ warn: (message) => early.push(message) });
    const saved = config.channel.apiUrlFlag
      ? undefined
      : await savedApiUrl(store, config.channel.folder);
    if (saved !== undefined) {
      try {
        config = { ...config, apiUrl: parseApiUrl(saved) };
      } catch {
        early.push(
          'The API saved for this folder is not valid; using BUILDIT_API_URL or the default.',
        );
      }
    }
  }
  if (config.channel !== undefined && config.token === undefined) {
    // Channel mode without a session token in BUILDIT_TOKEN: the token connect saved for the folder.
    const store = await openTokenStore({ warn: () => undefined });
    const key = sessionKey(config.channel.folder, config.apiUrl);
    const token = await store.get(key);
    if (token === undefined) {
      process.stderr.write(
        `${SERVER_NAME}: No buildIt.Social session is saved for ${config.channel.folder}. In a terminal in that folder, run: npx -y @kammcs/buildit-mcp@latest connect --project <KEY>\n`,
      );
      process.exitCode = 2;
      return;
    }
    const folder = config.channel.folder;
    const apiUrl = config.apiUrl;
    config = { ...config, token };
    clearSaved = async () => {
      // The token, and the record of its deployment, as disconnect does.
      await forgetSession(store, folder, apiUrl);
    };
  }

  const logger = createLogger({
    level: config.logLevel,
    ...(config.token ? { secrets: [config.token] } : {}),
  });
  for (const warning of [...config.warnings, ...early]) logger.warn(warning);
  const unknown = unknownToolNames(CATALOG, config.excludeTools);
  if (unknown.length > 0) {
    logger.warn('BUILDIT_EXCLUDE_TOOLS names tools this version does not have', { names: unknown });
  }
  logger.info('starting', {
    version: SERVER_VERSION,
    mode: config.mode,
    channel: config.channel !== undefined,
    api_url: config.apiUrl,
    toolsets: config.toolsets,
    read_only: config.readOnly,
  });

  if (config.mode === 'stdio') {
    // One channel server per folder: the first one to start holds the lock.
    let channelOwner = true;
    if (config.channel !== undefined) {
      try {
        const lock = acquireChannelLock(config.channel.folder, config.apiUrl);
        channelOwner = lock !== undefined;
      } catch (err) {
        // Without a lock folder, serve as the channel (as before locks existed).
        logger.warn('could not take the channel lock; serving as the channel', { error: err });
      }
    }
    const handle = startStdio(config, logger, {
      channelOwner,
      onSessionEnded: async (reason) => {
        if (reason !== 'token_revoked' && reason !== 'token_expired') return;
        if (clearSaved === undefined) return;
        await clearSaved().catch(() => undefined);
        logger.warn(
          'the session was revoked or has expired, so its saved token is cleared; run "buildit-mcp connect" in the folder to connect again',
        );
      },
    });
    const stop = (): void => {
      void handle.close().finally(() => process.exit(0));
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return;
  }

  const handle = await startHttp(config, logger);
  const stop = (): void => {
    logger.info('stopping');
    void handle.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  const token = process.env.BUILDIT_TOKEN;
  createLogger({ secrets: token ? [token] : [] }).error('fatal', { error: message });
  process.exitCode = 1;
});
