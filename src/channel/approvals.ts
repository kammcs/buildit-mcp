/**
 * The session's open tool approvals: the cards `approve` posted and still
 * waits on, so the plugin's other hooks can end them.
 *
 * Claude Code never says that a permission request no longer needs an
 * answer (the person answered in the terminal, pressed Esc, or the turn went
 * on), so the plugin's hooks say it instead, and the waiting `approve` call
 * ends with `{}` (it changes nothing) and closes its card in buildIt.Social:
 *
 * - `tool_done` (PostToolUse, PostToolUseFailure): the call ran, so it was
 *   answered elsewhere;
 * - `agent_done` (SubagentStop): that subagent's approvals are no longer
 *   needed;
 * - `turn_ended` (Stop) and `prompt_typed` (UserPromptSubmit): the main
 *   agent's approvals are no longer needed.
 *
 * On shutdown every open card is closed (the session ended). A journal file
 * keeps the open cards' ids, so a server that died with cards open closes
 * them when the next one starts in the folder: the owner never approves a
 * call nobody waits for.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { ApiError, type ApiClient } from '../api/client.js';
import type { Logger } from '../log.js';
import { closeSessionApproval } from './api.js';

/** Why the session closes a tool approval card itself. */
export type ApprovalCloseReason =
  'answered_elsewhere' | 'stale' | 'interrupted' | 'session_ended' | 'expired';

/** Why a waiting approval ends without a verdict: it no longer needs one. */
export type StaleReason = 'answered_elsewhere' | 'stale';

/** One open tool approval. */
export interface OpenApproval {
  /** The card message's id. */
  id: string;
  /** Claude Code's agent id of who asked ("" for the main agent). */
  agentRef: string;
  /** The tool call's id, when the approval could name it. */
  toolUseId: string | undefined;
  /** When it was posted (RFC 3339). */
  postedAt: string;
  /** Ends the waiting call: the approval no longer needs an answer. */
  settle: (reason: StaleReason) => void;
}

/** How the journal names the open cards. */
interface JournalFile {
  v: 1;
  open: { id: string; posted_at: string }[];
}

/**
 * Closes one card in buildIt.Social (best effort; the API call): true once
 * the card is closed or doesn't exist, false when that isn't known.
 */
export type ApprovalCloser = (id: string, reason: ApprovalCloseReason) => Promise<boolean>;

/** The closer that calls the API (at most 5 seconds each; a failure is only logged). */
export function apiApprovalCloser(api: ApiClient, logger: Logger): ApprovalCloser {
  return async (id, reason) => {
    try {
      await closeSessionApproval(api, id, reason, {
        tool: 'approve',
        signal: AbortSignal.timeout(5000),
      });
      return true;
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'error';
      logger.info('tool approval not closed', { message_id: id, code });
      // Nothing to close: the post never made it.
      return code === 'not_found';
    }
  };
}

export interface ToolApprovalsOptions {
  logger: Logger;
  /** The journal's path; none: no journal. */
  journal?: string | undefined;
}

/** How many ids of the session's tool approvals are remembered (to know their events). */
const KNOWN_MAX = 500;
/** How many ended ids are remembered (so a merged journal doesn't bring them back). */
const ENDED_MAX = 1000;

/** The longest shutdown waits for the cards to close. */
export const SHUTDOWN_CLOSE_MS = 5000;

export class ToolApprovals {
  private readonly open = new Map<string, OpenApproval>();
  /** Every waiting call's settle, by card (the hook may run twice for one call). */
  private readonly settles = new Map<string, Set<(reason: StaleReason) => void>>();
  /** Ids of every approval this process posted (bounded), and the journal's from before. */
  private readonly known = new Set<string>();
  /**
   * Cards no waiting call holds but that may be open in buildIt.Social: the
   * ones a process before this one left (the journal at startup), and posts
   * that failed in a way that may have stored them, until they are closed.
   */
  private leftOpen: { id: string; posted_at: string }[] = [];
  /** Ids this process knows have ended (the journal drops them). */
  private readonly ended = new Set<string>();

  constructor(private readonly options: ToolApprovalsOptions) {
    this.leftOpen = this.readJournal();
    for (const e of this.leftOpen) this.remember(e.id);
  }

  /** The open approvals (tests). */
  get openIds(): string[] {
    return [...this.open.keys()];
  }

  /** Whether a card message is one of this session's tool approvals. */
  isApproval(messageId: string): boolean {
    return this.known.has(messageId) || this.open.has(messageId);
  }

  /**
   * An approval was posted (or is about to be): it is open until removed. A
   * second call for the same card (the hook ran twice) joins it.
   */
  add(entry: OpenApproval): () => void {
    const settles = this.settles.get(entry.id) ?? new Set<(reason: StaleReason) => void>();
    settles.add(entry.settle);
    this.settles.set(entry.id, settles);
    if (!this.open.has(entry.id)) this.open.set(entry.id, entry);
    this.remember(entry.id);
    this.writeJournal();
    return () => {
      settles.delete(entry.settle);
      if (settles.size > 0) return;
      this.settles.delete(entry.id);
      if (this.open.delete(entry.id)) {
        if (!this.leftOpen.some((e) => e.id === entry.id)) this.markEnded(entry.id);
        this.writeJournal();
      }
    };
  }

