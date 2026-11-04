/**
 * Codex's approvals as Approve/Deny cards in buildIt.Social.
 *
 * Codex asks its client before it runs a command (or sends input to a
 * running one, or opens a network connection), changes files, widens its
 * permissions, or runs an MCP tool that needs approval (an elicitation
 * with `_meta.codex_approval_kind = "mcp_tool_call"`). Each such request
 * becomes a tool approval card through the session approvals API, the
 * same cards the Claude Code plugin posts, and the owner's tap is the
 * JSON-RPC answer: accept, or decline.
 *
 * - **What the owner sees:** the full command (with Windows' PowerShell
 *   wrapper, as Codex gives it) and its parsed actions; the diff of each
 *   file, from the `fileChange` item Codex announced in `item/started`
 *   (matched by `itemId`); the permissions asked for; the host and
 *   protocol of a network request; the MCP tool's server, name and
 *   arguments. Every value is cleaned, masked and cut by the Claude cards'
 *   rules (channel/mask.ts), and only the owner reads them.
 * - **Only what the owner can see in full is approved:** a card with a cut
 *   or left-out field, a hidden (masked) value, or a change Codex didn't
 *   show, is answered `decline` whatever the tap.
 * - **Never a lasting rule:** the answers are `accept` and `decline` only
 *   (`scope: "turn"` for permissions). This version never sends
 *   `acceptForSession`, `acceptWithExecpolicyAmendment` or
 *   `applyNetworkPolicyAmendment`, and offers no "Allow for this session".
 * - **Cards close** when Codex says the request is resolved
 *   (`serverRequest/resolved`, whoever answered: then nothing is sent),
 *   when the item's thread is taken from the session (unassigned), when
 *   the session ends, when the app-server exits, and after a restart (the
 *   approvals journal). Each of those answers decline when an answer is
 *   still owed.
 *
 * A Codex subagent's request (its thread spawned by a conversation's turn)
 * goes to that conversation's thread, with a first field naming the
 * subagent.
 *
 * Anything else Codex asks (questions, other elicitations, dynamic tools,
 * the old v1 approvals, unknown methods) goes to the fallback router,
 * which declines it safely.
 */
import { randomUUID } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';

import { ApiError, type ApiClient } from '../api/client.js';
import { closeSessionApproval, getSessionApproval, postSessionApproval } from '../channel/api.js';
import { apiApprovalCloser, type StaleReason } from '../channel/approvals.js';
import type { ChannelState } from '../channel/loop.js';
import {
  buildDetails,
  cleanApprovalText,
  DESCRIPTION_MAX,
  maskCredentials,
  REDACTED,
  type ApprovalDetails,
} from '../channel/mask.js';
import { CardInbox, eventMessageId } from '../channel/waiters.js';
import type { Logger } from '../log.js';
import {
  APPROVE_NAMESPACE,
  eventApproval,
  mayBeStored,
  POLL_EVERY_S,
  type Final,
} from '../tools/approve.js';
import { uuidV5 } from '../tools/ask.js';
import type { RequestId } from './protocol.js';
import type { RpcNotification, RpcServerRequest, ServerRequestAnswer } from './rpc.js';
import type { ServerRequestRouter } from './server-requests.js';

/** The server requests this module turns into cards. */
export const CARD_METHODS = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'mcpServer/elicitation/request',
] as const;

/** Why a card can't approve (its tap is answered decline). */
export type Unchecked = 'too_long' | 'hidden' | 'not_shown' | 'not_offered';

/** What a card shows, and how its answer is sent. */
export interface CardSpec {
  /** The card's tool name (the API's pattern). */
  toolName: string;
  description: string | undefined;
  /** The fields, before masking (one per key, in order). */
  input: Record<string, unknown>;
  /** Why it can't be approved whatever is shown (a change Codex didn't show, accept not offered). */
  unchecked?: Unchecked;
  /** The JSON-RPC result for accept and for decline. */
  accept: unknown;
  decline: unknown;
}

