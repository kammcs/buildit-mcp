/**
 * Two channel servers in one folder, end to end in process: the plugin's
 * server and one added with `claude mcp add`, in either start order, with
 * the real lock files (in a temporary folder) and the fake API's session.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CallToolResult } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { acquireChannelLock, NOT_THE_CHANNEL, type ChannelLock } from '../src/channel/lock.js';
import {
  channelConfig,
  channelNotes,
  startChannel,
  waitFor,
  type ChannelClient,
} from './support/channel-harness.js';
import { FakeApi } from './support/fake-api.js';
import { SESSION_TOKENS } from './support/fake-sessions.js';

const TOKEN = SESSION_TOKENS.first;

let api: FakeApi;
let dir: string;
const stops: (() => Promise<void>)[] = [];
const locks: ChannelLock[] = [];

beforeAll(async () => {
  api = await new FakeApi().start();
});
afterAll(async () => {
  await api.close();
});
beforeEach(() => {
  api.reset();
  dir = mkdtempSync(join(tmpdir(), 'buildit-mcp-locks-'));
});
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
  for (const lock of locks.splice(0)) lock.release();
  rmSync(dir, { recursive: true, force: true });
  expect(api.violations).toEqual([]);
});

const textOf = (r: CallToolResult): string =>
  (r.content as { type: string; text: string }[]).map((c) => c.text).join('\n');

/** The folder's lock for a server (process ids made up, all alive). */
function lock(pid: number, plugin: boolean): ChannelLock | undefined {
  const l = acquireChannelLock(join(dir, 'folder'), api.url, {
    dir: join(dir, 'locks'),
    pid,
    plugin,
    isAlive: () => true,
    releaseOnExit: false,
  });
  if (l) locks.push(l);
  return l;
}

/** A channel server with the lock it got (none: another server is the channel). */
function server(l: ChannelLock | undefined): Promise<ChannelClient> {
  return startChannel(api, stops, {
    config: channelConfig(api),
    stdio: {
      channelOwner: l !== undefined,
      ...(l === undefined ? {} : { channelLock: l }),
      preemptWaitMs: 50,
      typing: { everyMs: 60_000 },
    },
  });
}

const messages = (c: ChannelClient): (string | undefined)[] =>
  channelNotes(c.notes).map((n) => n.params?.content);

async function refusesAsNotTheChannel(c: ChannelClient): Promise<void> {
  const reply = await c.client.callTool({ name: 'reply', arguments: { text: 'Hi' } });
  expect(reply.isError).toBe(true);
  expect(textOf(reply)).toContain(NOT_THE_CHANNEL);
  const me = await c.client.callTool({ name: 'whoami', arguments: {} });
  expect(textOf(me)).toContain(NOT_THE_CHANNEL);
}

describe('two channel servers in one folder', () => {
  it("the plugin's server takes the folder over from one started before it", async () => {
    const session = api.sessions.open(TOKEN);
    const plain = await server(lock(1111, false));
    api.sessions.postFrom(TOKEN, 'One');
    await waitFor(() => messages(plain).includes('One'));

    const pluginLock = lock(2222, true);
    expect(pluginLock?.preempted).toBe(1111);
    const plugin = await server(pluginLock);
    await waitFor(() =>
      plain.logs.some((l) => l.includes("the buildit plugin's server now receives")),
    );
    api.sessions.postFrom(TOKEN, 'Two');
    await waitFor(() => messages(plugin).includes('Two'));
    expect(messages(plain)).toEqual(['One']);
    // The plugin's server didn't get what the other one had handed on and acked.
    expect(messages(plugin)).toEqual(['Two']);
    await refusesAsNotTheChannel(plain);
    // The one that gave way never said the session went offline.
    expect(session.heartbeats).not.toContain('offline');
    const ok = await plugin.client.callTool({ name: 'reply', arguments: { text: 'Hi' } });
    expect(ok.isError).toBeFalsy();
  });

  it("a server started after the plugin's never polls", async () => {
    api.sessions.open(TOKEN);
    const plugin = await server(lock(2222, true));
    const plainLock = lock(1111, false);
    expect(plainLock).toBeUndefined();
    const plain = await server(plainLock);
    await waitFor(() =>
      plain.logs.some((l) => l.includes('another buildit server in this folder receives')),
    );
    api.sessions.postFrom(TOKEN, 'One');
    await waitFor(() => messages(plugin).includes('One'));
    expect(messages(plain)).toEqual([]);
    await refusesAsNotTheChannel(plain);
  });

  it('keeps the first of two plugin servers', async () => {
    api.sessions.open(TOKEN);
    const first = await server(lock(2222, true));
    const second = await server(lock(3333, true));
    api.sessions.postFrom(TOKEN, 'One');
    await waitFor(() => messages(first).includes('One'));
    expect(messages(second)).toEqual([]);
    await refusesAsNotTheChannel(second);
  });
});
