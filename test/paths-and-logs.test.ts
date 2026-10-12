/**
 * Path parameters that would change the API route, and what the API call
 * log keeps of a path.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { operationPath } from '../src/api/operations.js';
import { ToolInputError } from '../src/errors.js';
import { CHANNELS, FakeApi, sampleIdentity } from './support/fake-api.js';
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

const READER = 'buildit_pat_test_paths_reader';

async function client(sink?: (line: string) => void): Promise<Connected> {
  api.identities[READER] ??= sampleIdentity([
    'projects:write',
    'projects:admin',
    'pages:write',
    'chat:read',
  ]);
  const c = await connect(api, READER, {}, sink);
  open.push(c);
  return c;
}

describe('path parameters', () => {
  it('refuses "." and ".." values, and values with such segments', () => {
    for (const value of ['.', '..', '../me', 'a/..', 'a/./b', '..\\x', 'x/../../v1/me']) {
      expect(() => operationPath('list_pages', { channel: value }), value).toThrow(ToolInputError);
    }
    // Dots inside a name, or more than two, are ordinary names.
    expect(operationPath('list_pages', { channel: '...' })).toBe('/v1/channels/.../pages');
    expect(operationPath('list_pages', { channel: 'v1.2 notes' })).toBe(
      '/v1/channels/v1.2%20notes/pages',
    );
    expect(operationPath('list_pages', { channel: 'a/b' })).toBe('/v1/channels/a%2Fb/pages');
  });

  it('answers invalid_arguments from the tools, and sends nothing to the API', async () => {
    const c = await client();
    const calls: [string, Record<string, unknown>][] = [
      ['read_channel', { channel: '..' }],
      ['list_pages', { channel: '.' }],
      ['create_page', { channel: '../general', title: 'x' }],
      ['get_workflow', { project: 'DEMO', workflow: '..' }],
      ['plan_sprint', { project: 'DEMO', action: 'start', sprint: '..' }],
      ['plan_release', { project: 'DEMO', action: 'release', release: 'x/../..' }],
    ];
    for (const [name, args] of calls) {
      const before = api.requests.length;
      const r = await c.call(name, args);
      expect(r.isError, name).toBe(true);
      expect(r.text, name).toMatch(/^buildit-mcp error: invalid_arguments/);
      expect(r.text).toContain('nothing was sent');
      expect(api.requests.length, name).toBe(before);
    }
    expect(api.requests.some((r) => r.path.includes('/..'))).toBe(false);
  });
});

describe('the API call log', () => {
  it('logs the operation and its path template, never the names in the path', async () => {
    const secret = 'Quarterly Board Secrets';
    api.store.channels.find((ch) => ch.id === CHANNELS.general)!.name = secret;
    const lines: string[] = [];
    const c = await client((l) => lines.push(l));
    const r = await c.call('read_channel', { channel: secret });
    expect(r.isError).toBe(false);
    const pages = await c.call('list_pages', { channel: secret });
    expect(pages.isError).toBe(false);
    const workflow = await c.call('get_workflow', { project: 'DEMO', workflow: 'Software' });
    expect(workflow.isError).toBe(false);

    const calls = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((rec) => rec.msg === 'api call');
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'list_channel_messages',
          path: '/v1/channels/{channel}/messages',
          tool: 'read_channel',
        }),
        expect.objectContaining({
          operation: 'list_pages',
          path: '/v1/channels/{channel}/pages',
        }),
        expect.objectContaining({
          operation: 'get_workflow',
          path: expect.stringMatching(/\{key\}.*\{workflow\}/) as unknown,
        }),
      ]),
    );
    for (const line of lines) {
      expect(line).not.toMatch(/Quarterly|Board%20Secrets|Software/);
    }
  });
});
