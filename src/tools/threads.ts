/**
 * list_threads: the threads this session works in (channel mode only):
 * its direct-message threads and the work items' threads bound to it,
 * newest activity first, at most 50 (GET /v1/session/threads).
 *
 * It also refreshes which item threads are active (the set the explicit
 * thread rule counts), since the server's list is the one that knows.
 */
import { z } from 'zod';

import { listSessionThreads } from '../channel/api.js';
import { NOT_THE_CHANNEL } from '../channel/lock.js';
import type { ChannelState } from '../channel/loop.js';
import { ToolInputError } from '../errors.js';
import { defineTool, type ToolDefinition } from '../toolsets/registry.js';
import { sanitizeLabel, wrapUntrusted } from '../untrusted.js';

const ThreadOutSchema = z.object({
  thread_id: z.string(),
  conversation_id: z.string(),
  kind: z.string().describe('dm: your direct message with the person; item: a work item.'),
  item: z
    .object({
      key: z.string(),
      title: z.string().describe('People-written; flattened to one defused line.'),
      status: z.string().nullable(),
    })
    .nullable(),
  open_cards: z.number(),
  last_owner_message_at: z.string().nullable(),
});

/** The list_threads tool for one channel session. */
export function createListThreadsTool(state: ChannelState): ToolDefinition {
  return defineTool({
    name: 'list_threads',
    // Not in the catalog: listed only in channel mode, whatever the toolsets.
    toolset: 'chat',
    title: 'List the threads this session works in',
    description:
      "Lists the threads this session works in: your direct message with the person, and the work items' threads (key, title, status, open cards, when the person last wrote). Use it to name the thread for reply, ask or an approval card (thread_id, or the item's key) while you work in several, and after a restart.",
    scopes: [],
    annotations: {
      title: 'List the threads this session works in',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: z.object({}),
    outputSchema: z.object({ threads: z.array(ThreadOutSchema) }),
    async run(_args, ctx) {
      if (!state.isChannel) throw new ToolInputError(NOT_THE_CHANNEL);
      const r = await listSessionThreads(ctx.api, ctx.apiOptions);
      const threads = r.threads.map((t) => ({
        thread_id: t.thread_id,
        conversation_id: t.conversation_id,
        kind: sanitizeLabel(t.kind, 20),
        item:
          t.item === null
            ? null
            : {
                key: sanitizeLabel(t.item.key, 40),
                title: sanitizeLabel(t.item.title, 300),
                status:
                  t.item.status?.name === null || t.item.status === null
                    ? null
                    : sanitizeLabel(t.item.status.name, 60),
              },
        open_cards: t.open_cards,
        last_owner_message_at: t.last_owner_message_at,
      }));
      // The server's list is the one that knows which item threads are bound.
      state.activeItems.clear();
      for (const t of r.threads) {
        if (t.kind === 'item' && t.item !== null) state.activateItem(t.item.key, t.item.id);
      }
      const newestDm = r.threads.find((t) => t.kind === 'dm');
      if (state.lastDmThread === undefined && newestDm !== undefined) {
        state.lastDmThread = newestDm.thread_id;
      }
      if (threads.length === 0) {
        return {
          structured: { threads },
          text: 'This session works in no thread yet.',
        };
      }
      const lines = threads.map((t) => {
        const facts = [
          `thread_id ${t.thread_id}`,
          `${t.open_cards} open ${t.open_cards === 1 ? 'card' : 'cards'}`,
          `the person last wrote ${t.last_owner_message_at ?? 'never'}`,
        ].join(' · ');
        return t.item === null
          ? `your direct message · ${facts}`
          : `${t.item.key} · ${t.item.status ?? 'no status'} · ${facts} — ${t.item.title}`;
      });
      return {
        structured: { threads },
        text: [
          `This session works in ${threads.length} ${threads.length === 1 ? 'thread' : 'threads'}, newest activity first:`,
          // The titles and statuses are people-written: the lines are one block.
          wrapUntrusted(lines.join('\n'), { source: 'threads', maxChars: 40_000 }),
        ].join('\n'),
      };
    },
  });
}
