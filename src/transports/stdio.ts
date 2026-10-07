/**
 * stdio mode: one person's agent, the token from BUILDIT_TOKEN.
 *
 * stdout carries only the protocol; logs go to stderr. The token's identity
 * (GET /v1/me) is read at startup and decides the tool list for the
 * connection. A 2025-era client (initialize handshake) and a 2026-07-28
 * client (per-request _meta) are both served from the same factory.
 */
import type { Readable, Writable } from 'node:stream';

import {
  serveStdio,
  StdioServerTransport,
  type StdioServerHandle,
} from '@modelcontextprotocol/server/stdio';

import { ApiClient } from '../api/client.js';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import { createMcpServer, resolveListedTools, type ListedTools } from '../server.js';
import { CATALOG } from '../toolsets/catalog.js';
import type { ToolDefinition } from '../toolsets/registry.js';
import { compareVersions, SERVER_VERSION } from '../version.js';

export interface StdioOptions {
  catalog?: readonly ToolDefinition[];
  fetch?: typeof fetch;
  /** For tests: streams to use instead of the process's stdin and stdout. */
  stdin?: Readable;
  stdout?: Writable;
}

export function startStdio(
  config: Config,
  logger: Logger,
  options: StdioOptions = {},
): StdioServerHandle {
  if (config.token === undefined) throw new Error('stdio mode needs a token');
  const catalog = options.catalog ?? CATALOG;
  const api = new ApiClient({
    baseUrl: config.apiUrl,
    token: config.token,
    logger,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const policy = {
    toolsets: config.toolsets,
    readOnly: config.readOnly,
    excludeTools: config.excludeTools,
  };

  // Read the identity once; retry on the next connection if it failed.
  let listed: Promise<ListedTools> | undefined;
  const listTools = (): Promise<ListedTools> => {
    listed ??= resolveListedTools(api, catalog, policy, logger).then((result) => {
      if (!result.identified) listed = undefined;
      else logger.info('token identified', { scopes: result.scopes, tools: result.tools.length });
      return result;
    });
    return listed;
  };
  void listTools();

  // Warn early when the API needs a newer server.
  void api
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

  return serveStdio(
    async () => {
      const listed = await listTools();
      return createMcpServer({
        tools: listed.tools,
        resources: listed.resources,
        prompts: listed.prompts,
        api,
        logger,
      });
    },
    {
      onerror: (error) => {
        logger.error('stdio transport error', { error });
      },
      ...(options.stdin && options.stdout
        ? { transport: new StdioServerTransport(options.stdin, options.stdout) }
        : {}),
    },
  );
}
