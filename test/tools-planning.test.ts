/**
 * The planning toolset: list_sprints, plan_sprint, list_releases,
 * plan_release and write_release_notes.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FakeApi, sampleIdentity, TOKENS } from './support/fake-api.js';
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

const demo = () => api.store.projects.find((p) => p.key === 'DEMO')!;
const item = (n: number) => api.store.items.find((i) => i.project === 'DEMO' && i.number === n)!;

describe('list_sprints', () => {
  it('lists sprints newest first, with counts and the goal wrapped', async () => {
    const c = await client(TOKENS.read);
    const r = await c.call('list_sprints', { project: 'DEMO' });
    expect(r.isError).toBe(false);
    const sprints = r.structured.sprints as { number: number; state: string; goal: string }[];
    expect(sprints.map((s) => s.number)).toEqual([3]);
    expect(sprints[0]).toMatchObject({ state: 'active', item_count: 1, done_count: 0 });
    expect(sprints[0]?.goal).toContain('<untrusted_content source="sprint_goal">');
    expect(r.text).toContain('#3 Sprint 3 · active · 2026-10-01 to 2026-10-14 · done 0 of 1');
    expect(r.text).toContain('This is the last page.');
  });

  it('filters by state', async () => {
    const c = await client();
    await c.call('plan_sprint', { project: 'DEMO', action: 'create', name: 'Sprint 4' });
    const r = await c.call('list_sprints', { project: 'DEMO', state: ['planned'] });
    expect((r.structured.sprints as { name: string }[]).map((s) => s.name)).toEqual(['Sprint 4']);
    expect(api.requests.at(-1)?.query).toBe('?state=planned');
  });

  it('defuses a hostile goal', async () => {
    demo().sprints[0]!.goal = HOSTILE;
    const c = await client();
    const r = await c.call('list_sprints', { project: 'DEMO' });
    assertDefused(r.text);
    expect(injectionIsInsideBlocks(r.text)).toBe(true);
    assertDefused(JSON.stringify(r.structured));
  });
});

describe('plan_sprint', () => {
  it('completes a sprint with one set of counts that agree, and explains carried items', async () => {
    const sprint3 = demo().sprints.find((s) => s.number === 3)!;
    const status = (name: string) => demo().statuses.find((s) => s.name === name)!.id;
    // In sprint 3: DEMO-42 (in progress) already; add one done and one canceled item.
    Object.assign(item(100), { sprintId: sprint3.id, statusId: status('Done'), estimate: 3 });
    Object.assign(item(101), { sprintId: sprint3.id, statusId: status('Canceled') });
    const c = await client();
    const r = await c.call('plan_sprint', {
      project: 'DEMO',
      action: 'complete',
      sprint: 'active',
      carry_to: 'new',
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.structured).toMatchObject({
      summary: { committed_count: 3, completed_count: 1, carried_count: 1 },
    });
    // The sprint's own counts no longer include the carried item: they are not shown.
    expect(r.structured.sprint).toMatchObject({ item_count: 2, done_count: 1 });
    const lines = r.text.split('\n');
    expect(lines[0]).toBe(
      'Completed sprint #3 Sprint 3: done 1 of 3 item(s) committed (3 of 6 points).',
    );
    expect(r.text).toContain(
      '1 open item(s) were carried to #4 Sprint 4; they count there now, no longer in this sprint.',
    );
    expect(r.text).toContain('1 canceled item(s) stay in this sprint, not done.');
    expect(r.text.match(/done \d+ of \d+/g)).toEqual(['done 1 of 3']);
    expect(r.text).toContain('- #3 Sprint 3 · completed');
  });

  it('says when nothing was left to carry', async () => {
    const sprint3 = demo().sprints.find((s) => s.number === 3)!;
    const done = demo().statuses.find((s) => s.name === 'Done')!.id;
    for (const i of api.store.items.filter((x) => x.sprintId === sprint3.id)) i.statusId = done;
    const c = await client();
    const r = await c.call('plan_sprint', { project: 'DEMO', action: 'complete', sprint: '3' });
    expect(r.text).toContain('done 1 of 1 item(s) committed');
    expect(r.text).toContain('No open items were left to carry.');
  });

  it('creates a sprint, fills it, starts and completes it', async () => {
    const c = await client();
    // Sprint 3 is active: complete it first, carrying its open item to a new sprint.
    const created = await c.call('plan_sprint', {
      project: 'DEMO',
      action: 'create',
      name: 'Sprint 4',
      goal: 'Polish',
      starts_on: '2026-10-15',
      ends_on: '2026-10-28',
    });
    expect(created.structured).toMatchObject({
      action: 'create',
      sprint: { number: 4, state: 'planned', name: 'Sprint 4' },
    });
    const added = await c.call('plan_sprint', {
      project: 'DEMO',
      action: 'add_items',
      sprint: '4',
      items: ['DEMO-43', 'demo-44'],
    });
    expect(added.structured).toMatchObject({ changed: ['DEMO-43', 'DEMO-44'] });
    expect(added.text).toContain('Added to sprint #4: DEMO-43, DEMO-44.');
    const again = await c.call('plan_sprint', {
      project: 'DEMO',
      action: 'add_items',
      sprint: 'Sprint 4',
      items: ['DEMO-43'],
    });
    expect(again.text).toContain('Nothing changed');

    const busy = await c.call('plan_sprint', { project: 'DEMO', action: 'start', sprint: '4' });
    expect(busy.isError).toBe(true);
    expect(busy.text).toContain('validation (HTTP 422)');
    expect(busy.text).toContain('- sprint: Another sprint is active');

    const done = await c.call('plan_sprint', {
      project: 'DEMO',
      action: 'complete',
      sprint: 'active',
    });
    expect(done.structured).toMatchObject({
      action: 'complete',
      sprint: { state: 'completed' },
      summary: { committed_count: 1, carried_count: 1, carried_to: '#4 Sprint 4' },
    });
    expect(item(42).sprintId).toBe(demo().sprints.find((s) => s.number === 4)!.id);

    const started = await c.call('plan_sprint', { project: 'DEMO', action: 'start', sprint: '4' });
    expect(started.structured).toMatchObject({ sprint: { state: 'active' } });

    const removed = await c.call('plan_sprint', {
      project: 'DEMO',
      action: 'remove_items',
      sprint: 'active',
      items: ['DEMO-43'],
    });
    expect(removed.structured).toMatchObject({ changed: ['DEMO-43'] });
    expect(item(43).sprintId).toBeNull();
  });

  it('checks its own arguments before calling the API', async () => {
    const c = await client();
    const before = api.requests.length;
    const noName = await c.call('plan_sprint', { project: 'DEMO', action: 'create' });
    expect(noName.isError).toBe(true);
    expect(noName.text).toContain('action "create" needs name.');
    const noSprint = await c.call('plan_sprint', {
      project: 'DEMO',
      action: 'add_items',
      items: ['DEMO-1'],
    });
    expect(noSprint.text).toContain('needs sprint');
    const noItems = await c.call('plan_sprint', {
      project: 'DEMO',
      action: 'add_items',
      sprint: 'active',
    });
    expect(noItems.text).toContain('needs items');
    expect(api.requests.length).toBe(before);
  });

  it('refuses more than 50 items in the input schema', async () => {
    const c = await client();
    const items = Array.from({ length: 51 }, (_, n) => `DEMO-${n + 100}`);
    const r = await c.call('plan_sprint', {
      project: 'DEMO',
      action: 'add_items',
      sprint: 'active',
      items,
    });
    expect(r.isError).toBe(true);
  });

  it('reports an unknown sprint and a refused permission', async () => {
    const c = await client();
    const unknown = await c.call('plan_sprint', {
      project: 'DEMO',
      action: 'add_items',
      sprint: '99',
      items: ['DEMO-43'],
    });
    expect(unknown.text).toContain('not_found (HTTP 404)');
    expect(unknown.text).toContain('- sprint: 99');
    demo().adminIds = [];
    const forbidden = await c.call('plan_sprint', {
      project: 'DEMO',
      action: 'complete',
      sprint: 'active',
    });
    expect(forbidden.text).toContain('forbidden (HTTP 403)');
    expect(forbidden.text).toContain('Ask a project admin');
  });
});

describe('list_releases and plan_release', () => {
  it('lists releases with counts', async () => {
    const c = await client(TOKENS.read);
    const r = await c.call('list_releases', { project: 'DEMO' });
    expect(r.structured.releases).toMatchObject([
      { name: '1.0.1', status: 'unreleased', item_count: 1, target_date: '2026-10-31' },
    ]);
    expect(r.text).toContain('- 1.0.1 · unreleased · target 2026-10-31 · 0/1 done');
    const filtered = await c.call('list_releases', { project: 'DEMO', status: ['released'] });
    expect(filtered.structured.releases).toEqual([]);
    expect(filtered.text).toContain('No releases in DEMO.');
  });

  it('creates a release, sets its items and ships it, moving open items on', async () => {
    const c = await client();
    const created = await c.call('plan_release', {
      project: 'DEMO',
      action: 'create',
      name: '1.1.0',
      target_date: '2026-11-30',
    });
    expect(created.structured).toMatchObject({ release: { name: '1.1.0', status: 'unreleased' } });
    const dup = await c.call('plan_release', { project: 'DEMO', action: 'create', name: '1.1.0' });
    expect(dup.text).toContain('- name: A release of this project already has that name.');

    const added = await c.call('plan_release', {
      project: 'DEMO',
      action: 'add_items',
      release: '1.0.1',
      items: ['DEMO-45', 'DEMO-43'],
    });
    expect(added.structured).toMatchObject({ changed: ['DEMO-45', 'DEMO-43'] });
    const removed = await c.call('plan_release', {
      project: 'DEMO',
      action: 'remove_items',
      release: '1.0.1',
      items: ['DEMO-43'],
    });
    expect(removed.structured).toMatchObject({ changed: ['DEMO-43'] });

    const shipped = await c.call('plan_release', {
      project: 'DEMO',
      action: 'release',
      release: '1.0.1',
      released_on: '2026-10-10',
      move_open_to: '1.1.0',
    });
    expect(shipped.structured).toMatchObject({
      release: { status: 'released', released_at: '2026-10-10T00:00:00Z', item_count: 1 },
    });
    // DEMO-44 was open, so it moved to 1.1.0; DEMO-45 is done and stays.
    expect(item(44).releaseId).toBe(demo().releases.find((r) => r.name === '1.1.0')!.id);
    const search = await c.call('search_items', { release: '1.1.0' });
    expect(search.isError).toBe(false);
  });

  it('needs a release for every action but create', async () => {
    const c = await client();
    const r = await c.call('plan_release', { project: 'DEMO', action: 'release' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('action "release" needs release');
  });

  it('defuses a hostile description', async () => {
    demo().releases[0]!.description = HOSTILE;
    const c = await client();
    const r = await c.call('list_releases', { project: 'DEMO' });
    assertDefused(r.text);
    expect(injectionIsInsideBlocks(r.text)).toBe(true);
  });
});

describe('write_release_notes', () => {
  it('creates the notes page, then never overwrites edits without the page version', async () => {
    const c = await client();
    const first = await c.call('write_release_notes', { project: 'DEMO', release: '1.0.1' });
    expect(first.structured).toMatchObject({
      created: true,
      needs_confirmation: false,
      page_version: 1,
    });
    expect(first.structured.markdown).toContain('<untrusted_content source="release_notes">');
    expect(first.text).toContain('- DEMO-44 Crash on start');
    const pageId = first.structured.page_id as string;
    const notes = api.store.pages.find((p) => p.id === pageId)!;
    expect(notes.body).toContain('DEMO-44 Crash on start');

    // Someone edits the page in the app.
    notes.body += '\n\nEdited by hand.';
    notes.version += 1;
    const blocked = await c.call('write_release_notes', { project: 'DEMO', release: '1.0.1' });
    expect(blocked.structured).toMatchObject({ needs_confirmation: true, page_version: 2 });
    expect(blocked.text).toContain('Nothing written');
    expect(blocked.text).toContain('page_version=2');
    expect(blocked.structured.markdown).toBeNull();
    expect(notes.body).toContain('Edited by hand.');

    const confirmed = await c.call('write_release_notes', {
      project: 'DEMO',
      release: '1.0.1',
      page_version: 2,
      locale: 'fr-CA',
    });
    expect(confirmed.structured).toMatchObject({ overwrote_edits: true, page_version: 3 });
    expect(notes.body).not.toContain('Edited by hand.');
  });

  it('needs pages:write too, and wraps and cuts the notes it shows', async () => {
    const writer = 'buildit_pat_test_planner_no_pages';
    api.identities[writer] = sampleIdentity(['projects:write']);
    const w = await client(writer);
    const names = (await w.client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('plan_release');
    expect(names).not.toContain('write_release_notes');

    api.store.items.find((i) => i.number === 44)!.title = HOSTILE.slice(0, 255);
    for (let n = 100; n < 130; n++) {
      const x = api.store.items.find((i) => i.number === n)!;
      x.releaseId = demo().releases[0]!.id;
      x.title = `A long title ${n} `.repeat(20).slice(0, 255);
    }
    const c = await client();
    const r = await c.call('write_release_notes', { project: 'DEMO', release: '1.0.1' });
    assertDefused(r.text);
    expect(injectionIsInsideBlocks(r.text)).toBe(true);
    expect(r.text).toContain('Call get_page with page=');
    expect((r.structured.markdown as string).length).toBeLessThan(8_500);
  });

  it('is destructive, and hidden from a token that can only read', async () => {
    const reader = await client(TOKENS.read);
    const names = (await reader.client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('list_releases');
    expect(names).not.toContain('write_release_notes');
    expect(names).not.toContain('plan_sprint');
    const writer = await client();
    const tool = (await writer.client.listTools()).tools.find(
      (t) => t.name === 'write_release_notes',
    );
    expect(tool?.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
  });

  it('reports an unknown project', async () => {
    const reader = 'buildit_pat_test_planning_reader';
    api.identities[reader] = sampleIdentity(['projects:read']);
    const c = await client(reader);
    const r = await c.client.callTool({
      name: 'list_sprints',
      arguments: { project: 'NOPE' },
    });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('not_found');
  });
});
