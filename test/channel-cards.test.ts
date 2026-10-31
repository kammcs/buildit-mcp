/**
 * Channel mode's cards, end to end in process: ask (from Claude and from
 * the plugin's hook), the plan cards, and "is writing", against the fake
 * API's sessions playing the person.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { CallToolResult } from '@modelcontextprotocol/client';

import { NOT_THE_CHANNEL } from '../src/channel/lock.js';
import { uuidV5 } from '../src/tools/ask.js';
import { CARD_STEP, cardFailedStep } from '../src/tools/plans.js';
import {
  channelConfig,
  channelNotes,
  startChannel,
  waitFor,
  type ChannelClient,
} from './support/channel-harness.js';
import { FakeApi } from './support/fake-api.js';
import { demoItem, SESSION_IDS, SESSION_TOKENS } from './support/fake-sessions.js';
import { HOSTILE, injectionIsInsideBlocks } from './support/harness.js';

const TOKEN = SESSION_TOKENS.first;

let api: FakeApi;
const stops: (() => Promise<void>)[] = [];

beforeAll(async () => {
  api = await new FakeApi().start();
});
afterAll(async () => {
  await api.close();
});
beforeEach(() => {
  api.reset();
});
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
  expect(api.violations).toEqual([]);
});

const color = {
  question: 'Which color?',
  header: 'Color',
  options: [{ label: 'Blue', description: 'The default.' }, { label: 'Green' }],
};
const targets = {
  question: 'Which targets?',
  header: 'Targets',
  options: [{ label: 'Windows' }, { label: 'macOS' }, { label: 'Linux' }],
  multiSelect: true,
};

const session = () => api.sessions.session(TOKEN);
const textOf = (r: CallToolResult): string =>
  (r.content as { type: string; text: string }[]).map((c) => c.text).join('\n');

interface HookOut {
  hookEventName: string;
  permissionDecision: string;
  permissionDecisionReason?: string;
  updatedInput?: { questions: unknown; answers: Record<string, string> };
}
/** The hook's output in a result's text. */
const hookOut = (r: CallToolResult): HookOut =>
  (JSON.parse(textOf(r)) as { hookSpecificOutput: HookOut }).hookSpecificOutput;

/** A channel server whose ask waits `msPerSecond` ms per second (so 600 s is short). */
async function start(
  options: {
    env?: Record<string, string>;
    msPerSecond?: number;
    owner?: boolean;
    typing?: { everyMs?: number; idleMs?: number };
  } = {},
): Promise<ChannelClient> {
  return startChannel(api, stops, {
    config: channelConfig(api, options.env),
    stdio: {
      ask: { msPerSecond: options.msPerSecond ?? 10 },
      ...(options.owner === undefined ? {} : { channelOwner: options.owner }),
      typing: options.typing ?? { everyMs: 60_000 },
    },
  });
}

/** Waits for the session to be loaded (the first poll). */
async function ready(): Promise<void> {
  await waitFor(() => session().heartbeats.includes('online'));
}

/** Calls ask the way the plugin's hook does: the questions as JSON text. */
function hookAsk(c: ChannelClient, questions: unknown[], toolUseId = 'toolu_test_1') {
  return c.client.callTool({
    name: 'ask',
    arguments: {
      questions: JSON.stringify(questions),
      tool_use_id: toolUseId,
      session_id: 'claude-session-1',
      format: 'hook',
    },
  });
}

async function cardOf(id: string) {
  await waitFor(() => session().cards.has(id));
  return session().cards.get(id)!;
}

