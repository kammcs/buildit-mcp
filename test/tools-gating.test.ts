/**
 * Which tools, resources and prompts a caller sees, how the tools'
 * annotations read, and the errors every tool shares (rate limits, limits,
 * Projects off).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TOOLSETS } from '../src/toolsets/toolsets.js';
import { FakeApi, sampleIdentity, TOKENS, uid } from './support/fake-api.js';
import { connect, type Connected } from './support/harness.js';

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

async function client(token: string, policy: Parameters<typeof connect>[2] = {}) {
  const c = await connect(api, token, policy);
  open.push(c);
  return c;
}

/** A token with exactly these scopes. */
function tokenWith(...scopes: string[]): string {
  const token = `buildit_pat_test_${scopes.join('_').replace(/[^a-z]/g, '') || 'none'}`;
  api.identities[token] = sampleIdentity(scopes);
  return token;
}

/** Every tool in the order a client sees them with every toolset on. */
const ALL_TOOLS = [
  // items
  'assign_item',
  'create_item',
  'describe_project',
  'find_users',
  'get_item',
  'link_items',
  'list_projects',
  'rank_item',
  'search_items',
  'transition_item',
  'unlink_items',
  'update_item',
  'whoami',
  // comments
  'add_comment',
  'list_comments',
  // planning
  'list_releases',
  'list_sprints',
  'plan_release',
  'plan_sprint',
  'write_release_notes',
  // pages
  'create_page',
  'get_page',
  'list_pages',
  'update_page',
  // chat
  'list_channels',
  'read_channel',
  'read_thread',
  // admin
  'get_workflow',
  'list_work_types',
  'propose_field_change',
  'propose_label_change',
  'propose_work_type_change',
  'propose_workflow_change',
  // destructive, and apply_plan with any propose_* tool
  'apply_plan',
  'propose_archive_status',
  'propose_bulk_update',
  'propose_delete_item',
  'propose_move_item',
];

const DEFAULT_TOOLS = ALL_TOOLS.slice(0, 15);

const READ_TOOLS = [
  'describe_project',
  'find_users',
  'get_item',
  'list_projects',
  'search_items',
  'whoami',
  'list_comments',
  'list_releases',
  'list_sprints',
  'get_page',
  'list_pages',
  'list_channels',
  'read_channel',
  'read_thread',
  'get_workflow',
  'list_work_types',
];

const DESTRUCTIVE = ['unlink_items', 'write_release_notes', 'update_page', 'apply_plan'];
const OPEN_WORLD = ['list_channels', 'read_channel', 'read_thread'];

async function names(c: Connected): Promise<string[]> {
  return (await c.client.listTools()).tools.map((t) => t.name);
}

