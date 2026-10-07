/**
 * The chat toolset (read only): list_channels, read_channel and read_thread.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  CHANNELS,
  FakeApi,
  MESSAGES,
  sampleIdentity,
  TOKENS,
  uid,
  USERS,
} from './support/fake-api.js';
import {
  assertDefused,
  connect,
  HOSTILE,
  injectionIsInsideBlocks,
  type Connected,
} from './support/harness.js';

let api: FakeApi;
let open: Connected[] = [];

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
  await Promise.all(open.map((c) => c.close()));
  open = [];
  expect(api.violations).toEqual([]);
});

const CHAT = 'buildit_pat_test_chat_reader';

async function client(token: string = CHAT): Promise<Connected> {
  api.identities[CHAT] ??= sampleIdentity(['chat:read']);
  const c = await connect(api, token);
  open.push(c);
  return c;
}

describe('list_channels', () => {
  it("lists the person's channels, never direct messages or channels they aren't in", async () => {
    const c = await client();
    const r = await c.call('list_channels');
    const names = (r.structured.channels as { name: string }[]).map((x) => x.name);
    expect(names).toEqual(['Demo project', 'general', 'Operations']);
    expect(names).not.toContain('Sam Example');
    expect(names).not.toContain('leadership');
    expect(r.structured.channels).toContainEqual(
      expect.objectContaining({ name: 'Demo project', project: 'DEMO', visibility: 'public' }),
    );
    expect(r.text).toContain('- general · public · org-wide');
  });

  it('respects the token channel limits', async () => {
    const limited = 'buildit_pat_test_chat_limited';
    api.identities[limited] = sampleIdentity(['chat:read']);
    api.identities[limited].token.limits.channels = [{ id: CHANNELS.general, name: 'general' }];
    const c = await client(limited);
    const r = await c.call('list_channels');
    expect((r.structured.channels as { name: string }[]).map((x) => x.name)).toEqual(['general']);
    const outside = await c.call('read_channel', { channel: 'Demo project' });
    expect(outside.text).toContain('outside_limits (HTTP 403)');
  });

  it('wraps a hostile channel description', async () => {
    api.store.channels.find((x) => x.id === CHANNELS.general)!.description = HOSTILE;
    const c = await client();
    const r = await c.call('list_channels');
    assertDefused(r.text);
    expect(injectionIsInsideBlocks(r.text)).toBe(true);
  });
});

describe('read_channel', () => {
  it('reads top-level messages newest first, with reply counts', async () => {
    const c = await client();
    const r = await c.call('read_channel', { channel: 'general' });
    const messages = r.structured.messages as { id: string; reply_count: number; body: string }[];
    expect(messages.map((m) => m.id)).toEqual([MESSAGES.other, MESSAGES.root]);
    expect(messages[1]?.reply_count).toBe(1);
    expect(messages[1]?.body).toContain(
      '<untrusted_content source="message" author="Sam Example">',
    );
    expect(r.text).toContain('1 replies (read_thread)');
    expect(r.text).toContain('2 message(s) in general, newest first:');
  });

  it('reads only what came after since, and pages with a cursor', async () => {
    const c = await client();
    const since = await c.call('read_channel', {
      channel: CHANNELS.general,
      since: '2026-10-06T12:00:00Z',
    });
    expect((since.structured.messages as { id: string }[]).map((m) => m.id)).toEqual([
      MESSAGES.other,
    ]);
    expect(api.requests.at(-1)?.query).toBe('?since=2026-10-06T12%3A00%3A00Z');
    const first = await c.call('read_channel', { channel: 'general', limit: 1 });
    const cursor = first.structured.next_cursor as string;
    expect(cursor).toBeTruthy();
    const second = await c.call('read_channel', { channel: 'general', limit: 1, cursor });
    expect((second.structured.messages as { id: string }[])[0]?.id).toBe(MESSAGES.root);
    expect(second.text).toContain('This is the last page.');
  });

  it('never reads a direct message', async () => {
    const c = await client();
    const dm = await c.call('read_channel', { channel: CHANNELS.dm });
    expect(dm.isError).toBe(true);
    expect(dm.text).toContain('not_found (HTTP 404)');
  });

  it('wraps and defuses hostile messages, and shares a size budget', async () => {
    api.store.messages.push(
      {
        id: uid(9100),
        channelId: CHANNELS.general,
        authorId: USERS.sam.id,
        body: HOSTILE,
        parentId: null,
        createdAt: '2026-10-07T09:00:00Z',
        deleted: false,
        viaAgent: null,
      },
      ...Array.from({ length: 40 }, (_, n) => ({
        id: uid(9200 + n),
        channelId: CHANNELS.general,
        authorId: USERS.alexTwo.id,
        body: `Long message ${n} `.repeat(800),
        parentId: null,
        createdAt: `2026-10-05T${String(10 + (n % 10)).padStart(2, '0')}:00:${String(n).padStart(2, '0')}Z`,
        deleted: false,
        viaAgent: null,
      })),
    );
    const c = await client();
    const r = await c.call('read_channel', { channel: 'general', limit: 50 });
    assertDefused(r.text);
    expect(injectionIsInsideBlocks(r.text)).toBe(true);
    assertDefused(JSON.stringify(r.structured));
    expect(r.text).toContain('Call read_channel with a smaller limit');
    expect(r.text.length + JSON.stringify(r.structured).length).toBeLessThan(100_000);
  });

  it('is open-world and read-only, and hidden without chat:read', async () => {
    const c = await client();
    const tools = (await c.client.listTools()).tools;
    for (const name of ['list_channels', 'read_channel', 'read_thread']) {
      expect(tools.find((t) => t.name === name)?.annotations).toMatchObject({
        readOnlyHint: true,
        openWorldHint: true,
      });
    }
    const reader = await client(TOKENS.read);
    const names = (await reader.client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('read_channel');
  });
});

describe('read_thread', () => {
  it('reads a message and its replies, oldest first', async () => {
    const c = await client();
    const r = await c.call('read_thread', { message: MESSAGES.root });
    expect(r.structured).toMatchObject({
      root: { id: MESSAGES.root, reply_count: 1 },
      replies: [{ id: MESSAGES.reply, author: { name: 'Test User' } }],
      next_cursor: null,
    });
    expect(r.text).toContain('1 reply, oldest first:');
  });

  it('says what to do for a reply id or an unknown message', async () => {
    const c = await client();
    const reply = await c.call('read_thread', { message: MESSAGES.reply });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain('- message: ');
    const dm = await c.call('read_thread', { message: uid(9004) });
    expect(dm.isError).toBe(true);
  });

  it('defuses a hostile reply', async () => {
    api.store.messages.push({
      id: uid(9300),
      channelId: CHANNELS.general,
      authorId: USERS.sam.id,
      body: HOSTILE,
      parentId: MESSAGES.root,
      createdAt: '2026-10-06T10:00:00Z',
      deleted: false,
      viaAgent: null,
    });
    const c = await client();
    const r = await c.call('read_thread', { message: MESSAGES.root });
    assertDefused(r.text);
    expect(injectionIsInsideBlocks(r.text)).toBe(true);
  });
});
