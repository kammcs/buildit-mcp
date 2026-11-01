/**
 * ask gets the person's answer whenever it is given during the wait:
 * within the first seconds, long after (when Claude Code has
 * moved the call to the background, which sends no cancel), with two cards
 * waiting at once, while the channel loop is in the middle of a poll, and,
 * where the server serves get_session_card, read back from the card when its
 * card.response never arrives. Without an answer it can confirm was never
 * given, the result says so, never a plain timeout.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { CallToolResult } from '@modelcontextprotocol/client';

import { noAnswerText } from '../src/tools/ask.js';
import {
  channelConfig,
  startChannel,
  waitFor,
  type ChannelClient,
} from './support/channel-harness.js';
import { FakeApi } from './support/fake-api.js';
import { SESSION_TOKENS } from './support/fake-sessions.js';

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
  options: [{ label: 'Blue' }, { label: 'Green' }],
};
const size = {
  question: 'Which size?',
  header: 'Size',
  options: [{ label: 'Small' }, { label: 'Large' }],
};

const session = () => api.sessions.session(TOKEN);
const textOf = (r: CallToolResult): string =>
  (r.content as { type: string; text: string }[]).map((c) => c.text).join('\n');

/** A channel server whose ask waits `msPerSecond` ms per second of wait_s. */
async function start(
  ask: { msPerSecond?: number; checkEveryS?: number; graceMs?: number } = {},
): Promise<ChannelClient> {
  const c = await startChannel(api, stops, {
    config: channelConfig(api),
    stdio: {
      ask: { msPerSecond: 10, graceMs: 1000, ...ask },
      typing: { everyMs: 60_000 },
    },
  });
  await waitFor(() => session().heartbeats.includes('online'));
  return c;
}

/** The id of the card with this question, once it is posted. */
async function cardWith(question: string): Promise<string> {
  const find = () =>
    [...session().cards.keys()].find((id) =>
      api.sessions.message(TOKEN, id)?.text.includes(question),
    );
  await waitFor(() => find() !== undefined);
  return find()!;
}

function ask(c: ChannelClient, questions: unknown[], waitS = 3600, onprogress?: () => void) {
  return c.client.callTool(
    { name: 'ask', arguments: { questions, wait_s: waitS, dm: true } },
    onprogress === undefined ? undefined : { onprogress, timeout: 60_000 },
  );
}