const TOOL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** A name for the card's tool from free text: the API's pattern, else a fallback. */
export function toolNameOf(name: string, fallback: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_.:-]+/g, '_').slice(0, 100);
  return TOOL_NAME_RE.test(cleaned) ? cleaned : fallback;
}

/** A description: cleaned, masked, trimmed and cut to 1,000 characters (none when empty). */
export function describe(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const shown = maskCredentials(cleanApprovalText(text)).trim();
  if (shown === '') return undefined;
  const chars = Array.from(shown);
  return chars.length <= DESCRIPTION_MAX
    ? shown
    : chars.slice(0, DESCRIPTION_MAX - 1).join('') + '…';
}

const declineDecision = { decision: 'decline' };
const acceptDecision = { decision: 'accept' };

/** item/commandExecution/requestApproval: a command, input to a running one, or a network request. */
export function commandCard(p: Record<string, unknown>): CardSpec {
  const network = record(p.networkApprovalContext);
  const host = str(network.host);
  const actions = Array.isArray(p.commandActions)
    ? p.commandActions.map((a) => str(record(a).command)).filter((c) => c !== undefined)
    : [];
  const command = str(p.command);
  const input: Record<string, unknown> = {};
  if (host !== undefined) {
    input.host = host;
    input.protocol = str(network.protocol) ?? 'unknown';
  }
  if (command !== undefined) input.command = command;
  if (actions.length > 0 && !(actions.length === 1 && actions[0] === command)) {
    input.actions = actions.join('\n');
  }
  if (str(p.cwd) !== undefined) input.cwd = p.cwd;
  const extra = p.additionalPermissions;
  if (extra !== undefined && extra !== null) input.additional_permissions = extra;
  const kind = str(p.kind) ?? 'command';
  const offered = Array.isArray(p.availableDecisions) ? p.availableDecisions : undefined;
  // Nothing to run shown (no command, no host): the owner can't check it.
  const empty = command === undefined && actions.length === 0 && host === undefined;
  if (empty) input.command = '(Codex sent no command)';
  return {
    toolName: host !== undefined ? 'network' : kind === 'writeStdin' ? 'terminal_input' : 'command',
    description: describe(str(p.reason)),
    input,
    ...(empty
      ? { unchecked: 'not_shown' as const }
      : offered !== undefined && !offered.includes('accept')
        ? { unchecked: 'not_offered' as const }
        : {}),
    accept: acceptDecision,
    decline: declineDecision,
  };
}

/** One change of a fileChange item, as the card shows it. */
interface Change {
  path: string;
  kind: string;
  movePath: string | undefined;
  diff: string;
}

/** The changes of a fileChange item (tolerant). */
export function changesOf(item: unknown): Change[] | undefined {
  const i = record(item);
  if (i.type !== 'fileChange' || !Array.isArray(i.changes)) return undefined;
  const out: Change[] = [];
  for (const c of i.changes) {
    const r = record(c);
    const path = str(r.path);
    if (path === undefined) continue;
    const kind = record(r.kind);
    out.push({
      path,
      kind: str(kind.type) ?? 'update',
      movePath: str(kind.move_path),
      diff: typeof r.diff === 'string' ? r.diff : '',
    });
  }
  return out;
}

/** A field's key is at most this long (the API's 100, the marker included). */
const KEY_MAX = 100;

/**
 * A file's name as a field's key: relative to the folder when inside it,
 * and, when still too long, its end (the file's own name) after "…". The
 * value starts with the whole path, so nothing is hidden by the cut.
 */
export function fileKey(path: string, folder: string | undefined): string {
  let shown = path;
  if (folder !== undefined && isAbsolute(path)) {
    const rel = relative(folder, path);
    if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) shown = rel;
  }
  const chars = Array.from(shown);
  return chars.length <= KEY_MAX ? shown : '…' + chars.slice(chars.length - (KEY_MAX - 1)).join('');
}

