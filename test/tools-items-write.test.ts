import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FakeApi, TOKENS, USERS } from './support/fake-api.js';
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

const item = (n: number) => api.store.items.find((i) => i.project === 'DEMO' && i.number === n)!;
const lastBody = (path: string): unknown =>
  api.requests.filter((r) => r.path === path).at(-1)?.body;

describe('create_item', () => {
  it('creates a story under an epic, with a generated idempotency key', async () => {
    const c = await client();
    const r = await c.call('create_item', {
      parent: 'DEMO-12',
      title: 'Show a tray icon',
      description: 'Ask @sam@example.com to review.',
      assignee: 'me',
      labels: ['frontend'],
      estimate: 5,
      custom: { Severity: 'Low' },
    });
    expect(r.isError).toBe(false);
    expect(r.structured).toMatchObject({
      created: true,
      item: {
        key: 'DEMO-130',
        type: 'Story',
        status: 'To do',
        parent: 'DEMO-12',
        estimate: 5,
        assignee: { id: USERS.me.id },
      },
    });
    const key = r.structured.idempotency_key as string;
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(lastBody('/v1/items')).toMatchObject({ parent: 'DEMO-12', idempotency_key: key });
    expect(r.text).toContain('Created DEMO-130 (Story, To do).');
    expect(item(130).description).toContain(`[@Sam Example](mention:${USERS.sam.id})`);

    // A retry with the same key returns the same item.
    const again = await c.call('create_item', {
      parent: 'DEMO-12',
      title: 'Show a tray icon',
      idempotency_key: key,
    });
    expect(again.structured).toMatchObject({ created: false, item: { key: 'DEMO-130' } });
    expect(again.text).toContain('Nothing new');
    expect(api.store.items.filter((i) => i.title === 'Show a tray icon')).toHaveLength(1);
  });

  it('creates a subtask, and an item at a position', async () => {
    const c = await client();
    const sub = await c.call('create_item', { parent: 'DEMO-42', title: 'Test on ARM' });
    expect(sub.structured).toMatchObject({ item: { type: 'Subtask', parent: 'DEMO-42' } });
    const placed = await c.call('create_item', {
      project: 'DEMO',
      type: 'Bug',
      title: 'Placed first',
      position: { before: 'DEMO-12' },
    });
    const list = await c.call('search_items', { projects: ['DEMO'], limit: 1 });
    expect((list.structured.items as { key: string }[])[0]?.key).toBe(
      (placed.structured.item as { key: string }).key,
    );
  });

  it('needs a project or a parent', async () => {
    const c = await client();
    const r = await c.call('create_item', { title: 'Orphan' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Give project (a key such as DEMO) or parent');
  });

  it('turns API refusals into actionable errors', async () => {
    const c = await client();
    const estimate = await c.call('create_item', { project: 'DEMO', title: 'X', estimate: 4 });
    expect(estimate.isError).toBe(true);
    expect(estimate.text).toContain('validation (HTTP 422)');
    expect(estimate.text).toContain('- estimate: Allowed: 1, 2, 3, 5, 8.');
    const label = await c.call('create_item', { project: 'DEMO', title: 'X', labels: ['nope'] });
    expect(label.text).toContain('- label: nope');
    const level = await c.call('create_item', { parent: 'DEMO-46', title: 'Too deep' });
    expect(level.text).toContain('An epic holds standard items');
  });

  it('is hidden from a read-only token, and the API refuses it anyway', async () => {
    const reader = await client(TOKENS.read);
    const { tools } = await reader.client.listTools();
    expect(tools.map((t) => t.name)).not.toContain('create_item');
    // Should a client call it anyway (a stale list), the API answers scope_missing.
    api.enqueue('/v1/items', {
      status: 403,
      body: {
        error: {
          code: 'scope_missing',
          message: 'This token lacks the projects:write scope.',
          details: { scope: 'projects:write', granted: ['projects:read'] },
        },
      },
    });
    const writer = await client();
    const r = await writer.call('create_item', { project: 'DEMO', title: 'X' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('scope_missing (HTTP 403)');
    expect(r.text).toContain('- needs: projects:write');
    expect(r.text).toContain("retrying with this token won't help");
    // The details list the token's scopes: no note sending the agent to whoami for them.
    expect(r.text).not.toContain('whoami lists the scopes');
  });

  it('defuses a hostile title in what it echoes back', async () => {
    const c = await client();
    const r = await c.call('create_item', { project: 'DEMO', title: HOSTILE.slice(0, 255) });
    expect(r.isError).toBe(false);
    assertDefused(r.text);
    expect(injectionIsInsideBlocks(r.text)).toBe(true);
    assertDefused(JSON.stringify(r.structured));
  });
});

describe('update_item', () => {
  it('appends to the description and changes fields in one write', async () => {
    const c = await client();
    const r = await c.call('update_item', {
      item: 'DEMO-42',
      if_version: 7,
      description_append: 'Also on macOS.',
      add_labels: ['docs'],
      priority: 'medium',
    });
    expect(r.isError).toBe(false);
    expect(r.structured).toMatchObject({
      item: { version: 8, description_version: 3, priority: 'medium', labels: ['backend', 'docs'] },
    });
    expect(lastBody('/v1/items/DEMO-42')).toEqual({
      if_version: 7,
      description: { mode: 'append', text: 'Also on macOS.' },
      add_labels: ['docs'],
      priority: 'medium',
    });
    expect(item(42).description).toMatch(/ends\.\n\ncc .*\n\nAlso on macOS\.$/s);
  });

  it('replaces the description with its version, and reports a conflict with the current one', async () => {
    const c = await client();
    const ok = await c.call('update_item', {
      item: 'DEMO-42',
      description_replace: 'New text.',
      description_version: 2,
    });
    expect(ok.structured).toMatchObject({ item: { description_version: 3 } });
    const stale = await c.call('update_item', {
      item: 'DEMO-42',
      description_replace: 'Other text.',
      description_version: 2,
    });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain('conflict (HTTP 409)');
    expect(stale.text).toContain(
      '- description changed; current: version 8, description_version 3',
    );
    expect(stale.text).toContain('What to do: Read it again, reapply your change');
    expect(stale.text).toContain('get_item reads the current item');
    expect(stale.text.match(/reapply your change/g)).toHaveLength(1);
  });

  it('reports an item version conflict', async () => {
    const c = await client();
    const r = await c.call('update_item', { item: 'DEMO-42', if_version: 3, title: 'Renamed' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('- item changed; current: version 7, description_version 2');
    expect(item(42).title).toBe('Share notices on Windows');
  });

  it('checks its own arguments before calling the API', async () => {
    const c = await client();
    const before = api.requests.length;
    const noVersion = await c.call('update_item', { item: 'DEMO-42', description_replace: 'x' });
    expect(noVersion.text).toContain('description_replace needs description_version');
    const both = await c.call('update_item', {
      item: 'DEMO-42',
      description_replace: 'x',
      description_append: 'y',
      description_version: 2,
    });
    expect(both.text).toContain('not both');
    const nothing = await c.call('update_item', { item: 'DEMO-42', if_version: 7 });
    expect(nothing.text).toContain('Nothing to change');
    const status = await c.call('update_item', { item: 'DEMO-42', status: 'Done' });
    expect(status.text).toContain('use transition_item');
    expect(api.requests.length).toBe(before);
  });

  it('clears fields with null', async () => {
    const c = await client();
    const r = await c.call('update_item', { item: 'DEMO-42', estimate: null, sprint: null });
    expect(r.structured).toMatchObject({ item: { estimate: null, sprint: null } });
  });
});

describe('assign_item', () => {
  it('assigns by email and unassigns', async () => {
    const c = await client();
    const r = await c.call('assign_item', { item: 'DEMO-43', assignee: 'sam@example.com' });
    expect(r.structured).toMatchObject({ item: { assignee: { name: 'Sam Example' } } });
    expect(r.text).toContain('DEMO-43 is assigned to Sam Example.');
    const none = await c.call('assign_item', { item: 'DEMO-43', assignee: 'none' });
    expect(none.structured).toMatchObject({ item: { assignee: null } });
    expect(lastBody('/v1/items/DEMO-43')).toEqual({ assignee: null });
    const nul = await c.call('assign_item', { item: 'DEMO-42', assignee: null });
    expect(nul.text).toContain('DEMO-42 is unassigned.');
  });

  it('lists the candidates for an ambiguous name, and says when nobody matches', async () => {
    const c = await client();
    const ambiguous = await c.call('assign_item', { item: 'DEMO-43', assignee: 'Alex Example' });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toContain('alex.two@example.com');
    const unknown = await c.call('assign_item', { item: 'DEMO-43', assignee: 'Nobody Here' });
    expect(unknown.text).toContain('- user: Nobody Here');
  });
});

describe('transition_item', () => {
  it('moves an item, sets required fields and posts a comment', async () => {
    const c = await client();
    const r = await c.call('transition_item', {
      item: 'DEMO-44',
      status: 'done',
      set: { assignee: 'me' },
      comment: 'Verified, thanks @[Sam Example].',
    });
    expect(r.isError).toBe(false);
    expect(r.structured).toMatchObject({
      item: { status: 'Done', status_category: 'done', assignee: { id: USERS.me.id } },
      comment: { mentions: ['Sam Example'] },
    });
    expect(r.text).toContain('Moved DEMO-44 to Done (done).');
    expect(r.text).toContain('Comment posted:');
  });

  it('lists the moves allowed from the current status when a move is refused', async () => {
    const c = await client();
    const r = await c.call('transition_item', { item: 'DEMO-43', status: 'Done' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('transition_not_allowed (HTTP 422)');
    expect(r.text).toContain('- moves allowed from here: In progress; Canceled');
    expect(r.text).toContain('From To do, DEMO-43 can move to: In progress; Canceled.');
    expect(r.text).toContain('move in steps');
    // The error's own moves are enough: no extra reads.
    expect(api.requests.at(-1)?.path).toBe('/v1/items/DEMO-43/transition');
  });

  it('shows what each allowed move needs, from the error', async () => {
    const c = await client();
    const r = await c.call('transition_item', { item: 'DEMO-44', status: 'To do' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(
      'From In review, DEMO-44 can move to: Done (needs assignee); In progress.',
    );
  });

  it('reads the allowed moves from the project when an older API sends none', async () => {
    api.compat.moves = false;
    api.compat.hints = false;
    const c = await client();
    const r = await c.call('transition_item', { item: 'DEMO-43', status: 'Done' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('- allowed from here: In progress, Canceled');
    expect(r.text).toContain(
      'From To do (workflow Software), DEMO-43 can move to: In progress; Canceled.',
    );
    // Without the API's hint, the contract's wording is used.
    expect(r.text).toContain('What to do: Move to one of details.allowed');
    expect(api.requests.map((x) => x.path)).toContain('/v1/projects/DEMO');
  });

  it('says how to pass the fields a move requires', async () => {
    const c = await client();
    const r = await c.call('transition_item', { item: 'DEMO-44', status: 'Done' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('field_required (HTTP 422)');
    expect(r.text).toContain('- set: assignee');
    expect(r.text).toContain('Pass them in set');
  });

  it('reports a version conflict and an unknown status', async () => {
    const c = await client();
    const conflict = await c.call('transition_item', {
      item: 'DEMO-43',
      status: 'In progress',
      if_version: 9,
    });
    expect(conflict.text).toContain('conflict (HTTP 409)');
    const unknown = await c.call('transition_item', { item: 'DEMO-43', status: 'Shipped' });
    expect(unknown.text).toContain('- status: Shipped');
    expect(unknown.text).toContain("What to do: describe_project lists the project's statuses");
  });
});

describe('link_items and unlink_items', () => {
  it('adds a link, and adding it again changes nothing', async () => {
    const c = await client();
    const r = await c.call('link_items', { item: 'DEMO-44', kind: 'blocks', target: 'DEMO-43' });
    expect(r.structured).toMatchObject({ created: true, target: 'DEMO-43', item: 'DEMO-44' });
    const again = await c.call('link_items', {
      item: 'DEMO-43',
      kind: 'blocked_by',
      target: 'DEMO-44',
    });
    expect(again.structured).toMatchObject({ created: false, kind: 'blocked_by' });
    expect(again.text).toContain('Nothing changed');
  });

  it('removes a link by kind and target, or by id', async () => {
    const c = await client();
    const r = await c.call('unlink_items', {
      item: 'DEMO-43',
      kind: 'blocked_by',
      target: 'demo-42',
    });
    expect(r.structured).toMatchObject({ removed: true, item: 'DEMO-43' });
    expect(api.store.links).toHaveLength(0);
    const missing = await c.call('unlink_items', {
      item: 'DEMO-43',
      kind: 'blocked_by',
      target: 'DEMO-42',
    });
    expect(missing.isError).toBe(false);
    expect(missing.structured).toMatchObject({ removed: false, link_id: null });
    const added = await c.call('link_items', {
      item: 'DEMO-45',
      kind: 'relates',
      target: 'DEMO-44',
    });
    const byId = await c.call('unlink_items', {
      item: 'DEMO-44',
      link_id: added.structured.link_id as string,
    });
    expect(byId.structured).toMatchObject({ removed: true });
  });

  it('needs a link id, or a kind and a target, to remove', async () => {
    const c = await client();
    const r = await c.call('unlink_items', { item: 'DEMO-43', kind: 'blocks' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Give link_id, or both kind and target.');
    expect(api.requests).toHaveLength(1); // the identity read only
  });

  it('marks only removing as destructive', async () => {
    const c = await client();
    const { tools } = await c.client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(byName.link_items).toMatchObject({
      destructiveHint: false,
      idempotentHint: true,
      readOnlyHint: false,
    });
    expect(byName.unlink_items).toMatchObject({
      destructiveHint: true,
      idempotentHint: true,
      readOnlyHint: false,
    });
  });
});

describe('rank_item', () => {
  it('moves an item before another', async () => {
    const c = await client();
    const r = await c.call('rank_item', { item: 'DEMO-45', before: 'DEMO-12' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('Moved DEMO-45 before DEMO-12.');
    const list = await c.call('search_items', { projects: ['DEMO'], limit: 2 });
    expect((list.structured.items as { key: string }[]).map((i) => i.key)).toEqual([
      'DEMO-45',
      'DEMO-12',
    ]);
  });

  it('needs exactly one of before and after', async () => {
    const c = await client();
    const r = await c.call('rank_item', { item: 'DEMO-45', before: 'DEMO-12', after: 'DEMO-42' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Give exactly one of before or after.');
    const cross = await c.call('rank_item', { item: 'DEMO-45', after: 'OPS-1' });
    expect(cross.text).toContain('Rank within one project.');
  });
});
