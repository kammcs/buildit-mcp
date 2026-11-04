/**
 * Questions and plan mode on Codex: `ask` through the hosted tool (with a
 * tool timeout that covers the question wait), Codex's own questions
 * (`item/tool/requestUserInput`) as the stacked question card (a secret
 * one never put on a card), and plan mode: the finished plan as an
 * Approve/Deny card, Approve starting the next turn in default mode, Deny
 * leaving the item planning; plan updates posted only behind the setting.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  PLAN_ABOVE,
  PLAN_APPROVED,
  planCard,
  planParts,
  planUpdateText,
} from '../src/codex/plans.js';
import { asyncAnswersText, cardQuestions, SECRET_REFUSED } from '../src/codex/questions.js';
import { toolTimeoutSeconds } from '../src/codex/tool-server.js';
import { CodexBench, waitFor } from './support/codex-run.js';
import { FakeApi } from './support/fake-api.js';
import type { Received, TurnContext } from './support/fake-codex.js';
import { demoItem, SESSION_TOKENS } from './support/fake-sessions.js';

let api: FakeApi;
let bench: CodexBench;

beforeAll(async () => {
  api = await new FakeApi().start();
});
afterAll(async () => {
  await api.close();
});
beforeEach(() => {
  api.reset();
  bench = new CodexBench(api);
});
afterEach(async () => {
  expect(await bench.cleanup()).toEqual([]);
  expect(api.violations).toEqual([]);
});

const token = SESSION_TOKENS.first;
const session = () => api.sessions.session(token);
const posts = () => session().messages;
const cardIds = () => new Set(api.sessions.approvals(token).map((c) => c.id));
const textsIn = (thread: string | null) =>
  posts()
    .filter((m) => m.thread_id === thread && !cardIds().has(m.id) && (m.card ?? null) === null)
    .map((m) => m.text);
const questionCards = () => posts().filter((m) => (m.card ?? null) !== null);
type Json = Record<string, unknown>;

const question = (id: string, extra: Json = {}): Json => ({
  id,
  header: `H ${id}`,
  question: `Which ${id}?`,
  isOther: true,
  isSecret: false,
  options: [
    { label: 'Red', description: 'warm' },
    { label: 'Blue', description: 'cool' },
  ],
  ...extra,
});

/** A turn that asks Codex's own question, then answers with what it got. */
function asking(questions: Json[], seen: { answer?: Received }) {
  return async (ctx: TurnContext) => {
    ctx.status(['waitingOnUserInput']);
    seen.answer = await ctx.request('item/tool/requestUserInput', {
      itemId: 'ask-1',
      questions,
      isBlocking: true,
      autoResolutionMs: null,
    });
    ctx.agentMessage('thanks', 'final_answer');
    ctx.complete();
  };
}

describe('codex questions: ask through the hosted tool', () => {
  it("asks on the stacked card with the question wait, and Codex's tool timeout covers it", async () => {
    const s = api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    let result: unknown;
    codex.onTurn = async (ctx) => {
      const client = await codex.mcp(ctx.threadId);
      result = await client.callTool({
        name: 'ask',
        arguments: {
          questions: [
            {
              question: 'Which colour?',
              header: 'Colour',
              options: [{ label: 'Red' }, { label: 'Blue' }],
            },
          ],
        },
      });
      ctx.agentMessage('', 'final_answer');
      ctx.complete();
    };
    await bench.start(codex, {
      ask: { questionsInApp: true, timeoutMinutes: 10, maxParallelItems: 3 },
    });
    await waitFor(() => s.heartbeats.includes('online'));
    const thread = api.sessions.postFrom(token, 'Ask me');
    await waitFor(() => questionCards().length === 1);
    const card = questionCards()[0]!;
    expect(card.thread_id).toBe(thread);
    // The tool's default wait is the question wait (10 minutes here), and Codex waits a minute more.
    const config = codex.threadConfig(codex.threadIds()[0]!)!['mcp_servers.buildit'] as Json;
    expect(config.tool_timeout_sec).toBe(660);
    expect(toolTimeoutSeconds(3540)).toBe(3600);
    const closes = Date.parse(String((card.card!.responses as Json).closes_at));
    expect(closes - Date.now()).toBeGreaterThan(9 * 60_000);
    // The card's own close is a minute after the wait (closesAt's margin).
    expect(closes - Date.now()).toBeLessThanOrEqual(11 * 60_000);
    api.sessions.answerCard(token, card.id, { inputs: { q1: 'o2' } });
    await waitFor(() => result !== undefined);
    expect(JSON.stringify(result)).toContain('Blue');
  });
});