describe('the tool list', () => {
  it('has the item and comment tools by default, in a fixed order', async () => {
    const c = await client(TOKENS.full, { toolsets: DEFAULT_TOOLSETS });
    expect(await names(c)).toEqual(DEFAULT_TOOLS);
    expect(DEFAULT_TOOLS).toHaveLength(15);
  });

  it('has every tool with every toolset on and every scope', async () => {
    const c = await client(TOKENS.full);
    expect(await names(c)).toEqual(ALL_TOOLS);
    expect(ALL_TOOLS).toHaveLength(38);
  });

  it('keeps admin and destructive off by default, even for a token with their scopes', async () => {
    const c = await client(TOKENS.full, { toolsets: DEFAULT_TOOLSETS });
    const listed = await names(c);
    for (const name of listed) expect(name).not.toMatch(/^(propose_|apply_plan|get_workflow)/);
    const admin = await client(TOKENS.full, { toolsets: ['admin'] });
    expect(await names(admin)).toEqual([
      'get_workflow',
      'list_work_types',
      'propose_field_change',
      'propose_label_change',
      'propose_work_type_change',
      'propose_workflow_change',
      'apply_plan',
    ]);
    const destructive = await client(TOKENS.full, { toolsets: ['destructive'] });
    expect(await names(destructive)).toEqual([
      'apply_plan',
      'propose_archive_status',
      'propose_bulk_update',
      'propose_delete_item',
      'propose_move_item',
    ]);
  });

  it('hides each toolset from a token without its scope', async () => {
    const reader = await client(TOKENS.read);
    expect((await names(reader)).sort()).toEqual(
      ['describe_project', 'find_users', 'get_item', 'list_projects', 'search_items', 'whoami']
        .concat(['list_comments', 'list_releases', 'list_sprints'])
        .sort(),
    );
    const pages = await client(tokenWith('pages:read'));
    expect(await names(pages)).toEqual(['whoami', 'get_page', 'list_pages']);
    const pageWriter = await client(tokenWith('pages:write'));
    expect(await names(pageWriter)).toEqual([
      'whoami',
      'create_page',
      'get_page',
      'list_pages',
      'update_page',
    ]);
    const chat = await client(tokenWith('chat:read'));
    expect(await names(chat)).toEqual(['whoami', 'list_channels', 'read_channel', 'read_thread']);
  });

  it('lists apply_plan with the propose_* tools a token may use, and only then', async () => {
    const admin = await names(await client(tokenWith('projects:admin')));
    expect(admin).toContain('propose_label_change');
    expect(admin).toContain('apply_plan');
    expect(admin).not.toContain('propose_delete_item');
    const deleter = await names(await client(tokenWith('projects:delete')));
    expect(deleter).toContain('propose_delete_item');
    expect(deleter).toContain('apply_plan');
    expect(deleter).not.toContain('get_workflow');
    // A writer has no propose_* tool, so no apply_plan either.
    const writer = await names(await client(tokenWith('projects:write')));
    expect(writer).not.toContain('apply_plan');
    // Excluding every propose_* tool takes apply_plan away too.
    const proposals = ALL_TOOLS.filter((n) => n.startsWith('propose_'));
    const excluded = await names(await client(TOKENS.full, { excludeTools: proposals }));
    expect(excluded).not.toContain('apply_plan');
  });

  it('hides the write tools in read-only mode, whatever the token', async () => {
    const c = await client(TOKENS.full, { readOnly: true });
    expect((await names(c)).sort()).toEqual([...READ_TOOLS].sort());
  });

  it('shows only whoami to a token without scopes', async () => {
    const c = await client(TOKENS.none);
    expect(await names(c)).toEqual(['whoami']);
  });

  it('gives every tool honest annotations, an output schema and a static description', async () => {
    const c = await client(TOKENS.full);
    const { tools } = await c.client.listTools();
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(READ_TOOLS.includes(tool.name));
      expect(tool.annotations?.destructiveHint ?? false, tool.name).toBe(
        DESTRUCTIVE.includes(tool.name),
      );
      expect(tool.annotations?.openWorldHint, tool.name).toBe(OPEN_WORLD.includes(tool.name));
      expect(tool.outputSchema, tool.name).toBeDefined();
      expect(tool.description?.length, tool.name).toBeGreaterThan(80);
      // Static text only: no data from the fake (its org, people or keys of the seed).
      expect(tool.description, tool.name).not.toMatch(/Example Org|Test User|test.user@/);
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(byName.create_item).toMatchObject({ destructiveHint: false, idempotentHint: false });
    expect(byName.add_comment).toMatchObject({ destructiveHint: false, idempotentHint: false });
    expect(byName.update_item).toMatchObject({ destructiveHint: false, idempotentHint: true });
    expect(byName.transition_item).toMatchObject({ destructiveHint: false, idempotentHint: true });
    expect(byName.link_items).toMatchObject({ destructiveHint: false, idempotentHint: true });
    expect(byName.unlink_items).toMatchObject({ destructiveHint: true, idempotentHint: true });
    expect(byName.apply_plan).toMatchObject({ destructiveHint: true, idempotentHint: false });
    expect(byName.propose_delete_item).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
  });

  it('keeps the whole list within budget', async () => {
    const all = await client(TOKENS.full);
    const { tools } = await all.client.listTools();
    expect(JSON.stringify(tools).length).toBeLessThan(160_000);
    const defaults = await client(TOKENS.full, { toolsets: DEFAULT_TOOLSETS });
    expect(JSON.stringify((await defaults.client.listTools()).tools).length).toBeLessThan(60_000);
  });
});

