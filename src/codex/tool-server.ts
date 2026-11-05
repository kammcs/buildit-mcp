/**
 * The bridge's own tools, served to its Codex child over loopback
 * Streamable HTTP MCP.
 *
 * Codex loads MCP servers itself, so the bridge serves buildit's tools
 * (the catalog, and the channel tools: reply, ask, get_attachment,
 * list_threads, the handoff and assignment tools, report_to_assigner,
 * ask_reporter) from this process, on 127.0.0.1 and a random port. They
 * share the bridge's ChannelState, so there is no second buildit process
 * and no fight over the folder's channel lock. The plugin's hook tools (approve, tool_seen,
 * turn_ended...) aren't served: Codex's approvals come to the bridge as
 * its own requests.
 *
 * - **Who may call:** every request must carry `Authorization: Bearer
 *   <secret>`, a random secret made for this run and given to the Codex
 *   child only, in its environment (`bearer_token_env_var`). The Host
 *   header must be a loopback name, and any Origin is refused unless it is
 *   a loopback one (DNS-rebinding protection, as in HTTP mode).
 * - **Which conversation calls:** each Codex thread gets its own URL,
 *   `/mcp/<token>`, a random token per place made once per run and set in
 *   that thread's config (`thread/start`'s and `thread/resume`'s
 *   `config`). The bridge knows the caller from the path alone: nothing
 *   the model writes (arguments) or Codex adds (`_meta`) is trusted for
 *   it. A path nobody was given answers 404. (Codex 0.166 does put the
 *   caller in each tools/call's `_meta`: `threadId`, `sessionId`,
 *   `itemId`, `callId`, `windowId` and `x-codex-turn-metadata`, seen in a
 *   real run. That is a cross-check at most: undocumented, and it may
 *   change; the path stays the source of truth.)
 * - **Stateless:** a fresh MCP server per request, as in HTTP mode; the
 *   token's identity (GET /v1/me) is read at most every minute.
 *
 * Nothing is logged of what the calls carry: methods, paths' kinds and
 * statuses only (and the names of `_meta`'s keys, at debug level).
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
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
import { Hono } from 'hono';

import type { ApiClient } from '../api/client.js';
import type { ChannelState } from '../channel/loop.js';
import type { Logger } from '../log.js';
import { createMcpServer, identityFromApi, resolveListedTools } from '../server.js';
import { createAskTool, type AskOptions } from '../tools/ask.js';
import { createAssignmentTools } from '../tools/assignment.js';
import { createReportTool } from '../tools/report.js';
import { createGetAttachmentTool } from '../tools/attachment.js';
import { createHandoffTools } from '../tools/handoff.js';
import { createReplyTool } from '../tools/reply.js';
import { createAskReporterTool } from '../tools/reporter.js';
import { createListThreadsTool } from '../tools/threads.js';
import { CATALOG } from '../toolsets/catalog.js';
import type { ToolCaller, ToolDefinition, ToolPolicy } from '../toolsets/registry.js';
import { TOOLSET_NAMES } from '../toolsets/toolsets.js';
import { servedTools, StdioIdentity } from '../transports/stdio.js';

/** The MCP server's name in Codex's config (its tools are `buildit`'s). */
export const BRIDGE_MCP_SERVER = 'buildit';
/** The environment variable that carries the run's secret to the Codex child. */
export const BRIDGE_SECRET_ENV = 'BUILDIT_MCP_BRIDGE_SECRET';
/** The longest Codex lets one of these tools run (ask waits up to an hour). */
export const BRIDGE_TOOL_TIMEOUT_S = 3600;

/**
 * How long Codex lets a hosted tool run: the question wait (ask's, the
 * plugin's question wait) and a minute more, at most an hour.
 */
export function toolTimeoutSeconds(askWaitS: number): number {
  return Math.min(BRIDGE_TOOL_TIMEOUT_S, Math.max(60, Math.ceil(askWaitS) + 60));
}
/** The path prefix of the per-thread endpoints. */
export const BRIDGE_MCP_PATH = '/mcp';

const MAX_BODY_BYTES = 1024 * 1024;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/;

/** A JSON value, as thread/start's config takes it. */
export type ConfigValue = string | number | boolean | null | ConfigValue[] | ConfigObject;
export interface ConfigObject {
  [key: string]: ConfigValue;
}

/** What the bridge gives a Codex thread's config: the buildit MCP server entry, whole. */
export interface ThreadToolsConfig {
  [key: string]: ConfigValue;
}

export interface ToolServerOptions {
  api: ApiClient;
  state: ChannelState;
  logger: Logger;
  /** The catalog (tests); default every tool. */
  catalog?: readonly ToolDefinition[];
  /** ask's settings (its wait). */
  ask: AskOptions;
  /** The host to bind (default 127.0.0.1; only loopback is allowed). */
  host?: string;
  /** The run's secret (default newBridgeSecret()). */
  secret?: string;
  /** Told when a call finds the session token refused for good. */
  onSessionOver?: (code: string) => void;
}