describe('ask from the hook', () => {
  it('posts one form in the latest thread, and allows AskUserQuestion with the answer', async () => {
    api.sessions.open(TOKEN);
    const c = await start();
    await ready();
    const root = api.sessions.postFrom(TOKEN, 'Set up the project.');
    await waitFor(() => channelNotes(c.notes).length === 1);
    const pending = hookAsk(c, [color]);
    const id = uuidV5('toolu_test_1');
    const card = await cardOf(id);
    expect(card.threadId).toBe(root);
    const message = api.sessions.message(TOKEN, id)!;
    expect(message.text).toBe('Claude asks: Which color?');
    expect((message.card!.inputs as { id: string }[]).map((i) => i.id)).toEqual(['q1', 'q1_other']);
    expect(message.card!.actions).toEqual([{ type: 'submit', label: 'Send' }]);
    api.sessions.answerCard(TOKEN, id, { inputs: { q1: 'o2' } });
    const r = await pending;
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(textOf(r))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { questions: [color], answers: { 'Which color?': 'Green' } },
      },
    });
    // Accepted, which closed the card; no second close, and the card never changed.
    expect(card.responses[0]?.status).toBe('accepted');
    expect(card.closedBy).toBe('app');
    expect(card.updates).toEqual([]);
  });

  it('takes a typed Other answer, its lines kept', async () => {
    api.sessions.open(TOKEN);
    const c = await start();
    await ready();
    const pending = hookAsk(c, [color]);
    const id = uuidV5('toolu_test_1');
    await cardOf(id);
    api.sessions.answerCard(TOKEN, id, {
      inputs: { q1_other: `Teal${String.fromCharCode(0x202e)}\nwith a stripe` },
    });
    const r = await pending;
    expect(hookOut(r).updatedInput?.answers).toEqual({ 'Which color?': 'Teal\nwith a stripe' });
  });

  describe('a set of several questions', () => {
    const wordy = (n: number) => ({
      question: `Question ${n}?`,
      header: `Q${n}`,
      options: [1, 2, 3, 4].map((o) => ({ label: `Option ${o}`, description: 'd'.repeat(1500) })),
    });
    const set = [wordy(1), wordy(2), wordy(3)];
    const id = uuidV5('toolu_test_1');

    it('is asked as one card, answered at once, which closes it', async () => {
      api.sessions.open(TOKEN);
      const c = await start();
      await ready();
      const pending = hookAsk(c, set);
      const card = await cardOf(id);
      expect(session().messages.map((m) => m.id)).toEqual([id]);
      const message = api.sessions.message(TOKEN, id)!;
      expect(message.text).toBe('Claude asks 3 questions: Question 1?');
      expect(message.card!.header).toEqual({ title: 'Claude asks', subtitle: '3 questions' });
      expect((message.card!.body as { text: string }[]).map((b) => b.text)).toEqual([
        'Question 1?',
        'Question 2?',
        'Question 3?',
      ]);
      expect((message.card!.inputs as { id: string }[]).map((i) => i.id)).toEqual([
        'q1',
        'q1_other',
        'q2',
        'q2_other',
        'q3',
        'q3_other',
      ]);
      expect(message.card!.actions).toEqual([{ type: 'submit', label: 'Send' }]);
      expect(message.card!.responses).toMatchObject({ visibility: 'private', results: 'hidden' });
      api.sessions.answerCard(TOKEN, id, {
        inputs: { q1: 'o1', q2_other: 'None of these', q3: 'o3' },
      });
      const r = await pending;
      expect(hookOut(r)).toMatchObject({ permissionDecision: 'allow' });
      expect(hookOut(r).updatedInput?.answers).toEqual({
        'Question 1?': 'Option 1',
        'Question 2?': 'None of these',
        'Question 3?': 'Option 3',
      });
      expect(Object.keys(hookOut(r).updatedInput?.answers ?? {})).toEqual([
        'Question 1?',
        'Question 2?',
        'Question 3?',
      ]);
      expect(card.responses.map((x) => x.status)).toEqual(['accepted']);
      expect(card.closedBy).toBe('app');
    });

    it('refuses an answer that leaves a question out, with a note, then takes a full one', async () => {
      api.sessions.open(TOKEN);
      const c = await start();
      await ready();
      const pending = hookAsk(c, set);
      const card = await cardOf(id);
      api.sessions.answerCard(TOKEN, id, { inputs: { q1: 'o1', q3: 'o2' } });
      await waitFor(() => card.responses[0]?.status === 'rejected');
      expect(card.responses[0]?.note).toBe('Choose an option or type your own answer');
      expect(card.closedAt).toBeNull();
      api.sessions.answerCard(TOKEN, id, { inputs: { q1: 'o1', q2: 'o2', q3: 'o2' } });
      const r = await pending;
      expect(hookOut(r).updatedInput?.answers).toEqual({
        'Question 1?': 'Option 1',
        'Question 2?': 'Option 2',
        'Question 3?': 'Option 2',
      });
      expect(card.closedBy).toBe('app');
    });

    it('ends as dismissed when the card is dismissed', async () => {
      api.sessions.open(TOKEN);
      const c = await start();
      await ready();
      const pending = hookAsk(c, set);
      await cardOf(id);
      api.sessions.closeCardBy(TOKEN, id, 'owner');
      const out = hookOut(await pending);
      expect(out.permissionDecision).toBe('deny');
      expect(out.permissionDecisionReason).toContain('dismissed this question');
    });

    it('lets the terminal ask when the card is refused', async () => {
      api.sessions.open(TOKEN);
      const c = await start();
      await ready();
      // Not about responses (in the direct message there is no fallback anyway).
      api.sessions.refusePosts = 1;
      expect(textOf(await hookAsk(c, set))).toBe('{}');
      expect(session().cards.size).toBe(0);
    });
  });

  it("drops anyone else's answer, and waits again when the answer changed meanwhile", async () => {
    api.sessions.open(TOKEN);
    const c = await start();
    await ready();
    const pending = hookAsk(c, [color]);
    const id = uuidV5('toolu_test_1');
    await cardOf(id);
    api.sessions.answerCard(
      TOKEN,
      id,
      { inputs: { q1: 'o1' } },
      { from: { id: SESSION_IDS.stranger, name: 'Someone Else' } },
    );
    // The owner answers twice before the next poll: the first one is stale by then.
    api.sessions.answerCard(TOKEN, id, { inputs: { q1: 'o1' } });
    api.sessions.answerCard(TOKEN, id, { inputs: { q1: 'o2' } });
    const r = await pending;
    expect(hookOut(r).updatedInput?.answers).toEqual({
      'Which color?': 'Green',
    });
    expect(c.logs.join('\n')).toContain('"reason":"not_owner"');
  });

  describe('called again for the same question (the same tool_use_id)', () => {
    it('returns the answers already given, without a new card', async () => {
      api.sessions.open(TOKEN);
      const c = await start();
      await ready();
      const first = hookAsk(c, [color, targets]);
      const id = uuidV5('toolu_test_1');
      await cardOf(id);
      api.sessions.answerCard(TOKEN, id, { inputs: { q1: 'o2', q2: ['o1'] } });
      const answers = { 'Which color?': 'Green', 'Which targets?': 'Windows' };
      expect(hookOut(await first).updatedInput?.answers).toEqual(answers);
      // The accepted card's own close arrives later: the repeat isn't fooled by it.
      await waitFor(() => session().cards.get(id)?.closedBy === 'app');
      await new Promise((r) => setTimeout(r, 100));
      const again = await hookAsk(c, [color, targets]);
      expect(hookOut(again)).toMatchObject({ permissionDecision: 'allow' });
      expect(hookOut(again).updatedInput?.answers).toEqual(answers);
      expect(session().messages.map((m) => m.id)).toEqual([id]);
    });

    it('waits along with a call still waiting, posting one card, and both get the answer', async () => {
      api.sessions.open(TOKEN);
      const c = await start();
      await ready();
      const first = hookAsk(c, [color, targets]);
      const id = uuidV5('toolu_test_1');
      await cardOf(id);
      const second = hookAsk(c, [color, targets]);
      await new Promise((r) => setTimeout(r, 100));
      api.sessions.answerCard(TOKEN, id, { inputs: { q1: 'o1', q2_other: 'BSD' } });
      const [a, b] = await Promise.all([first, second]);
      for (const r of [a, b]) {
        expect(hookOut(r).updatedInput?.answers).toEqual({
          'Which color?': 'Blue',
          'Which targets?': 'BSD',
        });
      }
      expect(session().messages).toHaveLength(1);
      expect(
        session()
          .cards.get(id)
          ?.responses.map((x) => x.status),
      ).toEqual(['accepted']);
    });

    it('still says dismissed for a card dismissed before', async () => {
      api.sessions.open(TOKEN);
      const c = await start();
      await ready();
      const first = hookAsk(c, [color]);
      const id = uuidV5('toolu_test_1');
      await cardOf(id);
      api.sessions.closeCardBy(TOKEN, id, 'owner');
      expect(hookOut(await first).permissionDecisionReason).toContain('dismissed this question');
      const again = await hookAsk(c, [color]);
      expect(hookOut(again).permissionDecisionReason).toContain('dismissed this question');
    });
  });

  it("writes the card in the owner's language", async () => {
    api.sessions.open(TOKEN);
    const c = await start();
    await ready();
    api.sessions.postFrom(TOKEN, 'Hola', { locale: 'es-419' });
    await waitFor(() => channelNotes(c.notes).length === 1);
    const pending = hookAsk(c, [color, targets]);
    const id = uuidV5('toolu_test_1');
    await cardOf(id);
    const message = api.sessions.message(TOKEN, id)!;
    expect(message.text).toBe('Claude hace 2 preguntas: Which color?');
    expect(message.card!.header).toEqual({ title: 'Claude pregunta', subtitle: '2 preguntas' });
    api.sessions.closeCardBy(TOKEN, id, 'owner');
    await pending;
  });

  describe('denies with a reason Claude reads when nobody answers', () => {
    it('closes the card at the deadline (BUILDIT_ASK_TIMEOUT_MINUTES)', async () => {
      api.sessions.open(TOKEN);
      const c = await start({ env: { BUILDIT_ASK_TIMEOUT_MINUTES: '2' }, msPerSecond: 2 });
      await ready();
      const r = await hookAsk(c, [color]);
      const out = hookOut(r);
      expect(out.permissionDecision).toBe('deny');
      expect(out.permissionDecisionReason).toContain('within 2 minutes, so the card was closed');
      expect(session().cards.get(uuidV5('toolu_test_1'))?.closedBy).toBe('app');
    });

    it.each([
      ['time', 'within 59 minutes'],
      ['owner', 'dismissed this question'],
      ['session_ended', 'session ended before anyone answered'],
      ['deleted', 'card was closed in buildIt.Social'],
      ['removed', 'card was closed in buildIt.Social'],
    ])('a card closed by %s', async (closedBy, reason) => {
      api.sessions.open(TOKEN);
      const c = await start();
      await ready();
      const pending = hookAsk(c, [color]);
      const id = uuidV5('toolu_test_1');
      await cardOf(id);
      api.sessions.closeCardBy(TOKEN, id, closedBy);
      const out = hookOut(await pending);
      expect(out).toMatchObject({ permissionDecision: 'deny' });
      expect(out.permissionDecisionReason).toContain(reason);
    });

    it('the session ends while it waits', async () => {
      api.sessions.open(TOKEN);
      const c = await start();
      await ready();
      const pending = hookAsk(c, [color]);
      await cardOf(uuidV5('toolu_test_1'));
      api.sessions.revoke(TOKEN);
      const out = hookOut(await pending);
      expect(out.permissionDecisionReason).toContain('session ended before anyone answered');
    });
  });

  describe('passes with {} (the terminal asks as usual)', () => {
    it('when questions in the app are turned off', async () => {
      api.sessions.open(TOKEN);
      const c = await start({ env: { BUILDIT_QUESTIONS_IN_APP: 'false' } });
      await ready();
      expect(textOf(await hookAsk(c, [color]))).toBe('{}');
      expect(session().cards.size).toBe(0);
    });

    it('when another server is the channel for this folder', async () => {
      api.sessions.open(TOKEN);
      const c = await start({ owner: false });
      const r = await hookAsk(c, [color]);
      expect(textOf(r)).toBe('{}');
      expect(session().heartbeats).toEqual([]);
      const reply = await c.client.callTool({
        name: 'reply',
        arguments: { text: 'Hi' },
      });
      expect(reply.isError).toBe(true);
      expect(textOf(reply)).toContain(NOT_THE_CHANNEL);
      const tool = await c.client.callTool({
        name: 'ask',
        arguments: { questions: [color] },
      });
      expect(textOf(tool)).toContain(NOT_THE_CHANNEL);
    });

    it("when the questions don't have AskUserQuestion's shape", async () => {
      api.sessions.open(TOKEN);
      const c = await start();
      await ready();
      for (const questions of ['', '[{"question": 1}]', 'not json']) {
        const r = await c.client.callTool({
          name: 'ask',
          arguments: { questions, format: 'hook' },
        });
        expect(textOf(r)).toBe('{}');
      }
    });

    it('when the card is refused, or the session ended before the call', async () => {
      api.sessions.open(TOKEN);
      const c = await start();
      await ready();
      api.sessions.refusePosts = 1;
      expect(textOf(await hookAsk(c, [color]))).toBe('{}');
      api.sessions.revoke(TOKEN);
      api.sessions.postFrom(TOKEN, 'x');
      await waitFor(() => c.logs.join('\n').includes('polling stopped'));
      const r = await hookAsk(c, [color], 'toolu_test_2');
      expect(r.isError).toBeFalsy();
      expect(textOf(r)).toBe('{}');
    });
  });
});