describe('ask gets the answer', () => {
  it('given within the first seconds', async () => {
    api.sessions.open(TOKEN);
    const c = await start();
    const pending = ask(c, [color]);
    const id = await cardWith('Which color?');
    api.sessions.answerCard(TOKEN, id, { inputs: { q1: 'o2' } });
    const r = await pending;
    expect(r.structuredContent).toMatchObject({ status: 'answered', message_id: id });
    expect(textOf(r)).toContain('A: Green');
    const card = session().cards.get(id)!;
    expect(card.responses[0]?.status).toBe('accepted');
    expect(card.closedBy).toBe('app');
  });

  it('given long after the call was moved to the background (no cancel comes)', async () => {
    api.sessions.open(TOKEN);
    // 30 s of waiting is 30 ms: the progress beats go on while nothing else happens.
    const c = await start({ msPerSecond: 1 });
    let beats = 0;
    const pending = ask(c, [color], 3600, () => {
      beats++;
    });
    const id = await cardWith('Which color?');
    // Well past the point where Claude Code moves the call to the background.
    await waitFor(() => beats >= 5);
    api.sessions.answerCard(TOKEN, id, { inputs: { q1: 'o1' } });
    const r = await pending;
    expect(r.structuredContent).toMatchObject({ status: 'answered', message_id: id });
    expect(textOf(r)).toContain('A: Blue');
  });

  it('for each of two cards waiting at once, answered in the other order', async () => {
    api.sessions.open(TOKEN);
    const c = await start();
    const first = ask(c, [color]);
    const second = ask(c, [size]);
    const colorId = await cardWith('Which color?');
    const sizeId = await cardWith('Which size?');
    expect(colorId).not.toBe(sizeId);
    api.sessions.answerCard(TOKEN, sizeId, { inputs: { q1: 'o2' } });
    const s = await second;
    expect(s.structuredContent).toMatchObject({ status: 'answered', message_id: sizeId });
    expect(textOf(s)).toContain('A: Large');
    api.sessions.answerCard(TOKEN, colorId, { inputs: { q1: 'o1' } });
    const f = await first;
    expect(f.structuredContent).toMatchObject({ status: 'answered', message_id: colorId });
    expect(textOf(f)).toContain('A: Blue');
  });

  it('given while the channel loop is in the middle of a poll', async () => {
    api.sessions.open(TOKEN);
    const c = await start();
    const card: { id?: string } = {};
    let answeredMidPoll = false;
    // The answer is recorded after the poll read its page, before the page is returned.
    const events = api.sessions.events.bind(api.sessions);
    api.sessions.events = (token, query) => {
      const page = events(token, query);
      if (card.id !== undefined && !answeredMidPoll) {
        answeredMidPoll = true;
        api.sessions.answerCard(TOKEN, card.id, { inputs: { q1: 'o2' } });
      }
      return page;
    };
    const pending = ask(c, [color]);
    const id = await cardWith('Which color?');
    card.id = id;
    const r = await pending;
    expect(answeredMidPoll).toBe(true);
    expect(r.structuredContent).toMatchObject({ status: 'answered', message_id: id });
    expect(textOf(r)).toContain('A: Green');
  });

  it('after a cancel, the call ends at once and closes the card; the loop goes on', async () => {
    api.sessions.open(TOKEN);
    const c = await start();
    const abort = new AbortController();
    const pending = c.client
      .callTool(
        { name: 'ask', arguments: { questions: [color], wait_s: 3600, dm: true } },
        { signal: abort.signal },
      )
      .catch(() => 'cancelled');
    const id = await cardWith('Which color?');
    abort.abort();
    expect(await pending).toBe('cancelled');
    await waitFor(() => session().cards.get(id)!.closedAt !== null);
    expect(session().cards.get(id)!.closedBy).toBe('app');
    // A late answer to the closed card is never accepted for nobody.
    api.sessions.answerCard(TOKEN, id, { inputs: { q1: 'o1' } });
    // The next question still gets its answer.
    const next = ask(c, [size]);
    const sizeId = await cardWith('Which size?');
    api.sessions.answerCard(TOKEN, sizeId, { inputs: { q1: 'o1' } });
    expect((await next).structuredContent).toMatchObject({ status: 'answered' });
    expect(session().cards.get(id)!.responses[0]?.status).toBe('recorded');
  });
});