describe("codex questions: Codex's own (requestUserInput)", () => {
  it('puts them on the stacked card and answers with the chosen labels and the typed text', async () => {
    const s = api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    const seen: { answer?: Received } = {};
    codex.onTurn = asking([question('colour'), question('size')], seen);
    await bench.start(codex);
    await waitFor(() => s.heartbeats.includes('online'));
    const thread = api.sessions.postFrom(token, 'Plan something');
    await waitFor(() => questionCards().length === 1);
    const card = questionCards()[0]!;
    expect(card.thread_id).toBe(thread);
    const body = JSON.stringify(card.card);
    for (const t of ['Which colour?', 'Which size?', 'H colour', 'Red', 'cool']) {
      expect(body).toContain(t);
    }
    api.sessions.answerCard(token, card.id, { inputs: { q1: 'o1', q2_other: 'A big one' } });
    await waitFor(() => seen.answer !== undefined);
    expect(seen.answer!.result).toEqual({
      answers: { colour: { answers: ['Red'] }, size: { answers: ['A big one'] } },
    });
    await waitFor(() => textsIn(thread).includes('thanks'));
  });

  it('never puts a secret question on a card: declined, and says why in the thread', async () => {
    const s = api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    const seen: { answer?: Received } = {};
    codex.onTurn = asking([question('colour'), question('token', { isSecret: true })], seen);
    await bench.start(codex);
    await waitFor(() => s.heartbeats.includes('online'));
    const thread = api.sessions.postFrom(token, 'Set it up');
    await waitFor(() => seen.answer !== undefined);
    expect(seen.answer!.result).toEqual({ answers: {} });
    expect(questionCards()).toHaveLength(0);
    await waitFor(() => textsIn(thread).includes(SECRET_REFUSED));
    // Nothing of the question went anywhere.
    expect(JSON.stringify(posts())).not.toContain('Which token?');
  });

  it('closes the card unanswered when Codex resolves the question itself', async () => {
    const s = api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    let done = false;
    codex.onTurn = async (ctx) => {
      void ctx.request('item/tool/requestUserInput', {
        itemId: 'ask-2',
        questions: [question('colour')],
        isBlocking: true,
        autoResolutionMs: null,
      });
      await waitFor(() => questionCards().length === 1);
      codex.resolveElsewhere(codex.pendingServerRequests()[0]!.id);
      done = true;
      ctx.agentMessage('ok', 'final_answer');
      ctx.complete();
    };
    await bench.start(codex);
    await waitFor(() => s.heartbeats.includes('online'));
    api.sessions.postFrom(token, 'Go');
    await waitFor(() => done);
    const card = questionCards()[0]!;
    await waitFor(() => session().cards.get(card.id)?.closedAt !== undefined);
    expect(codex.pendingServerRequests()).toEqual([]);
  });

  it("maps Codex's questions, and refuses the ones a card can't show", () => {
    expect(cardQuestions([question('a')])?.questions[0]).toMatchObject({
      question: 'Which a?',
      header: 'H a',
      options: [{ label: 'Red', description: 'warm' }, { label: 'Blue' }],
    });
    expect(cardQuestions([question('a', { options: null })])).toBeUndefined();
    expect(cardQuestions([question('a'), question('a')])).toBeUndefined();
    expect(cardQuestions([question('a', { isSecret: true })])?.secret).toBe(true);
  });
});