/** item/fileChange/requestApproval, with the changes of its item (undefined: not seen). */
export function fileChangeCard(
  p: Record<string, unknown>,
  changes: Change[] | undefined,
  folder?: string,
): CardSpec {
  const input: Record<string, unknown> = {};
  const root = str(p.grantRoot);
  if (root !== undefined) input.write_access_under = root;
  for (const c of changes ?? []) {
    const head =
      c.kind === 'add'
        ? 'add'
        : c.kind === 'delete'
          ? 'delete'
          : c.movePath !== undefined
            ? `update, moved to ${c.movePath}`
            : 'update';
    const base = fileKey(c.path, folder);
    let key = base;
    for (let n = 2; key in input; n++) key = `${base} (${n})`;
    input[key] = `${head}: ${c.path}\n${c.diff}`;
  }
  const unseen = changes === undefined || changes.length === 0;
  if (unseen) input.changes = "(Codex didn't show the changes)";
  return {
    toolName: 'file_change',
    description: describe(str(p.reason)),
    input,
    ...(unseen ? { unchecked: 'not_shown' as const } : {}),
    accept: acceptDecision,
    decline: declineDecision,
  };
}

/** item/permissions/requestApproval: granted for this turn only, exactly as asked. */
export function permissionsCard(p: Record<string, unknown>): CardSpec {
  const asked = record(p.permissions);
  const network = record(asked.network);
  const fs = record(asked.fileSystem);
  const input: Record<string, unknown> = {};
  const granted: Record<string, unknown> = {};
  if (asked.network !== null && asked.network !== undefined) {
    input.network = network.enabled === true ? 'enabled' : JSON.stringify(network);
    granted.network = asked.network;
  }
  if (asked.fileSystem !== null && asked.fileSystem !== undefined) {
    if (Array.isArray(fs.read) && fs.read.length > 0) input.read = fs.read.join('\n');
    if (Array.isArray(fs.write) && fs.write.length > 0) input.write = fs.write.join('\n');
    if (Array.isArray(fs.entries) && fs.entries.length > 0) input.entries = fs.entries;
    granted.fileSystem = asked.fileSystem;
  }
  if (str(p.cwd) !== undefined) input.cwd = p.cwd;
  const empty = Object.keys(granted).length === 0;
  if (empty) input.permissions = '(Codex asked for nothing it named)';
  return {
    toolName: 'permissions',
    description: describe(str(p.reason)),
    input,
    ...(empty ? { unchecked: 'not_shown' as const } : {}),
    accept: { permissions: granted, scope: 'turn' },
    decline: { permissions: {}, scope: 'turn' },
  };
}

/** Whether an elicitation is Codex's approval of an MCP tool call. */
export function isMcpToolApproval(p: Record<string, unknown>): boolean {
  return record(p._meta).codex_approval_kind === 'mcp_tool_call';
}

/** mcpServer/elicitation/request for an MCP tool call: the server, the tool, the arguments. */
export function mcpToolCard(p: Record<string, unknown>): CardSpec {
  const meta = record(p._meta);
  const server = str(p.serverName) ?? 'mcp';
  const tool = str(meta.tool_name) ?? str(meta.tool_title);
  const args = meta.tool_params ?? meta.tool_params_display;
  const input: Record<string, unknown> = { server, tool: tool ?? '(not named)' };
  if (args !== undefined && args !== null) input.arguments = args;
  const connector = str(meta.connector_name);
  if (connector !== undefined) input.connector = connector;
  const unseen = tool === undefined || args === undefined || args === null;
  return {
    toolName: toolNameOf(`mcp__${server}__${tool ?? 'tool'}`, 'mcp_tool'),
    description: describe(str(p.message)),
    input,
    ...(unseen ? { unchecked: 'not_shown' as const } : {}),
    accept: { action: 'accept', content: {}, _meta: null },
    decline: { action: 'decline', content: null, _meta: null },
  };
}

