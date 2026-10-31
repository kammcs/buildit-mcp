/**
 * Which thread a channel tool (reply, ask, an approval card) posts in.
 *
 * A thread named by `thread_id`, or a work item's by `item` (its key: its
 * id comes from the items the events named, else from get_item; the
 * item's id is its thread's). Without either, the thread of the latest
 * message, mention or assignment, but only while one thread is active:
 * once the session works in several (an item's thread besides the direct
 * message, or two items; the lead's item workers post in parallel through
 * this one server), "the latest" could be another worker's, so a thread
 * must be named, and the refusal lists the active ones.
 */
import { ToolInputError } from '../errors.js';
import type { ToolContext } from '../toolsets/registry.js';
import { sanitizeLabel } from '../untrusted.js';
import type { ChannelState, KnownRequest } from './loop.js';

const UUID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

export const isUuid = (s: string): boolean => UUID_RE.test(s);

/** An item reference as the tools take it (a leading # is fine). */
const keyOf = (ref: string): string => (ref.startsWith('#') ? ref.slice(1) : ref);

/** An item's thread id: its own id, from the events' items or read with get_item. */
export async function itemThreadId(ref: string, ctx: ToolContext): Promise<string> {
  const key = keyOf(ref);
  if (isUuid(key)) return key;
  const known = ctx.channel?.items.get(key.toUpperCase());
  if (known !== undefined) return known;
  const { item } = await ctx.call('get_item', { path: { key } });
  ctx.channel?.rememberItem(item.key, item.id);
  return item.id;
}

/**
 * Whether a thread is a work item's (its id is the item's): one of the
 * items the session works in, an item the events or get_item named, or the
 * latest message's item. Anything else (none: a new message) is the direct
 * message's.
 */
export function isItemThread(state: ChannelState, threadId: string | undefined): boolean {
  if (threadId === undefined) return false;
  const id = threadId.toLowerCase();
  const same = (other: string | undefined): boolean => other?.toLowerCase() === id;
  if (same(state.last?.item?.id)) return true;
  for (const active of state.activeItems.keys()) if (same(active)) return true;
  for (const known of state.items.values()) if (same(known)) return true;
  return false;
}

/**
 * The direct message's latest thread, when there is one and it is not an
 * item's (undefined: a new message of the direct message). Never an item's
 * thread: what `dm: true` posts is private to the person.
 */
export function dmThread(state: ChannelState): string | undefined {
  const t = state.lastDmThread;
  return t !== undefined && !isItemThread(state, t) ? t : undefined;
}

/** The refusal of `dm: true` with a thread or an item named. */
export const DM_AND_THREAD =
  'Give dm: true, or thread_id or item, not both: dm: true posts in your direct message with the person.';

/** The refusal when several threads are active and none was named. */
export function threadRequiredMessage(state: ChannelState, tool: string, how: string): string {
  const listed = state
    .activeThreads()
    .map((t) =>
      t.item === undefined
        ? `your direct message (thread_id ${t.thread_id})`
        : `${sanitizeLabel(t.item, 40)} (thread_id ${t.thread_id})`,
    );
  return `This session works in several threads now, so ${tool} needs ${how}: ${listed.join('; ')}. Name the thread of the message or item you are working on (list_threads shows them all).`;
}

/**
 * The thread to post in: `item`'s, `thread_id`, else the latest one while
 * only one thread is active (undefined: none yet, a new message of the
 * direct message). Throws ToolInputError for a conflict, or when several
 * threads are active and none is named.
 */
export async function resolveThread(
  state: ChannelState,
  ctx: ToolContext,
  given: { thread_id?: string | undefined; item?: string | undefined },
  tool: string,
  how = 'thread_id or item',
): Promise<string | undefined> {
  const fromItem = given.item === undefined ? undefined : await itemThreadId(given.item, ctx);
  if (
    fromItem !== undefined &&
    given.thread_id !== undefined &&
    given.thread_id.toLowerCase() !== fromItem.toLowerCase()
  ) {
    throw new ToolInputError(
      "Give item or thread_id, not both: item's thread is the item's own id, and this thread_id is another thread.",
    );
  }
  const named = fromItem ?? given.thread_id;
  if (named !== undefined) return named;
  if (state.activeThreads().length > 1) {
    throw new ToolInputError(threadRequiredMessage(state, tool, how));
  }
  return state.lastThreadId;
}

/** A request's place in words, for refusals. */
function placeWords(known: KnownRequest): string {
  if (known.place === 'thread')
    return `the thread it was made in (thread_id ${known.thread ?? '?'})`;
  const items = (known.items ?? []).map((i) => i.key);
  return items.length === 1
    ? `the thread of ${items[0] ?? '?'}`
    : `the threads of its items (${items.join(', ')}), each item's result in its own`;
}

/** The refusal of a request's post outside its place, before any call. */
export function outsidePlace(known: KnownRequest): string {
  return `Not posted (request_result_private): this request's result goes only to ${placeWords(known)}. Post it there with the same request, or leave thread_id, item and card_thread out to use that place.`;
}

/**
 * The thread a post for a request goes to (reply, a propose_* card,
 * ask_reporter), when this session knows the request and its result goes
 * to a thread or an item's thread: the place named, which must be one of
 * the request's, or the only one it has. Undefined when the request is
 * unknown here (a restart forgets them) or its result is the direct
 * message's: the caller's own rules apply, and the server checks again.
 * Throws ToolInputError for a place outside the request's, or when it has
 * several (triage on several items) and none is named.
 */
export function requestThread(
  state: ChannelState,
  request: string,
  given: { thread_id?: string | undefined; item?: string | undefined },
): { known: KnownRequest; threadId: string } | undefined {
  const known = state.requests.get(request.toLowerCase());
  if (known === undefined || known.place === 'dm') return undefined;
  if (known.place === 'thread') {
    const thread = known.thread;
    if (thread === undefined) return undefined;
    if (given.item !== undefined) throw new ToolInputError(outsidePlace(known));
    if (given.thread_id !== undefined && given.thread_id.toLowerCase() !== thread.toLowerCase()) {
      throw new ToolInputError(outsidePlace(known));
    }
    return { known, threadId: thread };
  }
  const items = known.items ?? [];
  const byItem =
    given.item === undefined
      ? undefined
      : items.find((i) =>
          isUuid(keyOf(given.item ?? ''))
            ? i.id.toLowerCase() === keyOf(given.item ?? '').toLowerCase()
            : i.key === keyOf(given.item ?? '').toUpperCase(),
        );
  if (given.item !== undefined && byItem === undefined)
    throw new ToolInputError(outsidePlace(known));
  const byThread =
    given.thread_id === undefined
      ? undefined
      : items.find((i) => i.id.toLowerCase() === given.thread_id?.toLowerCase());
  if (given.thread_id !== undefined && byThread === undefined) {
    throw new ToolInputError(outsidePlace(known));
  }
  if (byItem !== undefined && byThread !== undefined && byItem.id !== byThread.id) {
    throw new ToolInputError(
      "Give item or thread_id, not both: item's thread is the item's own id, and this thread_id is another thread.",
    );
  }
  const chosen = byItem ?? byThread ?? (items.length === 1 ? items[0] : undefined);
  if (chosen === undefined) {
    throw new ToolInputError(
      `This request is about several items (${items.map((i) => i.key).join(', ')}): name the one this post is for (item or card_thread set to its key). Each item's result goes in its own thread.`,
    );
  }
  return { known, threadId: chosen.id };
}
