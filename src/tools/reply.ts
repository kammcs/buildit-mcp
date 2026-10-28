/**
 * reply: answers the session's owner in buildIt.Social (channel mode only).
 *
 * The answer is posted as the agent, labelled with the session, in the
 * agent's direct conversation with its owner: in the thread named, else in
 * the thread of the latest message that arrived, else as a new message.
 * It is safe to retry: the idempotency key is the new message's id.
 */
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { postSessionMessage } from '../channel/api.js';
import type { ChannelState } from '../channel/loop.js';
import { defineTool, type ToolDefinition } from '../toolsets/registry.js';
import { IdempotencyKeyInput } from './shared.js';

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
      'The thread_id of the <channel> message you answer. Left out: the thread of the latest message.',
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
    description: `Answers the person who directs this session, in buildIt.Social: posts your text as the agent (labelled with this session) in its conversation with them, where they read it on their computer or phone. Use it for every answer to a message that arrived as a <channel> tag: pass that tag's thread_id so the answer lands in the same thread (left out, it goes to the thread of the latest message; with no message yet, it starts a new one). Markdown, at most ${REPLY_MAX_CHARS} characters; split longer answers. idempotency_key makes a retry return the first message instead of posting twice; one is generated and returned if you leave it out.`,
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
      const key = args.idempotency_key ?? randomUUID();
      const threadId = args.thread_id ?? state.lastThreadId;
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
      const m = r.message;
      const where = m.thread_id ? `in thread ${m.thread_id}` : 'as a new message';
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
