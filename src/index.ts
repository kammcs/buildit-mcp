#!/usr/bin/env node
/**
 * The buildit-mcp command. stdio by default; Streamable HTTP with --http.
 */
import { ConfigError, parseCli, USAGE } from './config.js';
import { createLogger } from './log.js';
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
    process.stdout.write(USAGE);
    return;
  }
  if (action.kind === 'version') {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  const { config } = action;
  const logger = createLogger({
    level: config.logLevel,
    ...(config.token ? { secrets: [config.token] } : {}),
  });
  for (const warning of config.warnings) logger.warn(warning);
  const unknown = unknownToolNames(CATALOG, config.excludeTools);
  if (unknown.length > 0) {
    logger.warn('BUILDIT_EXCLUDE_TOOLS names tools this version does not have', { names: unknown });
  }
  logger.info('starting', {
    version: SERVER_VERSION,
    mode: config.mode,
    api_url: config.apiUrl,
    toolsets: config.toolsets,
    read_only: config.readOnly,
  });

  if (config.mode === 'stdio') {
    const handle = startStdio(config, logger);
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
