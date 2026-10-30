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
import { rm } from 'node:fs/promises';

import { z } from 'zod';

import { postSessionMessage } from '../channel/api.js';
import { FILES_API, FILES_OPERATIONS, filesServed } from '../channel/attachments.js';
import { checkFiles, prepareFiles, REPLY_MAX_FILES, shareFiles } from '../channel/upload.js';
import { NOT_THE_CHANNEL } from '../channel/lock.js';
import type { ChannelState } from '../channel/loop.js';
import { isUuid, resolveThread } from '../channel/threads.js';
import { ToolInputError } from '../errors.js';
import { defineTool, type ToolDefinition } from '../toolsets/registry.js';
import { sanitizeLabel } from '../untrusted.js';
import { IdempotencyKeyInput, itemRef, ItemRefInput } from './shared.js';

export const REPLY_MAX_CHARS = 4000;

const TextInput = z
  .string()
  .min(1)
  .max(REPLY_MAX_CHARS)
  .refine((s) => s.trim().length > 0, 'A reply cannot be blank.');

const ThreadInput = z
  .uuid()
  .optional()
  .describe(
    'The thread_id of the <channel> message you answer. Left out: the thread of the latest message, while only one thread is active; with several, give it (or item).',
  );

const ItemInput = ItemRefInput.optional().describe(
  "A work item's key (DEMO-12), to answer in its thread: one you work on (the <channel> tag's item). Instead of thread_id.",
);

const ReplyToInput = z
  .uuid()
  .optional()
  .describe('A message_id to quote as the one you answer, inside the thread.');

/**
 * reply on a server older than 1.11.0: loose, so a call that still passes
 * `files` (from a tool list read before the server's version was known)
 * reaches run and is refused, instead of the files being dropped silently.
 */
export const ReplyInputSchema = z.looseObject({
  text: TextInput.describe(
    `The answer, in Markdown, at most ${REPLY_MAX_CHARS} characters. No images. Item keys such as DEMO-12 show as live cards.`,
  ),
  thread_id: ThreadInput,
  item: ItemInput,
  reply_to_id: ReplyToInput,
  idempotency_key: IdempotencyKeyInput.optional(),
});

/** reply on a server that serves files: `files`, and text optional with them. */
export const ReplyWithFilesInputSchema = z.object({
  text: TextInput.optional().describe(
    `The answer, in Markdown, at most ${REPLY_MAX_CHARS} characters. Item keys such as DEMO-12 show as live cards. May be left out when files are sent.`,
  ),
  files: z
    .array(z.string().min(1).max(4096))
    .min(1)
    .max(REPLY_MAX_FILES)
    .optional()
    .describe(
      `Local files to post with the answer (1 to ${REPLY_MAX_FILES} paths; give absolute ones: a relative path is read from the project folder, not from a worktree): images, videos, logs, documents, archives. Only files inside the project folder or the temp folder. Never credentials, keys, .env files or private files.`,
    ),
  thread_id: ThreadInput,
  item: ItemInput,
  reply_to_id: ReplyToInput,
  idempotency_key: IdempotencyKeyInput.optional(),
});

const MessageOutput = z.object({
  id: z.string(),
  conversation_id: z.string(),
  thread_id: z.string().nullable(),
  reply_to_id: z.string().nullable(),
  created_at: z.string(),
});

const ReplyOutputSchema = z.object({
  created: z.boolean().describe('false: an earlier call with this idempotency_key posted it.'),
  message: MessageOutput,
  idempotency_key: z.string(),
});

const ReplyWithFilesOutputSchema = ReplyOutputSchema.extend({
  messages: z
    .array(MessageOutput)
    .optional()
    .describe(
      'Every message posted, in order (several when files were sent); message is the first.',
    ),
  files: z
    .array(
      z.object({
        path: z.string(),
        name: z.string(),
        upload_id: z.string(),
        location_removed: z.boolean(),
      }),
    )
    .optional()
    .describe('The files posted, as given, with the name readers see.'),
});

