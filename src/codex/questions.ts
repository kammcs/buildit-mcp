/**
 * Codex's own questions (`item/tool/requestUserInput`, experimental: for
 * now Codex asks them only in Plan mode) as the stacked question card in
 * buildIt.Social, the same card the `ask` tool posts.
 *
 * - **The card:** Codex's 1 to 3 questions, each with its header and
 *   options (and their descriptions); the person can always type another
 *   answer, as on every question card. It goes in the thread the Codex
 *   thread's turn answers (a subagent's: its parent's), and waits as long
 *   as `ask` does. The answer is Codex's: per question, the chosen option's
 *   label or the text typed.
 * - **Never a secret:** a question Codex marks `isSecret` is never put on a
 *   card. The request is declined (no answers, which Codex reads as none
 *   given), and the bridge says why in that thread, in its own words.
 * - **What it can't show** (no options, more than 4 questions, empty
 *   texts) is declined the same way, with a log line.
 * - **Ends:** Codex resolving the request itself (`serverRequest/resolved`)
 *   closes the card and answers nothing; the item unassigned, the session's
 *   end and the bridge's stop close it and answer with no answers.
 *
 * Anything else goes to the fallback router. Nothing of the questions or
 * answers is logged.
 */
import { randomUUID } from 'node:crypto';

import { ApiError, type ApiClient } from '../api/client.js';
import { postSessionMessage } from '../channel/api.js';
import type { ChannelState } from '../channel/loop.js';
import { isItemThread } from '../channel/threads.js';
import type { Logger } from '../log.js';
import {
  ASK_NAMESPACE,
  askOnCard,
  CardNotPosted,
  parseQuestions,
  uuidV5,
  type AskOptions,
  type Question,
} from '../tools/ask.js';
import { createToolContext } from '../toolsets/registry.js';
import type { RpcNotification, RpcServerRequest, ServerRequestAnswer } from './rpc.js';
import type { ServerRequestRouter } from './server-requests.js';

/** What the bridge says when Codex asks for a secret (static text). */
export const SECRET_REFUSED =
  "Codex asked a question whose answer is secret (a password or a key, say). Secrets are never asked on a card, so it wasn't asked here, and Codex was told there is no answer. If the work needs it, set it up yourself on this computer (an environment variable or a config file), then say so here.";

const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** Codex's questions as the card's, with their ids; undefined when the card can't show them. */
export function cardQuestions(
  raw: unknown,
): { ids: string[]; questions: Question[]; secret: boolean } | undefined {
  const list = Array.isArray(raw) ? raw : [];
  const secret = list.some((q) => record(q).isSecret === true);
  const ids: string[] = [];
  const mapped: Question[] = [];
  for (const q of list) {
    const r = record(q);
    const id = str(r.id);
    if (id === undefined) return { ids, questions: [], secret };
    ids.push(id);
    const options = Array.isArray(r.options) ? r.options : [];
    mapped.push({
      question: typeof r.question === 'string' ? r.question : '',
      header: typeof r.header === 'string' && r.header.trim() !== '' ? r.header : 'Question',
      options: options.map((o) => {
        const opt = record(o);
        const description = str(opt.description);
        return {
          label: typeof opt.label === 'string' ? opt.label : '',
          ...(description === undefined ? {} : { description }),
        };
      }),
    });
  }
  if (secret) return { ids, questions: [], secret };
  const parsed = parseQuestions(mapped);
  // Two questions of the same text can't be told apart in the answer.
  if (parsed === undefined || new Set(parsed.map((q) => q.question)).size !== parsed.length) {
    return undefined;
  }
  return { ids, questions: parsed, secret };
}

/**
 * An agent message's asynchronous questions (`delivery: "async"`, each a
 * title and its options) as the card's; undefined when it has none, or the
 * card can't show them (fewer than two options, or more than four questions).
 */
export function asyncCardQuestions(item: unknown): Question[] | undefined {
  const i = record(item);
  if (i.type !== 'agentMessage' || i.delivery !== 'async' || !Array.isArray(i.questions)) {
    return undefined;
  }
  const mapped: Question[] = i.questions.map((q, n) => {
    const r = record(q);
    const options = Array.isArray(r.options) ? r.options : [];
    return {
      question: typeof r.title === 'string' ? r.title : '',
      header:
        i.questions !== undefined && (i.questions as unknown[]).length > 1
          ? `Question ${n + 1}`
          : 'Question',
      options: options
        .filter((o): o is string => typeof o === 'string')
        .map((label) => ({ label })),
    };
  });
  const parsed = parseQuestions(mapped);
  if (parsed === undefined || new Set(parsed.map((q) => q.question)).size !== parsed.length) {
    return undefined;
  }
  return parsed;
}

