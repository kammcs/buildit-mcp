/**
 * Names that people write (people, the org, the token, projects, channels,
 * sprints, releases, statuses, types, labels, fields) come back inside
 * untrusted blocks in every tool's text, and capped in structured content.
 * The fake API's names are all poisoned (support/poison.ts).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CHANNELS, FakeApi, MESSAGES, PAGES, sampleIdentity, TOKENS } from './support/fake-api.js';
import {
  assertDefused,
  connect,
  expectOnlyInsideBlocks,
  type Connected,
} from './support/harness.js';
import { expectNamesContained, MARK, poisoned, poisonNames } from './support/poison.js';

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
  poisonNames(api);
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

/** Every read tool, with arguments that reach every name it shows. */
const READS: [string, Record<string, unknown>][] = [
  ['whoami', {}],
  ['list_projects', {}],
  ['describe_project', { project: 'DEMO' }],
  ['find_users', { project: 'DEMO' }],
  ['find_users', { project: 'DEMO', query: 'me' }],
  ['search_items', { projects: ['DEMO'], limit: 10 }],
  ['search_items', { projects: ['DEMO'], detail: 'full', limit: 5 }],
  ['search_items', { query: 'share' }],
  [
    'get_item',
    { item: 'DEMO-42', detail: 'full', include_history: true, include_development: true },
  ],
  ['get_item', { item: 'DEMO-12' }],
  ['get_item', { item: 'DEMO-43' }],
  ['list_comments', { item: 'DEMO-42' }],
  ['list_sprints', { project: 'DEMO' }],
  ['list_releases', { project: 'DEMO' }],
  ['list_pages', { channel: CHANNELS.demo }],
  ['get_page', { page: PAGES.home }],
  ['get_page', { page: PAGES.spec }],
  ['list_channels', {}],
  ['read_channel', { channel: CHANNELS.general }],
  ['read_thread', { message: MESSAGES.root }],
  ['get_workflow', { project: 'DEMO', workflow: 'Software' }],
  ['list_work_types', {}],
];

describe('person-written names', () => {
  it('stay inside untrusted blocks in every read tool', async () => {
    const c = await client();
    for (const [name, args] of READS) {
      const r = await c.call(name, args);
      expectNamesContained(`${name} ${JSON.stringify(args)}`, r);
      assertDefused(r.text);
      // The names are there (inside blocks); list_pages shows only titles.
      if (name !== 'list_pages') expect(r.text, name).toContain(MARK);
    }
  });

  it('stay inside untrusted blocks when the token is limited to channels', async () => {
    const limited = 'buildit_pat_test_poison_limited';
    api.identities[limited] = sampleIdentity(['projects:read', 'chat:read']);
    api.identities[limited].token.limits.channels = [
      { id: CHANNELS.general, name: poisoned('limit channel') },
    ];
    api.identities[limited].org.name = poisoned('org');
    const c = await client(limited);
    expectNamesContained('whoami', await c.call('whoami'));
  });

  it('stay inside untrusted blocks in resource reads', async () => {
    const c = await client();
    for (const uri of ['buildit://items/DEMO-42', `buildit://pages/${PAGES.home}`]) {
      const r = await c.client.readResource({ uri });
      const text = r.contents.map((x) => ('text' in x ? x.text : '')).join('\n');
      expectOnlyInsideBlocks(text, MARK, uri);
      assertDefused(text);
    }
  });

  it('stay inside untrusted blocks in what write tools echo back', async () => {
    const c = await client();
    const status = api.store.projects[0]!.statuses.find((s) => s.category === 'started')!.name;
    const release = api.store.projects[0]!.releases[0]!.name;
    const writes: [string, Record<string, unknown>][] = [
      ['assign_item', { item: 'DEMO-43', assignee: 'sam@example.com' }],
      ['update_item', { item: 'DEMO-43', priority: 'high' }],
      ['rank_item', { item: 'DEMO-43', before: 'DEMO-42' }],
      ['transition_item', { item: 'DEMO-43', status, comment: 'Started.' }],
      ['add_comment', { item: 'DEMO-42', body: 'Thanks @sam@example.com' }],
      ['plan_sprint', { project: 'DEMO', action: 'add_items', sprint: '3', items: ['DEMO-43'] }],
      ['plan_release', { project: 'DEMO', action: 'add_items', release, items: ['DEMO-43'] }],
      ['create_page', { channel: CHANNELS.demo, title: 'Notes', body: 'Hello.' }],
      ['update_page', { page: PAGES.home, version: 3, body: 'Changed.' }],
      ['propose_bulk_update', { items: ['DEMO-43', 'DEMO-44'], patch: { priority: 'low' } }],
    ];
    for (const [name, args] of writes) {
      const r = await c.call(name, args);
      expectNamesContained(`${name} ${JSON.stringify(args)}`, r);
      assertDefused(r.text);
    }
  });
});

describe('name caps', () => {
  it('shows at most 64 characters of a display name and 60 of any other name', async () => {
    const c = await client();
    const who = (await c.call('whoami')).structured as {
      user: { name: string };
      org: { name: string };
      token: { name: string };
      projects: { name: string }[];
    };
    expect(who.user.name).toHaveLength(64);
    expect(who.user.name.endsWith('…')).toBe(true);
    for (const name of [who.org.name, who.token.name, ...who.projects.map((p) => p.name)]) {
      expect(name).toHaveLength(60);
    }
    const project = (await c.call('describe_project', { project: 'DEMO' })).structured as {
      project: { name: string };
      members: { name: string }[];
    };
    expect(project.project.name).toHaveLength(60);
    expect(project.members.every((m) => m.name.length === 64)).toBe(true);
    const channels = (await c.call('list_channels')).structured as {
      channels: { name: string }[];
    };
    expect(channels.channels.every((ch) => ch.name.length === 60)).toBe(true);
    const sprints = (await c.call('list_sprints', { project: 'DEMO' })).structured as {
      sprints: { name: string }[];
    };
    expect(sprints.sprints[0]?.name).toHaveLength(60);
    const releases = (await c.call('list_releases', { project: 'DEMO' })).structured as {
      releases: { name: string }[];
    };
    expect(releases.releases[0]?.name).toHaveLength(60);
  });
});
