/**
 * Tool approvals in buildIt.Social: the plugin's PermissionRequest hook
 * (`approve`), and the hooks that tell it when an approval is no longer
 * needed (`tool_seen`, `tool_done`, `agent_done`, `prompt_typed`; `turn_ended`
 * is in reply.ts). Channel mode only; none of them is for Claude to call.
 *
 * When Claude Code would ask the person whether a tool may run, `approve`
 * posts a tool approval card in buildIt.Social and waits for the owner's
 * answer there, while the terminal asks too (for the main agent; for a
 * background subagent the terminal asks only once the hook gives up). The
 * card shows only the tool's name and who asks, in buildIt.Social's own
 * words; the details (Claude's description, the command, the file and the
 * change) are cleaned, masked and cut here (channel/mask.ts) and only the
 * owner can read them. Only the owner's own tap answers: the verdict comes
 * back as the card's `card.closed` event (its `data.approval`), and nothing
 * else this server reads (an answer to the card, a message) is a verdict.
 *
 * The hook's answer (the tool's text) is one JSON object: allow (with the
 * session rule when the owner chose "Allow for this session"), deny with a
 * reason Claude reads, or `{}`, which changes nothing (the terminal decides):
 * when approvals in the app are off, the folder has no channel session, the
 * input can't be read, the post failed, or the approval stopped being needed.
 */
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { ApiError } from '../api/client.js';
import { closeSessionApproval, getSessionApproval, postSessionApproval } from '../channel/api.js';
import {
  apiApprovalCloser,
  type ApprovalCloseReason,
  type StaleReason,
} from '../channel/approvals.js';
import type { ChannelState } from '../channel/loop.js';
import { buildDetails, REDACTED, sessionRuleFrom, type SessionRule } from '../channel/mask.js';
import { isUuid, itemThreadId } from '../channel/threads.js';
import { canonicalJson, inputHash, parseToolInput } from '../channel/tool-ring.js';
import { CardInbox, eventMessageId, type ApprovalVerdict } from '../channel/waiters.js';
import { isItemWorker, workerEntry } from '../channel/workers.js';
import { defineTool, type ToolContext, type ToolDefinition } from '../toolsets/registry.js';
import { sanitizeLabel } from '../untrusted.js';
import { uuidV5 } from './ask.js';

// ---------------------------------------------------------------------------
// The hook's answers
// ---------------------------------------------------------------------------

/** The hook's answer that changes nothing: Claude Code decides as usual. */
export const HOOK_PASS = '{}';

/** The hook's answer that lets the tool run (with the session rule the owner allowed). */
export function permissionAllow(rule?: SessionRule): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: 'allow',
        ...(rule === undefined ? {} : { updatedPermissions: [rule] }),
      },
    },
  });
}

/** The hook's answer that refuses the tool, with a reason Claude reads. */
export function permissionDeny(message: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'deny', message },
    },
  });
}

/** Why Claude was told no, in words Claude reads. */
export type DenyReason =
  | 'denied'
  | 'too_long'
  | 'hidden'
  | 'expired'
  | 'session_ended'
  | 'unassigned'
  | 'switched_off'
  | 'closed';

export function denyText(reason: DenyReason, owner: string, minutes: number): string {
  switch (reason) {
    case 'denied':
      return `${owner} denied this in buildIt.Social. Don't retry it; ask them what to do instead.`;
    case 'too_long':
      return `This command was too long to show in full in buildIt.Social, so ${owner} could not approve it there. Split it into shorter commands, or ask ${owner} to approve it in the terminal.`;
    case 'hidden':
      return `This holds something that looks like a credential, which buildIt.Social hides, so ${owner} could not check it there. Ask ${owner} to approve it in the terminal, or keep credentials out of commands and files (read them from the environment).`;
    case 'switched_off':
      return 'Tool approvals in buildIt.Social were switched off before anyone answered, so this was not run.';
    case 'expired':
      return `Nobody approved this in buildIt.Social within ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}, so it was not run. Don't retry it now: stop and tell the person what you need, or do the task another way.`;
    case 'session_ended':
      return 'The buildIt.Social session ended before anyone approved this, so it was not run. Stop and tell the person in this terminal what you need.';
    case 'unassigned':
      return 'You were taken off this work item in buildIt.Social, so this was not run. Stop work on it.';
    case 'closed':
      return 'The approval card was closed in buildIt.Social before anyone answered, so this was not run. Ask the person what to do.';
  }
}