/** Why the details can't be approved in the app: cut, left out, or hidden. */
export function uncheckedOf(details: ApprovalDetails): Unchecked | undefined {
  if (details.fields.some((f) => (f.cut ?? 0) > 0) || (details.more_fields ?? 0) > 0) {
    return 'too_long';
  }
  if (details.fields.some((f) => f.value.includes(REDACTED) || f.key.includes(REDACTED))) {
    return 'hidden';
  }
  return undefined;
}

export interface CodexApprovalsOptions {
  api: ApiClient;
  state: ChannelState;
  logger: Logger;
  /** Who answers everything that isn't a card (the declines, the clock). */
  fallback: ServerRequestRouter;
  /** Cards at all (BUILDIT_APPROVALS_IN_APP); false: every approval is declined. */
  inApp?: boolean;
  /** How long a card waits for the owner, in seconds (60 to 3,540). */
  waitS: number;
  /** The folder Codex works in (file changes' names are shown relative to it). */
  folder?: string;
  /** The buildIt.Social thread a Codex thread's cards go in (undefined: the direct message, new). */
  threadFor: (codexThreadId: string | undefined) => string | undefined;
  /** A subagent's name when the Codex thread is one (its cards name it); undefined otherwise. */
  subagentOf?: (codexThreadId: string | undefined) => string | undefined;
  /** Milliseconds per second of waiting (tests). */
  msPerSecond?: number;
  now?: () => number;
}

/** How a card's wait ended. */
type Outcome = 'accept' | 'decline' | 'none';

interface OpenCard {
  codexThread: string | undefined;
  settle: (reason: StaleReason | 'interrupted') => void;
}

/** How many fileChange items are remembered (by item id) for their approvals. */
const CHANGES_MAX = 200;

export class CodexApprovals implements ServerRequestRouter {
  private readonly changes = new Map<string, Change[]>();
  /** Open cards by the request's id. */
  private readonly open = new Map<string, OpenCard>();
  private readonly runId = randomUUID();
  private closed = false;
  private readonly scale: number;
  private readonly clock: () => number;

  constructor(private readonly options: CodexApprovalsOptions) {
    this.scale = options.msPerSecond ?? 1000;
    this.clock = options.now ?? Date.now;
  }

  /** The open cards' count (tests). */
  get openCount(): number {
    return this.open.size;
  }

  /** The bridge's notifications: fileChange items (their diffs), and resolved requests. */
  observe(n: RpcNotification): void {
    const p = record(n.params);
    if (n.method === 'item/started' || n.method === 'item/completed') {
      const item = record(p.item);
      const id = str(item.id);
      const changes = changesOf(item);
      if (id === undefined || changes === undefined) return;
      // item/completed may carry the final changes; an empty list never replaces a seen one.
      if (changes.length === 0 && this.changes.has(id)) return;
      this.changes.delete(id);
      this.changes.set(id, changes);
      if (this.changes.size > CHANGES_MAX) {
        const oldest = this.changes.keys().next().value;
        if (oldest !== undefined) this.changes.delete(oldest);
      }
      return;
    }
    if (n.method === 'serverRequest/resolved') {
      const id = p.requestId;
      if (typeof id !== 'string' && typeof id !== 'number') return;
      // A card's entry is made as its request arrives, so a resolution always finds it;
      // none: answered already (by this bridge), or not a card.
      this.open.get(String(id))?.settle('answered_elsewhere');
    }
  }

  /** Every open card closes (the app-server exited, or the bridge stops): declined. */
  closeAll(): void {
    this.closed = true;
    for (const card of [...this.open.values()]) card.settle('interrupted');
  }

  /** A Codex thread's open cards close (its work was taken away): declined. */
  closeThread(codexThreadId: string): number {
    let n = 0;
    for (const card of [...this.open.values()]) {
      if (card.codexThread === codexThreadId) {
        card.settle('interrupted');
        n++;
      }
    }
    return n;
  }

