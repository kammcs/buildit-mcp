/**
 * Streamable HTTP mode: stateless, one MCP server instance per request.
 *
 * - Every POST must carry `Authorization: Bearer <token>`; that request's
 *   API calls use that token, and nothing is kept afterwards.
 * - Host and Origin are checked before anything else (DNS-rebinding
 *   protection): on a loopback bind only localhost names pass; elsewhere the
 *   configured lists apply, and any request with an Origin header is refused
 *   unless its hostname is listed.
 * - GET and DELETE on the endpoint answer 405: there are no sessions to
 *   resume or end, and no standalone event stream.
 * - `X-Buildit-Toolsets` picks the toolsets for one request; read-only mode
 *   and the exclude list from the server's own config still apply.
 * - Both protocol eras are served: 2026-07-28 (stateless, per-request _meta)
 *   and the 2025-11-25 initialize handshake (through the SDK's stateless
 *   fallback).
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { serve, type ServerType } from '@hono/node-server';
import { hostHeaderValidation, originValidation } from '@modelcontextprotocol/hono';
import {
  createMcpHandler,
  isJsonContentType,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  readRequestBody,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';
import { Hono, type Context } from 'hono';

import { ApiClient } from '../api/client.js';
import { ConfigError, isLoopbackHost, parseToolsets, type Config } from '../config.js';
import { IdentityCache, invalidatesIdentity, type IdentityCacheOptions } from '../identity.js';
import type { Logger } from '../log.js';
import {
  createMcpServer,
  DEGRADED_LIST_TTL_MS,
  listedByPolicy,
  resolveListedTools,
  scopesFromApi,
} from '../server.js';
import { CATALOG } from '../toolsets/catalog.js';
import type { ToolDefinition, ToolPolicy } from '../toolsets/registry.js';
import type { ToolsetName } from '../toolsets/toolsets.js';

export const MCP_PATH = '/mcp';
export const TOOLSETS_HEADER = 'x-buildit-toolsets';
const MAX_BODY_BYTES = 1024 * 1024;

export interface HttpOptions {
  catalog?: readonly ToolDefinition[];
  fetch?: typeof fetch;
  /** The per-token identity cache's settings (tests shorten or clock it). */
  identityCache?: IdentityCacheOptions;
}

/** Per-request data handed to the server factory through the SDK's authInfo pass-through. */
interface RequestExtra {
  [key: string]: unknown;
  toolsets: ToolsetName[];
  /** True when the request lists tools, resources or prompts, so the token's scopes must be read. */
  lists: boolean;
  requestId: string;
}

function jsonRpcError(code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

/** The bearer token from an Authorization header, or undefined. */
export function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer[ \t]+([^\s]+)[ \t]*$/i.exec(header.trim());
  return match?.[1];
}

/** The list methods whose answer depends on the token's scopes. */
const LIST_METHODS = new Set([
  'tools/list',
  'resources/list',
  'resources/templates/list',
  'prompts/list',
]);

/** Whether a JSON-RPC body (single or batch) lists tools, resources or prompts. */
function listsTools(body: unknown): boolean {
  const messages = Array.isArray(body) ? (body as unknown[]) : [body];
  return messages.some((m) => {
    const method =
      m !== null && typeof m === 'object' ? (m as { method?: unknown }).method : undefined;
    return typeof method === 'string' && LIST_METHODS.has(method);
  });
}

