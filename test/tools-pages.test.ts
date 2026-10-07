/**
 * The pages toolset: list_pages, get_page, create_page and update_page.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PAGE_WINDOW_CHARS } from '../src/tools/pages.js';
import { CHANNELS, FakeApi, PAGES, sampleIdentity, TOKENS, uid } from './support/fake-api.js';
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

async function client(token: string = TOKENS.full): Promise<Connected> {
  const c = await connect(api, token);
  open.push(c);
  return c;
}

const page = (id: string) => api.store.pages.find((p) => p.id === id)!;

describe('list_pages', () => {
  it("lists a channel's pages by name or id, without bodies", async () => {
    const c = await client();
    const r = await c.call('list_pages', { channel: 'Demo project' });
    expect(r.isError).toBe(false);
    expect(r.structured.pages).toMatchObject([
      { id: PAGES.home, title: 'Home', is_home: true, version: 3, parent_id: null },
      { id: PAGES.spec, title: 'Agent access spec', parent_id: PAGES.home },
    ]);
    expect(JSON.stringify(r.structured)).not.toContain('Start here');
    const byId = await c.call('list_pages', { channel: CHANNELS.demo, limit: 1 });
    expect((byId.structured.pages as unknown[]).length).toBe(1);
    expect(byId.text).toContain('call list_pages again');
  });

  it('says what to do for a channel the person is not in', async () => {
    const c = await client();
    const r = await c.call('list_pages', { channel: 'leadership' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('not_found (HTTP 404)');
    expect(r.text).toContain('list_channels and list_pages find channels and pages');
  });

  it('respects the token channel limits', async () => {
    const limited = 'buildit_pat_test_pages_limited';
    api.identities[limited] = sampleIdentity(['pages:read']);
    api.identities[limited].token.limits.channels = [{ id: CHANNELS.general, name: 'general' }];
    const c = await client(limited);
    const r = await c.call('list_pages', { channel: 'Demo project' });
    expect(r.text).toContain('outside_limits (HTTP 403)');
  });
});

describe('get_page', () => {
  it('reads a page with its version, the body wrapped', async () => {
    const c = await client(TOKENS.full);
    const r = await c.call('get_page', { page: PAGES.home });
    expect(r.structured.page).toMatchObject({
      id: PAGES.home,
      version: 3,
      channel: { name: 'Demo project' },
      updated_by: { name: 'Sam Example' },
      next_offset: null,
    });
    expect(r.text).toContain('<untrusted_content source="page" author="Sam Example">');
    expect(r.text).toContain('# Demo project');
    expect(r.text).toContain('version 3');
  });

  it('reads a long page in windows', async () => {
    const long = 'x'.repeat(PAGE_WINDOW_CHARS) + 'TAIL'.repeat(1000);
    page(PAGES.spec).body = long;
    const c = await client();
    const first = await c.call('get_page', { page: PAGES.spec });
    const p = first.structured.page as { next_offset: number; body_length: number };
    expect(p.next_offset).toBe(PAGE_WINDOW_CHARS);
    expect(p.body_length).toBe(long.length);
    expect(first.text).toContain(`offset=${PAGE_WINDOW_CHARS} to read on`);
    expect(first.text).not.toContain('TAIL');
    const second = await c.call('get_page', { page: PAGES.spec, offset: PAGE_WINDOW_CHARS });
    expect(second.text).toContain('TAILTAIL');
    expect((second.structured.page as { next_offset: number | null }).next_offset).toBeNull();
    // One window, in the text and the structured content, stays well under 25k tokens.
    expect(first.text.length + JSON.stringify(first.structured).length).toBeLessThan(60_000);
  });

  it('says what to do for an unknown page', async () => {
    const c = await client();
    const r = await c.call('get_page', { page: uid(8999) });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('- page: ');
  });

  it('wraps and defuses a hostile title and body', async () => {
    page(PAGES.spec).body = `Notes\n${HOSTILE}`;
    page(PAGES.spec).title = HOSTILE.slice(0, 200);
    const c = await client();
    const r = await c.call('get_page', { page: PAGES.spec });
    assertDefused(r.text);
    expect(injectionIsInsideBlocks(r.text)).toBe(true);
    assertDefused(JSON.stringify(r.structured));
    const list = await c.call('list_pages', { channel: 'Demo project' });
    assertDefused(list.text);
    expect(injectionIsInsideBlocks(list.text)).toBe(true);
  });
});

describe('create_page', () => {
  it('creates a page under a parent, with a generated idempotency key', async () => {
    const c = await client();
    const r = await c.call('create_page', {
      channel: 'Demo project',
      title: 'Runbook',
      body: '## Steps\n\n1. Rotate the keys.',
      parent_id: PAGES.home,
    });
    expect(r.isError).toBe(false);
    const key = r.structured.idempotency_key as string;
    expect(r.structured).toMatchObject({ created: true, page: { id: key, version: 1 } });
    expect(page(key)).toMatchObject({ parentId: PAGES.home, viaAgent: 'Test token' });
    const again = await c.call('create_page', {
      channel: 'Demo project',
      title: 'Runbook',
      idempotency_key: key,
    });
    expect(again.structured).toMatchObject({ created: false });
    expect(again.text).toContain('Nothing new');
    expect(api.store.pages.filter((p) => p.title === 'Runbook')).toHaveLength(1);
  });

  it('turns API refusals into actionable errors', async () => {
    const c = await client();
    const parent = await c.call('create_page', {
      channel: 'general',
      title: 'Wrong parent',
      parent_id: PAGES.home,
    });
    expect(parent.text).toContain('validation (HTTP 422)');
    expect(parent.text).toContain('- parent_id: Not a page of this channel.');
    const clash = await c.call('create_page', {
      channel: 'Demo project',
      title: 'Clash',
      idempotency_key: api.store.items[0]!.id,
    });
    expect(clash.text).toContain('idempotency_conflict (HTTP 409)');
  });

  it('is hidden from a token that can only read pages', async () => {
    const reader = 'buildit_pat_test_page_reader';
    api.identities[reader] = sampleIdentity(['pages:read']);
    const c = await client(reader);
    const names = (await c.client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(['whoami', 'get_page', 'list_pages']);
  });
});

describe('update_page', () => {
  it('updates with the version read, and makes a conflict actionable', async () => {
    const c = await client();
    const ok = await c.call('update_page', {
      page: PAGES.home,
      version: 3,
      body: '# Demo project\n\nStart here. Then read the spec.',
    });
    expect(ok.isError).toBe(false);
    expect(ok.structured.page).toMatchObject({ version: 4, updated_via_agent: 'Test token' });
    expect(ok.text).toContain('it is now version 4');

    // Someone else edits it in between.
    page(PAGES.home).version = 5;
    const stale = await c.call('update_page', { page: PAGES.home, version: 4, title: 'Start' });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain('conflict (HTTP 409)');
    expect(stale.text).toContain('- page changed; current: version 5');
    expect(stale.text).toContain(`Call get_page with page="${PAGES.home}"`);
    expect(page(PAGES.home).title).toBe('Home');
  });

  it('needs something to change, and moves a page to the top with parent_id null', async () => {
    const c = await client();
    const before = api.requests.length;
    const nothing = await c.call('update_page', { page: PAGES.spec, version: 1 });
    expect(nothing.text).toContain('Nothing to change');
    expect(api.requests.length).toBe(before);
    const moved = await c.call('update_page', { page: PAGES.spec, version: 1, parent_id: null });
    expect(moved.structured.page).toMatchObject({ parent_id: null, version: 2 });
  });

  it('is marked destructive, since the body is replaced as a whole', async () => {
    const c = await client();
    const tools = (await c.client.listTools()).tools;
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(byName.update_page).toMatchObject({ destructiveHint: true, idempotentHint: true });
    expect(byName.create_page).toMatchObject({ destructiveHint: false, idempotentHint: false });
    expect(byName.get_page).toMatchObject({ readOnlyHint: true });
  });
});