describe('codex plan mode', () => {
  it('plans first, turns the plan into a card, and carries it out in default mode once approved', async () => {
    const s = api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    const turns: TurnContext[] = [];
    codex.onTurn = (ctx) => {
      turns.push(ctx);
      if (turns.length === 1) {
        ctx.planUpdate([{ step: 'Look', status: 'inProgress' }]);
        ctx.agentMessage('Here is my plan.', 'final_answer');
        ctx.plan('1. Add the field\n2. Test it');
      } else {
        ctx.agentMessage('Carried out.', 'final_answer');
      }
      ctx.complete();
    };
    await bench.start(codex, { planItems: true });
    await waitFor(() => s.heartbeats.includes('online'));
    const one = demoItem(1);
    api.sessions.assignItem(token, one);
    await waitFor(() => api.sessions.approvals(token).length === 1);
    const first = codex.requests('turn/start')[0]!;
    expect(first.collaborationMode).toEqual({
      mode: 'plan',
      settings: { model: 'test-model', reasoning_effort: null, developer_instructions: null },
    });
    expect(textsIn(one.id)).toEqual(['Here is my plan.']);
    const card = api.sessions.approvals(token)[0]!;
    expect(card.toolName).toBe('plan');
    expect(card.posted.thread_id).toBe(one.id);
    expect(card.posted.fields).toEqual([{ key: 'plan', value: '1. Add the field\n2. Test it' }]);
    api.sessions.decideApproval(token, card.id, 'approve');
    await waitFor(() => turns.length === 2);
    const second = codex.requests('turn/start')[1]!;
    expect((second.collaborationMode as Json).mode).toBe('default');
    expect((second.input as Json[])[0]).toMatchObject({ text: PLAN_APPROVED });
    await waitFor(() => textsIn(one.id).includes('Carried out.'));
    // Plan updates stay off by default.
    expect(textsIn(one.id).some((t) => t.includes('[~] Look'))).toBe(false);
    // It stays in default mode for the item's next turns.
    api.sessions.itemMessage(token, one, 'One more thing');
    await waitFor(() => codex.requests('turn/start').length === 3);
    expect((codex.requests('turn/start')[2]!.collaborationMode as Json).mode).toBe('default');
  });

  it('keeps planning when the plan is denied, and posts plan updates with the setting', async () => {
    const s = api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    codex.onTurn = (ctx) => {
      ctx.planUpdate(
        [
          { step: 'Read the code', status: 'completed' },
          { step: 'Write it', status: 'pending' },
        ],
        'Two steps.',
      );
      ctx.plan('Do the thing');
      ctx.complete();
    };
    await bench.start(codex, { planItems: true, planUpdates: true });
    await waitFor(() => s.heartbeats.includes('online'));
    const one = demoItem(1);
    api.sessions.assignItem(token, one);
    await waitFor(() => api.sessions.approvals(token).length === 1);
    expect(textsIn(one.id)).toContain('Two steps.\n\n- [x] Read the code\n- [ ] Write it');
    api.sessions.decideApproval(token, api.sessions.approvals(token)[0]!.id, 'deny');
    await new Promise((r) => setTimeout(r, 200));
    expect(codex.requests('turn/start')).toHaveLength(1);
    // The person's next message is still planned.
    api.sessions.itemMessage(token, one, 'Do it differently');
    await waitFor(() => codex.requests('turn/start').length === 2);
    expect((codex.requests('turn/start')[1]!.collaborationMode as Json).mode).toBe('plan');
    await waitFor(() => api.sessions.approvals(token).length === 2);
  });

  it("puts plan mode's async questions on the card, and brings the answer back as the next input", async () => {
    const s = api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    const turns: TurnContext[] = [];
    codex.onTurn = (ctx) => {
      turns.push(ctx);
      if (turns.length === 1) {
        // As Codex 0.166 asked in a real plan-mode turn: an async message, then a closing word.
        ctx.asyncQuestion('Which word should I use?\n- yes\n- no', [
          { title: 'Which word should I use?', options: ['yes', 'no'] },
        ]);
        ctx.asyncQuestion('And this?', [{ title: 'No options here', options: null }]);
        ctx.agentMessage('I need your answer first.', 'final_answer');
      } else {
        ctx.agentMessage('Planned.', 'final_answer');
        ctx.plan('1. Reply yes');
      }
      ctx.complete();
    };
    await bench.start(codex, { planItems: true });
    await waitFor(() => s.heartbeats.includes('online'));
    const one = demoItem(1);
    api.sessions.assignItem(token, one);
    await waitFor(() => questionCards().length === 1);
    const card = questionCards()[0]!;
    expect(card.thread_id).toBe(one.id);
    expect(JSON.stringify(card.card)).toContain('Which word should I use?');
    // Questions a card can't show are posted as they came; the carded one isn't posted again.
    await waitFor(() => textsIn(one.id).includes('I need your answer first.'));
    expect(textsIn(one.id)).toEqual(['And this?', 'I need your answer first.']);
    api.sessions.answerCard(token, card.id, { inputs: { q1: 'o1' } });
    await waitFor(() => turns.length === 2);
    const next = codex.requests('turn/start')[1]!;
    expect((next.input as Json[])[0]).toMatchObject({
      text: asyncAnswersText([{ question: 'Which word should I use?', answer: 'yes' }]),
    });
    expect((next.collaborationMode as Json).mode).toBe('plan');
    await waitFor(() => api.sessions.approvals(token).some((c) => c.toolName === 'plan'));
  });

  it('leaves the direct message and items out of plan mode without the setting', async () => {
    const s = api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    codex.onTurn = (ctx) => {
      ctx.plan('A plan nobody asked for');
      ctx.agentMessage('done', 'final_answer');
      ctx.complete();
    };
    await bench.start(codex);
    await waitFor(() => s.heartbeats.includes('online'));
    api.sessions.assignItem(token, demoItem(2));
    await waitFor(() => textsIn(demoItem(2).id).length === 1);
    expect(codex.requests('turn/start')[0]!.collaborationMode).toBeUndefined();
    expect(api.sessions.approvals(token)).toHaveLength(0);
  });

  it('splits a plan into fields, posts a long one first, and writes updates as a checklist', () => {
    expect(planParts('a\nb', 3)).toEqual(['a\nb']);
    expect(planParts('aa\nbb\ncc', 5)).toEqual(['aa\nbb', 'cc']);
    expect(planParts('x'.repeat(7), 3)).toEqual(['xxx', 'xxx', 'x']);
    const long = Array.from({ length: 400 }, (_, i) => `step ${i} ${'y'.repeat(30)}`).join('\n');
    const { spec, before } = planCard(long);
    expect(spec.input).toEqual({ plan: PLAN_ABOVE });
    expect(before.join('\n\n').replace(/\s+/g, '')).toBe(long.replace(/\s+/g, ''));
    const mid = Array.from({ length: 120 }, (_, i) => `step ${i} ${'z'.repeat(30)}`).join('\n');
    const two = planCard(mid);
    expect(Object.keys(two.spec.input)).toEqual(['plan', 'plan (2)']);
    expect(two.before).toEqual([]);
    expect(planUpdateText({ plan: [{ step: 'a', status: 'inProgress' }] })).toBe('- [~] a');
    expect(planUpdateText({ plan: [] })).toBeUndefined();
  });
});
