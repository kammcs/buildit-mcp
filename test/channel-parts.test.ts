/**
 * Channel mode's smaller parts on their own: the folder's lock, the card
 * waiters, reading the events page, the plugin settings, and what status
 * finds in Claude Code's files.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ApiClient } from '../src/api/client.js';
import type { SessionEvent } from '../src/api/generated/schemas.js';
import { listSessionEvents } from '../src/channel/api.js';
import { acquireChannelLock } from '../src/channel/lock.js';
import { CardInbox, CardWaiters } from '../src/channel/waiters.js';
import {
  channelServerPlaces,
  duplicateChannelWarning,
  isChannelServer,
  pluginConfigured,
} from '../src/cli/claude-config.js';
import { runStatus } from '../src/cli/commands.js';
import { parseCli } from '../src/config.js';
import { createLogger } from '../src/log.js';
import { FileTokenStore } from '../src/secrets/keychain.js';
import { hookWaitSeconds, HOOK_TIMEOUT_S } from '../src/transports/stdio.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'buildit-mcp-parts-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const API = 'https://api.example.com/functions/v1/agent-api';

describe('the channel lock', () => {
  const lockDir = (): string => join(dir, 'locks');

  it('is taken by the first server of a folder; a second one goes without it', () => {
    const first = acquireChannelLock(join(dir, 'proj'), API, {
      dir: lockDir(),
      pid: 1111,
      isAlive: () => true,
      releaseOnExit: false,
    });
    expect(first).toBeDefined();
    expect(JSON.parse(readFileSync(first!.path, 'utf8'))).toMatchObject({ pid: 1111 });
    const second = acquireChannelLock(join(dir, 'proj'), API, {
      dir: lockDir(),
      pid: 2222,
      isAlive: () => true,
      releaseOnExit: false,
    });
    expect(second).toBeUndefined();
    // Another folder, or another deployment, has its own lock.
    expect(
      acquireChannelLock(join(dir, 'other'), API, {
        dir: lockDir(),
        pid: 2222,
        releaseOnExit: false,
      }),
    ).toBeDefined();
    expect(
      acquireChannelLock(join(dir, 'proj'), 'https://api.example.org', {
        dir: lockDir(),
        pid: 2222,
        releaseOnExit: false,
      }),
    ).toBeDefined();
    first!.release();
    expect(existsSync(first!.path)).toBe(false);
    first!.release();
  });

  it('takes over a lock whose process is gone, or that it cannot read', () => {
    const stale = acquireChannelLock(dir, API, {
      dir: lockDir(),
      pid: 1111,
      releaseOnExit: false,
    })!;
    const taken = acquireChannelLock(dir, API, {
      dir: lockDir(),
      pid: 2222,
      isAlive: (pid) => pid !== 1111,
      releaseOnExit: false,
    });
    expect(taken?.path).toBe(stale.path);
    expect(JSON.parse(readFileSync(taken!.path, 'utf8'))).toMatchObject({ pid: 2222 });
    // The old holder's release leaves the new holder's lock.
    stale.release();
    expect(existsSync(taken!.path)).toBe(true);
    taken!.release();

    writeFileSync(taken!.path, 'not json');
    expect(
      acquireChannelLock(dir, API, { dir: lockDir(), pid: 3333, releaseOnExit: false }),
    ).toBeDefined();
  });

  it('treats this process as alive by default', () => {
    const mine = acquireChannelLock(dir, API, { dir: lockDir(), releaseOnExit: false })!;
    expect(
      acquireChannelLock(dir, API, { dir: lockDir(), pid: process.pid + 1, releaseOnExit: false }),
    ).toBeUndefined();
    mine.release();
  });
});

const event = (messageId: string, type: SessionEvent['type'] = 'card.closed'): SessionEvent =>
  ({
    v: 1,
    id: `e-${messageId}`,
    type,
    data: { message: { id: messageId, thread_id: null } },
  }) as unknown as SessionEvent;

describe('card waiters', () => {
  it('hand an event to its card and wait until it is handled', async () => {
    const waiters = new CardWaiters();
    const inbox = new CardInbox();
    const unregister = waiters.register('m1', inbox);
    expect(await waiters.deliver(event('m2'))).toBe(false);
    let handled = false;
    const delivered = waiters.deliver(event('m1')).then(() => handled);
    const next = await inbox.next(Date.now() + 1000);
    expect(typeof next).toBe('object');
    expect(handled).toBe(false);
    handled = true;
    (next as { done: () => void }).done();
    expect(await delivered).toBe(true);
    unregister();
    expect(waiters.has('m1')).toBe(false);
  });

  it("don't wait past a step for a slow waiter", async () => {
    const waiters = new CardWaiters(30);
    waiters.register('m1', new CardInbox());
    const started = Date.now();
    expect(await waiters.deliver(event('m1'))).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('end every waiter when the session ends, and later ones at once', async () => {
    const waiters = new CardWaiters();
    const inbox = new CardInbox();
    waiters.register('m1', inbox);
    const pending = inbox.next(Date.now() + 10_000);
    waiters.endAll();
    expect(await pending).toBe('session_ended');
    const late = new CardInbox();
    waiters.register('m2', late);
    expect(await late.next(Date.now() + 10_000)).toBe('session_ended');
  });

  it('time out at the deadline, and stop on abort', async () => {
    const inbox = new CardInbox();
    expect(await inbox.next(Date.now() + 20)).toBe('timeout');
    const abort = new AbortController();
    const pending = inbox.next(Date.now() + 10_000, abort.signal);
    abort.abort();
    expect(await pending).toBe('aborted');
  });
});

describe('the events page', () => {
  it('leaves out an event type this version does not know, and counts it', async () => {
    const body = {
      events: [
        { v: 1, id: '00000000-0000-4000-8000-000000000001', type: 'something.new', data: {} },
      ],
      cursor: 1,
      more: false,
    };
    const api = new ApiClient({
      baseUrl: API,
      token: 'buildit_ags_test',
      logger: createLogger({ sink: () => undefined }),
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
        ),
    });
    const page = await listSessionEvents(api, { limit: 10 });
    expect(page).toMatchObject({ events: [], cursor: 1, skipped: 1 });
  });
});

describe('the plugin settings', () => {
  const config = (env: Record<string, string>) => {
    const action = parseCli(['--channel'], { BUILDIT_TOKEN: 'buildit_ags_x', ...env });
    if (action.kind !== 'run') throw new Error('expected run');
    return action.config;
  };

  it('default to questions in the app, waiting 60 minutes', () => {
    expect(config({}).ask).toEqual({ questionsInApp: true, timeoutMinutes: 60 });
    expect(
      config({ BUILDIT_QUESTIONS_IN_APP: 'false', BUILDIT_ASK_TIMEOUT_MINUTES: '15' }).ask,
    ).toEqual({
      questionsInApp: false,
      timeoutMinutes: 15,
    });
  });

  it('keep the defaults, with a warning, for values that are empty or wrong', () => {
    expect(config({ BUILDIT_QUESTIONS_IN_APP: '', BUILDIT_ASK_TIMEOUT_MINUTES: '' }).ask).toEqual({
      questionsInApp: true,
      timeoutMinutes: 60,
    });
    const bad = config({ BUILDIT_QUESTIONS_IN_APP: 'maybe', BUILDIT_ASK_TIMEOUT_MINUTES: '600' });
    expect(bad.ask).toEqual({ questionsInApp: true, timeoutMinutes: 60 });
    expect(bad.warnings.join('\n')).toContain('BUILDIT_ASK_TIMEOUT_MINUTES must be 1 to 60');
    expect(bad.warnings.join('\n')).toContain('BUILDIT_QUESTIONS_IN_APP is not true or false');
  });

  it("end the hook's wait a minute before the hook's timeout", () => {
    expect(HOOK_TIMEOUT_S).toBe(3600);
    expect(hookWaitSeconds(60)).toBe(3540);
    expect(hookWaitSeconds(30)).toBe(1800);
    expect(hookWaitSeconds(1)).toBe(60);
  });
});

describe("Claude Code's files (status)", () => {
  const home = (): string => join(dir, 'home');
  const folder = (): string => join(dir, 'proj');
  const channelServer = { command: 'npx', args: ['-y', '@kammcs/buildit-mcp@latest', '--channel'] };

  beforeEach(() => {
    mkdirSync(join(home(), '.claude', 'plugins'), { recursive: true });
    mkdirSync(folder(), { recursive: true });
  });

  it('knows a channel server', () => {
    expect(isChannelServer(channelServer)).toBe(true);
    expect(
      isChannelServer({ command: 'node', args: ['/x/buildit-mcp/dist/index.js', '--channel'] }),
    ).toBe(true);
    expect(isChannelServer({ command: 'npx', args: ['@kammcs/buildit-mcp@latest'] })).toBe(false);
    expect(isChannelServer({ command: 'buildit-mcp', env: { BUILDIT_CHANNEL: 'true' } })).toBe(
      true,
    );
    expect(isChannelServer({ command: 'npx', args: ['other-server', '--channel'] })).toBe(false);
  });

  it("finds one in ~/.claude.json (user or this project) and in the folder's .mcp.json", () => {
    expect(channelServerPlaces(folder(), home())).toEqual([]);
    writeFileSync(
      join(home(), '.claude.json'),
      JSON.stringify({
        projects: { [folder().toUpperCase()]: { mcpServers: { buildit: channelServer } } },
      }),
    );
    const sameCase = process.platform === 'win32' || process.platform === 'darwin';
    expect(channelServerPlaces(folder(), home())).toEqual(sameCase ? ['~/.claude.json'] : []);
    writeFileSync(
      join(home(), '.claude.json'),
      JSON.stringify({ mcpServers: { b: channelServer } }),
    );
    writeFileSync(
      join(folder(), '.mcp.json'),
      JSON.stringify({ mcpServers: { b: channelServer } }),
    );
    expect(channelServerPlaces(folder(), home())).toEqual(['~/.claude.json', '.mcp.json']);
  });

  it('warns only when the plugin is set up too', async () => {
    writeFileSync(
      join(folder(), '.mcp.json'),
      JSON.stringify({ mcpServers: { b: channelServer } }),
    );
    expect(pluginConfigured(folder(), home())).toBe(false);
    expect(duplicateChannelWarning(folder(), home())).toBeUndefined();
    writeFileSync(
      join(home(), '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'buildit@buildit-mcp': [{}] } }),
    );
    expect(pluginConfigured(folder(), home())).toBe(true);
    expect(duplicateChannelWarning(folder(), home())).toContain('.mcp.json also starts');

    let out = '';
    const code = await runStatus(
      { apiUrl: API, folder: folder() },
      {
        out: (t) => (out += t),
        err: () => undefined,
        store: new FileTokenStore(join(dir, 'sessions.json')),
        logger: createLogger({ sink: () => undefined }),
        home: home(),
      },
    );
    expect(code).toBe(1);
    expect(out).toContain('Warning:  the buildit plugin is installed');
  });

  it('sees the plugin enabled in settings, and ignores unreadable files', () => {
    mkdirSync(join(folder(), '.claude'), { recursive: true });
    writeFileSync(join(home(), '.claude.json'), '{ not json');
    writeFileSync(
      join(folder(), '.claude', 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'buildit@buildit-mcp': true, 'other@x': true } }),
    );
    expect(pluginConfigured(folder(), home())).toBe(true);
    expect(channelServerPlaces(folder(), home())).toEqual([]);
  });
});