  handle(request: RpcServerRequest): Promise<ServerRequestAnswer> {
    const p = record(request.params);
    let spec: CardSpec | undefined;
    switch (request.method) {
      case 'item/commandExecution/requestApproval':
        spec = commandCard(p);
        break;
      case 'item/fileChange/requestApproval': {
        const item = str(p.itemId);
        spec = fileChangeCard(
          p,
          item === undefined ? undefined : this.changes.get(item),
          this.options.folder,
        );
        break;
      }
      case 'item/permissions/requestApproval':
        spec = permissionsCard(p);
        break;
      case 'mcpServer/elicitation/request':
        if (isMcpToolApproval(p)) spec = mcpToolCard(p);
        break;
      default:
        break;
    }
    if (spec === undefined) return this.options.fallback.handle(request);
    // A Codex subagent's request: its card goes to the parent's thread, and says whose it is.
    const subagent = this.options.subagentOf?.(str(p.threadId));
    if (subagent !== undefined) spec = { ...spec, input: { subagent, ...spec.input } };
    return this.ask(request.id, p, spec);
  }

  /** Posts the card, waits for the owner, and answers (or not, when Codex resolved it). */
  private async ask(
    requestId: RequestId,
    p: Record<string, unknown>,
    spec: CardSpec,
  ): Promise<ServerRequestAnswer> {
    const { logger } = this.options;
    const codexThread = str(p.threadId);
    let outcome: Outcome;
    try {
      outcome = await this.card(requestId, codexThread, p, spec);
    } catch (err) {
      logger.warn('codex approval failed; declined', {
        code: err instanceof ApiError ? err.code : 'error',
      });
      outcome = 'decline';
    }
    logger.info('codex approval answered', {
      tool: spec.toolName,
      outcome,
      codex_thread: codexThread,
    });
    if (outcome === 'none') return { none: true };
    return { result: outcome === 'accept' ? spec.accept : spec.decline };
  }

