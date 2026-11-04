/**
 * Which Codex conversation a message from buildIt.Social goes to.
 *
 * The channel loop hands every event on as a channel notification
 * (`content` and `meta`, as Claude Code would get it). A router turns one
 * into a route: the place (the key of its Codex thread in the thread map)
 * and the buildIt.Social thread the answer goes back to. This version
 * routes the owner's direct messages only, all into one Codex thread (the
 * direct message is one conversation, as it is for a Claude Code
 * session); other events are dropped with a log line. Work items'
 * threads and requests get their own routes later.
 */
import type { ChannelNotificationParams } from '../channel/loop.js';

/** The place of the owner's direct message. */
export const DM_ROUTE = 'dm';

export interface Route {
  /** The Codex conversation's key in the thread map. */
  key: string;
  /** The buildIt.Social thread the message came in (the answer goes there). */
  threadId: string;
  /** The message's id. */
  messageId: string | undefined;
}

export interface CodexRouter {
  /** The route for a notification, or why it isn't routed. */
  route(n: ChannelNotificationParams): Route | { dropped: string };
}

/** Routes the owner's direct messages (a plain message.posted: no `event`) to one thread. */
export class DirectMessageRouter implements CodexRouter {
  route(n: ChannelNotificationParams): Route | { dropped: string } {
    const event = n.meta.event;
    if (event !== undefined) return { dropped: event };
    const threadId = n.meta.thread_id;
    if (threadId === undefined || threadId === '') return { dropped: 'no_thread' };
    return { key: DM_ROUTE, threadId, messageId: n.meta.message_id };
  }
}
