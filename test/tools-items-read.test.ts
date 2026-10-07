import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FakeApi, TOKENS, uid, USERS } from './support/fake-api.js';
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

async function client(token: string = TOKENS.read): Promise<Connected> {
  const c = await connect(api, token);
  open.push(c);
  return c;
}

const keys = (s: Record<string, unknown>): string[] =>
  (s.items as { key: string }[]).map((i) => i.key);

function makeHostile(): void {
  const item = api.store.items.find((i) => i.number === 43)!;
  item.title = HOSTILE.slice(0, 255);
  item.description = `Steps:\n${HOSTILE}`;
  api.store.comments.push({
    id: uid(6100),
    itemId: item.id,
    authorId: USERS.sam.id,
    body: HOSTILE,
    mentionIds: [],
    createdAt: '2026-10-07T12:00:00Z',
    viaAgent: null,
  });
}

describe('search_items', () => {
  it('filters by project, category and assignee', async () => {
    const c = await client();
    const r = await c.call('search_items', {
      projects: ['DEMO'],
      categories: ['not_started', 'started'],
      assignees: ['me'],
    });
    expect(r.isError).toBe(false);
    expect(keys(r.structured)).toEqual(['DEMO-12', 'DEMO-42']);
    expect(r.structured.text_search).toBe(false);
    const first = (r.structured.items as Record<string, unknown>[])[1];
    expect(first).toMatchObject({
      key: 'DEMO-42',
      status: 'In progress',
      status_category: 'started',
      assignee: { email: 'test.user@example.com' },
      parent: 'DEMO-12',
      labels: ['backend'],
      sprint: 'Sprint 3',
      version: 7,
      description_version: 2,
    });
    expect(first).not.toHaveProperty('description');
    expect(r.text).toContain('DEMO-42 · Story · In progress (started) · high · @Test User');
    // The request used the contract's parameter names.
    const req = api.requests.find((x) => x.path === '/v1/items');
    expect(req?.query).toContain('project=DEMO');
    expect(req?.query).toContain('category=not_started&category=started');
    expect(req?.headers['x-buildit-tool']).toBe('search_items');
  });

  it('pages through a long list with the cursor', async () => {
    const c = await client();
    const first = await c.call('search_items', { projects: ['DEMO'], statuses: ['To do'] });
    expect(keys(first.structured)).toHaveLength(25);
    const cursor = first.structured.next_cursor as string;
    expect(cursor).toBeTruthy();
    expect(first.text).toContain('call search_items again with the same arguments');
    const second = await c.call('search_items', {
      projects: ['DEMO'],
      statuses: ['To do'],
      cursor,
    });
    expect(keys(second.structured).length).toBeGreaterThan(0);
    expect(second.structured.next_cursor).toBeNull();
    const all = [...keys(first.structured), ...keys(second.structured)];
    expect(new Set(all).size).toBe(all.length);
    expect(all).toContain('DEMO-129');
  });

  it('sorts, and finds children of a parent', async () => {
    const c = await client();
    const sorted = await c.call('search_items', {
      projects: ['DEMO'],
      sort: ['-number'],
      limit: 2,
    });
    expect(keys(sorted.structured)).toEqual(['DEMO-129', 'DEMO-128']);
    const children = await c.call('search_items', { parent: 'demo-12' });
    expect(keys(children.structured)).toEqual(['DEMO-42', 'DEMO-43']);
  });

  it('searches text, best first, in one page', async () => {
    const c = await client();
    const r = await c.call('search_items', { query: 'notice' });
    expect(keys(r.structured)).toEqual(['DEMO-42', 'DEMO-46']);
    expect(r.structured.text_search).toBe(true);
    expect(r.structured.next_cursor).toBeNull();
    expect((r.structured.items as { match?: { snippet: string } }[])[0]?.match?.snippet).toContain(
      '<untrusted_content source="snippet">',
    );
    expect(r.text).toContain('Text search returns one page of at most 50');
  });

  it('refuses query with sort or cursor, without calling the API', async () => {
    const c = await client();
    const before = api.requests.length;
    const r = await c.call('search_items', { query: 'notice', sort: ['-updated_at'] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('buildit-mcp error: invalid_arguments');
    expect(r.text).toContain('query cannot be combined with sort or cursor');
    expect(api.requests.length).toBe(before);
  });

  it('returns descriptions with detail="full", in smaller pages', async () => {
    const c = await client();
    const r = await c.call('search_items', { parent: 'DEMO-12', detail: 'full', limit: 50 });
    const items = r.structured.items as { key: string; description?: string; custom?: unknown[] }[];
    expect(items[0]?.description).toContain('<untrusted_content source="description">');
    expect(items[0]?.custom).toEqual([{ field: 'Severity', kind: 'single_select', value: 'High' }]);
    expect(r.text).toContain('page size cut to 20');
    expect(api.requests.at(-1)?.query).toContain('limit=20');
  });

  it('lists the candidates when a name is ambiguous', async () => {
    const c = await client();
    const r = await c.call('search_items', { projects: ['DEMO'], assignees: ['Alex Example'] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('ambiguous (HTTP 422)');
    expect(r.text).toContain('- user "Alex Example" matches:');
    expect(r.text).toContain('alex.one@example.com');
    expect(r.text).toContain('alex.two@example.com');
  });

  it('wraps and defuses hostile titles', async () => {
    makeHostile();
    const c = await client();
    const r = await c.call('search_items', { parent: 'DEMO-12' });
    assertDefused(r.text);
    expect(injectionIsInsideBlocks(r.text)).toBe(true);
    const json = JSON.stringify(r.structured);
    assertDefused(json);
    expect(json).not.toContain('</untrusted_content>');
    const full = await c.call('search_items', { parent: 'DEMO-12', detail: 'full' });
    assertDefused(full.text);
    expect(injectionIsInsideBlocks(full.text)).toBe(true);
    assertDefused(JSON.stringify(full.structured));
  });
});

describe('get_item', () => {
  it('reads an item with its children, links and latest comments', async () => {
    const c = await client();
    const r = await c.call('get_item', { item: '#demo-42' });
    expect(r.isError).toBe(false);
    const s = r.structured as {
      item: Record<string, unknown>;
      children: { key: string }[];
      links: { kind: string; key: string }[];
      comments: { body: string; author: { name: string } }[];
      comments_next_cursor: string | null;
    };
    expect(s.item).toMatchObject({
      key: 'DEMO-42',
      version: 7,
      description_version: 2,
      description_truncated: false,
      custom: [{ field: 'Severity', kind: 'single_select', value: 'High' }],
    });
    expect(s.item.description).toContain('Show a notice when a share ends.');
    expect(s.children.map((x) => x.key)).toEqual(['DEMO-46']);
    expect(s.links).toEqual([
      expect.objectContaining({ kind: 'blocks', key: 'DEMO-43', status: 'To do' }),
    ]);
    expect(s.comments).toHaveLength(2);
    expect(s.comments[0]?.author.name).toBe('Sam Example');
    expect(s.comments_next_cursor).toBeNull();
    expect(s).not.toHaveProperty('history');
    expect(r.text).toContain('version 7 · description_version 2');
    expect(r.text).toContain('<untrusted_content source="comment" author="Sam Example">');
    expect(api.requests.at(-1)?.path).toBe('/v1/items/demo-42');
  });

  it('adds history on request', async () => {
    const c = await client();
    const r = await c.call('get_item', { item: 'DEMO-42', include_history: true });
    const history = r.structured.history as {
      field: string;
      old: string;
      old_label: string;
      new_label: string;
    }[];
    expect(history[0]?.field).toBe('status');
    // The raw value is the status id; the label is its name as people read it now.
    expect(history[0]?.old).toContain(uid(111));
    expect(history[0]).toMatchObject({ old_label: 'To do', new_label: 'In progress' });
    expect(r.text).toContain('changed status: To do -> In progress');
  });

  it('shows the raw history value when there is no label', async () => {
    const event = api.store.events[0]!;
    event.old_label = null;
    const c = await client();
    const r = await c.call('get_item', { item: 'DEMO-42', include_history: true });
    expect(r.text).toContain(`changed status: ${uid(111)} -> In progress`);
  });

  it('cuts a long description in concise mode and says how to read it all', async () => {
    const item = api.store.items.find((i) => i.number === 43)!;
    item.description = 'x'.repeat(5000);
    const c = await client();
    const concise = await c.call('get_item', { item: 'DEMO-43' });
    expect(
      (concise.structured.item as { description_truncated: boolean }).description_truncated,
    ).toBe(true);
    const full = await c.call('get_item', { item: 'DEMO-43', detail: 'full' });
    expect((full.structured.item as { description: string }).description).toContain(
      'x'.repeat(5000),
    );
  });

  it('points older comments to list_comments', async () => {
    const story = api.store.items.find((i) => i.number === 42)!;
    for (let n = 0; n < 6; n++) {
      api.store.comments.push({
        id: uid(6200 + n),
        itemId: story.id,
        authorId: USERS.me.id,
        body: `Note ${n}`,
        mentionIds: [],
        createdAt: `2026-10-07T15:0${n}:00Z`,
        viaAgent: null,
      });
    }
    const c = await client();
    const r = await c.call('get_item', { item: 'DEMO-42' });
    expect((r.structured.comments as unknown[]).length).toBe(5);
    expect(r.structured.comments_next_cursor).toBeTruthy();
    expect(r.text).toContain(
      'Older comments: call list_comments with item="DEMO-42", order="desc"',
    );
  });

  it('says "(no description)" instead of an empty block', async () => {
    const c = await client();
    const target = api.store.items.find((i) => i.project === 'DEMO' && i.number === 100)!;
    expect(target.description).toBe('');
    const r = await c.call('get_item', { item: 'DEMO-100' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('(no description)');
    expect(r.text).not.toContain('source="description"');
    expect((r.structured.item as { description: string }).description).toBe('');

    target.description = '   ';
    const blank = await c.call('get_item', { item: 'DEMO-100' });
    expect(blank.text).toContain('(no description)');
  });

  it('says what to do for an unknown item', async () => {
    const c = await client();
    const r = await c.call('get_item', { item: 'DEMO-999' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('not_found (HTTP 404)');
    expect(r.text).toContain('- item: DEMO-999');
    expect(r.text).toContain('What to do: Check the key with search_items');
  });

  it('rejects a malformed key before calling the API', async () => {
    const c = await client();
    const before = api.requests.length;
    const r = await c.call('get_item', { item: 'not a key' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('An item key such as DEMO-12');
    expect(api.requests.length).toBe(before);
  });

  it('wraps and defuses a hostile title, description and comment', async () => {
    makeHostile();
    const c = await client();
    const r = await c.call('get_item', { item: 'DEMO-43', include_history: true });
    expect(r.isError).toBe(false);
    assertDefused(r.text);
    expect(injectionIsInsideBlocks(r.text)).toBe(true);
    expect(r.text).toContain('[/untrusted_content>');
    const json = JSON.stringify(r.structured);
    assertDefused(json);
    // In structured content the title is a single defused line.
    expect((r.structured.item as { title: string }).title).not.toContain('\n');
    // The parent's view lists the hostile child inside a block.
    const parent = await c.call('get_item', { item: 'DEMO-12' });
    assertDefused(parent.text);
    expect(injectionIsInsideBlocks(parent.text)).toBe(true);
  });
});

describe('response size', () => {
  it('keeps the largest get_item well under the 25k-token guideline', async () => {
    const story = api.store.items.find((i) => i.number === 42)!;
    story.description = 'z'.repeat(250_000);
    for (let n = 0; n < 25; n++) {
      api.store.comments.push({
        id: uid(6500 + n),
        itemId: story.id,
        authorId: USERS.sam.id,
        body: 'w'.repeat(20_000),
        mentionIds: [],
        createdAt: '2026-10-07T16:00:00Z',
        viaAgent: null,
      });
    }
    const c = await client();
    const r = await c.call('get_item', { item: 'DEMO-42', detail: 'full', include_history: true });
    const size = r.text.length + JSON.stringify(r.structured).length;
    // About 4 characters a token: well under 25k tokens, text and structured content together.
    expect(size).toBeLessThan(90_000);
    expect(r.text).toContain('the person can read it in buildIt.Social');
    expect((r.structured.item as { description_truncated: boolean }).description_truncated).toBe(
      true,
    );
  });
});