describe("when the answer's event never arrives", () => {
  it('reads the answer back from the card while waiting, and accepts it', async () => {
    api.sessions.open(TOKEN);
    api.compat.sessionCardRead = true;
    api.sessions.loseCardEvents = () => true;
    // A read every 5 s of waiting: 50 ms.
    const c = await start({ checkEveryS: 5 });
    const pending = ask(c, [color, size]);
    const id = await cardWith('Which color?');
    api.sessions.answerCard(TOKEN, id, { inputs: { q1: 'o1', q2_other: 'Medium' } });
    const r = await pending;
    expect(r.structuredContent).toMatchObject({ status: 'answered', message_id: id });
    expect(textOf(r)).toContain('A: Blue');
    expect(textOf(r)).toContain('A: Medium');
    const card = session().cards.get(id)!;
    expect(card.responses[0]?.status).toBe('accepted');
    expect(card.closedBy).toBe('app');
    expect(api.requests.some((q) => q.path === `/v1/session/messages/${id}/card`)).toBe(true);
  });

  it('reads it back once more at the deadline, before it closes the card', async () => {
    api.sessions.open(TOKEN);
    api.compat.sessionCardRead = true;
    api.sessions.loseCardEvents = () => true;
    // No read before the deadline: 60 s of waiting is 300 ms.
    const c = await start({ msPerSecond: 5, checkEveryS: 100_000 });
    const pending = ask(c, [color], 60);
    const id = await cardWith('Which color?');
    api.sessions.answerCard(TOKEN, id, { inputs: { q1: 'o2' } });
    const r = await pending;
    expect(r.structuredContent).toMatchObject({ status: 'answered', message_id: id });
    expect(textOf(r)).toContain('A: Green');
    expect(session().cards.get(id)!.responses[0]?.status).toBe('accepted');
  });

  it('says it could not confirm that nobody answered when the card cannot be read', async () => {
    api.sessions.open(TOKEN);
    api.sessions.loseCardEvents = () => true;
    const c = await start({ msPerSecond: 2, graceMs: 200 });
    const pending = ask(c, [color], 60);
    const id = await cardWith('Which color?');
    api.sessions.answerCard(TOKEN, id, { inputs: { q1: 'o2' } });
    const r = await pending;
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({
      status: 'no_answer',
      reason: 'unconfirmed',
      message_id: id,
    });
    expect(textOf(r)).toContain("couldn't confirm that nobody answered");
    expect(textOf(r)).not.toContain('Nobody answered');
    expect(session().cards.get(id)!.closedBy).toBe('app');
  });

  it('says unconfirmed when the card closes with a respondent whose answer never came', async () => {
    api.sessions.open(TOKEN);
    // The answer's event is lost; the card's closing (one respondent) arrives.
    api.sessions.loseCardEvents = (type) => type === 'card.response';
    const c = await start({ msPerSecond: 2 });
    const pending = ask(c, [color], 60);
    const id = await cardWith('Which color?');
    api.sessions.answerCard(TOKEN, id, { inputs: { q1: 'o1' } });
    const r = await pending;
    expect(r.structuredContent).toMatchObject({ status: 'no_answer', reason: 'unconfirmed' });
  });
});

describe('when nobody answers', () => {
  it('times out when the server confirms it by reading the card', async () => {
    api.sessions.open(TOKEN);
    api.compat.sessionCardRead = true;
    api.sessions.loseCardEvents = () => true;
    const c = await start({ msPerSecond: 2, checkEveryS: 10, graceMs: 200 });
    const r = await ask(c, [color], 60);
    expect(r.structuredContent).toMatchObject({ status: 'no_answer', reason: 'timeout' });
    expect(textOf(r)).toContain('Nobody answered this question in buildIt.Social within 1 minute');
  });

  it("times out when the card's closing counts no respondents", async () => {
    api.sessions.open(TOKEN);
    const c = await start({ msPerSecond: 2 });
    const r = await ask(c, [color], 60);
    expect(r.structuredContent).toMatchObject({ status: 'no_answer', reason: 'timeout' });
  });

  it('ends as dismissed when the read finds the card dismissed', async () => {
    api.sessions.open(TOKEN);
    api.compat.sessionCardRead = true;
    api.sessions.loseCardEvents = () => true;
    const c = await start({ checkEveryS: 5 });
    const pending = ask(c, [color]);
    const id = await cardWith('Which color?');
    api.sessions.closeCardBy(TOKEN, id, 'owner');
    expect((await pending).structuredContent).toMatchObject({
      status: 'no_answer',
      reason: 'dismissed',
    });
  });
});

describe('the unconfirmed text', () => {
  it('asks Claude to tell the person, not to treat it as no answer', () => {
    const text = noAnswerText('unconfirmed', 60);
    expect(text).toContain('within 60 minutes');
    expect(text).toContain('Tell them with reply');
    expect(noAnswerText('unconfirmed', 1)).toContain('within 1 minute,');
  });
});
