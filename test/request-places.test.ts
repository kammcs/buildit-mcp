/**
 * Posting by request (agent API 1.15.0): a thread's or an item's request
 * result goes to the request's own thread or item thread, whatever thread
 * is the latest and with no binding: the Apply cards of propose_new_items
 * and propose_item_changes with `request` (never moved to the direct
 * message), reply's notes, the per-place cap, and the refusals in words.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { CallToolResult } from '@modelcontextprotocol/client';

import { uuidV5 } from '../src/tools/ask.js';
import { CARD_STEP, planResolvedContent, REQUEST_CARD_NOTE } from '../src/tools/plans.js';
import {
  channelConfig,
  channelNotes,
  startChannel,
  waitFor,
  type ChannelClient,
} from './support/channel-harness.js';
import { FakeApi } from './support/fake-api.js';
import { demoItem, SESSION_IDS, SESSION_TOKENS } from './support/fake-sessions.js';

const TOKEN = SESSION_TOKENS.first;
const THREAD = '00000000-0000-4000-8000-0000000c0001';

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

const session = () => api.sessions.session(TOKEN);
const textOf = (r: CallToolResult): string =>
  (r.content as { type: string; text: string }[]).map((c) => c.text).join('\n');

/** The DEMO item with this number, as a request's context names it. */
function storeItem(n: number): { id: string; key: string } {
  const i = api.store.items.find((x) => x.project === 'DEMO' && x.number === n);
  if (!i) throw new Error(`no DEMO-${n}`);
  return { id: i.id, key: `DEMO-${n}` };
}

async function start(): Promise<ChannelClient> {
  api.sessions.open(TOKEN, 'laptop');
  api.identities[TOKEN]!.token.scopes = ['projects:write', 'chat:read'];
  const c = await startChannel(api, stops, {
    config: channelConfig(api, { BUILDIT_TOOLSETS: 'all' }),
    stdio: { ask: { msPerSecond: 10 }, typing: { everyMs: 60_000 } },
  });
  await waitFor(() => session().heartbeats.includes('online'));
  return c;
}

async function notes(c: ChannelClient, n: number) {
  await waitFor(() => channelNotes(c.notes).length >= n);
  return channelNotes(c.notes);
}

/** A thread_to_items request on THREAD, delivered. */
async function threadRequest(c: ChannelClient, already = 0): Promise<string> {
  const { requestId } = api.sessions.pushRequest(TOKEN, {
    kind: 'thread_to_items',
    context: {
      type: 'thread',
      channel: { id: SESSION_IDS.demoChannel, name: 'general', dm: false },
      thread_id: THREAD,
    },
    place: 'thread',
  });
  await notes(c, already + 1);
  return requestId;
}

/** An item_thread request (triage by default) on these items, delivered. */
async function itemRequest(
  c: ChannelClient,
  items: { id: string; key: string }[],
  kind = 'triage',
  already = 0,
): Promise<string> {
  const { requestId } = api.sessions.pushRequest(TOKEN, {
    kind,
    context: items.length === 1 ? { type: 'item', item: items[0] } : { type: 'items', items },
    place: 'item_thread',
  });
  await notes(c, already + 1);
  return requestId;
}

const NEW_ITEMS = {
  project: 'DEMO',
  items: [
    {
      ref: 'a1',
      title: 'Export reports as CSV',
      description: 'Why and what.\n\n## Acceptance criteria\n- [ ] A CSV downloads',
      priority: 'high',
      labels: ['backend'],
    },
    { ref: 'a2', title: 'Write the CSV writer', parent: { ref: 'a1' } },
    { ref: 'a3', title: 'Add the download button', parent: { ref: 'a1' } },
  ],
};

const cardPosts = () =>
  api.requests
    .filter((r) => r.method === 'POST' && r.path === '/v1/session/plan-cards')
    .map((r) => r.body as Record<string, unknown>);

