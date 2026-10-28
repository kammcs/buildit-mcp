/**
 * Waiters for answers to the session's own cards.
 *
 * `ask` posts a question card and waits for the person's answer. The
 * channel loop is the only reader of the session's events, so it hands each
 * `card.response` and `card.closed` event whose card has a waiter to that
 * waiter, and waits until the waiter has handled it (at most
 * WAITER_STEP_MS) before it acknowledges the page. An answer is therefore
 * never acknowledged before it was seen, and a server that stops while
 * handling one sees it again after a restart.
 *
 * A waiter is registered by the card message's id before the card is
 * posted (the id is chosen by the server), so an answer that arrives in the
 * first poll after the post still finds it.
 */
import type { SessionEvent } from '../api/generated/schemas.js';

/** The longest the loop waits for a waiter to handle one event. */
export const WAITER_STEP_MS = 10_000;

/** Why waiting stopped without an event. */
export type WaitEnd = 'timeout' | 'aborted' | 'session_ended';

/** One event handed to a waiter, and the callback that says it was handled. */
export interface Delivery {
  event: SessionEvent;
  /** Call once the event is handled (the loop then goes on). */
  done: () => void;
}

/** What waits for one card's events. */
export interface CardWaiter {
  /** Handles one event; the promise settles when it has been handled. */
  handle(event: SessionEvent): Promise<void>;
  /** The session ended for good: no more events will come. */
  end(): void;
}

/** The card message's id that an event is about, if it names one. */
export function eventMessageId(event: SessionEvent): string | undefined {
  const message = (event.data as Record<string, unknown>).message;
  if (message === null || typeof message !== 'object') return undefined;
  const id = (message as Record<string, unknown>).id;
  return typeof id === 'string' ? id : undefined;
}

/** The waiters of one session, by card message id. */
export class CardWaiters {
  private readonly waiters = new Map<string, CardWaiter>();
  private ended = false;

  constructor(private readonly stepMs: number = WAITER_STEP_MS) {}

  /** Whether the session has ended (a new waiter is ended at once). */
  get isEnded(): boolean {
    return this.ended;
  }

  /** Registers the waiter for a card; the returned function unregisters it. */
  register(messageId: string, waiter: CardWaiter): () => void {
    this.waiters.set(messageId, waiter);
    if (this.ended) waiter.end();
    return () => {
      if (this.waiters.get(messageId) === waiter) this.waiters.delete(messageId);
    };
  }

  has(messageId: string): boolean {
    return this.waiters.has(messageId);
  }

  /** How many cards are waited on (tests). */
  get size(): number {
    return this.waiters.size;
  }

  /**
   * Hands the event to its card's waiter and waits until it is handled, or
   * for at most stepMs. False when no waiter waits for that card.
   */
  async deliver(event: SessionEvent): Promise<boolean> {
    const id = eventMessageId(event);
    const waiter = id === undefined ? undefined : this.waiters.get(id);
    if (waiter === undefined) return false;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.stepMs);
    });
    try {
      await Promise.race([waiter.handle(event).catch(() => undefined), late]);
    } finally {
      clearTimeout(timer);
    }
    return true;
  }

  /** The session ended for good: every waiter is told, and later ones at once. */
  endAll(): void {
    this.ended = true;
    for (const waiter of [...this.waiters.values()]) waiter.end();
  }
}

/**
 * A waiter that queues its events, for a loop that takes them one at a
 * time (`next`) and says when each is handled.
 */
export class CardInbox implements CardWaiter {
  private readonly queue: Delivery[] = [];
  private wake: (() => void) | undefined;
  private ended = false;

  handle(event: SessionEvent): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push({ event, done: resolve });
      this.wake?.();
    });
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  /**
   * The next event, or why there is none: the deadline passed (`timeout`),
   * the signal aborted, or the session ended. Events already queued come
   * first.
   */
  async next(
    deadline: number,
    signal?: AbortSignal,
    now: () => number = Date.now,
  ): Promise<Delivery | WaitEnd> {
    for (;;) {
      const queued = this.queue.shift();
      if (queued !== undefined) return queued;
      if (signal?.aborted) return 'aborted';
      if (this.ended) return 'session_ended';
      const left = deadline - now();
      if (left <= 0) return 'timeout';
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, left);
        function done(): void {
          clearTimeout(timer);
          signal?.removeEventListener('abort', done);
          resolve();
        }
        this.wake = done;
        signal?.addEventListener('abort', done, { once: true });
      });
      this.wake = undefined;
    }
  }

  /** Says every queued event was handled (when the waiter stops). */
  drain(): void {
    for (const d of this.queue.splice(0)) d.done();
  }
}