const BASE_DESCRIPTION = `Answers the person who directs this session, in buildIt.Social: posts your text as the agent (labelled with this session) in its conversation with them, or in a work item's thread when the message came from one (meta item), where they read it on their computer or phone. Use it for every answer to a message that arrived as a <channel> tag: pass that tag's thread_id so the answer lands in the same thread (left out, it goes to the thread of the latest message, mention or assignment; with none yet, it starts a new message in your conversation with them). For an item assigned to you, post progress, questions and the result in its thread: pass its thread_id, or item with its key. You can post only in the threads of items you work on; everyone in the project's channel reads them. Markdown, at most ${REPLY_MAX_CHARS} characters; split longer answers. idempotency_key makes a retry return the first message instead of posting twice; one is generated and returned if you leave it out.`;

const FILES_DESCRIPTION = ` To share files (a render, a screenshot, a log, a document), pass their local paths in files: they are posted at once in the same thread, with the text, and everyone who reads the thread can open them. Before anything is uploaded, every file is checked: it must be inside the project folder or the temp folder, not a secret store (.env files, keys, certificates, .ssh and the like), not a program, within the size limit (250 MiB for a video, 100 MiB for anything else), and a text file must not hold anything that looks like a credential. Location is removed from photos and videos. One refused file sends nothing, and the error says why: fix it and send the reply again. Share only files the person asked for or that your work needs.`;

/** The refusal of files on a server that doesn't take them: nothing is sent. */
const TOO_OLD_FOR_FILES = `Not sent: this buildIt.Social server is older than agent API ${FILES_API}; files can't be sent. Nothing was posted. Send the text alone, and describe the file (or where it is) instead.`;

function messageOut(m: {
  id: string;
  conversation_id: string;
  thread_id?: string | null | undefined;
  reply_to_id?: string | null | undefined;
  created_at: string;
}) {
  return {
    id: m.id,
    conversation_id: m.conversation_id,
    thread_id: m.thread_id ?? null,
    reply_to_id: m.reply_to_id ?? null,
    created_at: m.created_at,
  };
}

function whereOf(m: { thread_id?: string | null | undefined }, item: string | undefined): string {
  return m.thread_id
    ? item !== undefined && !isUuid(item)
      ? `in the thread of ${item} (${m.thread_id})`
      : `in thread ${m.thread_id}`
    : 'as a new message';
}

/**
 * The reply tool for one channel session. With `files` (a server that
 * serves them, 1.11.0 and newer), it also posts local files; without, it
 * is the text-only reply older servers take.
 */
