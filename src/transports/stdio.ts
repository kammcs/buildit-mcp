/**
 * stdio mode: one person's agent, the token from BUILDIT_TOKEN.
 *
 * stdout carries only the protocol; logs go to stderr. The token's identity
 * (GET /v1/me) is read at startup and decides which tools are listed. It is
 * read again at most every 60 seconds, when the client lists or calls
 * something, and sooner after an auth error. When it can't be read, the
 * next list or call tries again; meanwhile a passing failure (rate limit,
 * network, 5xx) lists every tool the configuration allows, and a refused
 * token lists only whoami. A 2025-era client (initialize handshake) and a
 * 2026-07-28 client (per-request _meta) are both served from the same
 * factory.
 *
 * Channel mode (--channel) adds what makes the server a Claude Code
 * channel: the `claude/channel` capability, the reply tool, and the channel
 * loop (src/channel/loop.ts), started once the client has initialized and
 * stopped when the connection closes. Claude Code doesn't register a
 * channel that negotiates protocol revision 2026-07-28, so in this mode a
 * 2026-07-28 opening is answered as unsupported and the client falls back
 * to the 2025 handshake.
 */
import type { Readable, Writable } from 'node:stream';

import {
  isJSONRPCNotification,
  isJSONRPCRequest,
  PROTOCOL_VERSION_META_KEY,
  ProtocolErrorCode,
  SUPPORTED_PROTOCOL_VERSIONS,
  type JSONRPCMessage,
  type Transport,
  type TransportSendOptions,
} from '@modelcontextprotocol/server';
import {
  serveStdio,
  StdioServerTransport,
  type StdioServerHandle,
} from '@modelcontextprotocol/server/stdio';

import { ApiClient } from '../api/client.js';
import {
  CHANNEL_NOTIFICATION,
  ChannelLoop,
  ChannelState,
  type ChannelLoopOptions,
  type EndReason,
} from '../channel/loop.js';
import type { Config } from '../config.js';
import { invalidatesIdentity } from '../identity.js';
import type { Logger } from '../log.js';
import {
  createSwitchableMcpServer,
  DEGRADED_LIST_TTL_MS,
  listedByPolicy,
  resolveListedTools,
  identityFromApi,
  type ListedTools,
  type SwitchableServer,
} from '../server.js';
import { PREEMPT_WAIT_MS, type ChannelLock } from '../channel/lock.js';
import { TypingIndicator } from '../channel/typing.js';
import { createAskTool, type AskOptions } from '../tools/ask.js';
import { createReplyTool, createTurnEndedTool } from '../tools/reply.js';
import { CATALOG } from '../toolsets/catalog.js';
import type { ToolDefinition, ToolPolicy } from '../toolsets/registry.js';
import { compareVersions, SERVER_VERSION } from '../version.js';

export interface StdioOptions {
  catalog?: readonly ToolDefinition[];
  fetch?: typeof fetch;
  /** For tests: streams to use instead of the process's stdin and stdout. */
  stdin?: Readable;
  stdout?: Writable;
  /** For tests: the clock that times identity refreshes. */
  now?: () => number;
  /** Channel mode: called once when the session can't continue (to clear its saved token). */
  onSessionEnded?: (reason: EndReason) => void | Promise<void>;
  /** For tests: the channel loop's poll interval and wait. */
  channelLoop?: Pick<ChannelLoopOptions, 'intervalMs' | 'sleep'>;
  /**
   * Channel mode: whether this server holds the folder's channel lock
   * (default true). Without it there is no loop, and reply and ask say
   * another server is the channel.
   */
  channelOwner?: boolean;
  /**
   * Channel mode: the folder's channel lock this server holds, checked
   * before each poll (another server may take the folder over).
   */
  channelLock?: Pick<ChannelLock, 'owns' | 'preempted'>;
  /** The wait before the first poll after taking the folder over (default PREEMPT_WAIT_MS). */
  preemptWaitMs?: number;
  /** For tests: ask's timing. */
  ask?: Pick<AskOptions, 'msPerSecond' | 'now'>;
  /** For tests: the typing indicator's timing. */
  typing?: { everyMs?: number; idleMs?: number };
}