describe('propose_new_items for a thread request', () => {
  it("posts one card in the request's thread, whatever thread is the latest; nothing exists before the tap", async () => {
    const c = await start();
    const dm = api.sessions.postFrom(TOKEN, 'Hi');
    await notes(c, 1);
    const request = await threadRequest(c, 1);
    const before = api.store.items.length;
    const r = await c.client.callTool({
      name: 'propose_new_items',
      arguments: { ...NEW_ITEMS, request },
    });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(api.store.items).toHaveLength(before);
    const handle = (r.structuredContent as { handle: string }).handle;
    expect(cardPosts().at(-1)).toEqual({
      handle,
      id: uuidV5(`plan:${handle}`),
      thread_id: THREAD,
      request,
    });
    expect(cardPosts().at(-1)?.thread_id).not.toBe(dm);
    expect(session().cards.get(uuidV5(`plan:${handle}`))).toMatchObject({
      kind: 'plan',
      threadId: THREAD,
      action: 'create_items',
    });
    expect(textOf(r)).toContain(CARD_STEP);
    expect(textOf(r)).toContain(REQUEST_CARD_NOTE);
    // A request's card lasts 24 hours.
    expect((r.structuredContent as { expires_at: string }).expires_at).toMatch(/^2026-10-08T15:0/);
    expect(api.sessions.requests.get(request)?.status).toBe('answered');
    // The preview names each new item and its parent.
    expect(textOf(r)).toContain('Creates 3 item(s) in DEMO.');
    expect(textOf(r)).toContain('+ Subtask "Write the CSV writer" — parent: {ref a1}');
    // The session still can't apply it.
    const applied = await c.client.callTool({ name: 'apply_plan', arguments: { handle } });
    expect(applied.isError).toBe(true);
    expect(textOf(applied)).toContain('plan_card_required');
    expect(api.store.items).toHaveLength(before);
  });

  it('tells Claude the keys once the person applies it', () => {
    // The card.closed event's plan, as the loop hands it to planResolvedContent.
    const created = planResolvedContent({
      handle: 'h'.repeat(32),
      outcome: 'applied',
      result: {
        action: 'create_items',
        items: [
          { id: '00000000-0000-4000-8000-000000000201', key: 'DEMO-50', title: 'A' },
          { id: '00000000-0000-4000-8000-000000000202', key: 'DEMO-51', title: 'B' },
        ],
      },
    });
    expect(created?.content).toContain('Created 2 item(s): DEMO-50, DEMO-51.');
    const changed = planResolvedContent({
      handle: 'h'.repeat(32),
      outcome: 'applied',
      result: {
        action: 'edit_items',
        items: [{ id: '00000000-0000-4000-8000-000000000201', key: 'DEMO-42', title: 'A' }],
        links_added: 1,
      },
    });
    expect(changed?.content).toContain('Changed 1 item(s): DEMO-42; 1 link(s) added.');
  });

  it('refuses another place before any call: an item, or another thread', async () => {
    const c = await start();
    const request = await threadRequest(c);
    const before = api.requests.length;
    for (const card_thread of ['DEMO-42', '00000000-0000-4000-8000-0000000c0002']) {
      const r = await c.client.callTool({
        name: 'propose_new_items',
        arguments: { ...NEW_ITEMS, request, card_thread },
      });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain('request_result_private');
      expect(textOf(r)).toContain(`the thread it was made in (thread_id ${THREAD})`);
    }
    expect(api.requests.slice(before).filter((x) => x.path.startsWith('/v1/plans'))).toEqual([]);
  });

  it('checks the refs before any call: unique, and a parent earlier in the list', async () => {
    const c = await start();
    const request = await threadRequest(c);
    const before = api.requests.length;
    const twice = await c.client.callTool({
      name: 'propose_new_items',
      arguments: {
        project: 'DEMO',
        request,
        items: [
          { ref: 'a1', title: 'One' },
          { ref: 'a1', title: 'Two' },
        ],
      },
    });
    expect(twice.isError).toBe(true);
    expect(textOf(twice)).toContain('ref "a1" is used twice');
    const later = await c.client.callTool({
      name: 'propose_new_items',
      arguments: {
        project: 'DEMO',
        request,
        items: [
          { ref: 'a1', title: 'Child', parent: { ref: 'a2' } },
          { ref: 'a2', title: 'Parent' },
        ],
      },
    });
    expect(later.isError).toBe(true);
    expect(textOf(later)).toContain('must be an earlier item of this plan');
    expect(api.requests.length).toBe(before);
  });
});