export function createReplyTool(
  state: ChannelState,
  options: { files: boolean } = { files: false },
): ToolDefinition {
  const annotations = {
    title: 'Reply in buildIt.Social',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  };
  if (!options.files) {
    return defineTool({
      name: 'reply',
      // Not in the catalog: listed only in channel mode, whatever the toolsets.
      toolset: 'chat',
      title: 'Reply in buildIt.Social',
      description: BASE_DESCRIPTION,
      scopes: [],
      // Listed only for a server known not to serve files (the other reply is the default).
      listedUnlessOperations: FILES_OPERATIONS,
      annotations,
      inputSchema: ReplyInputSchema,
      outputSchema: ReplyOutputSchema,
      async run(args, ctx) {
        if (!state.isChannel) throw new ToolInputError(NOT_THE_CHANNEL);
        if ('files' in args && args.files !== undefined && args.files !== null) {
          throw new ToolInputError(TOO_OLD_FOR_FILES);
        }
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
        const where = whereOf(m, item);
        return {
          structured: { created: r.created, message: messageOut(m), idempotency_key: key },
          text: r.created
            ? `Sent ${where} (message ${m.id}).`
            : `Nothing new: this reply was already sent ${where} with this idempotency_key (message ${m.id}).`,
        };
      },
    });
  }
  return defineTool({
    name: 'reply',
    toolset: 'chat',
    title: 'Reply in buildIt.Social',
    description: BASE_DESCRIPTION + FILES_DESCRIPTION,
    scopes: [],
    requiresOperations: FILES_OPERATIONS,
    annotations,
    inputSchema: ReplyWithFilesInputSchema,
    outputSchema: ReplyWithFilesOutputSchema,
    async run(args, ctx) {
      if (!state.isChannel) throw new ToolInputError(NOT_THE_CHANNEL);
      const files = args.files ?? [];
      if (args.text === undefined && files.length === 0) {
        throw new ToolInputError('Give text, files, or both.');
      }
      if (files.length > 0 && filesServed(ctx.api) === false) {
        throw new ToolInputError(TOO_OLD_FOR_FILES);
      }
      const key = args.idempotency_key ?? randomUUID();
      const threadId = await resolveThread(state, ctx, args, 'reply');
      const item = args.item === undefined ? undefined : itemRef(args.item).toUpperCase();
      const base = {
        ...(args.text === undefined ? {} : { text: args.text }),
        ...(args.reply_to_id === undefined ? {} : { reply_to_id: args.reply_to_id }),
      };
      if (files.length === 0) {
        const r = await postSessionMessage(
          ctx.api,
          {
            id: key,
            text: args.text ?? '',
            ...base,
            ...(threadId === undefined ? {} : { thread_id: threadId }),
          },
          ctx.apiOptions,
        );
        state.typing?.stop(threadId);
        const m = r.message;
        const where = whereOf(m, item);
        return {
          structured: { created: r.created, message: messageOut(m), idempotency_key: key },
          text: r.created
            ? `Sent ${where} (message ${m.id}).`
            : `Nothing new: this reply was already sent ${where} with this idempotency_key (message ${m.id}).`,
        };
      }
      const session = state.session;
      if (session === undefined) {
        throw new ToolInputError(
          'The buildIt.Social session is still starting; try again in a few seconds.',
        );
      }
      const folder = state.folder ?? process.cwd();
      // 1 and 2: every check before any network call, then the location removed.
      const checked = await checkFiles(files, folder, ctx.signal);
      const prepared = await prepareFiles(checked, { signal: ctx.signal });
      try {
        const { response: r, ids } = await shareFiles(prepared.files, base, {
          api: ctx.api,
          apiOptions: ctx.apiOptions,
          sessionId: session.session.id,
          owner: sanitizeLabel(session.owner.name, 64),
          key,
          threadId,
          signal: ctx.signal,
          progress: ctx.progress,
        });
        state.typing?.stop(threadId);
        const m = r.message;
        const messages = (r.messages ?? [m]).map(messageOut);
        const where = whereOf(m, item);
        const n = prepared.files.length;
        const posted = `${n} ${n === 1 ? 'file' : 'files'}`;
        return {
          structured: {
            created: r.created,
            message: messageOut(m),
            messages,
            files: prepared.files.map((f, i) => ({
              path: f.given,
              name: f.name,
              upload_id: ids[i] ?? '',
              location_removed: f.stripped,
            })),
            idempotency_key: key,
          },
          text: r.created
            ? `Posted ${posted} ${where} (${messages.length === 1 ? `message ${m.id}` : `messages ${messages.map((x) => x.id).join(', ')}`}).`
            : `Nothing new: this reply and its ${posted} were already posted ${where} with this idempotency_key (message ${m.id}).`,
        };
      } finally {
        if (prepared.temp !== undefined) {
          await rm(prepared.temp, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    },
  });
}

/**
 * turn_ended: called by the plugin's Stop hook when Claude's turn ends, so
 * buildIt.Social stops showing that the agent is writing, and the main
 * agent's tool approvals still open (the person answered "No" in the
 * terminal, so the turn went on) close as no longer needed. Not for Claude.
 */
export function createTurnEndedTool(state: ChannelState): ToolDefinition {
  return defineTool({
    name: 'turn_ended',
    toolset: 'chat',
    title: 'Turn ended (plugin hook)',
    description:
      "Called by the buildit plugin's Stop hook when your turn ends; it tells buildIt.Social that the agent is no longer writing, and closes your tool approvals that no longer need an answer. Not for you to call: it does nothing you need.",
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
      // The main agent's open tool approvals are no longer needed.
      state.approvals?.agentDone('');
      await state.typing?.stopAll();
      // The Stop hook reads the text as its output: an empty object lets the turn end.
      return { structured: { stopped: working }, text: '{}' };
    },
  });
}