describe('ask from Claude', () => {
  it("returns the person's answer as untrusted content", async () => {
    api.sessions.open(TOKEN);
    const c = await start();
    await ready();
    const pending = c.client.callTool({
      name: 'ask',
      arguments: { questions: [color] },
    });
    await waitFor(() => session().cards.size === 1);
    const [id] = [...session().cards.keys()];
    // An empty answer is refused first; then the typed one.
    api.sessions.answerCard(TOKEN, id!, { inputs: {} });
    await waitFor(() => session().cards.get(id!)!.responses[0]?.status === 'rejected');
    api.sessions.answerCard(TOKEN, id!, { inputs: { q1_other: HOSTILE } });
    const r = await pending;
    const text = textOf(r);
    expect(text.startsWith('The person answered in buildIt.Social:')).toBe(true);
    expect(text).toContain('source="card answer"');
    expect(text).toContain('Q: Which color?');
    expect(injectionIsInsideBlocks(text)).toBe(true);
    expect(r.structuredContent).toMatchObject({ status: 'answered', message_id: id });
  });

  it('says when nobody answered, without an error', async () => {
    api.sessions.open(TOKEN);
    const c = await start({ msPerSecond: 1 });
    await ready();
    const r = await c.client.callTool({
      name: 'ask',
      arguments: { questions: [color], wait_s: 60 },
    });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('Nobody answered this question in buildIt.Social within 1 minute,');
    expect(r.structuredContent).toMatchObject({ status: 'no_answer', reason: 'timeout' });
  });

  it('reports progress while it waits, when asked', async () => {
    api.sessions.open(TOKEN);
    const c = await start({ msPerSecond: 2 });
    await ready();
    const progress: string[] = [];
    await c.client.callTool(
      { name: 'ask', arguments: { questions: [color], wait_s: 120 } },
      {
        onprogress: (p) => {
          progress.push(String(p.message));
        },
      },
    );
    expect(progress.length).toBeGreaterThanOrEqual(2);
    expect(progress[0]).toContain("Waiting for the person's answer");
  });

  it('closes the card when the call is cancelled', async () => {
    api.sessions.open(TOKEN);
    const c = await start();
    await ready();
    const abort = new AbortController();
    const pending = c.client
      .callTool(
        { name: 'ask', arguments: { questions: [color] } },
        {
          signal: abort.signal,
        },
      )
      .catch(() => 'cancelled');
    await waitFor(() => session().cards.size === 1);
    abort.abort();
    expect(await pending).toBe('cancelled');
    const [card] = [...session().cards.values()];
    await waitFor(() => card!.closedAt !== null);
    expect(card!.closedBy).toBe('app');
  });

  it('closes the card when the call is cancelled while the card is posted', async () => {
    api.sessions.open(TOKEN);
    const c = await start();
    await ready();
    const abort = new AbortController();
    // The cancel lands after the server made the card, before its answer reaches the tool.
    const post = api.sessions.post.bind(api.sessions);
    api.sessions.post = (token, body) => {
      const r = post(token, body);
      if (body.card !== undefined) abort.abort();
      return r;
    };
    const pending = c.client
      .callTool({ name: 'ask', arguments: { questions: [color] } }, { signal: abort.signal })
      .catch(() => 'cancelled');
    expect(await pending).toBe('cancelled');
    await waitFor(() => session().cards.size === 1);
    const [card] = [...session().cards.values()];
    await waitFor(() => card!.closedAt !== null);
    expect(card!.closedBy).toBe('app');
  });

  it('says the session ended, after it has', async () => {
    api.sessions.open(TOKEN);
    const c = await start();
    await ready();
    api.sessions.revoke(TOKEN);
    await waitFor(() => c.logs.join('\n').includes('polling stopped'));
    const r = await c.client.callTool({
      name: 'ask',
      arguments: { questions: [color] },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('not connected to buildIt.Social');
  });
});

describe("ask in an item's thread", () => {
  const item = demoItem(12, { title: 'Fix the login redirect' });

  /** A channel server working on the item (its assignment handed on). */
  async function onItem(): Promise<ChannelClient> {
    api.sessions.open(TOKEN);
    const c = await start();
    await ready();
    api.sessions.assignItem(TOKEN, item);
    await waitFor(() => channelNotes(c.notes).length === 1);
    return c;
  }

  /** Records every post's card responses, refused or not. */
  function recordPosts(): { visibility: unknown; results: unknown; id: unknown }[] {
    const posts: { visibility: unknown; results: unknown; id: unknown }[] = [];
    const post = api.sessions.post.bind(api.sessions);
    api.sessions.post = (token, body) => {
      const r = (body.card as { responses?: Record<string, unknown> } | undefined)?.responses;
      posts.push({ id: body.id, visibility: r?.visibility, results: r?.results });
      return post(token, body);
    };
    return posts;
  }

  it('takes shared answers, shown once sent, on a server that has them', async () => {
    api.sessions.sharedResults = true;
    const c = await onItem();
    const posts = recordPosts();
    const pending = c.client.callTool({
      name: 'ask',
      arguments: { questions: [color, targets], item: 'DEMO-12' },
    });
    await waitFor(() => session().cards.size === 1);
    const [id, card] = [...session().cards.entries()][0]!;
    expect(card.threadId).toBe(item.id);
    expect(api.sessions.message(TOKEN, id)!.card!.responses).toMatchObject({
      mode: 'once',
      visibility: 'shared',
      results: 'on_close',
      guests: false,
      confirm: true,
    });
    expect(posts).toEqual([{ id, visibility: 'shared', results: 'on_close' }]);
    api.sessions.answerCard(TOKEN, id, { inputs: { q1: 'o2', q2: ['o3'] } });
    const r = await pending;
    expect(r.structuredContent).toMatchObject({ status: 'answered', message_id: id });
    expect(textOf(r)).toContain('Q: Which targets?');
    expect(card.closedBy).toBe('app');
  });

  it("knows the item's thread by its thread_id too, or as the latest thread", async () => {
    api.sessions.sharedResults = true;
    const c = await onItem();
    const posts = recordPosts();
    // Other questions each time: the tool's id comes from the questions and the minute.
    for (const [questions, args] of [
      [[color], { thread_id: item.id }],
      [[targets], {}],
    ] as const) {
      const pending = c.client.callTool({
        name: 'ask',
        arguments: { questions, ...args },
      });
      await waitFor(() => [...session().cards.values()].some((x) => x.closedAt === null));
      const [id] = [...session().cards].find(([, x]) => x.closedAt === null)!;
      api.sessions.closeCardBy(TOKEN, id, 'owner');
      await pending;
    }
    expect(posts.map((p) => p.visibility)).toEqual(['shared', 'shared']);
  });

  it('posts the same card private, with the same id, once, when an older server refuses shared answers', async () => {
    const c = await onItem();
    const posts = recordPosts();
    const pending = c.client.callTool({
      name: 'ask',
      arguments: { questions: [color, targets], item: 'DEMO-12' },
    });
    await waitFor(() => session().cards.size === 1);
    const [id, card] = [...session().cards.entries()][0]!;
    expect(posts).toEqual([
      { id, visibility: 'shared', results: 'on_close' },
      { id, visibility: 'private', results: 'hidden' },
    ]);
    expect(card.threadId).toBe(item.id);
    const message = api.sessions.message(TOKEN, id)!;
    expect(message.text).toBe('Claude asks 2 questions: Which color?');
    expect(message.card!.responses).toMatchObject({ visibility: 'private', results: 'hidden' });
    expect(session().messages.filter((m) => m.id === id)).toHaveLength(1);
    expect(c.logs.join('\n')).toContain('ask card refused shared answers; posting it private');
    api.sessions.answerCard(TOKEN, id, { inputs: { q1: 'o1', q2_other: 'All' } });
    const r = await pending;
    expect(r.structuredContent).toMatchObject({ status: 'answered', message_id: id });
  });

  it('retries only for a refusal of responses, and only once', async () => {
    const c = await onItem();
    const posts = recordPosts();
    // Refused at responses (the fake's own check), then refused again by the test: no third post.
    const post = api.sessions.post.bind(api.sessions);
    let n = 0;
    api.sessions.post = (token, body) => {
      n++;
      if (n === 2) api.sessions.refusePosts = 1;
      return post(token, body);
    };
    const r = await c.client.callTool({
      name: 'ask',
      arguments: { questions: [color], item: 'DEMO-12' },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('card_invalid');
    expect(posts.map((p) => p.visibility)).toEqual(['shared', 'private']);
    expect(session().cards.size).toBe(0);
  });

  it('keeps the direct message private, with no retry', async () => {
    api.sessions.sharedResults = true;
    api.sessions.open(TOKEN);
    const c = await start();
    await ready();
    api.sessions.postFrom(TOKEN, 'Pick for me.');
    await waitFor(() => channelNotes(c.notes).length === 1);
    const posts = recordPosts();
    api.sessions.refusePosts = 1;
    const r = await c.client.callTool({ name: 'ask', arguments: { questions: [color] } });
    expect(r.isError).toBe(true);
    expect(posts).toEqual([
      { id: expect.any(String) as unknown, visibility: 'private', results: 'hidden' },
    ]);
  });
});

describe('plan cards', () => {
  async function planner(): Promise<ChannelClient> {
    api.sessions.open(TOKEN);
    api.identities[TOKEN]!.token.scopes = ['projects:write', 'projects:delete', 'chat:read'];
    const c = await start({ env: { BUILDIT_TOOLSETS: 'items,destructive' } });
    await ready();
    return c;
  }

  it('says so in the instructions: the person applies, this session never does', async () => {
    const c = await planner();
    const instructions = c.client.getInstructions() ?? '';
    expect(instructions).toContain("Only the person's tap on Apply applies it");
    expect(instructions).not.toContain('call apply_plan only after they confirm');
    const tools = (await c.client.listTools()).tools;
    expect(tools.find((t) => t.name === 'apply_plan')?.description).toContain('plan_card_required');
    expect(tools.find((t) => t.name === 'propose_delete_item')?.description).toContain(
      "only the person's tap on Apply applies it",
    );
  });

  it('posts the preview for the owner to apply; apply_plan is refused', async () => {
    const c = await planner();
    const root = api.sessions.postFrom(TOKEN, 'Delete DEMO-42 please.');
    await waitFor(() => channelNotes(c.notes).length === 1);
    const r = await c.client.callTool({
      name: 'propose_delete_item',
      arguments: { item: 'DEMO-42' },
    });
    expect(r.isError).toBeFalsy();
    const handle = (r.structuredContent as { handle: string }).handle;
    const card = session().cards.get(uuidV5(`plan:${handle}`));
    expect(card).toMatchObject({ kind: 'plan', threadId: root, handle });
    expect(textOf(r)).toContain(CARD_STEP);
    expect(textOf(r)).not.toContain('Call apply_plan with this handle only if');
    expect(r.structuredContent).toMatchObject({ next_step: CARD_STEP });

    const applied = await c.client.callTool({
      name: 'apply_plan',
      arguments: { handle },
    });
    expect(applied.isError).toBe(true);
    expect(textOf(applied)).toContain('plan_card_required');
    expect(textOf(applied)).toContain('the owner approves this by tapping Apply in buildIt.Social');
    expect(api.store.items.some((i) => `${i.project}-${i.number}` === 'DEMO-42')).toBe(true);
  });

  it("says the plan can't be applied when its card can't be posted", async () => {
    const c = await planner();
    api.refusePlanCards = 1;
    const r = await c.client.callTool({
      name: 'propose_delete_item',
      arguments: { item: 'DEMO-42' },
    });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain(cardFailedStep('unavailable'));
    expect(textOf(r)).not.toContain('Call apply_plan with this handle only if');
    const handle = (r.structuredContent as { handle: string }).handle;
    const applied = await c.client.callTool({ name: 'apply_plan', arguments: { handle } });
    expect(applied.isError).toBe(true);
    expect(textOf(applied)).toContain('plan_card_required');
  });

  it("posts the card from a server that isn't the folder's channel too", async () => {
    api.sessions.open(TOKEN);
    api.identities[TOKEN]!.token.scopes = ['projects:write', 'projects:delete', 'chat:read'];
    const c = await start({ env: { BUILDIT_TOOLSETS: 'items,destructive' }, owner: false });
    const r = await c.client.callTool({
      name: 'propose_delete_item',
      arguments: { item: 'DEMO-42' },
    });
    const handle = (r.structuredContent as { handle: string }).handle;
    expect(session().cards.get(uuidV5(`plan:${handle}`))).toMatchObject({
      kind: 'plan',
      threadId: null,
    });
    expect(textOf(r)).toContain(CARD_STEP);
  });

  it.each([
    [
      'applied',
      {
        result: {
          action: 'delete_item',
          deleted: [
            { id: '00000000-0000-4000-8000-000000000042', key: 'DEMO-42', title: 'A task' },
          ],
        },
      },
      'The person applied plan',
      'Deleted DEMO-42.',
    ],
    ['cancelled', {}, 'The person cancelled plan', 'Nothing changed.'],
    [
      'stale',
      { error: { code: 'plan_stale' }, changed: [{ kind: 'item', ref: 'DEMO-42' }] },
      'was not applied: DEMO-42 changed since the preview',
      'Propose again',
    ],
    [
      'failed',
      { error: { code: 'forbidden', message: 'No.' } },
      'applying it failed',
      '(forbidden)',
    ],
    ['expired', {}, 'expired in buildIt.Social', 'Nothing changed'],
    ['unknown', {}, 'It is unclear whether plan', 'Check the items it targets'],
  ] as const)('tells Claude the outcome: %s', async (outcome, extra, first, second) => {
    const c = await planner();
    const r = await c.client.callTool({
      name: 'propose_delete_item',
      arguments: { item: 'DEMO-42' },
    });
    const handle = (r.structuredContent as { handle: string }).handle;
    const id = uuidV5(`plan:${handle}`);
    // The tap's answer itself is the server's business: dropped here.
    api.sessions.answerCard(TOKEN, id, { action: 'apply' });
    api.resolvePlanCard(handle, outcome, extra);
    await waitFor(() =>
      channelNotes(c.notes).some((n) => n.params?.meta?.event === 'plan_resolved'),
    );
    const note = channelNotes(c.notes).find((n) => n.params?.meta?.event === 'plan_resolved')!;
    expect(note.params?.meta).toEqual({
      event: 'plan_resolved',
      handle,
      outcome,
      thread_id: id,
      message_id: id,
      session: 'demo-folder',
    });
    expect(note.params?.content).toContain(first);
    expect(note.params?.content).toContain(second);
  });
});

describe('is writing', () => {
  it('says so in the thread of a message at once and again while working; reply stops it', async () => {
    api.sessions.open(TOKEN);
    const c = await start({ typing: { everyMs: 40 } });
    await ready();
    const root = api.sessions.postFrom(TOKEN, 'Hello');
    await waitFor(() => session().typings.filter((t) => t.typing).length >= 3);
    expect(session().typings[0]).toEqual({ thread_id: root, typing: true });
    await c.client.callTool({ name: 'reply', arguments: { text: 'Hi!' } });
    await waitFor(() => session().typings.at(-1)?.typing === false);
    expect(session().typings.at(-1)).toEqual({ thread_id: root, typing: false });
    const count = session().typings.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(session().typings).toHaveLength(count);
  });

  it('stops when ask posts its card, and on turn_ended for every thread', async () => {
    api.sessions.open(TOKEN);
    const c = await start({ typing: { everyMs: 60_000 } });
    await ready();
    const one = api.sessions.postFrom(TOKEN, 'One');
    const two = api.sessions.postFrom(TOKEN, 'Two');
    await waitFor(() => session().typings.length === 2);
    const pending = hookAsk(c, [color]);
    await waitFor(() => session().typings.some((t) => !t.typing));
    expect(session().typings.filter((t) => !t.typing)).toEqual([{ thread_id: two, typing: false }]);
    api.sessions.closeCardBy(TOKEN, uuidV5('toolu_test_1'), 'owner');
    await pending;
    const ended = await c.client.callTool({
      name: 'turn_ended',
      arguments: {},
    });
    expect(textOf(ended)).toBe('{}');
    await waitFor(() => session().typings.filter((t) => !t.typing).length === 2);
    expect(session().typings.at(-1)).toEqual({ thread_id: one, typing: false });
  });

  it('stops after a while without tool calls', async () => {
    api.sessions.open(TOKEN);
    await start({ typing: { everyMs: 20, idleMs: 100 } });
    await ready();
    const root = api.sessions.postFrom(TOKEN, 'Hello');
    await waitFor(() => session().typings.at(-1)?.typing === false, 3000);
    expect(session().typings.at(-1)).toEqual({ thread_id: root, typing: false });
  });

  it('backs off silently after a 429', async () => {
    api.sessions.open(TOKEN);
    const c = await start({ typing: { everyMs: 20 } });
    await ready();
    session().typingRefusals = 1;
    api.sessions.postFrom(TOKEN, 'Hello');
    await waitFor(() => channelNotes(c.notes).length === 1);
    await new Promise((r) => setTimeout(r, 200));
    // The first was refused; the retry-after (30 s) keeps it quiet.
    expect(session().typings).toEqual([]);
    const r = await c.client.callTool({
      name: 'reply',
      arguments: { text: 'Hi' },
    });
    expect(r.isError).toBeFalsy();
    // The stop is still sent, so the app doesn't wait out the time.
    await waitFor(() => session().typings.length === 1);
    expect(session().typings[0]?.typing).toBe(false);
  });

  it('stops on shutdown', async () => {
    api.sessions.open(TOKEN);
    const c = await start({ typing: { everyMs: 60_000 } });
    await ready();
    api.sessions.postFrom(TOKEN, 'Hello');
    await waitFor(() => session().typings.length === 1);
    await c.close();
    expect(session().typings.at(-1)?.typing).toBe(false);
  });

  it('lists turn_ended only for the plugin hook, and ask, in channel mode', async () => {
    api.sessions.open(TOKEN);
    const c = await start();
    const tools = (await c.client.listTools()).tools;
    const turn = tools.find((t) => t.name === 'turn_ended');
    expect(turn?.description).toContain("Called by the buildit plugin's Stop hook");
    expect(turn?.description).toContain('Not for you to call');
    expect(tools.map((t) => t.name)).toContain('ask');
  });
});