/** Whether a header holds exactly this bearer secret (in constant time). */
export function hasSecret(header: string | undefined, secret: string): boolean {
  if (header === undefined) return false;
  const match = /^Bearer[ \t]+([^\s]+)[ \t]*$/i.exec(header.trim());
  const given = Buffer.from(match?.[1] ?? '', 'utf8');
  const want = Buffer.from(secret, 'utf8');
  return given.length === want.length && timingSafeEqual(given, want);
}

const randomToken = (): string => randomBytes(24).toString('base64url');

/** A secret for one run: 32 random bytes, base64url. */
export function newBridgeSecret(): string {
  return randomBytes(32).toString('base64url');
}

function jsonRpcError(code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

/**
 * The channel tools a Codex thread gets: those of channel mode without
 * the plugin's hooks (approve, tool_seen, tool_done, agent_done,
 * prompt_typed, turn_ended).
 */
export function bridgeChannelTools(state: ChannelState, ask: AskOptions): ToolDefinition[] {
  return [
    createReplyTool(state, { files: true }),
    createReplyTool(state, { files: false }),
    createGetAttachmentTool(state, { folder: '.buildit/attachments' }),
    createAskTool(state, ask),
    createListThreadsTool(state),
    ...createHandoffTools(state),
    ...createAssignmentTools(state),
    createReportTool(state),
    createAskReporterTool(state),
  ];
}

export class BridgeToolServer {
  readonly secret: string;
  private readonly host: string;
  private server: ServerType | undefined;
  private handler: McpHttpHandler | undefined;
  private listenPort: number | undefined;
  /** Each place's token (made once per run), and back. */
  private readonly tokens = new Map<string, string>();
  private readonly places = new Map<string, string>();
  private readonly identity: StdioIdentity;
  private readonly extraTools: ToolDefinition[];
  /** The thread each place answers now (the bridge tells it). */
  private threadOf: (place: string) => string | undefined = () => undefined;

  constructor(private readonly options: ToolServerOptions) {
    this.secret = options.secret ?? newBridgeSecret();
    this.host = options.host ?? '127.0.0.1';
    const catalog = options.catalog ?? CATALOG;
    // Channel mode's policy: every toolset, nothing excluded (the API checks every call).
    const policy: ToolPolicy = { toolsets: TOOLSET_NAMES, readOnly: false, excludeTools: [] };
    this.extraTools = bridgeChannelTools(options.state, options.ask);
    const { api, logger } = options;
    this.identity = new StdioIdentity(async () => {
      const listed = await resolveListedTools(identityFromApi(api), catalog, policy, logger);
      if (api.served === undefined) await api.getMeta().catch(() => undefined);
      const served = servedTools(api, this.extraTools);
      return { ...listed, tools: [...listed.tools, ...served] };
    }, logger);
  }

  /** The bridge says which buildIt.Social thread each place answers now. */
  attachThreads(threadOf: (place: string) => string | undefined): void {
    this.threadOf = threadOf;
  }

  /** The port it listens on, once started. */
  get port(): number | undefined {
    return this.listenPort;
  }

  /** The environment the Codex child needs (the secret). */
  get env(): Record<string, string> {
    return { [BRIDGE_SECRET_ENV]: this.secret };
  }

  /** The per-thread token of a place, made once in this run. */
  tokenFor(place: string): string {
    let token = this.tokens.get(place);
    if (token === undefined) {
      token = randomToken();
      this.tokens.set(place, token);
      this.places.set(token, place);
    }
    return token;
  }

  /** The URL a place's Codex thread calls the tools on. */
  urlFor(place: string): string {
    if (this.listenPort === undefined) throw new Error('the tool server is not started');
    return `http://${this.host}:${this.listenPort}${BRIDGE_MCP_PATH}/${this.tokenFor(place)}`;
  }

  /**
   * The config a place's Codex thread starts or resumes with: the buildit
   * MCP server entry, replaced whole (so the person's own `buildit` entry,
   * if any, never mixes with it), approved without asking, with the
   * question wait and a minute per call (an hour at most).
   */
  threadConfig(place: string): ThreadToolsConfig {
    return {
      [`mcp_servers.${BRIDGE_MCP_SERVER}`]: {
        url: this.urlFor(place),
        bearer_token_env_var: BRIDGE_SECRET_ENV,
        default_tools_approval_mode: 'approve',
        tool_timeout_sec: toolTimeoutSeconds(
          this.options.ask.toolMaxWaitS ?? this.options.ask.hookWaitS,
        ),
        startup_timeout_sec: 30,
      },
    };
  }

  /** The caller of a place (the tools' ctx.caller). */
  private callerOf(place: string): ToolCaller {
    return { place, thread: () => this.threadOf(place) };
  }

  /** Starts listening on the loopback host and a random port. */
  async start(): Promise<void> {
    if (this.server !== undefined) return;
    const { api, logger, state } = this.options;
    const handler = createMcpHandler(
      async (ctx) => {
        const place = (ctx.authInfo?.extra as { place?: unknown } | undefined)?.place;
        // Unreachable: the route below always names the place.
        if (typeof place !== 'string') throw new Error('missing caller');
        const listed = await this.identity.refresh();
        return createMcpServer({
          tools: listed.tools,
          api,
          logger: logger.child({ codex_place: place }),
          channel: true,
          channelCapability: false,
          channelState: state,
          caller: this.callerOf(place),
          sessionEnded: () => state.ended,
          ...(this.options.onSessionOver === undefined
            ? {}
            : { onSessionOver: this.options.onSessionOver }),
        });
      },
      {
        onerror: (error) => {
          logger.warn('bridge tools: mcp handler error', { error });
        },
        maxRequestBodySize: MAX_BODY_BYTES,
      },
    );
    this.handler = handler;

    const app = new Hono();
    app.use('*', async (c, next) => {
      const started = Date.now();
      await next();
      logger.debug('bridge tools: http request', {
        method: c.req.method,
        status: c.res.status,
        duration_ms: Date.now() - started,
      });
    });
    app.use('*', hostHeaderValidation(localhostAllowedHostnames()));
    app.use('*', originValidation(localhostAllowedOrigins()));
    const unauthorized = (): Response =>
      new Response(JSON.stringify(jsonRpcError(-32001, 'Unauthorized.')), {
        status: 401,
        headers: {
          'content-type': 'application/json',
          'WWW-Authenticate': 'Bearer realm="buildit-mcp-bridge"',
        },
      });
    app.all(`${BRIDGE_MCP_PATH}/:token`, async (c) => {
      // The secret first: without it, nothing says whether a path exists.
      if (!hasSecret(c.req.header('authorization'), this.secret)) return unauthorized();
      const token = c.req.param('token');
      const place = TOKEN_RE.test(token) ? this.places.get(token) : undefined;
      if (place === undefined) {
        logger.warn('bridge tools: a call on a path no thread was given');
        return c.json(jsonRpcError(-32000, 'Not found.'), 404);
      }
      if (c.req.method !== 'POST') {
        c.header('Allow', 'POST');
        return c.json(jsonRpcError(-32000, 'Method not allowed: POST only.'), 405);
      }
      let parsedBody: unknown = undefined;
      if (isJsonContentType(c.req.header('content-type'))) {
        const body = await readRequestBody(c.req.raw.clone(), MAX_BODY_BYTES);
        if (body.tooLarge) return c.json(jsonRpcError(-32000, 'Payload too large.'), 413);
        try {
          parsedBody = JSON.parse(body.text);
        } catch {
          return c.json(jsonRpcError(-32700, 'Parse error: the body is not valid JSON.'), 400);
        }
        logMeta(logger, place, parsedBody);
      }
      return handler.fetch(c.req.raw, {
        ...(parsedBody === undefined ? {} : { parsedBody }),
        authInfo: {
          token: 'bridge',
          clientId: 'codex-bridge',
          scopes: [],
          extra: { place },
        },
      });
    });
    app.notFound((c) => {
      if (!hasSecret(c.req.header('authorization'), this.secret)) return unauthorized();
      return c.json(jsonRpcError(-32000, 'Not found.'), 404);
    });
    app.onError((err, c) => {
      logger.error('bridge tools: handler failed', { error: err });
      return c.json(jsonRpcError(-32603, 'Internal error.'), 500);
    });

    const server = await new Promise<ServerType>((resolve, reject) => {
      const s = serve({ fetch: app.fetch, hostname: this.host, port: 0 }, () => {
        resolve(s);
      });
      s.once('error', reject);
    });
    // A tool may wait for the person for up to an hour (ask): no request timeout.
    if ('requestTimeout' in server) server.requestTimeout = 0;
    this.server = server;
    this.listenPort = (server.address() as AddressInfo).port;
    logger.info('bridge tools listening on loopback', { port: this.listenPort });
  }

  /** Stops listening; calls under way end. */
  async close(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    this.server = undefined;
    await this.handler?.close().catch(() => undefined);
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      if ('closeAllConnections' in server) server.closeAllConnections();
    });
  }
}

/**
 * Logs, at debug level, which `_meta` keys a tools/call carries (names
 * only): what Codex says of the call's thread and turn, for the record.
 * The bridge never relies on them.
 */
function logMeta(logger: Logger, place: string, body: unknown): void {
  const messages = Array.isArray(body) ? (body as unknown[]) : [body];
  for (const m of messages) {
    if (m === null || typeof m !== 'object') continue;
    const r = m as { method?: unknown; params?: { _meta?: unknown } };
    if (r.method !== 'tools/call') continue;
    const meta = r.params?._meta;
    const keys =
      meta !== null && typeof meta === 'object' ? Object.keys(meta).slice(0, 20).sort() : [];
    logger.debug('bridge tools: tools/call', { codex_place: place, meta_keys: keys });
  }
}
