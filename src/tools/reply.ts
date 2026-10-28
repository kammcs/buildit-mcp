/**
 * reply: answers the session's owner in buildIt.Social (channel mode only).
 *
 * The answer is posted as the agent, labelled with the session, in the
 * agent's direct conversation with its owner, or in a work item's thread
 * (in the item's project channel) when the session works on that item: in
 * the thread named (or the item's, by key), else in the thread of the
 * latest message, mention or assignment that arrived, else as a new
 * message of the direct conversation. It is safe to retry: the
 * idempotency key is the new message's id.
 */
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { postSessionMessage } from '../channel/api.js';
import { NOT_THE_CHANNEL } from '../channel/lock.js';
import type { ChannelState } from '../channel/loop.js';
import { isUuid, resolveThread } from '../channel/threads.js';
import { ToolInputError } from '../errors.js';
import { defineTool, type ToolDefinition } from '../toolsets/registry.js';
import { IdempotencyKeyInput, itemRef, ItemRefInput } from './shared.js';

export const REPLY_MAX_CHARS = 4000;

export const ReplyInputSchema = z.object({
  text: z
    .string()
    .min(1)
    .max(REPLY_MAX_CHARS)
    .refine((s) => s.trim().length > 0, 'A reply cannot be blank.')
    .describe(
      `The answer, in Markdown, at most ${REPLY_MAX_CHARS} characters. No images. Item keys such as DEMO-12 show as live cards.`,
    ),
  thread_id: z
    .uuid()
    .optional()
    .describe(
      'The thread_id of the <channel> message you answer. Left out: the thread of the latest message, while only one thread is active; with several, give it (or item).',
    ),
  item: ItemRefInput.optional().describe(
    "A work item's key (DEMO-12), to answer in its thread: one you work on (the <channel> tag's item). Instead of thread_id.",
  ),
  reply_to_id: z
    .uuid()
    .optional()
    .describe('A message_id to quote as the one you answer, inside the thread.'),
  idempotency_key: IdempotencyKeyInput.optional(),
});

const ReplyOutputSchema = z.object({
  created: z.boolean().describe('false: an earlier call with this idempotency_key posted it.'),
  message: z.object({
    id: z.string(),
    conversation_id: z.string(),
    thread_id: z.string().nullable(),
    reply_to_id: z.string().nullable(),
    created_at: z.string(),
  }),
  idempotency_key: z.string(),
});

/** The reply tool for one channel session. */
export function createReplyTool(state: ChannelState): ToolDefinition {
  return defineTool({
    name: 'reply',
    // Not in the catalog: listed only in channel mode, whatever the toolsets.
    toolset: 'chat',
    title: 'Reply in buildIt.Social',
    description: `Answers the person who directs this session, in buildIt.Social: posts your text as the agent (labelled with this session) in its conversation with them, or in a work item's thread when the message came from one (meta item), where they read it on their computer or phone. Use it for every answer to a message that arrived as a <channel> tag: pass that tag's thread_id so the answer lands in the same thread (left out, it goes to the thread of the latest message, mention or assignment; with none yet, it starts a new message in your conversation with them). For an item assigned to you, post progress, questions and the result in its thread: pass its thread_id, or item with its key. You can post only in the threads of items you work on; everyone in the project's channel reads them. Markdown, at most ${REPLY_MAX_CHARS} characters; split longer answers. idempotency_key makes a retry return the first message instead of posting twice; one is generated and returned if you leave it out.`,
    scopes: [],
    annotations: {
      title: 'Reply in buildIt.Social',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: ReplyInputSchema,
    outputSchema: ReplyOutputSchema,
    async run(args, ctx) {
      if (!state.isChannel) throw new ToolInputError(NOT_THE_CHANNEL);
      const key = args.idempotency_key ?? randomUUID();
      const threadId = await resolveThread(state, ctx, args, 'reply');
      const r = await postSessionMessage(
        ctx.api,
        {
          id: key,
          text: args.text,
          ...(threadId === undefined ? {} : { thread_id: threadId }),
          ...(args.reply_to_id === undefined ? {} : { reply_to_id: args.reply_to_id }),
        },
        ctx.apiOptions,
      );
      state.typing?.stop(threadId);
      const m = r.message;
      const item = args.item === undefined ? undefined : itemRef(args.item).toUpperCase();
      const where = m.thread_id
        ? item !== undefined && !isUuid(item)
          ? `in the thread of ${item} (${m.thread_id})`
          : `in thread ${m.thread_id}`
        : 'as a new message';
      return {
        structured: {
          created: r.created,
          message: {
            id: m.id,
            conversation_id: m.conversation_id,
            thread_id: m.thread_id ?? null,
            reply_to_id: m.reply_to_id ?? null,
            created_at: m.created_at,
          },
          idempotency_key: key,
        },
        text: r.created
          ? `Sent ${where} (message ${m.id}).`
          : `Nothing new: this reply was already sent ${where} with this idempotency_key (message ${m.id}).`,
      };
    },
  });
}

/**
 * turn_ended: called by the plugin's Stop hook when Claude's turn ends, so
 * buildIt.Social stops showing that the agent is writing. Not for Claude.
 */
export function createTurnEndedTool(state: ChannelState): ToolDefinition {
  return defineTool({
    name: 'turn_ended',
    toolset: 'chat',
    title: 'Turn ended (plugin hook)',
    description:
      "Called by the buildit plugin's Stop hook when your turn ends; it tells buildIt.Social that the agent is no longer writing. Not for you to call: it does nothing you need.",
    scopes: [],
    runsAfterSessionEnd: true,
    annotations: {
      title: 'Turn ended (plugin hook)',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({}),
    outputSchema: z.object({ stopped: z.number().describe('Threads that were working.') }),
    async run() {
      const working = state.typing?.working.length ?? 0;
      await state.typing?.stopAll();
      // The Stop hook reads the text as its output: an empty object lets the turn end.
      return { structured: { stopped: working }, text: '{}' };
    },
  });
}