/**
 * The plugin's AskUserQuestion hook timeout, in seconds (plugin/hooks/hooks.json).
 * The card's wait ends a minute before it, so the answer arrives in time.
 */
export const HOOK_TIMEOUT_S = 3600;

/** How long the hook's question card waits: the configured minutes, a minute under the hook's timeout at most. */
export function hookWaitSeconds(minutes: number): number {
  return Math.min(minutes * 60, HOOK_TIMEOUT_S - 60);
}

/** A known identity is read again at most this often. */
export const IDENTITY_REFRESH_MS = 60_000;

/** Methods whose answer depends on the token's scopes: they wait for a due refresh. */
const LIST_METHODS = new Set([
  'tools/list',
  'resources/list',
  'resources/templates/list',
  'prompts/list',
]);
/** Methods that use something listed: they trigger a due refresh. */
const CALL_METHODS = new Set(['tools/call', 'resources/read', 'prompts/get']);

/**
 * The token's identity for one stdio connection, and the server whose
 * visible tools follow it.
 */
export class StdioIdentity {
  private listed: ListedTools | undefined;
  private refreshAt = 0;
  private pending: Promise<ListedTools> | undefined;
  private generation = 0;
  private server: SwitchableServer | undefined;

  constructor(
    private readonly read: () => Promise<ListedTools>,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  /** The latest listing, if any. */
  get current(): ListedTools | undefined {
    return this.listed;
  }

  /** Whether the identity should be read again before it is relied on. */
  get due(): boolean {
    return this.listed === undefined || this.now() >= this.refreshAt;
  }

  /** Reads the identity again if it is due (one read at a time), and returns the listing. */
  refresh(): Promise<ListedTools> {
    if (this.pending) return this.pending;
    if (this.listed && !this.due) return Promise.resolve(this.listed);
    const generation = this.generation;
    const pending = this.read()
      .then((result) => {
        const before = this.listed?.identity;
        this.listed = result;
        const wait =
          result.identity === 'known' ? IDENTITY_REFRESH_MS : (result.error?.retryAfterMs ?? 0);
        // An invalidation during the read asks for another one.
        this.refreshAt = generation === this.generation ? this.now() + wait : 0;
        if (result.identity === 'known' && before !== 'known') {
          this.logger.info('token identified', {
            scopes: result.scopes,
            limited: result.limited,
            tools: result.tools.length,
          });
        }
        this.server?.show(result);
        return result;
      })
      .finally(() => {
        if (this.pending === pending) this.pending = undefined;
      });
    this.pending = pending;
    return pending;
  }

  /** Read the identity again on the next list or call (after an auth error). */
  invalidate(): void {
    this.generation++;
    this.refreshAt = 0;
  }

  /** The server whose visible tools follow the identity from now on. */
  attach(server: SwitchableServer): void {
    this.server = server;
    if (this.listed) server.show(this.listed);
  }

  /** Called before a message reaches the server: refreshes the identity when it is due. */
  async beforeMessage(message: JSONRPCMessage): Promise<void> {
    if (!isJSONRPCRequest(message) || !this.due) return;
    if (LIST_METHODS.has(message.method)) {
      await this.refresh();
      return;
    }
    if (!CALL_METHODS.has(message.method)) return;
    if (this.listed?.identity === 'refused') {
      // The called tool may be hidden until the token is accepted: wait for the answer.
      await this.refresh();
    } else {
      // The call goes ahead; the API checks it either way.
      void this.refresh();
    }
  }
}

/**
 * A transport that lets `before` run (in order) ahead of each incoming
 * message, so the identity can be refreshed before a list or call is served.
 */
class GatedTransport implements Transport {
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: Transport['onmessage'];
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly inner: Transport,
    private readonly before: (message: JSONRPCMessage) => Promise<void>,
    /** Told when the connection closes (stdin ended, or close()). */
    private readonly closed: () => void = () => undefined,
  ) {}