// ---------------------------------------------------------------------------
// Ids and input
// ---------------------------------------------------------------------------

/** The UUIDv5 namespace of tool approval cards' message ids. */
export const APPROVE_NAMESPACE = '6c2f8a14-3b7d-4e91-8d5a-0f4b9c2e7a63';

const TOOL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const TOOL_USE_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const AGENT_REF_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
/** The agent types sent to buildIt.Social (anything else is left out). */
const AGENT_TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

/** A hook field: trimmed, and empty when Claude Code left the `${…}` unfilled. */
export function hookField(value: unknown): string {
  if (typeof value !== 'string') return '';
  const s = value.trim();
  return s.startsWith('${') ? '' : s;
}

/**
 * A card's id from its tool call: its id, who asks, the tool and the input's
 * hash. One card per call, however often the hook runs; and a verdict for
 * one input is never the verdict for another under the same tool call id
 * (Claude can call these tools itself, and name any id).
 */
export function approvalIdForToolUse(
  toolUseId: string,
  agentId: string,
  toolName: string,
  hash: string,
): string {
  return uuidV5(['tool_use', toolUseId, agentId, toolName, hash].join('\n'), APPROVE_NAMESPACE);
}

/** How long `approve` waits for the call's PreToolUse to name its id. */
export const CORRELATE_WAIT_MS = 300;
/** How often a waiting approval reads its state (the fallback when an event was missed). */
export const POLL_EVERY_S = 120;
/** How often a long wait reports progress. */
const PROGRESS_EVERY_S = 30;

export const ApproveInputSchema = z.object({
  tool_name: z.string().max(300),
  tool_input: z.union([z.string().max(2_000_000), z.record(z.string(), z.unknown())]),
  tool_use_id: z.string().max(300).optional(),
  agent_id: z.string().max(300).optional(),
  agent_type: z.string().max(300).optional(),
  session_id: z.string().max(300).optional(),
  prompt_id: z.string().max(300).optional(),
  suggestions: z.union([z.string().max(200_000), z.array(z.unknown())]).optional(),
  mode: z.string().max(100).optional(),
});

const ApproveOutputSchema = z.object({
  status: z.enum(['approved', 'approved_session', 'denied', 'expired', 'closed', 'passed']),
  reason: z.string().optional(),
  message_id: z.string().nullable(),
});
type ApproveOutput = z.infer<typeof ApproveOutputSchema>;

