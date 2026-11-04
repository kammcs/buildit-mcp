/**
 * Which Codex conversation an event from buildIt.Social goes to, decided
 * in code (a Claude Code session's lead decides it in its instructions).
 *
 * The channel loop hands every event on as a channel notification
 * (`content` and `meta`, as Claude Code would get it). A route names the
 * place (the conversation's key in the thread map), what kind of place it
 * is, and the buildIt.Social thread the answer goes back to:
 *
 * - **the direct message** (`dm`): the owner's messages there (no
 *   `event`), all in one conversation;
 * - **a work item** (`item:<id>`), with its own Codex thread in its own
 *   worktree: `item_assigned` (a handed subtask, `handoff="true"`, too);
 *   `mention` and `message` in its thread. An event in the thread of an
 *   item under one the session works on (a story, task, bug or subtask of
 *   an assigned epic or story; `get_item` names the parents, read once per
 *   item) goes to that ancestor's conversation instead, as the plugin's
 *   lead sends it to that item's worker; with no ancestor working, the item
 *   gets its own;
 * - **the work's own events:** `child_done` and `handoff_resolved` go to the
 *   parent item's conversation (a new one when none works on it);
 *   `assignment_resolved`, `assigned_item_done` and `plan_resolved` to the
 *   conversation of the item whose thread the card is in, else the direct
 *   message's (a plan card a request posted outside an item's thread: only
 *   when the plan failed or went stale, so the owner hears of it);
 * - **a request** (`request:<id>`): its own conversation, which ends with
 *   its turn;
 * - **stop:** `item_unassigned` stops the item's own conversation (or, for
 *   an item under one, tells that ancestor's).
 *
 * Anything else is dropped with a log line.
 */
import type { ChannelNotificationParams } from '../channel/loop.js';

/** The place of the owner's direct message. */
export const DM_ROUTE = 'dm';

/** A work item's place. */
export const itemPlace = (id: string): string => `item:${id.toLowerCase()}`;

/** A request's place. */
export const requestPlace = (id: string): string => `request:${id.toLowerCase()}`;

/** What kind of conversation a place is. */
export type PlaceInfo =
  | { kind: 'dm' }
  | { kind: 'item'; item: { key: string; id: string } }
  | { kind: 'request'; requestId: string; requestKind: string; result: string };

export interface Route {
  /** The Codex conversation's key in the thread map. */
  key: string;
  place: PlaceInfo;
  /** The buildIt.Social thread the answer goes back to (none: a request's, which posts by its tools). */
  threadId: string | undefined;
  /** The message's id. */
  messageId: string | undefined;
  /** The event (undefined: a direct message). */
  event: string | undefined;
}

/** item_unassigned: the item's own conversation stops; an ancestor's is told. */
export interface Stop {
  stop: { key: string; id: string };
  /** The conversation to stop (the item's own), when it has one. */
  own: string | undefined;
  /** An ancestor's conversation to tell, when the item had none of its own. */
  tell: Route | undefined;
}

export type Routed = Route | Stop | { dropped: string };

/** What the router needs to know of the bridge's conversations and the items. */
export interface RouterHost {
  /** Whether a place has a conversation now (one being opened, or queued, counts). */
  has(key: string): boolean;
  /** An item's parent (id and key), null for none; undefined when it can't be read. */
  parentOf(itemId: string): Promise<{ id: string; key: string } | null | undefined>;
  /** Whether a thread is a work item's (its id is the item's). */
  isItemThread(threadId: string): boolean;
}

/** The interface the bridge takes (tests give their own). */
export interface CodexRouter {
  route(n: ChannelNotificationParams): Promise<Routed>;
}

/** How far up the parents are looked at (subtask, story, epic). */
const ANCESTORS_MAX = 3;

/** Plan outcomes the owner hears of even when no item's conversation posted the card. */
const PLAN_TROUBLE: ReadonlySet<string> = new Set(['failed', 'stale']);

const nonEmpty = (v: string | undefined): string | undefined =>
  v === undefined || v === '' ? undefined : v;

export class SessionRouter implements CodexRouter {
  constructor(private readonly host: RouterHost) {}

