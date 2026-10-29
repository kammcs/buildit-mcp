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
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/** Closes one card in buildIt.Social (best effort; the API call). */
export type ApprovalCloser = (id: string, reason: ApprovalCloseReason) => Promise<void>;

/** The closer that calls the API (at most 5 seconds each; a failure is only logged). */
export function apiApprovalCloser(api: ApiClient, logger: Logger): ApprovalCloser {
  return async (id, reason) => {
    try {
      await closeSessionApproval(api, id, reason, {
        tool: 'approve',
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      logger.info('tool approval not closed', {
        message_id: id,
        code: err instanceof ApiError ? err.code : 'error',
      });
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

/** The longest shutdown waits for the cards to close. */
export const SHUTDOWN_CLOSE_MS = 5000;

export class ToolApprovals {
  private readonly open = new Map<string, OpenApproval>();
  /** Every waiting call's settle, by card (the hook may run twice for one call). */
  private readonly settles = new Map<string, Set<(reason: StaleReason) => void>>();
  /** Ids of every approval this process posted (bounded), and the journal's from before. */
  private readonly known = new Set<string>();
  /** The cards a process before this one left open (the journal at startup), until closed. */
  private leftOpen: { id: string; posted_at: string }[] = [];

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
      if (this.open.delete(entry.id)) this.writeJournal();
    };
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
    if (left.length === 0) {
      this.leftOpen = [];
      return;
    }
    await Promise.all(left.map((e) => closer(e.id, 'interrupted').catch(() => undefined)));
    this.leftOpen = [];
    this.writeJournal();
    this.options.logger.info('tool approvals left open by an earlier server closed', {
      count: left.length,
    });
  }

  private settle(id: string, reason: StaleReason): void {
    for (const settle of [...(this.settles.get(id) ?? [])]) settle(reason);
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

  private writeJournal(): void {
    const path = this.options.journal;
    if (path === undefined) return;
    const file: JournalFile = {
      v: 1,
      open: [
        ...this.leftOpen,
        ...[...this.open.values()].map((e) => ({ id: e.id, posted_at: e.postedAt })),
      ],
    };
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, JSON.stringify(file), { mode: 0o600 });
      chmodSync(path, 0o600);
    } catch (err) {
      this.options.logger.info('tool approval journal not written', {
        code: (err as NodeJS.ErrnoException).code ?? 'error',
      });
    }
  }
}
