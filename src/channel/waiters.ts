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

/** How many cards' outcomes are remembered for a repeated ask. */
const REMEMBERED = 500;

/** A map that forgets its oldest entries past a size. */
class Bounded<V> {
  private readonly map = new Map<string, V>();
  get(key: string): V | undefined {
    return this.map.get(key);
  }
  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > REMEMBERED) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
}

/**
 * The waiters of one session, by card message id (several may wait for one
 * card: the hook can run twice for one question), and what the session's
 * cards became: the answers accepted, and how each card closed. A repeated
 * ask for a card that was already answered returns those answers instead
 * of waiting for events that were handed on (and acknowledged) before.
 */
export class CardWaiters {
  private readonly waiters = new Map<string, Set<CardWaiter>>();
  private readonly answers = new Bounded<Record<string, string>>();
  private readonly closings = new Bounded<string>();
  private ended = false;

  constructor(private readonly stepMs: number = WAITER_STEP_MS) {}

  /** Whether the session has ended (a new waiter is ended at once). */
  get isEnded(): boolean {
    return this.ended;
  }

  /** Registers a waiter for a card; the returned function unregisters it. */
  register(messageId: string, waiter: CardWaiter): () => void {
    let set = this.waiters.get(messageId);
    if (set === undefined) {
      set = new Set();
      this.waiters.set(messageId, set);
    }
    set.add(waiter);
    if (this.ended) waiter.end();
    return () => {
      const current = this.waiters.get(messageId);
      if (current === undefined) return;
      current.delete(waiter);
      if (current.size === 0) this.waiters.delete(messageId);
    };
  }

  has(messageId: string): boolean {
    return this.waiters.has(messageId);
  }

  /** How many cards are waited on (tests). */
  get size(): number {
    return this.waiters.size;
  }

  /** Remembers the answers accepted for a card. */
  rememberAnswers(messageId: string, answers: Record<string, string>): void {
    this.answers.set(messageId, answers);
  }

  /** The answers accepted for a card, if this process saw them. */
  answersOf(messageId: string): Record<string, string> | undefined {
    return this.answers.get(messageId);
  }

  /** How a card closed (its closed_by), if this process saw it. */
  closedBy(messageId: string): string | undefined {
    return this.closings.get(messageId);
  }

  /**
   * Hands the event to its card's waiters and waits until they have handled
   * it, or for at most stepMs. A card.closed is remembered first. False when
   * no waiter waits for that card.
   */
  async deliver(event: SessionEvent): Promise<boolean> {
    const id = eventMessageId(event);
    if (id === undefined) return false;
    if (event.type === 'card.closed') {
      const by = (event.data as Record<string, unknown>).closed_by;
      this.closings.set(id, typeof by === 'string' ? by : 'app');
    }
    const set = this.waiters.get(id);
    if (set === undefined || set.size === 0) return false;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.stepMs);
    });
    try {
      await Promise.race([
        Promise.all([...set].map((w) => w.handle(event).catch(() => undefined))),
        late,
      ]);
    } finally {
      clearTimeout(timer);
    }
    return true;
  }

  /** The session ended for good: every waiter is told, and later ones at once. */
  endAll(): void {
    this.ended = true;
    for (const set of [...this.waiters.values()]) for (const waiter of [...set]) waiter.end();
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
