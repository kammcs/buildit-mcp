import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FakeApi, TOKENS, USERS } from './support/fake-api.js';
import { assertDefused, connect, HOSTILE, type Connected } from './support/harness.js';

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

describe('list_projects', () => {
  it('lists projects with keys and counts', async () => {
    const c = await client(TOKENS.read);
    const r = await c.call('list_projects');
    expect(r.isError).toBe(false);
    const projects = r.structured.projects as { key: string; item_counts: { done: number } }[];
    expect(projects.map((p) => p.key)).toEqual(['DEMO', 'OPS']);
    expect(projects[0]?.item_counts.done).toBe(1);
    expect(r.structured.next_cursor).toBeNull();
    expect(r.text).toContain('- DEMO: Demo project');
    expect(r.text).toContain('This is the last page.');
  });

  it('pages with a cursor', async () => {
    const c = await client();
    const first = await c.call('list_projects', { limit: 1 });
    expect((first.structured.projects as unknown[]).length).toBe(1);
    const cursor = first.structured.next_cursor as string;
    expect(cursor).toBeTruthy();
    expect(first.text).toContain('call list_projects again with the same arguments');
    expect(first.text).toContain(cursor);
    const second = await c.call('list_projects', { limit: 1, cursor });
    expect((second.structured.projects as { key: string }[])[0]?.key).toBe('OPS');
    expect(second.structured.next_cursor).toBeNull();
  });
});

describe('describe_project', () => {
  it('gives types, workflows with allowed moves, labels, fields and members', async () => {
    const c = await client(TOKENS.read);
    const r = await c.call('describe_project', { project: 'demo' });
    expect(r.isError).toBe(false);
    const s = r.structured as {
      project: { key: string; estimate_values: number[] };
      types: { name: string }[];
      workflows: {
        statuses: { name: string; allowed: { to: string; required_fields: string[] }[] }[];
      }[];
      labels: string[];
      members: { email: string }[];
    };
    expect(s.project).toMatchObject({ key: 'DEMO', estimate_values: [1, 2, 3, 5, 8] });
    expect(s.types.map((t) => t.name)).toContain('Subtask');
    const review = s.workflows[0]?.statuses.find((x) => x.name === 'In review');
    expect(review?.allowed).toContainEqual({
      to: 'Done',
      required_fields: ['assignee'],
      admins_only: false,
    });
    expect(s.labels).toEqual(['backend', 'frontend', 'docs']);
    expect(s.members.map((m) => m.email)).toContain('sam@example.com');
    expect(r.text).toContain('- In review [started] -> Done (needs assignee); In progress');
    expect(r.text).toContain('Severity (single_select; options High, Low)');
    expect(r.text).toContain('Sam Example <sam@example.com> (member)');
  });

  it('says what to do when the project does not exist', async () => {
    const c = await client();
    const r = await c.call('describe_project', { project: 'NOPE' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('buildIt.Social API error: not_found (HTTP 404)');
    expect(r.text).toContain('- project: NOPE');
    expect(r.text).toContain('What to do:');
  });

  it('defuses hostile names of statuses, labels and people', async () => {
    const demo = api.store.projects[0]!;
    demo.labels.push({ id: '00000000-0000-4000-8000-00000000ffff', name: HOSTILE.slice(0, 40) });
    demo.statuses[0]!.name = HOSTILE.slice(0, 60);
    api.store.users[1]!.display_name = HOSTILE.slice(0, 100);
    const c = await client();
    const r = await c.call('describe_project', { project: 'DEMO' });
    expect(r.isError).toBe(false);
    expect(r.text).not.toContain('</untrusted_content>');
    expect(r.text).not.toMatch(/\nIgnore previous/);
    expect(JSON.stringify(r.structured)).not.toContain('</untrusted_content>');
  });
});

describe('find_users', () => {
  it('searches the members by part of a name or email, through the members route', async () => {
    const c = await client(TOKENS.read);
    const r = await c.call('find_users', { project: 'DEMO', query: 'SAM' });
    expect(r.structured).toMatchObject({ project: 'DEMO', next_cursor: null });
    expect((r.structured.users as { email: string }[]).map((u) => u.email)).toEqual([
      'sam@example.com',
    ]);
    expect(api.requests.at(-1)?.path).toBe('/v1/projects/DEMO/members');
    expect(api.requests.at(-1)?.query).toBe('?q=SAM&limit=25');
    const alex = await c.call('find_users', { project: 'DEMO', query: 'alex' });
    expect(alex.structured.users).toHaveLength(2);
    expect(alex.text).toContain('alex.one@example.com');
    expect(alex.text).toContain('alex.two@example.com');
  });

  it('finds "me", and pages through everyone without a query', async () => {
    const c = await client();
    const me = await c.call('find_users', { project: 'DEMO', query: 'me' });
    expect((me.structured.users as { id: string }[]).map((u) => u.id)).toEqual([USERS.me.id]);
    const first = await c.call('find_users', { project: 'DEMO', limit: 3 });
    expect((first.structured.users as unknown[]).length).toBe(3);
    expect(first.text).toContain('call find_users again');
    const cursor = first.structured.next_cursor as string;
    const second = await c.call('find_users', { project: 'DEMO', limit: 3, cursor });
    expect((second.structured.users as unknown[]).length).toBe(1);
    expect(second.structured.next_cursor).toBeNull();
  });

  it('falls back to the project members on an older API without the members route', async () => {
    api.compat.membersRoute = false;
    const c = await client();
    const r = await c.call('find_users', { project: 'DEMO', query: 'alex' });
    expect(r.isError).toBe(false);
    expect(r.structured.users).toHaveLength(2);
    expect(api.requests.at(-1)?.path).toBe('/v1/projects/DEMO');
    const me = await c.call('find_users', { project: 'DEMO', query: 'me' });
    expect((me.structured.users as { id: string }[]).map((u) => u.id)).toEqual([USERS.me.id]);
  });

  it('says when nobody matches', async () => {
    const c = await client();
    const r = await c.call('find_users', { project: 'DEMO', query: 'nobody@example.com' });
    expect(r.isError).toBe(false);
    expect(r.structured.users).toEqual([]);
    expect(r.text).toContain('No member of DEMO matches');
  });

  it('defuses a hostile query echoed back', async () => {
    const c = await client();
    const r = await c.call('find_users', { project: 'DEMO', query: HOSTILE.slice(0, 100) });
    assertDefused(r.text);
    expect(r.text).not.toMatch(/\nIgnore previous/);
  });
});
