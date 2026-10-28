/**
 * The channel loop: brings the session's inbound messages into the Claude
 * Code session.
 *
 * It reads the session (GET /v1/session) for its owner and poll interval,
 * says it is online, and then polls GET /v1/session/events. Each new
 * `message.posted` event from the owner becomes one
 * `notifications/claude/channel` notification, `{content, meta: {thread_id,
 * message_id, session}}`; then the page is acknowledged, so an event is
 * never acknowledged before it was handed on. Everything else is
 * acknowledged and dropped: events from anyone but the owner (the server
 * sends only the owner's, and this checks again, since whoever can write
 * into a channel can steer the session), other event types, and events seen
 * before (by event and message id).
 *
 * Polling counts as the session's heartbeat on the server. The loop polls
 * at the server's pace (poll_interval_s; the API allows 12 polls a minute),
 * never faster, even while more events wait; a 429 waits out its
 * Retry-After. On stop it says "offline".
 *
 * A revoked or expired token (token_revoked, token_expired) ends the loop
 * for good, and `onEnded` clears the saved token. A suspended session, or
 * sessions turned off for the org, waits and tries again; so do the
 * network, rate limits and the API's 5xx, with a growing pause.
 */
import { ApiError, type ApiClient } from '../api/client.js';
import { ToolInputError } from '../errors.js';
import { isTransientFailure } from '../identity.js';
import type { Logger } from '../log.js';
import { sanitizeLabel } from '../untrusted.js';
import {
  ackSessionEvents,
  getSession,
  listSessionEvents,
  SESSION_ENDED_CODES,
  sessionHeartbeat,
  type SessionEvent,
  type SessionInfo,
} from './api.js';

/** The notification Claude Code reads as a channel event. */
export const CHANNEL_NOTIFICATION = 'notifications/claude/channel';

export type ChannelNotificationParams = {
  /** The message's text: the body of the <channel> tag. */
  content: string;
  /** Attributes of the tag: where to reply, and which session it came to. */
  meta: { thread_id: string; message_id: string; session: string };
};

/** What the loop and the reply tool share: the session, and the thread of the latest message. */
export class ChannelState {
  session: SessionInfo | undefined;
  /** The thread the latest message came in, which reply uses when it names none. */
  lastThreadId: string | undefined;
}

/** Why the loop ended for good. */
export type EndReason =
  | 'token_revoked'
  | 'token_expired'
  | 'token_invalid'
  | 'session_token_required'
  /** The deployment's API is older than the session operations. */
  | 'not_served';

export interface ChannelLoopOptions {
  api: ApiClient;
  logger: Logger;
  state: ChannelState;
  /** Sends one channel notification to the client. A failure stops the loop. */
  notify(params: ChannelNotificationParams): Promise<void>;
  /** Called once when the session can't continue (the loop has stopped). */
  onEnded?(reason: EndReason): void | Promise<void>;
  /** For tests: the wait between polls, which `signal` cuts short. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** For tests: the poll interval to use instead of the server's. */
  intervalMs?: number;
}

/** The longest pause after repeated failures. */
export const MAX_BACKOFF_MS = 60_000;
/** The pause while the session is suspended or sessions are off. */
export const SUSPENDED_WAIT_MS = 60_000;
const DEFAULT_INTERVAL_MS = 5_000;
const PAGE_LIMIT = 100;
/** How many event and message ids are remembered to drop repeats. */
const SEEN_MAX = 1000;
/** Codes that pause the session without ending it. */
const PAUSED_CODES: ReadonlySet<string> = new Set(['token_suspended', 'agent_sessions_off']);

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

/** A bounded set of ids, oldest dropped first. */
class Seen {
  private readonly ids = new Set<string>();
  has(id: string): boolean {
    return this.ids.has(id);
  }
  add(id: string): void {
    this.ids.add(id);
    if (this.ids.size > SEEN_MAX) {
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
  }
}

export class ChannelLoop {
  private readonly stopper = new AbortController();
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly seen = new Seen();
  private running: Promise<void> | undefined;
  private ended = false;
  private failures = 0;