/** Whether an agent message carries asynchronous questions at all (shown or not). */
export function hasAsyncQuestions(item: unknown): boolean {
  const i = record(item);
  return (
    i.type === 'agentMessage' &&
    i.delivery === 'async' &&
    Array.isArray(i.questions) &&
    i.questions.length > 0
  );
}

/** The input that brings the person's answers back to Codex (its titles, their words). */
export function asyncAnswersText(answers: readonly { question: string; answer: string }[]): string {
  return [
    'The person answered your question in buildIt.Social:',
    ...answers.map((a) => `- ${a.question.replace(/\s+/g, ' ').trim()}: ${a.answer}`),
  ].join('\n');
}

export interface CodexQuestionsOptions {
  api: ApiClient;
  state: ChannelState;
  logger: Logger;
  /** Who answers everything that isn't a question. */
  fallback: ServerRequestRouter;
  /** The question card's settings (its wait, as ask's). */
  ask: AskOptions;
  /** The buildIt.Social thread a Codex thread's cards go in. */
  threadFor: (codexThreadId: string | undefined) => string | undefined;
}

interface Pending {
  codexThread: string | undefined;
  abort: AbortController;
  /** Why it was ended from outside: Codex resolved it, or its work was taken away. */
  ended?: 'resolved' | 'closed';
}

export class CodexQuestions implements ServerRequestRouter {
  private readonly pending = new Map<string, Pending>();
  private readonly runId = randomUUID();

  constructor(private readonly options: CodexQuestionsOptions) {}

  /** Codex resolved a request itself: its card closes, unanswered. */
  observe(n: RpcNotification): void {
    if (n.method !== 'serverRequest/resolved') return;
    const id = record(n.params).requestId;
    if (typeof id !== 'string' && typeof id !== 'number') return;
    const p = this.pending.get(String(id));
    if (p === undefined) return;
    p.ended = 'resolved';
    p.abort.abort();
  }

  closeAll(): void {
    for (const p of this.pending.values()) {
      p.ended ??= 'closed';
      p.abort.abort();
    }
  }

  /** A Codex thread's questions close (its work was taken away); answered with none. */
  closeThread(codexThreadId: string): number {
    let n = 0;
    for (const p of this.pending.values()) {
      if (p.codexThread !== codexThreadId) continue;
      p.ended ??= 'closed';
      p.abort.abort();
      n++;
    }
    return n;
  }

  handle(request: RpcServerRequest): Promise<ServerRequestAnswer> {
    if (request.method !== 'item/tool/requestUserInput')
      return this.options.fallback.handle(request);
    return this.ask(request);
  }