export interface ApproveOptions {
  /** Ask in buildIt.Social at all (BUILDIT_APPROVALS_IN_APP); false: the hook passes. */
  approvalsInApp: boolean;
  /** How long a card waits for the owner, in seconds (60 to 3,540). */
  hookWaitS: number;
  /** Milliseconds per second of waiting (tests shorten time with it). */
  msPerSecond?: number;
  /** The clock (tests). */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Where the card goes
// ---------------------------------------------------------------------------

interface Placement {
  /** The thread to post in (undefined: a new message of the direct message). */
  thread: string | undefined;
  /** Whether it is a work item's thread (a refusal there falls back to the direct message). */
  item: boolean;
}

/**
 * The main agent's approvals go to the direct message (its latest thread);
 * an item worker named in the lead's table asks in its item's thread; any
 * other subagent, and a worker the table doesn't name, asks in the direct
 * message too (the card names the subagent), never only in a terminal
 * nobody may be watching.
 */
async function placement(
  state: ChannelState,
  ctx: ToolContext,
  agentId: string,
  agentType: string,
): Promise<Placement> {
  const dm = { thread: state.lastDmThread, item: false };
  if (agentId === '' || !isItemWorker(agentType) || state.folder === undefined) return dm;
  const entry = workerEntry(state.folder, agentId);
  if (entry === undefined) return dm;
  if (entry.thread_id !== undefined && isUuid(entry.thread_id)) {
    return { thread: entry.thread_id, item: true };
  }
  if (entry.item === undefined) return dm;
  try {
    return { thread: await itemThreadId(entry.item, ctx), item: true };
  } catch {
    return dm;
  }
}

/** The refusals of an item thread after which the card goes to the direct message instead. */
const ITEM_FALLBACK_CODES: ReadonlySet<string> = new Set([
  'thread_not_bound',
  'outside_reach',
  'not_found',
]);

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/** How a card ended, as the API says it (an event's data.approval, or a SessionApproval). */
interface Final {
  status: string;
  reason?: string | undefined;
  /** The session rule the server stored (an event's data.approval.rule only). */
  rule?: unknown;
}

/** What the call answers for one way the wait ended. */
interface Answer {
  structured: ApproveOutput;
  text: string;
}

function answerOf(
  final: Final,
  init: {
    id: string;
    owner: string;
    minutes: number;
    rule: SessionRule | undefined;
    /**
     * Why the card can't approve the call, when it can't: a Bash or
     * PowerShell call cut to fit (`too_long`, which wins), or a field with a
     * hidden value (`hidden`). Its card offers only Deny.
     */
    unchecked?: 'too_long' | 'hidden' | undefined;
    /** Told when "Allow for this session" can't be granted as a rule. */
    mismatch?: () => void;
  },
): Answer {
  const at = (status: ApproveOutput['status'], text: string, reason?: string): Answer => ({
    structured: {
      status,
      ...(reason === undefined ? {} : { reason }),
      message_id: init.id,
    },
    text,
  });
  switch (final.status) {
    case 'approved':
      return at('approved', permissionAllow());
    case 'approved_session':
      // The rule this call offered, and only when the server stored that same rule (what the
      // owner was shown); otherwise this one call only.
      if (
        init.rule !== undefined &&
        final.rule !== undefined &&
        canonicalJson(final.rule) === canonicalJson(init.rule)
      ) {
        return at('approved_session', permissionAllow(init.rule));
      }
      init.mismatch?.();
      return at('approved', permissionAllow(), 'rule_mismatch');
    case 'denied':
      return at(
        'denied',
        permissionDeny(denyText(init.unchecked ?? 'denied', init.owner, init.minutes)),
        init.unchecked,
      );
    case 'expired':
      return at(
        'expired',
        permissionDeny(denyText('expired', init.owner, init.minutes)),
        final.reason,
      );
    case 'closed': {
      const why: DenyReason =
        final.reason === 'session_ended' ||
        final.reason === 'unassigned' ||
        final.reason === 'switched_off'
          ? final.reason
          : 'closed';
      return at('closed', permissionDeny(denyText(why, init.owner, init.minutes)), final.reason);
    }
    default:
      // answered_elsewhere, stale, and anything newer: nothing to decide here.
      return at('passed', HOOK_PASS, final.status);
  }
}

const codeOf = (err: unknown): string => (err instanceof ApiError ? err.code : 'error');

/** The approval object of a card.closed event for this card, if it carries one (and names it). */
function eventApproval(event: { data: unknown }, id: string): Final | undefined {
  const approval = (event.data as Record<string, unknown>).approval;
  if (approval === null || typeof approval !== 'object') return undefined;
  const a = approval as Record<string, unknown>;
  if (typeof a.outcome !== 'string' || a.id !== id) return undefined;
  return {
    status: a.outcome,
    reason: typeof a.reason === 'string' ? a.reason : undefined,
    ...(a.rule === undefined ? {} : { rule: a.rule }),
  };
}

/** A post that failed in a way that may have stored it: a timeout, the network, a 5xx. */
function mayBeStored(err: unknown): boolean {
  if (!(err instanceof ApiError)) return true;
  return err.status >= 500 || err.status === 408 || err.code === 'timeout';
}

// ---------------------------------------------------------------------------
// approve
// ---------------------------------------------------------------------------

/** The approve tool (the PermissionRequest hook) for one channel session. */
export function createApproveTool(state: ChannelState, options: ApproveOptions): ToolDefinition {
  const scale = options.msPerSecond ?? 1000;
  const clock = options.now ?? Date.now;
  /**
   * How many fallback ids this process made per prefix (so a retried
   * identical call gets a new card), and how many of them are in use; a
   * prefix in use is never forgotten.
   */
  const fallbackSeq = new Map<string, { seq: number; inUse: number }>();
  /** This server's own nonce (made once, at start-up): fallback ids can't be guessed or reused. */
  const nonce = randomUUID();

  return defineTool({
    name: 'approve',
    // Not in the catalog: listed only in channel mode, whatever the toolsets.
    toolset: 'chat',
    title: 'Tool approval (plugin hook)',
    description:
      "Called by the buildit plugin's PermissionRequest hook when a tool needs the person's approval: it asks them in buildIt.Social too. Not for you to call. Keep secrets, tokens, passwords and keys out of commands, file contents and edits (read them from environment variables or config files, never echo them): the app hides anything that looks like a credential, and a call with a hidden value can only be denied there.",
    scopes: [],
    runsAfterSessionEnd: true,
    annotations: {
      title: 'Tool approval (plugin hook)',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: ApproveInputSchema,
    outputSchema: ApproveOutputSchema,
    async run(args, ctx) {
      const pass = (why: string, id: string | null = null): Answer => {
        ctx.logger.info('tool approval passed to the terminal', { reason: why });
        return {
          structured: { status: 'passed', reason: why, message_id: id },
          text: HOOK_PASS,
        };
      };
      try {
        return await approve(args, ctx, pass);
      } catch (err) {
        // A hook never fails: the terminal asks.
        ctx.logger.warn('tool approval failed', { code: codeOf(err) });
        return pass('error');
      }
    },
  });

  async function approve(
    args: z.infer<typeof ApproveInputSchema>,
    ctx: ToolContext,
    pass: (why: string, id?: string | null) => Answer,
  ): Promise<Answer> {
    // The whole call, the post included, stays within the card's wait (and so the hook's timeout).
    const started = clock();
    if (!options.approvalsInApp) return pass('approvals_in_app_off');
    const toolName = hookField(args.tool_name);
    // AskUserQuestion is the question hook's.
    if (toolName === 'AskUserQuestion') return pass('ask_user_question');
    if (!TOOL_NAME_RE.test(toolName)) return pass('tool_name');
    if (!state.isChannel) return pass('not_the_channel');
    const info = state.session;
    if (info === undefined || state.ended !== undefined || state.waiters.isEnded) {
      return pass('no_session');
    }
    const input = parseToolInput(args.tool_input);
    if (input === undefined) return pass('tool_input');
    const approvals = state.approvals;
    if (approvals === undefined) return pass('no_session');

    const agentId = hookField(args.agent_id);
    const hash = inputHash(input);
    const given = hookField(args.tool_use_id);
    const toolUseId = TOOL_USE_ID_RE.test(given)
      ? given
      : await state.ring.claimSoon(agentId, toolName, hash, CORRELATE_WAIT_MS);
    let id: string;
    let releasePrefix = (): void => undefined;
    if (toolUseId !== undefined) {
      id = approvalIdForToolUse(toolUseId, agentId, toolName, hash);
    } else {
      const sessionId = hookField(args.session_id) || info.session.id;
      const prefix = [sessionId, agentId, toolName, hash, hookField(args.prompt_id), nonce].join(
        '\n',
      );
      const entry = fallbackSeq.get(prefix) ?? { seq: 0, inUse: 0 };
      entry.seq++;
      entry.inUse++;
      fallbackSeq.delete(prefix);
      fallbackSeq.set(prefix, entry);
      if (fallbackSeq.size > 1000) {
        for (const [key, value] of fallbackSeq) {
          if (value.inUse === 0) {
            fallbackSeq.delete(key);
            break;
          }
        }
      }
      releasePrefix = () => {
        entry.inUse = Math.max(0, entry.inUse - 1);
      };
      id = uuidV5(`${prefix}\n${entry.seq}`, APPROVE_NAMESPACE);
    }
    try {
      return await approveCard(args, ctx, pass, { started, id, toolName, hash, toolUseId, input });
    } finally {
      releasePrefix();
    }
  }

  async function approveCard(
    args: z.infer<typeof ApproveInputSchema>,
    ctx: ToolContext,
    pass: (why: string, id?: string | null) => Answer,
    call: {
      started: number;
      id: string;
      toolName: string;
      hash: string;
      toolUseId: string | undefined;
      input: Record<string, unknown>;
    },
  ): Promise<Answer> {
    const { started, id, toolName, hash, toolUseId, input } = call;
    const info = state.session;
    const approvals = state.approvals;
    if (info === undefined || approvals === undefined) return pass('no_session');
    const agentId = hookField(args.agent_id);
    const agentType = hookField(args.agent_type);
    const rule = sessionRuleFrom(args.suggestions, toolName);
    const known = state.waiters.approvalOf(id, toolName, hash);
    if (known !== undefined) {
      // A remembered session rule is granted again only to a call that offers that same rule.
      if (
        known.status === 'approved_session' &&
        (rule === undefined || canonicalJson(known.rule) !== canonicalJson(rule))
      ) {
        ctx.logger.warn('tool approval rule not granted', { reason: 'rule_mismatch' });
        return {
          structured: { status: 'approved', reason: 'rule_mismatch', message_id: id },
          text: permissionAllow(),
        };
      }
      return {
        structured: {
          status: known.status as ApproveOutput['status'],
          ...(known.reason === undefined ? {} : { reason: known.reason }),
          message_id: id,
        },
        text: known.text,
      };
    }

    const owner = sanitizeLabel(info.owner.name, 64);
    const waitS = options.hookWaitS;
    const minutes = Math.max(1, Math.round(waitS / 60));
    const details = buildDetails(toolName, input);
    // A command cut to fit can't be checked in the app: its card offers only Deny.
    const tooLong =
      (toolName === 'Bash' || toolName === 'PowerShell') &&
      (details.fields.some((f) => (f.cut ?? 0) > 0) || (details.more_fields ?? 0) > 0);
    // Nor can a call with a hidden part: the owner can approve only what they see in full.
    const hidden = details.fields.some(
      (f) => f.value.includes(REDACTED) || f.key.includes(REDACTED),
    );
    const unchecked: 'too_long' | 'hidden' | undefined = tooLong
      ? 'too_long'
      : hidden
        ? 'hidden'
        : undefined;
    const subagent = agentId !== '' || agentType !== '';
    const agent =
      subagent && AGENT_REF_RE.test(agentId)
        ? { ref: agentId, ...(AGENT_TYPE_RE.test(agentType) ? { type: agentType } : {}) }
        : undefined;
    let place = await placement(state, ctx, agentId, agentType);

    // Registered before the post, so a verdict in the next poll finds its waiter.
    const inbox = new CardInbox();
    let staleReason: StaleReason | undefined;
    let wake: (() => void) | undefined;
    const settle = (reason: StaleReason): void => {
      staleReason ??= reason;
      wake?.();
    };
    let pollNow = false;
    /** The session can't answer any more: switched off, or ended (from a poll or a GET). */
    let gone: Final | undefined;
    const goneBy = (err: unknown): Final | undefined => {
      const code = codeOf(err);
      if (code === 'agent_sessions_off') return { status: 'closed', reason: 'switched_off' };
      if (code === 'token_revoked' || code === 'token_expired' || code === 'token_invalid') {
        return { status: 'closed', reason: 'session_ended' };
      }
      return undefined;
    };
    /** Read through a function: a poll or GET may set it while this call waits. */
    const goneNow = (): Final | undefined => gone;
    const onPollFailed = (err: unknown): void => {
      gone ??= goneBy(err);
      pollNow = true;
      wake?.();
    };
    let unregister = state.waiters.register(id, inbox, place.thread);
    const postedAt = new Date(clock()).toISOString();
    const leave = approvals.add({ id, agentRef: agentId, toolUseId, postedAt, settle });
    state.pollFailed.add(onPollFailed);
    const closer = apiApprovalCloser(ctx.api, ctx.logger);
    const closeLater = (reason: ApprovalCloseReason): void => {
      void closer(id, reason);
    };
    let progress: NodeJS.Timeout | undefined;
    let answer: Answer | undefined;
    let typingThread: string | undefined;
    try {
      const post = (thread: string | undefined) =>
        postSessionApproval(
          ctx.api,
          {
            id,
            ...(thread === undefined ? {} : { thread_id: thread }),
            tool_name: toolName,
            ...(toolUseId === undefined ? {} : { tool_use_id: toolUseId }),
            ...(agent === undefined ? {} : { agent }),
            ...(details.description === undefined ? {} : { description: details.description }),
            fields: details.fields,
            ...(details.more_fields === undefined ? {} : { more_fields: details.more_fields }),
            ...(rule === undefined ? {} : { suggestion: rule }),
            wait_s: waitS,
          },
          ctx.apiOptions,
        );
      /**
       * A post that failed: when it may have been stored anyway (or the id is
       * another call's), the card is closed as interrupted and stays in the
       * journal until that close succeeds; then the terminal decides.
       */
      const failed = (err: unknown): Answer => {
        const code = codeOf(err);
        ctx.logger.info('tool approval not posted', { code });
        if (mayBeStored(err) || code === 'idempotency_conflict') {
          approvals.orphan(id, postedAt);
          void closer(id, 'interrupted').then((ok) => {
            if (ok) approvals.forget(id);
          });
        }
        return pass('post_failed');
      };
      let posted: Awaited<ReturnType<typeof post>>;
      try {
        posted = await post(place.thread);
      } catch (err) {
        if (!(place.item && ITEM_FALLBACK_CODES.has(codeOf(err)))) return failed(err);
        // The item's thread refused it: ask in the direct message instead.
        ctx.logger.info('tool approval moved to the direct message', { code: codeOf(err) });
        place = { thread: state.lastDmThread, item: false };
        unregister();
        unregister = state.waiters.register(id, inbox, place.thread);
        try {
          posted = await post(place.thread);
        } catch (again) {
          return failed(again);
        }
      }
      const init = {
        id,
        owner,
        minutes,
        rule,
        unchecked,
        mismatch: () => {
          ctx.logger.warn('tool approval rule not granted', { reason: 'rule_mismatch' });
        },
      };
      ctx.logger.info('tool approval posted', {
        message_id: id,
        created: posted.created,
        correlated: toolUseId !== undefined,
      });
      if (posted.approval.status !== 'open') {
        answer = answerOf(posted.approval, init);
        return answer;
      }
      typingThread = place.thread ?? posted.message.thread_id ?? undefined;
      state.typing?.stop(typingThread);
      if (ctx.progress !== undefined) {
        const report = ctx.progress;
        let beats = 0;
        progress = setInterval(() => {
          beats++;
          void report(
            `Waiting for the person's approval in buildIt.Social (${Math.round((beats * PROGRESS_EVERY_S) / 60)} min).`,
          ).catch(() => undefined);
        }, PROGRESS_EVERY_S * scale);
      }

      const deadline = started + waitS * scale;
      let nextPoll = clock() + POLL_EVERY_S * scale;
      const readState = async (): Promise<Final | undefined> => {
        try {
          const r = await getSessionApproval(ctx.api, id, ctx.apiOptions);
          return r.approval.status === 'open' ? undefined : r.approval;
        } catch (err) {
          ctx.logger.info('tool approval state not read', { code: codeOf(err) });
          gone ??= goneBy(err);
          return undefined;
        }
      };
      for (;;) {
        const ended = goneNow();
        if (ended !== undefined) {
          answer = answerOf(ended, init);
          return answer;
        }
        if (staleReason !== undefined) {
          closeLater(staleReason);
          answer = answerOf({ status: staleReason }, init);
          return answer;
        }
        if (ctx.signal?.aborted === true) {
          closeLater('interrupted');
          answer = pass('aborted', id);
          return answer;
        }
        const now = clock();
        if (now >= deadline) {
          // The owner may have tapped in the last second: the close answers the final state.
          let final: Final = { status: 'expired', reason: 'client' };
          try {
            const closed = await closeSessionApproval(ctx.api, id, 'expired', {
              ...(ctx.apiOptions.tool === undefined ? {} : { tool: ctx.apiOptions.tool }),
              signal: AbortSignal.timeout(5000),
            });
            if (closed.approval.status !== 'open') final = closed.approval;
          } catch (err) {
            ctx.logger.info('tool approval not closed', { code: codeOf(err) });
          }
          answer = answerOf(final, init);
          return answer;
        }
        if (pollNow || now >= nextPoll) {
          pollNow = false;
          nextPoll = now + POLL_EVERY_S * scale;
          const final = await readState();
          if (goneNow() !== undefined) continue;
          if (final !== undefined) {
            answer = answerOf(final, init);
            return answer;
          }
          continue;
        }
        const local = new AbortController();
        wake = () => {
          local.abort();
        };
        const signal =
          ctx.signal === undefined ? local.signal : AbortSignal.any([local.signal, ctx.signal]);
        const next = await inbox.next(Math.min(deadline, nextPoll), signal, clock);
        wake = undefined;
        if (next === 'timeout' || next === 'aborted') continue;
        if (next === 'session_ended') {
          answer = answerOf({ status: 'closed', reason: 'session_ended' }, init);
          return answer;
        }
        if (next === 'closed') {
          // The session was taken off the item: the server closed the card.
          answer = answerOf({ status: 'closed', reason: 'unassigned' }, init);
          return answer;
        }
        const { event, done } = next;
        try {
          if (event.type !== 'card.closed' || eventMessageId(event) !== id) continue;
          const final = eventApproval(event, id);
          if (final === undefined) {
            // A close without the verdict: read it.
            pollNow = true;
            continue;
          }
          answer = answerOf(final, init);
          return answer;
        } finally {
          done();
        }
      }
    } finally {
      if (progress !== undefined) clearInterval(progress);
      state.pollFailed.delete(onPollFailed);
      unregister();
      leave();
      inbox.drain();
      if (answer !== undefined) {
        const verdict: ApprovalVerdict = {
          status: answer.structured.status,
          ...(answer.structured.reason === undefined ? {} : { reason: answer.structured.reason }),
          text: answer.text,
          toolName,
          hash,
          ...(rule === undefined ? {} : { rule }),
        };
        state.waiters.rememberApproval(id, verdict);
        if (
          (answer.structured.status === 'approved' ||
            answer.structured.status === 'approved_session') &&
          typingThread !== undefined
        ) {
          // The agent works again there.
          state.typing?.work(typingThread);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The hooks that end approvals
// ---------------------------------------------------------------------------

/** A hook field that may be long or of any type (only strings count). */
const HookString = z.unknown().optional();

const str = (v: unknown): string => hookField(v);

/** What every hook tool answers: nothing for Claude Code to do. */
const EMPTY = { structured: { ok: true }, text: '{}' };
const OkSchema = z.object({ ok: z.boolean() });

/**
 * The hooks' annotations: tool_seen only records the call here (read-only);
 * the others may close a card in buildIt.Social. All of them stay listed
 * under --read-only (where approve isn't, so there is nothing for them to
 * close), so the plugin's hooks never fail.
 */
const hookAnnotations = (title: string, readOnly: boolean) => ({
  title,
  readOnlyHint: readOnly,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: !readOnly,
});

/**
 * Whether a prompt Claude Code submitted was typed by the person: a channel
 * message (`<channel …>`) and a background task's report
 * (`<task-notification>`) arrive as prompts too, and say nothing about the
 * approvals waiting.
 */
export function typedByPerson(prompt: unknown): boolean {
  if (typeof prompt !== 'string') return true;
  const p = prompt.trimStart();
  return !p.startsWith('<channel') && !p.startsWith('<task-notification');
}

/**
 * tool_seen (PreToolUse), tool_done (PostToolUse, PostToolUseFailure),
 * agent_done (SubagentStop) and prompt_typed (UserPromptSubmit).
 */
export function createApprovalHookTools(state: ChannelState): ToolDefinition[] {
  const guarded =
    (name: string, body: (args: Record<string, unknown>, ctx: ToolContext) => void) =>
    (args: Record<string, unknown>, ctx: ToolContext) => {
      try {
        body(args, ctx);
      } catch (err) {
        ctx.logger.info(`${name} failed`, { code: codeOf(err) });
      }
      return Promise.resolve(EMPTY);
    };

  const toolSeen = defineTool({
    name: 'tool_seen',
    toolset: 'chat',
    title: 'Tool call seen (plugin hook)',
    description:
      "Called by the buildit plugin's PreToolUse hook before each tool call, so a tool approval can name its call. Not for you to call.",
    scopes: [],
    runsAfterSessionEnd: true,
    annotations: hookAnnotations('Tool call seen (plugin hook)', true),
    inputSchema: z.object({
      tool_name: HookString,
      tool_input: HookString,
      tool_use_id: HookString,
      agent_id: HookString,
    }),
    outputSchema: OkSchema,
    run: guarded('tool_seen', (args) => {
      const toolName = str(args.tool_name);
      const toolUseId = str(args.tool_use_id);
      const agentId = str(args.agent_id);
      if (toolName !== '' && TOOL_USE_ID_RE.test(toolUseId)) {
        const input = parseToolInput(args.tool_input);
        state.ring.record({
          agentId,
          toolName,
          hash: inputHash(input ?? args.tool_input ?? null),
          toolUseId,
        });
      }
      // Claude is at work: the main agent on its thread, an item worker on its item's.
      const typing = state.typing;
      if (typing === undefined) return;
      if (agentId === '') {
        typing.activity();
        return;
      }
      if (state.folder === undefined) return;
      const entry = workerEntry(state.folder, agentId);
      if (entry === undefined) return;
      const thread =
        entry.thread_id !== undefined && isUuid(entry.thread_id)
          ? entry.thread_id
          : entry.item === undefined
            ? undefined
            : state.items.get(entry.item.toUpperCase());
      if (thread !== undefined && state.activeItems.has(thread)) typing.work(thread);
    }),
  });

  const toolDone = defineTool({
    name: 'tool_done',
    toolset: 'chat',
    title: 'Tool call done (plugin hook)',
    description:
      "Called by the buildit plugin's PostToolUse and PostToolUseFailure hooks after each tool call: a tool approval still waiting for that call was answered in the terminal. Not for you to call.",
    scopes: [],
    runsAfterSessionEnd: true,
    annotations: hookAnnotations('Tool call done (plugin hook)', false),
    inputSchema: z.object({ tool_use_id: HookString, agent_id: HookString }),
    outputSchema: OkSchema,
    run: guarded('tool_done', (args, ctx) => {
      const toolUseId = str(args.tool_use_id);
      if (toolUseId === '') return;
      const n = state.approvals?.toolDone(toolUseId) ?? 0;
      if (n > 0) ctx.logger.info('tool approval answered elsewhere', { count: n });
    }),
  });

  const agentDone = defineTool({
    name: 'agent_done',
    toolset: 'chat',
    title: 'Subagent done (plugin hook)',
    description:
      "Called by the buildit plugin's SubagentStop hook when a subagent stops: its tool approvals are no longer needed. Not for you to call.",
    scopes: [],
    runsAfterSessionEnd: true,
    annotations: hookAnnotations('Subagent done (plugin hook)', false),
    inputSchema: z.object({ agent_id: HookString, agent_type: HookString }),
    outputSchema: OkSchema,
    run: guarded('agent_done', (args, ctx) => {
      const agentId = str(args.agent_id);
      if (agentId === '') return;
      const n = state.approvals?.agentDone(agentId) ?? 0;
      if (n > 0) ctx.logger.info('tool approvals no longer needed', { count: n });
    }),
  });

  const promptTyped = defineTool({
    name: 'prompt_typed',
    toolset: 'chat',
    title: 'Prompt typed (plugin hook)',
    description:
      "Called by the buildit plugin's UserPromptSubmit hook: a new prompt from the person means the main agent's tool approvals are no longer needed. Not for you to call.",
    scopes: [],
    runsAfterSessionEnd: true,
    annotations: hookAnnotations('Prompt typed (plugin hook)', false),
    inputSchema: z.object({ prompt: HookString }),
    outputSchema: OkSchema,
    run: guarded('prompt_typed', (args, ctx) => {
      if (!typedByPerson(args.prompt)) return;
      const n = state.approvals?.agentDone('') ?? 0;
      if (n > 0) ctx.logger.info('tool approvals no longer needed', { count: n });
    }),
  });

  return [toolSeen, toolDone, agentDone, promptTyped];
}

/** The hook tools listed under --read-only too (no-ops there: approve, which posts, isn't). */
export const READ_ONLY_SAFE_HOOKS: ReadonlySet<string> = new Set([
  'tool_seen',
  'tool_done',
  'agent_done',
  'prompt_typed',
]);

/** The hook tools that are no activity of their own for "is writing" (tool_seen counts it itself). */
export const APPROVAL_HOOK_TOOLS: ReadonlySet<string> = new Set([
  'approve',
  'tool_seen',
  'tool_done',
  'agent_done',
  'prompt_typed',
]);
