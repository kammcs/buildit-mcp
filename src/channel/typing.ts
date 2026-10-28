/**
 * "<agent> is writing…" in buildIt.Social while Claude works on a message.
 *
 * When the loop hands one of the owner's messages to Claude, the thread it
 * came in starts "working": the server says the agent is typing there at
 * once (POST /v1/session/typing), and again every 15 seconds (the app shows
 * it for 30). It stops, with one `typing: false`, when for that thread:
 * reply posts, ask posts a question card (the card shows the agent waits),
 * a plan card is posted; for every thread, when the plugin's Stop hook says
 * Claude's turn ended (the turn_ended tool), after 10 minutes without a
 * tool call for it, and on shutdown. When the session ends, the timers
 * just stop (the token no longer works).
 *
 * The 10 minutes count per thread: a tool call that names a thread (its
 * thread_id, or an item's key) is that thread's activity, and a call that
 * names none counts for the working thread only while there is one. Item
 * workers run in parallel through this one server, so each item's thread
 * shows "is writing" while its own worker calls tools, and `work` starts it
 * again when a worker goes on after a reply.
 *
 * It is only a hint: failures are logged, never shown to Claude, and a 429
 * pauses the beats until its Retry-After has passed.
 */
import { ApiError, type ApiClient } from '../api/client.js';
import type { Logger } from '../log.js';
import { sessionTyping } from './api.js';

/** How often a working thread says so again. */
export const TYPING_EVERY_MS = 15_000;
/** A thread stops working after this long without a tool call. */
export const TYPING_IDLE_MS = 10 * 60_000;

export interface TypingOptions {
  api: ApiClient;
  logger: Logger;
  everyMs?: number;
  idleMs?: number;
  now?: () => number;
}

export class TypingIndicator {
  private readonly threads = new Map<string, NodeJS.Timeout>();
  /** Each working thread's latest activity. */
  private readonly lastActivity = new Map<string, number>();
  private readonly everyMs: number;
  private readonly idleMs: number;
  private readonly now: () => number;
  /** No beats before this time (after a 429). */
  private quietUntil = 0;
  private closed = false;

  constructor(private readonly options: TypingOptions) {
    this.everyMs = options.everyMs ?? TYPING_EVERY_MS;
    this.idleMs = options.idleMs ?? TYPING_IDLE_MS;
    this.now = options.now ?? Date.now;
  }

  /** The threads working now (tests). */
  get working(): string[] {
    return [...this.threads.keys()];
  }

  /** A message for Claude arrived in this thread: it is working on it. */
  start(threadId: string): void {
    if (this.closed) return;
    this.lastActivity.set(threadId, this.now());
    const old = this.threads.get(threadId);
    if (old !== undefined) clearInterval(old);
    const timer = setInterval(() => {
      this.beat(threadId);
    }, this.everyMs);
    timer.unref();
    this.threads.set(threadId, timer);
    void this.send(threadId, true);
  }

  /**
   * A tool call to this server: Claude is still at work, on that thread
   * when the call names one, else on the only working thread (with
   * several, a call that names none keeps none of them going).
   */
  activity(threadId?: string): void {
    const now = this.now();
    if (threadId !== undefined) {
      if (this.threads.has(threadId)) this.lastActivity.set(threadId, now);
      return;
    }
    if (this.threads.size !== 1) return;
    for (const id of this.threads.keys()) this.lastActivity.set(id, now);
  }

  /** A worker is at work on this thread: it shows "is writing" again if it had stopped. */
  work(threadId: string): void {
    if (this.closed) return;
    if (this.threads.has(threadId)) {
      this.lastActivity.set(threadId, this.now());
      return;
    }
    this.start(threadId);
  }

  /** Stops one thread (reply, a card posted); nothing when it isn't working. */
  stop(threadId: string | undefined): void {
    if (threadId === undefined) return;
    const timer = this.threads.get(threadId);
    if (timer === undefined) return;
    clearInterval(timer);
    this.threads.delete(threadId);
    this.lastActivity.delete(threadId);
    void this.send(threadId, false);
  }

  /** Stops every thread (the turn ended, or shutdown); the promise settles once they are told. */
  async stopAll(): Promise<void> {
    const ids = [...this.threads.keys()];
    for (const timer of this.threads.values()) clearInterval(timer);
    this.threads.clear();
    this.lastActivity.clear();
    await Promise.all(ids.map((id) => this.send(id, false)));
  }

  /** The session ended: stop every timer, and send nothing more. */
  close(): void {
    this.closed = true;
    for (const timer of this.threads.values()) clearInterval(timer);
    this.threads.clear();
  }

  private beat(threadId: string): void {
    if (this.now() - (this.lastActivity.get(threadId) ?? 0) >= this.idleMs) {
      this.options.logger.debug('typing stopped: no activity', { thread_id: threadId });
      this.stop(threadId);
      return;
    }
    if (this.now() < this.quietUntil) return;
    void this.send(threadId, true);
  }

  private async send(threadId: string, typing: boolean): Promise<void> {
    if (this.closed) return;
    // A stop is sent even while quiet: the app would otherwise show it until its time runs out.
    if (typing && this.now() < this.quietUntil) return;
    try {
      await sessionTyping(
        this.options.api,
        { thread_id: threadId, typing },
        { tool: 'typing', signal: AbortSignal.timeout(15_000) },
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        this.quietUntil = this.now() + Math.max(this.everyMs, (err.retryAfterSeconds ?? 60) * 1000);
        return;
      }
      this.options.logger.debug('typing not sent', {
        code: err instanceof ApiError ? err.code : 'error',
      });
    }
  }
}