  private async ask(request: RpcServerRequest): Promise<ServerRequestAnswer> {
    const { state, logger } = this.options;
    const p = record(request.params);
    const codexThread = str(p.threadId);
    const none: ServerRequestAnswer = { result: { answers: {} } };
    const thread = this.options.threadFor(codexThread);
    const shaped = cardQuestions(p.questions);
    if (shaped?.secret === true) {
      logger.warn('codex asked for a secret; not asked on a card, declined', {
        codex_thread: codexThread,
      });
      await this.say(String(request.id), thread, SECRET_REFUSED);
      return none;
    }
    if (shaped === undefined || shaped.questions.length === 0) {
      logger.warn("codex asked questions a card can't show; declined", {
        codex_thread: codexThread,
      });
      return none;
    }
    const info = state.session;
    if (info === undefined || state.ended !== undefined || state.waiters.isEnded) return none;
    const key = String(request.id);
    const abort = new AbortController();
    const pending: Pending = { codexThread, abort };
    this.pending.set(key, pending);
    const ctx = createToolContext({
      api: this.options.api,
      logger,
      tool: 'ask',
      signal: abort.signal,
      channel: state,
    });
    const id = uuidV5(
      [
        'codex-question',
        info.session.id,
        this.runId,
        key,
        codexThread ?? '',
        str(p.itemId) ?? '',
      ].join('\n'),
      ASK_NAMESPACE,
    );
    try {
      const outcome = await askOnCard(state, ctx, this.options.ask, {
        id,
        questions: shaped.questions,
        threadId: thread,
        inItem: isItemThread(state, thread),
        waitS: this.options.ask.toolDefaultWaitS ?? this.options.ask.hookWaitS,
        started: (this.options.ask.now ?? Date.now)(),
      });
      if (pending.ended === 'resolved') {
        logger.info('codex question resolved by codex; nothing answered');
        return { none: true };
      }
      if (outcome.status !== 'answered') {
        logger.info('codex question not answered', { reason: outcome.reason });
        return none;
      }
      const answers: Record<string, { answers: string[] }> = {};
      shaped.questions.forEach((q, i) => {
        const id = shaped.ids[i];
        const a = outcome.answers[q.question];
        if (id !== undefined && a !== undefined) answers[id] = { answers: [a] };
      });
      logger.info('codex question answered', { questions: shaped.questions.length });
      return { result: { answers } };
    } catch (err) {
      logger.warn('codex question failed; answered with none', {
        code:
          err instanceof CardNotPosted && err.cause instanceof ApiError
            ? err.cause.code
            : err instanceof ApiError
              ? err.code
              : 'error',
      });
      return pending.ended === 'resolved' ? { none: true } : none;
    } finally {
      this.pending.delete(key);
    }
  }

  /**
   * Codex's asynchronous questions (an agent message with `delivery:
   * "async"` and `questions`, as Codex 0.166 asks in plan mode): the same
   * card, in `thread`. The turn doesn't wait for them; the answers (by
   * question) come back for the conversation's next input. Undefined when
   * nobody answered, or the card closed.
   */
  async askAsync(
    key: string,
    codexThread: string | undefined,
    thread: string | undefined,
    questions: readonly Question[],
  ): Promise<{ question: string; answer: string }[] | undefined> {
    const { state, logger } = this.options;
    const info = state.session;
    if (info === undefined || state.ended !== undefined || state.waiters.isEnded) return undefined;
    const abort = new AbortController();
    const pending: Pending = { codexThread, abort };
    this.pending.set(key, pending);
    const ctx = createToolContext({
      api: this.options.api,
      logger,
      tool: 'ask',
      signal: abort.signal,
      channel: state,
    });
    try {
      const outcome = await askOnCard(state, ctx, this.options.ask, {
        id: uuidV5(
          ['codex-async-question', info.session.id, this.runId, key].join('\n'),
          ASK_NAMESPACE,
        ),
        questions,
        threadId: thread,
        inItem: isItemThread(state, thread),
        waitS: this.options.ask.toolDefaultWaitS ?? this.options.ask.hookWaitS,
        started: (this.options.ask.now ?? Date.now)(),
      });
      if (outcome.status !== 'answered') {
        logger.info("codex's async question not answered", { reason: outcome.reason });
        return undefined;
      }
      logger.info("codex's async question answered", { questions: questions.length });
      return questions.flatMap((q) => {
        const answer = outcome.answers[q.question];
        return answer === undefined ? [] : [{ question: q.question, answer }];
      });
    } catch (err) {
      logger.warn("codex's async question failed", {
        code:
          err instanceof CardNotPosted && err.cause instanceof ApiError
            ? err.cause.code
            : err instanceof ApiError
              ? err.code
              : 'error',
      });
      return undefined;
    } finally {
      this.pending.delete(key);
    }
  }

  /** A line of the bridge's own in the thread (best effort). */
  private async say(key: string, thread: string | undefined, text: string): Promise<void> {
    const session = this.options.state.session?.session.id ?? 'session';
    try {
      await postSessionMessage(
        this.options.api,
        {
          id: uuidV5(['codex-question-note', session, this.runId, key].join('\n'), ASK_NAMESPACE),
          text,
          ...(thread === undefined ? {} : { thread_id: thread }),
        },
        { tool: 'reply', signal: AbortSignal.timeout(30_000) },
      );
    } catch (err) {
      this.options.logger.info('codex question note not posted', {
        code: err instanceof ApiError ? err.code : 'error',
      });
    }
  }
}