describe('resources and prompts', () => {
  it('are offered by toolset and scope', async () => {
    const full = await client(TOKENS.full);
    const templates = (await full.client.listResourceTemplates()).resourceTemplates;
    expect(templates.map((t) => t.uriTemplate)).toEqual([
      'buildit://items/{key}',
      'buildit://pages/{id}',
    ]);
    const prompts = (await full.client.listPrompts()).prompts.map((p) => p.name);
    expect(prompts).toEqual(['plan_epic', 'triage', 'standup']);

    const reader = await client(TOKENS.read, { toolsets: DEFAULT_TOOLSETS });
    expect(
      (await reader.client.listResourceTemplates()).resourceTemplates.map((t) => t.name),
    ).toEqual(['item']);
    // Recipes that end in writes need a write token.
    expect((await reader.client.listPrompts()).prompts.map((p) => p.name)).toEqual(['standup']);
  });

  it('are not offered without a toolset that has them', async () => {
    const chat = await client(TOKENS.full, { toolsets: ['chat'] });
    const caps = chat.client.getServerCapabilities();
    expect(caps?.resources).toBeUndefined();
    expect(caps?.prompts).toBeUndefined();
  });
});

describe('errors every tool shares', () => {
  it('reports a long rate limit with the time to wait', async () => {
    api.enqueue('/v1/items', {
      status: 429,
      headers: { 'Retry-After': '42' },
      body: {
        error: {
          code: 'rate_limited',
          message: 'Too many requests.',
          details: { retry_after: 42, bucket: 'token_requests_per_minute' },
        },
      },
    });
    const c = await client(TOKENS.read);
    const r = await c.call('search_items', { projects: ['DEMO'] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('rate_limited (HTTP 429)');
    expect(r.text).toContain('Retry after: 42 s');
  });

  it('reports a project outside the token limits', async () => {
    const limited = 'buildit_pat_test_limited';
    api.identities[limited] = sampleIdentity(['projects:write'], {
      projects: [{ id: uid(11), key: 'OPS', name: 'Operations' }],
    });
    api.identities[limited].token.limits.projects = [
      { id: uid(11), key: 'OPS', name: 'Operations' },
    ];
    const c = await client(limited);
    const r = await c.call('get_item', { item: 'DEMO-42' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('outside_limits (HTTP 403)');
    expect(r.text).toContain('whoami lists the projects in reach');
    const ok = await c.call('get_item', { item: 'OPS-1' });
    expect(ok.isError).toBe(false);
  });

  it('reports Projects being off for the org', async () => {
    const off = 'buildit_pat_test_projects_off';
    api.identities[off] = sampleIdentity(['projects:write'], { features: { projects: false } });
    const c = await client(off);
    const r = await c.call('list_projects');
    expect(r.isError).toBe(true);
    expect(r.text).toContain('projects_off');
    const who = await c.call('whoami');
    expect(who.text).toContain('Projects is not enabled for this org');
  });

  it('reports a response that breaks the contract as an update hint', async () => {
    api.enqueue('/v1/projects', { status: 200, body: { items: [{ key: 'DEMO' }] } });
    const c = await client(TOKENS.read);
    const r = await c.call('list_projects');
    expect(r.isError).toBe(true);
    expect(r.text).toContain('invalid_response');
    expect(r.text).toContain('update buildit-mcp');
  });
});