  async route(n: ChannelNotificationParams): Promise<Routed> {
    const m = n.meta;
    const event = nonEmpty(m.event);
    const threadId = nonEmpty(m.thread_id);
    const messageId = nonEmpty(m.message_id);
    if (event === undefined) {
      if (threadId === undefined) return { dropped: 'no_thread' };
      return { key: DM_ROUTE, place: { kind: 'dm' }, threadId, messageId, event };
    }
    const toDm = (thread: string | undefined): Route => ({
      key: DM_ROUTE,
      place: { kind: 'dm' },
      threadId: thread,
      messageId,
      event,
    });
    switch (event) {
      case 'item_assigned': {
        const key = nonEmpty(m.item);
        if (threadId === undefined || key === undefined) return { dropped: 'item_shape' };
        const item = { key, id: threadId };
        return {
          key: itemPlace(threadId),
          place: { kind: 'item', item },
          threadId,
          messageId,
          event,
        };
      }
      case 'mention':
      case 'message':
      case 'child_done': {
        const key = nonEmpty(m.item);
        if (threadId === undefined || key === undefined) return { dropped: 'item_shape' };
        const place = await this.itemConversation({ key, id: threadId }, true);
        if (place === undefined) return { dropped: 'item_shape' };
        return { ...place, threadId, messageId, event };
      }
      case 'handoff_resolved': {
        if (threadId === undefined) return { dropped: 'item_shape' };
        const parent = nonEmpty(m.parent);
        // The parent known: its thread. Else the card's (the subtask's): its parent is looked up.
        const place = await this.itemConversation(
          { key: parent ?? '', id: threadId },
          parent !== undefined,
        );
        return place === undefined ? toDm(undefined) : { ...place, threadId, messageId, event };
      }
      case 'assignment_resolved':
      case 'assigned_item_done': {
        if (threadId === undefined || !this.host.isItemThread(threadId)) return toDm(threadId);
        const place = await this.itemConversation({ key: '', id: threadId }, false);
        return place === undefined ? toDm(undefined) : { ...place, threadId, messageId, event };
      }
      case 'plan_resolved': {
        if (threadId === undefined) return { dropped: 'plan_no_thread' };
        const inItem = this.host.isItemThread(threadId);
        if (inItem) {
          const place = await this.itemConversation({ key: '', id: threadId }, false);
          if (place !== undefined) return { ...place, threadId, messageId, event };
        } else if (this.host.has(DM_ROUTE)) {
          // A card the direct message's conversation posted, in its thread.
          return toDm(threadId);
        }
        // A card no conversation works on now (a request's, say): only trouble is told, in the DM.
        return PLAN_TROUBLE.has(m.outcome ?? '')
          ? toDm(undefined)
          : { dropped: 'plan_resolved_no_conversation' };
      }
      case 'item_unassigned': {
        const key = nonEmpty(m.item);
        if (threadId === undefined || key === undefined) return { dropped: 'item_shape' };
        const item = { key, id: threadId };
        const own = itemPlace(threadId);
        if (this.host.has(own)) return { stop: item, own, tell: undefined };
        const above = await this.ancestorConversation(threadId);
        return {
          stop: item,
          own: undefined,
          tell: above === undefined ? undefined : { ...above, threadId, messageId, event },
        };
      }
      case 'request': {
        const requestId = nonEmpty(m.request_id);
        const kind = nonEmpty(m.kind);
        if (requestId === undefined || kind === undefined) return { dropped: 'request_shape' };
        return {
          key: requestPlace(requestId),
          place: { kind: 'request', requestId, requestKind: kind, result: m.result ?? 'dm' },
          threadId: undefined,
          messageId,
          event,
        };
      }
      default:
        return { dropped: event };
    }
  }

  /**
   * The conversation an item's event goes to: the item's own, else the
   * nearest ancestor's that has one, else (`create`) a new one of its own.
   */
  private async itemConversation(
    item: { key: string; id: string },
    create: boolean,
  ): Promise<Pick<Route, 'key' | 'place'> | undefined> {
    const own = itemPlace(item.id);
    if (this.host.has(own)) return { key: own, place: { kind: 'item', item } };
    const above = await this.ancestorConversation(item.id);
    if (above !== undefined) return above;
    if (!create || item.key === '') return undefined;
    return { key: own, place: { kind: 'item', item } };
  }

  /** The nearest ancestor of an item with a conversation. */
  private async ancestorConversation(
    itemId: string,
  ): Promise<Pick<Route, 'key' | 'place'> | undefined> {
    let id = itemId;
    for (let depth = 0; depth < ANCESTORS_MAX; depth++) {
      const parent = await this.host.parentOf(id);
      if (parent === null || parent === undefined) return undefined;
      const key = itemPlace(parent.id);
      if (this.host.has(key)) {
        return { key, place: { kind: 'item', item: { key: parent.key, id: parent.id } } };
      }
      id = parent.id;
    }
    return undefined;
  }
}