  constructor(private readonly options: ChannelLoopOptions) {
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Starts the loop (once); the promise settles when it stops. */
  start(): Promise<void> {
    this.running ??= this.run().catch((err: unknown) => {
      this.options.logger.error('channel loop failed', { error: err });
    });
    return this.running;
  }

  /** Whether the loop has stopped (asked to, or the session ended). */
  isStopped(): boolean {
    return this.stopper.signal.aborted;
  }

  /** Stops polling, waits for the loop, and says the session is offline (best effort). */
  async stop(): Promise<void> {
    if (this.stopper.signal.aborted && this.running === undefined) return;
    this.stopper.abort();
    await this.running;
    if (this.ended || this.options.state.session === undefined) return;
    await sessionHeartbeat(this.options.api, 'offline', {
      signal: AbortSignal.timeout(3000),
    }).then(
      () => {
        this.options.logger.info('channel session offline');
      },
      () => undefined,
    );
  }

  private get signal(): AbortSignal {
    return this.stopper.signal;
  }

  private async run(): Promise<void> {
    const info = await this.loadSession();
    if (info === undefined) return;
    await sessionHeartbeat(this.options.api, 'online', { signal: this.signal }).catch(
      (err: unknown) => {
        if (err instanceof ApiError) {
          this.options.logger.info('channel heartbeat failed', { code: err.code });
        }
      },
    );
    const interval = this.options.intervalMs ?? Math.max(1000, info.poll_interval_s * 1000);
    let cursor: number | undefined;
    while (!this.isStopped()) {
      let wait = interval;
      try {
        const page = await listSessionEvents(
          this.options.api,
          { ...(cursor === undefined ? {} : { cursor }), limit: PAGE_LIMIT },
          { signal: this.signal },
        );
        this.failures = 0;
        if (page.events.length > 0) {
          for (const event of page.events) {
            if (this.isStopped()) return;
            await this.deliver(event, info);
          }
          if (this.isStopped()) return;
          await ackSessionEvents(this.options.api, page.cursor, { signal: this.signal });
        }
        cursor = page.cursor;
      } catch (err) {
        if (this.isStopped()) return;
        const next = await this.failed(err, interval);
        if (next === undefined) return;
        wait = next;
      }
      if (wait > 0) await this.sleep(wait, this.signal);
    }
  }

  /** GET /v1/session, retried while it fails for a reason that may pass. */
  private async loadSession(): Promise<SessionInfo | undefined> {
    while (!this.isStopped()) {
      try {
        const info = await getSession(this.options.api, { signal: this.signal });
        this.options.state.session = info;
        this.options.logger.info('channel session ready', {
          session_id: info.session.id,
          agent_id: info.agent.id,
        });
        return info;
      } catch (err) {
        if (this.isStopped()) return undefined;
        const wait = await this.failed(err, DEFAULT_INTERVAL_MS);
        if (wait === undefined) return undefined;
        await this.sleep(wait, this.signal);
      }
    }
    return undefined;
  }

  /** Hands one event on, or drops it. A notification that fails stops the loop. */
  private async deliver(event: SessionEvent, info: SessionInfo): Promise<void> {
    const { logger } = this.options;
    if (this.seen.has(event.id)) {
      logger.debug('channel event dropped', { event_id: event.id, reason: 'repeat' });
      return;
    }
    this.seen.add(event.id);
    if (event.type !== 'message.posted') {
      logger.info('channel event dropped', {
        event_id: event.id,
        reason: 'type',
        type: event.type,
      });
      return;
    }
    if (event.session.id !== info.session.id) {
      logger.warn('channel event dropped', { event_id: event.id, reason: 'other_session' });
      return;
    }
    const { message, user } = event.data;
    if (message === undefined) {
      logger.warn('channel event dropped', { event_id: event.id, reason: 'shape' });
      return;
    }
    // Only the owner may direct the session: anyone else's message, or one without a sender, is dropped.
    if (user?.id !== info.owner.id) {
      logger.warn('channel event dropped', { event_id: event.id, reason: 'not_owner' });
      return;
    }
    if (this.seen.has(`m:${message.id}`)) {
      logger.debug('channel event dropped', { event_id: event.id, reason: 'repeat' });
      return;
    }
    this.seen.add(`m:${message.id}`);
    const threadId = message.thread_id ?? message.id;
    try {
      await this.options.notify({
        content: message.text,
        meta: {
          thread_id: threadId,
          message_id: message.id,
          session: sanitizeLabel(event.session.label, 40),
        },
      });
    } catch (err) {
      logger.error('channel notification failed; stopping', { error: err });
      this.stopper.abort();
      throw err;
    }
    this.options.state.lastThreadId = threadId;
    logger.info('channel message delivered', { event_id: event.id, message_id: message.id });
  }

  /**
   * What to do after a failed call: the pause before trying again, or
   * undefined when the loop must stop (the session ended).
   */
  private async failed(err: unknown, interval: number): Promise<number | undefined> {
    const { logger } = this.options;
    if (err instanceof ToolInputError) {
      // callOperation's answer when the deployment doesn't serve the session operations.
      this.ended = true;
      this.stopper.abort();
      logger.error('this buildIt.Social server does not serve agent sessions yet; stopping');
      await this.options.onEnded?.('not_served');
      return undefined;
    }
    if (!(err instanceof ApiError)) {
      this.failures++;
      logger.error('channel poll failed', { error: err });
      return this.backoff(interval);
    }
    const ended: EndReason | undefined = SESSION_ENDED_CODES.has(err.code)
      ? (err.code as EndReason)
      : err.code === 'token_invalid' || err.code === 'session_token_required'
        ? err.code
        : undefined;
    if (ended !== undefined) {
      this.ended = true;
      this.stopper.abort();
      logger.warn(
        ended === 'session_token_required'
          ? 'channel mode needs a session token from "buildit-mcp connect"; stopping'
          : 'the session is no longer accepted; stopping',
        { code: err.code },
      );
      await this.options.onEnded?.(ended);
      return undefined;
    }
    this.failures++;
    if (PAUSED_CODES.has(err.code)) {
      logger.warn('the session is paused; trying again later', { code: err.code });
      return SUSPENDED_WAIT_MS;
    }
    if (isTransientFailure(err)) {
      logger.info('channel poll failed; trying again', { code: err.code });
      const asked = err.retryAfterSeconds === undefined ? 0 : err.retryAfterSeconds * 1000;
      return Math.max(asked, this.backoff(interval));
    }
    logger.warn('channel poll refused; trying again later', { code: err.code });
    return Math.max(SUSPENDED_WAIT_MS / 2, this.backoff(interval));
  }

  private backoff(interval: number): number {
    return Math.min(MAX_BACKOFF_MS, interval * 2 ** Math.min(this.failures, 6));
  }
}