export function createHttpApp(
  config: Config,
  logger: Logger,
  options: HttpOptions = {},
): { app: Hono; handler: McpHttpHandler } {
  const catalog = options.catalog ?? CATALOG;
  const loopback = isLoopbackHost(config.http.host);
  const allowedHosts =
    config.http.allowedHosts ?? (loopback ? localhostAllowedHostnames() : undefined);
  const allowedOrigins = config.http.allowedOrigins ?? (loopback ? localhostAllowedOrigins() : []);
  const basePolicy: Omit<ToolPolicy, 'toolsets'> = {
    readOnly: config.readOnly,
    excludeTools: config.excludeTools,
  };

  // The token's scopes, briefly, so listing doesn't read /v1/me on every request.
  const identities = new IdentityCache(options.identityCache);

  const handler = createMcpHandler(
    async (ctx) => {
      const auth = ctx.authInfo;
      // Unreachable: the route below only calls the handler with authInfo.
      if (!auth) throw new Error('missing caller');
      const extra = auth.extra as RequestExtra;
      const token = auth.token;
      const reqLogger = logger.child({ http_request_id: extra.requestId });
      const api = new ApiClient({
        baseUrl: config.apiUrl,
        token,
        logger: reqLogger,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        onError: (err) => {
          if (invalidatesIdentity(err)) identities.evict(token);
        },
      });
      const policy: ToolPolicy = { ...basePolicy, toolsets: extra.toolsets };
      // Listing reads the token's scopes (cached briefly); a call is checked by the API itself.
      if (!extra.lists) {
        return createMcpServer({ ...listedByPolicy(catalog, policy), api, logger: reqLogger });
      }
      const readScopes = scopesFromApi(api);
      const listed = await resolveListedTools(
        async () =>
          (await identities.get(token, async () => ({ scopes: await readScopes() }))).scopes,
        catalog,
        policy,
        reqLogger,
      );
      return createMcpServer({
        tools: listed.tools,
        resources: listed.resources,
        prompts: listed.prompts,
        api,
        logger: reqLogger,
        // A list made without the token's scopes is cached briefly, so it is soon read again.
        ...(listed.identity === 'known' ? {} : { toolsListTtlMs: DEGRADED_LIST_TTL_MS }),
      });
    },
    {
      onerror: (error) => {
        logger.warn('mcp handler error', { error });
      },
      maxRequestBodySize: MAX_BODY_BYTES,
    },
  );

  const app = new Hono();

  // Access log: method, path, status and timing only. Never headers or bodies.
  app.use('*', async (c, next) => {
    const started = Date.now();
    await next();
    logger.info('http request', {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      duration_ms: Date.now() - started,
    });
  });

  if (allowedHosts !== undefined) app.use('*', hostHeaderValidation(allowedHosts));
  app.use('*', originValidation(allowedOrigins));

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  const methodNotAllowed = (c: Context): Response => {
    c.header('Allow', 'POST');
    return c.json(
      jsonRpcError(-32000, 'Method not allowed. This server is stateless: POST only.'),
      405,
    );
  };
  app.on(['GET', 'DELETE', 'PUT', 'PATCH'], MCP_PATH, methodNotAllowed);

  app.post(MCP_PATH, async (c) => {
    const token = bearerToken(c.req.header('authorization'));
    if (token === undefined) {
      c.header('WWW-Authenticate', 'Bearer realm="buildit-mcp"');
      return c.json(
        jsonRpcError(
          -32001,
          'Unauthorized: send "Authorization: Bearer <token>" with a buildIt.Social personal access token.',
        ),
        401,
      );
    }

    let toolsets = config.toolsets;
    const header = c.req.header(TOOLSETS_HEADER);
    if (header !== undefined) {
      try {
        toolsets = parseToolsets(header, 'X-Buildit-Toolsets');
      } catch (err) {
        if (!(err instanceof ConfigError)) throw err;
        return c.json(jsonRpcError(-32602, err.message), 400);
      }
    }

    let parsedBody: unknown = undefined;
    if (isJsonContentType(c.req.header('content-type'))) {
      const body = await readRequestBody(c.req.raw.clone(), MAX_BODY_BYTES);
      if (body.tooLarge) {
        return c.json(jsonRpcError(-32000, 'Payload too large.'), 413);
      }
      try {
        parsedBody = JSON.parse(body.text);
      } catch {
        return c.json(jsonRpcError(-32700, 'Parse error: the body is not valid JSON.'), 400);
      }
    }

    const extra: RequestExtra = {
      toolsets,
      lists: listsTools(parsedBody),
      requestId: randomUUID(),
    };
    return handler.fetch(c.req.raw, {
      ...(parsedBody === undefined ? {} : { parsedBody }),
      authInfo: { token, clientId: 'buildit-personal-access-token', scopes: [], extra },
    });
  });

  app.notFound((c) =>
    c.json(jsonRpcError(-32000, `Not found. The MCP endpoint is ${MCP_PATH}.`), 404),
  );
  app.onError((err, c) => {
    logger.error('http handler failed', { error: err });
    return c.json(jsonRpcError(-32603, 'Internal error.'), 500);
  });

  return { app, handler };
}

export interface HttpServerHandle {
  /** The MCP endpoint URL, for example http://127.0.0.1:8765/mcp. */
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startHttp(
  config: Config,
  logger: Logger,
  options: HttpOptions = {},
): Promise<HttpServerHandle> {
  const { app, handler } = createHttpApp(config, logger, options);
  const server = await new Promise<ServerType>((resolve, reject) => {
    const s = serve(
      { fetch: app.fetch, hostname: config.http.host, port: config.http.port },
      () => {
        resolve(s);
      },
    );
    s.once('error', reject);
  });
  const port = (server.address() as AddressInfo).port;
  const hostForUrl = config.http.host.includes(':') ? `[${config.http.host}]` : config.http.host;
  const url = `http://${hostForUrl}:${port}${MCP_PATH}`;
  logger.info('listening', { url });
  return {
    url,
    port,
    close: async () => {
      await handler.close();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        if ('closeAllConnections' in server) server.closeAllConnections();
      });
    },
  };
}