  /**
   * A post that failed in a way that may have stored it (a timeout, the
   * network, a 5xx): the card stays in the journal until a close succeeds.
   */
  orphan(id: string, postedAt: string): void {
    if (!this.leftOpen.some((e) => e.id === id)) this.leftOpen.push({ id, posted_at: postedAt });
    this.writeJournal();
  }

  /** A card closed for sure (or never stored): it leaves the journal. */
  forget(id: string): void {
    this.leftOpen = this.leftOpen.filter((e) => e.id !== id);
    if (!this.open.has(id)) this.markEnded(id);
    this.writeJournal();
  }

  /** The tool call ran (its PostToolUse): an approval waiting for it was answered elsewhere. */
  toolDone(toolUseId: string): number {
    let n = 0;
    for (const entry of [...this.open.values()]) {
      if (entry.toolUseId !== undefined && entry.toolUseId === toolUseId) {
        this.settle(entry.id, 'answered_elsewhere');
        n++;
      }
    }
    return n;
  }

  /** An agent's approvals are no longer needed ("" is the main agent). */
  agentDone(agentRef: string): number {
    let n = 0;
    for (const entry of [...this.open.values()]) {
      if (entry.agentRef === agentRef) {
        this.settle(entry.id, 'stale');
        n++;
      }
    }
    return n;
  }

  /**
   * Shutdown: closes every open approval's card (at most SHUTDOWN_CLOSE_MS
   * in all). The waiting calls end with the session.
   */
  async closeAll(closer: ApprovalCloser, reason: ApprovalCloseReason): Promise<void> {
    const ids = [...this.open.keys()];
    if (ids.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(ids.map((id) => closer(id, reason).catch(() => undefined))),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SHUTDOWN_CLOSE_MS);
      }),
    ]);
    clearTimeout(timer);
    this.options.logger.info('tool approvals closed on shutdown', { count: ids.length });
  }

  /**
   * The cards an earlier process left open (it stopped while they waited):
   * each is closed as interrupted, then the journal holds only this
   * process's own. Called once the session is known.
   */
  async recover(closer: ApprovalCloser): Promise<void> {
    const left = this.leftOpen.filter((e) => !this.open.has(e.id));
    if (left.length === 0) return;
    const closed = await Promise.all(
      left.map((e) => closer(e.id, 'interrupted').catch(() => false)),
    );
    // A close that failed keeps its card in the journal, for the next try.
    left.forEach((e, i) => {
      if (closed[i] === true) this.forget(e.id);
    });
    this.options.logger.info('tool approvals left open by an earlier server closed', {
      count: closed.filter(Boolean).length,
      kept: closed.filter((c) => !c).length,
    });
  }

  private settle(id: string, reason: StaleReason): void {
    for (const settle of [...(this.settles.get(id) ?? [])]) settle(reason);
  }

  private markEnded(id: string): void {
    this.ended.delete(id);
    this.ended.add(id);
    if (this.ended.size > ENDED_MAX) {
      const oldest = this.ended.values().next().value;
      if (oldest !== undefined) this.ended.delete(oldest);
    }
  }

  private remember(id: string): void {
    this.known.delete(id);
    this.known.add(id);
    if (this.known.size > KNOWN_MAX) {
      const oldest = this.known.values().next().value;
      if (oldest !== undefined) this.known.delete(oldest);
    }
  }

  private readJournal(): { id: string; posted_at: string }[] {
    const path = this.options.journal;
    if (path === undefined) return [];
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<JournalFile>;
      if (parsed.v !== 1 || !Array.isArray(parsed.open)) return [];
      return parsed.open
        .filter(
          (e): e is { id: string; posted_at: string } =>
            typeof e === 'object' && typeof e.id === 'string' && /^[0-9a-f-]{36}$/i.test(e.id),
        )
        .slice(0, 100)
        .map((e) => ({ id: e.id, posted_at: typeof e.posted_at === 'string' ? e.posted_at : '' }));
    } catch {
      return [];
    }
  }

  /**
   * Writes the journal: what it already lists (another server's entries
   * stay), this process's open and left-open cards, less what this process
   * knows has ended; to a temporary file, then renamed over it.
   */
  private writeJournal(): void {
    const path = this.options.journal;
    if (path === undefined) return;
    const entries = new Map<string, string>();
    for (const e of [
      ...this.readJournal(),
      ...this.leftOpen,
      ...[...this.open.values()].map((o) => ({ id: o.id, posted_at: o.postedAt })),
    ]) {
      if (!this.ended.has(e.id)) entries.set(e.id, e.posted_at);
    }
    const file: JournalFile = {
      v: 1,
      open: [...entries].slice(-100).map(([id, posted_at]) => ({ id, posted_at })),
    };
    const temp = `${path}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(temp, JSON.stringify(file), { mode: 0o600 });
      chmodSync(temp, 0o600);
      renameSync(temp, path);
    } catch (err) {
      this.options.logger.info('tool approval journal not written', {
        code: (err as NodeJS.ErrnoException).code ?? 'error',
      });
      try {
        rmSync(temp, { force: true });
      } catch {
        // Nothing to clean up.
      }
    }
  }
}