  private async card(
    requestId: RequestId,
    codexThread: string | undefined,
    p: Record<string, unknown>,
    spec: CardSpec,
  ): Promise<Outcome> {
    const { api, state, logger } = this.options;
    const key = String(requestId);
    if (this.options.inApp === false) {
      logger.warn('codex asked for an approval; declined (approvals in the app are off)');
      return 'decline';
    }
    const info = state.session;
    const approvals = state.approvals;
    if (this.closed || info === undefined || approvals === undefined) return 'decline';
    if (state.ended !== undefined || state.waiters.isEnded) return 'decline';

    const details = buildDetails(spec.toolName, spec.input);
    const unchecked = spec.unchecked ?? uncheckedOf(details);
    const id = uuidV5(
      [
        'codex',
        info.session.id,
        this.runId,
        key,
        codexThread ?? '',
        str(p.itemId) ?? '',
        str(p.approvalId) ?? '',
      ].join('\n'),
      APPROVE_NAMESPACE,
    );
    let thread = this.options.threadFor(codexThread);
    const scale = this.scale;
    const deadline = this.clock() + this.options.waitS * scale;

    const inbox = new CardInbox();
    let stale: StaleReason | 'interrupted' | undefined;
    let wake: (() => void) | undefined;
    const settle = (reason: StaleReason | 'interrupted'): void => {
      stale ??= reason;
      wake?.();
    };
    this.open.set(key, { codexThread, settle });
    let unregister = state.waiters.register(id, inbox, thread);
    const postedAt = new Date(this.clock()).toISOString();
    const leave = approvals.add({
      id,
      agentRef: `codex:${codexThread ?? ''}`,
      toolUseId: undefined,
      postedAt,
      settle,
    });
    const closer = apiApprovalCloser(api, logger);
    try {
      const post = (where: string | undefined) =>
        postSessionApproval(
          api,
          {
            id,
            ...(where === undefined ? {} : { thread_id: where }),
            tool_name: spec.toolName,
            ...(spec.description === undefined ? {} : { description: spec.description }),
            fields: details.fields,
            ...(details.more_fields === undefined ? {} : { more_fields: details.more_fields }),
            wait_s: this.options.waitS,
          },
          { tool: 'approve', signal: AbortSignal.timeout(30_000) },
        );
      let posted: Awaited<ReturnType<typeof post>>;
      try {
        posted = await post(thread);
      } catch (err) {
        const code = err instanceof ApiError ? err.code : 'error';
        const itemRefused =
          thread !== undefined &&
          thread !== state.lastDmThread &&
          (code === 'thread_not_bound' || code === 'outside_reach' || code === 'not_found');
        if (!itemRefused) throw err;
        // The item's thread refused it: the card goes to the direct message instead.
        thread = state.lastDmThread;
        unregister();
        unregister = state.waiters.register(id, inbox, thread);
        posted = await post(thread);
      }
      logger.info('codex approval posted', {
        message_id: id,
        tool: spec.toolName,
        checked: unchecked === undefined,
      });
      if (posted.approval.status !== 'open') return this.verdict(posted.approval, unchecked);

      let nextPoll = this.clock() + POLL_EVERY_S * scale;
      for (;;) {
        if (stale !== undefined) {
          void closer(id, stale);
          return stale === 'interrupted' ? 'decline' : 'none';
        }
        const now = this.clock();
        if (now >= deadline) {
          // The owner may have tapped in the last second: the close answers the final state.
          let final: Final = { status: 'expired', reason: 'client' };
          try {
            const closed = await closeSessionApproval(api, id, 'expired', {
              tool: 'approve',
              signal: AbortSignal.timeout(5000),
            });
            if (closed.approval.status !== 'open') final = closed.approval;
          } catch {
            // Expired either way.
          }
          return this.verdict(final, unchecked);
        }
        if (now >= nextPoll) {
          nextPoll = now + POLL_EVERY_S * scale;
          try {
            const r = await getSessionApproval(api, id, { tool: 'approve' });
            if (r.approval.status !== 'open') return this.verdict(r.approval, unchecked);
          } catch (err) {
            logger.info('codex approval state not read', {
              code: err instanceof ApiError ? err.code : 'error',
            });
          }
          continue;
        }
        const local = new AbortController();
        wake = () => {
          local.abort();
        };
        const next = await inbox.next(Math.min(deadline, nextPoll), local.signal, this.clock);
        wake = undefined;
        if (next === 'timeout' || next === 'aborted') continue;
        if (next === 'session_ended' || next === 'closed') {
          // The session ended, or the card's thread was taken from it (the server closed it).
          return 'decline';
        }
        const { event, done } = next;
        try {
          if (event.type !== 'card.closed' || eventMessageId(event) !== id) continue;
          const final = eventApproval(event, id);
          if (final === undefined) {
            nextPoll = 0;
            continue;
          }
          return this.verdict(final, unchecked);
        } finally {
          done();
        }
      }
    } catch (err) {
      if (mayBeStored(err)) {
        approvals.orphan(id, postedAt);
        void closer(id, 'interrupted').then((ok) => {
          if (ok) approvals.forget(id);
        });
      }
      throw err;
    } finally {
      this.open.delete(key);
      unregister();
      leave();
      inbox.drain();
    }
  }

  /** The answer for how the card ended: accept only an approval the owner could check. */
  private verdict(final: Final, unchecked: Unchecked | undefined): Outcome {
    if (final.status === 'approved' || final.status === 'approved_session') {
      if (unchecked !== undefined) {
        this.options.logger.warn(
          'codex approval approved in the app, but the card could not show it in full; declined',
          { reason: unchecked },
        );
        return 'decline';
      }
      return 'accept';
    }
    // Expired, denied, closed, or ended without the owner (Codex still waits): declined.
    return 'decline';
  }
}