describe('propose_item_changes for an item request', () => {
  it("goes to the item's own thread with no binding, and is never moved to the direct message", async () => {
    const c = await start();
    const item = storeItem(42);
    const request = await itemRequest(c, [item], 'item_helper.spec');
    const r = await c.client.callTool({
      name: 'propose_item_changes',
      arguments: {
        request,
        items: [
          {
            item: 'DEMO-42',
            description: {
              mode: 'append',
              text: '## Acceptance criteria\n- [ ] The notice shows',
              description_version: 2,
            },
          },
        ],
      },
    });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(cardPosts().at(-1)).toMatchObject({ thread_id: item.id, request });
    expect(textOf(r)).toContain('description: version 2 → +2 lines (append)');

    // A refusal in the item's thread is an error: no second post anywhere.
    api.plansOutsideThread = true;
    const posted = cardPosts().length;
    const refused = await c.client.callTool({
      name: 'propose_item_changes',
      arguments: { request, items: [{ item: 'DEMO-42', priority: 'urgent' }] },
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('plan_outside_thread');
    expect(textOf(refused)).toContain("A request's card goes only to the request's place");
    expect(cardPosts()).toHaveLength(posted + 1);
    expect(cardPosts().at(-1)).toMatchObject({ thread_id: item.id });
  });

  it('needs the item named when the request has several, and only one of them', async () => {
    const c = await start();
    const a = storeItem(42);
    const b = storeItem(44);
    const request = await itemRequest(c, [a, b]);
    const unnamed = await c.client.callTool({
      name: 'propose_item_changes',
      arguments: { request, items: [{ item: 'DEMO-44', priority: 'high' }] },
    });
    expect(unnamed.isError).toBe(true);
    expect(textOf(unnamed)).toContain('several items (DEMO-42, DEMO-44)');
    const outside = await c.client.callTool({
      name: 'propose_item_changes',
      arguments: {
        request,
        card_thread: 'DEMO-43',
        items: [{ item: 'DEMO-43', priority: 'high' }],
      },
    });
    expect(outside.isError).toBe(true);
    expect(textOf(outside)).toContain('request_result_private');
    const named = await c.client.callTool({
      name: 'propose_item_changes',
      arguments: {
        request,
        card_thread: 'demo-44',
        items: [
          {
            item: 'DEMO-44',
            add_labels: ['frontend'],
            add_links: [{ kind: 'duplicates', target: 'DEMO-42' }],
          },
        ],
      },
    });
    expect(named.isError, textOf(named)).toBeFalsy();
    expect(cardPosts().at(-1)).toMatchObject({ thread_id: b.id, request });
    expect(textOf(named)).toContain('DEMO-44 duplicates DEMO-42');
  });

  it("checks each item's changes before any call", async () => {
    const c = await start();
    const request = await itemRequest(c, [storeItem(42)]);
    const before = api.requests.length;
    for (const [items, says] of [
      [[{ item: 'DEMO-42' }], 'has nothing to change'],
      [
        [
          { item: 'DEMO-42', priority: 'high' },
          { item: '#demo-42', priority: 'low' },
        ],
        'listed twice',
      ],
      [
        [{ item: 'DEMO-42', add_links: [{ kind: 'relates', target: 'DEMO-42' }] }],
        'link to itself',
      ],
    ] as const) {
      const r = await c.client.callTool({
        name: 'propose_item_changes',
        arguments: { request, items },
      });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain(says);
    }
    expect(api.requests.length).toBe(before);
  });

  it("asks for card_thread when this session doesn't know the request", async () => {
    const c = await start();
    const before = api.requests.length;
    const r = await c.client.callTool({
      name: 'propose_item_changes',
      arguments: {
        request: '00000000-0000-4000-8000-0000000a0009',
        items: [{ item: 'DEMO-42', priority: 'high' }],
      },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("doesn't know that request");
    expect(api.requests.length).toBe(before);
  });
});

describe('reply with a thread or item request', () => {
  it("posts in the request's place by default, never the latest thread, and the server caps it at 3", async () => {
    const c = await start();
    const dm = api.sessions.postFrom(TOKEN, 'Hi');
    await notes(c, 1);
    const item = storeItem(44);
    const request = await itemRequest(c, [item], 'item_helper.stalled', 1);
    for (let i = 0; i < 3; i++) {
      const r = await c.client.callTool({
        name: 'reply',
        arguments: { text: `Stalled: blocked by DEMO-43 (${i}).`, request },
      });
      expect(r.isError, textOf(r)).toBeFalsy();
    }
    const posted = api.requests
      .filter((r) => r.path === '/v1/session/messages')
      .map((r) => r.body as Record<string, unknown>);
    expect(posted.at(-1)).toMatchObject({ thread_id: item.id, request });
    expect(posted.some((p) => p.thread_id === dm)).toBe(false);
    const fourth = await c.client.callTool({
      name: 'reply',
      arguments: { text: 'One more.', request },
    });
    expect(fourth.isError).toBe(true);
    expect(textOf(fourth)).toContain('request_post_limit');
    expect(textOf(fourth)).toContain('(HTTP 429)');
    // A note to the person still goes to the direct message, without request.
    const note = await c.client.callTool({
      name: 'reply',
      arguments: { text: 'Done with DEMO-44.', dm: true },
    });
    expect(note.isError).toBeFalsy();
  });

  it("refuses another thread before any call, and a thread request's item", async () => {
    const c = await start();
    const request = await threadRequest(c);
    const before = api.requests.length;
    for (const where of [
      { item: 'DEMO-42' },
      { thread_id: '00000000-0000-4000-8000-0000000c0009' },
    ]) {
      const r = await c.client.callTool({
        name: 'reply',
        arguments: { text: 'Nothing to turn into items.', request, ...where },
      });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain('request_result_private');
    }
    expect(api.requests.length).toBe(before);
    const ok = await c.client.callTool({
      name: 'reply',
      arguments: { text: 'Nothing to turn into items.', request },
    });
    expect(ok.isError, textOf(ok)).toBeFalsy();
    expect(
      api.requests.filter((r) => r.path === '/v1/session/messages').at(-1)?.body,
    ).toMatchObject({ thread_id: THREAD, request });
  });

  it("says why the server refused a place it didn't remember", async () => {
    const c = await start();
    api.sessions.postFrom(TOKEN, 'Hi');
    await notes(c, 1);
    api.enqueue('/v1/session/messages', {
      status: 409,
      body: {
        error: {
          code: 'request_result_private',
          message: "This request's result goes only to its place.",
          details: {},
        },
      },
    });
    const r = await c.client.callTool({
      name: 'reply',
      arguments: { text: 'A note.', request: '00000000-0000-4000-8000-0000000a0009' },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('a thread\'s or an item\'s (result="thread" or "item_thread")');
  });
});

describe('against an older server', () => {
  it('refuses the new tools and request on a card before any call (agent API 1.14.0)', async () => {
    api.compat.v115 = false;
    api.meta = { ...api.meta, api_version: '1.14.0' };
    const c = await start();
    const before = api.requests.length;
    const r = await c.client.callTool({ name: 'propose_new_items', arguments: NEW_ITEMS });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("needs buildIt.Social's agent API 1.15.0 or newer");
    const tools = (await c.client.listTools()).tools.map((t) => t.name);
    expect(tools).not.toContain('ask_reporter');
    expect(tools).toContain('reply');
    expect(api.requests.slice(before).filter((x) => x.path !== '/v1/session/events')).toEqual([]);
  });

  it('keeps an item key known from the request, without get_item', async () => {
    const c = await start();
    const { id, key } = demoItem(77);
    const item = { id, key };
    const request = await itemRequest(c, [item], 'item_helper.related');
    const r = await c.client.callTool({
      name: 'reply',
      arguments: { text: 'Nothing related found.', request, item: 'DEMO-77' },
    });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(api.requests.some((x) => x.path === '/v1/items/DEMO-77')).toBe(false);
  });
});