  start(): Promise<void> {
    this.inner.onmessage = (message, extra) => {
      this.queue = this.queue
        .then(() => this.before(message))
        .catch(() => undefined)
        .then(() => {
          this.onmessage?.(message, extra);
        });
    };
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onclose = () => {
      this.closed();
      this.onclose?.();
    };
    return this.inner.start();
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    return this.inner.send(message, options);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

/** Whether a message claims a protocol revision in its _meta (the 2026-07-28 way of opening). */
function claimsRevision(message: JSONRPCMessage): boolean {
  if (!isJSONRPCRequest(message) && !isJSONRPCNotification(message)) return false;
  const params = message.params as { _meta?: Record<string, unknown> } | undefined;
  return params?._meta?.[PROTOCOL_VERSION_META_KEY] !== undefined;
}

/**
 * Keeps a connection on the 2025 handshake (channel mode): until
 * `initialize`, a request that claims a revision is answered with the
 * unsupported-version error naming only the 2025-era revisions, which makes
 * a client fall back to `initialize`; such a notification is dropped.
 */
export class LegacyOnlyTransport implements Transport {
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: Transport['onmessage'];
  private initialized = false;

  constructor(private readonly inner: Transport) {}

  start(): Promise<void> {
    this.inner.onmessage = (message, extra) => {
      if (!this.initialized && claimsRevision(message)) {
        if (isJSONRPCRequest(message)) {
          const meta = (message.params as { _meta?: Record<string, unknown> })._meta ?? {};
          const requested = meta[PROTOCOL_VERSION_META_KEY];
          void this.inner
            .send({
              jsonrpc: '2.0',
              id: message.id,
              error: {
                code: ProtocolErrorCode.UnsupportedProtocolVersion,
                message:
                  'Unsupported protocol version: this channel server speaks the 2025 handshake.',
                data: {
                  supported: [...SUPPORTED_PROTOCOL_VERSIONS],
                  requested: typeof requested === 'string' ? requested : 'unknown',
                },
              },
            })
            .catch((error: unknown) => {
              this.onerror?.(error instanceof Error ? error : new Error(String(error)));
            });
        }
        return;
      }
      if (isJSONRPCRequest(message) && message.method === 'initialize') this.initialized = true;
      this.onmessage?.(message, extra);
    };
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onclose = () => this.onclose?.();
    return this.inner.start();
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    return this.inner.send(message, options);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

/**
 * The tools only channel mode has (reply, ask, and turn_ended for the
 * plugin's Stop hook), under the operator's read-only and exclude rules.
 */
function channelTools(policy: ToolPolicy, state: ChannelState, ask: AskOptions): ToolDefinition[] {
  return [createReplyTool(state), createAskTool(state, ask), createTurnEndedTool(state)].filter(
    (tool) =>
      (!policy.readOnly || tool.annotations.readOnlyHint) &&
      !policy.excludeTools.includes(tool.name),
  );
}

export function startStdio(
  config: Config,
  logger: Logger,
  options: StdioOptions = {},
): StdioServerHandle {
  if (config.token === undefined) throw new Error('stdio mode needs a token');
  const catalog = options.catalog ?? CATALOG;
  const policy = {
    toolsets: config.toolsets,
    readOnly: config.readOnly,
    excludeTools: config.excludeTools,
  };

  const invalidations = { listener: (): void => undefined };
  const api = new ApiClient({
    baseUrl: config.apiUrl,
    token: config.token,
    logger,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    onError: (err) => {
      if (invalidatesIdentity(err)) invalidations.listener();
    },
  });
  const channel = config.channel !== undefined;
  const state = new ChannelState();
  state.isChannel = options.channelOwner ?? true;
  if (channel && state.isChannel) {
    state.typing = new TypingIndicator({
      api,
      logger: logger.child({ component: 'typing' }),
      ...options.typing,
    });
  }
  const extraTools = channel
    ? channelTools(policy, state, {
        questionsInApp: config.ask.questionsInApp,
        hookWaitS: hookWaitSeconds(config.ask.timeoutMinutes),
        ...options.ask,
      })
    : [];
  // Once a channel's session has ended, the listing stays as it last was
  // (without reply), so Claude keeps its tools, which then say why.
  let lastKnown: ListedTools | undefined;
  const isEnded = (): boolean => state.ended !== undefined;
  const frozen = (): ListedTools => {
    const base = lastKnown ?? {
      ...listedByPolicy(catalog, policy),
      identity: 'unverified' as const,
    };
    return {
      ...base,
      tools: base.tools.filter((t) => !extraTools.includes(t) || t.runsAfterSessionEnd === true),
    };
  };
  const identity = new StdioIdentity(
    async () => {
      if (isEnded()) return frozen();
      const listed = await resolveListedTools(identityFromApi(api), catalog, policy, logger);
      const shown =
        extraTools.length > 0 ? { ...listed, tools: [...listed.tools, ...extraTools] } : listed;
      if (shown.identity === 'known') lastKnown = shown;
      // The session may have ended while the identity was read.
      return isEnded() ? frozen() : shown;
    },
    logger,
    options.now,
  );
  invalidations.listener = () => {
    identity.invalidate();
  };
  // Read the identity at startup.
  void identity.refresh();

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

  // Everything the configuration allows is registered; the identity decides what is shown.
  const allowed = listedByPolicy(catalog, policy);
  const wire =
    options.stdin && options.stdout
      ? new StdioServerTransport(options.stdin, options.stdout)
      : new StdioServerTransport();
  let loop: ChannelLoop | undefined;
  const stopLoop = (): Promise<void> => loop?.stop() ?? Promise.resolve();
  const handle = serveStdio(
    async () => {
      const listed = await identity.refresh();
      const switchable = createSwitchableMcpServer({
        tools: [...allowed.tools, ...extraTools],
        resources: allowed.resources,
        prompts: allowed.prompts,
        api,
        logger,
        channel,
        ...(channel
          ? {
              channelState: state,
              onToolCall: () => {
                state.typing?.activity();
              },
              sessionEnded: () => state.ended,
              onSessionOver: (code: string) => {
                void loop?.end(code as EndReason);
              },
            }
          : {}),
        ...(listed.identity === 'known' ? {} : { toolsListTtlMs: DEGRADED_LIST_TTL_MS }),
      });
      identity.attach(switchable);
      if (channel) {
        const mcp = switchable.server.server;
        // Notifications sent before the client has initialized would be lost.
        mcp.oninitialized = () => {
          if (loop !== undefined) return;
          if (!state.isChannel) {
            logger.warn(
              'another buildit server in this folder receives the messages from buildIt.Social (it holds the channel lock); this one serves its tools without the channel. Remove the extra server (claude mcp remove <name>; "buildit-mcp status" names them)',
            );
            return;
          }
          loop = new ChannelLoop({
            api,
            logger: logger.child({ component: 'channel' }),
            state,
            notify: (params) => mcp.notification({ method: CHANNEL_NOTIFICATION, params }),
            ...(options.channelLock === undefined
              ? {}
              : {
                  owns: () => options.channelLock?.owns() ?? true,
                  ...(options.channelLock.preempted === undefined
                    ? {}
                    : { firstPollDelayMs: options.preemptWaitMs ?? PREEMPT_WAIT_MS }),
                }),
            onEnded: async (reason) => {
              if (state.ended !== undefined) {
                // The server stays up: Claude keeps its tools (which now say the session
                // ended), without reply.
                switchable.show(frozen());
                try {
                  switchable.server.sendToolListChanged();
                } catch {
                  // A client that is gone can't be told.
                }
              }
              await options.onSessionEnded?.(reason);
            },
            ...options.channelLoop,
          });
          void loop.start();
        };
      }
      return switchable.server;
    },
    {
      onerror: (error) => {
        logger.error('stdio transport error', { error });
      },
      transport: new GatedTransport(
        channel ? new LegacyOnlyTransport(wire) : wire,
        (message) => identity.beforeMessage(message),
        () => {
          void stopLoop();
        },
      ),
    },
  );
  return {
    async close() {
      await stopLoop();
      await handle.close();
    },
  };
}
