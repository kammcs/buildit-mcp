/**
 * The session commands against the fake API, with an in-memory keychain:
 * connect (the device-code flow), disconnect and status.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  machineName,
  plain,
  runConnect,
  runDisconnect,
  runStatus,
  serverCommand,
  type CommandIO,
} from '../src/cli/commands.js';
import type { ConnectOptions } from '../src/config.js';
import { createLogger } from '../src/log.js';
import {
  FileTokenStore,
  KeyringTokenStore,
  savedApiUrl,
  sessionKey,
  type KeyringFactory,
  type TokenStore,
} from '../src/secrets/keychain.js';
import { FakeApi } from './support/fake-api.js';
import { SESSION_TOKENS } from './support/fake-sessions.js';

let api: FakeApi;
let dir: string;

beforeAll(async () => {
  api = await new FakeApi().start();
});
afterAll(async () => {
  await api.close();
});
beforeEach(() => {
  api.reset();
  dir = mkdtempSync(join(tmpdir(), 'buildit-mcp-connect-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  expect(api.violations).toEqual([]);
});

function memoryKeyring(): KeyringFactory {
  const entries = new Map<string, string>();
  return (service, account) => {
    const id = `${service}/${account}`;
    return {
      getPassword: () => Promise.resolve(entries.get(id) ?? null),
      setPassword: (password) => {
        entries.set(id, password);
        return Promise.resolve();
      },
      deletePassword: () => Promise.resolve(entries.delete(id)),
    };
  };
}

interface Harness {
  io: CommandIO;
  store: TokenStore;
  out: () => string;
  err: () => string;
  waits: number[];
  /** The questions asked, in order. */
  asked: string[];
}

/** The commands' IO; `onWait` runs at each poll's wait (to approve, deny...). */
/** The commands' IO; `onWait` runs at each poll's wait, `answer` answers "Is this you?". */
function harness(onWait: (n: number) => void = () => undefined, answer = 'y'): Harness {
  let out = '';
  let err = '';
  const waits: number[] = [];
  const asked: string[] = [];
  const store = new KeyringTokenStore(
    memoryKeyring(),
    new FileTokenStore(join(dir, 'sessions.json')),
    () => undefined,
    'Test Keychain',
  );
  const io: CommandIO = {
    out: (t) => (out += t),
    err: (t) => (err += t),
    store,
    logger: createLogger({ sink: () => undefined }),
    machine: 'DESKTOP-TEST',
    sleep: (ms) => {
      waits.push(ms);
      onWait(waits.length);
      return Promise.resolve();
    },
    ask: (question) => {
      asked.push(question);
      return Promise.resolve(answer);
    },
  };
  return { io, store, out: () => out, err: () => err, waits, asked };
}

function options(extra: Partial<ConnectOptions> = {}): ConnectOptions {
  return {
    apiUrl: api.url,
    folder: dir,
    projects: ['DEMO'],
    label: 'demo-folder',
    yes: false,
    ...extra,
  };
}

describe('connect', () => {
  it('shows the code and link, polls until approved, and saves the token for the folder', async () => {
    const h = harness((n) => {
      if (n === 2) api.sessions.approve();
    });
    expect(await runConnect(options(), h.io)).toBe(0);
    const grant = api.sessions.grants[0];
    expect(grant).toMatchObject({
      client: 'Claude Code',
      machine: 'DESKTOP-TEST',
      label: 'demo-folder',
      projects: ['DEMO'],
    });
    expect(h.out()).toContain(`https://app.example.com/connect?code=${grant?.userCode}`);
    expect(h.out()).toContain(`this code: ${grant?.userCode}`);
    expect(h.out()).toContain(
      'Connected as Claude (Test User) in Example Org, project DEMO; session "demo-folder".',
    );
    expect(h.asked).toEqual(['Is this you? [y/N] ']);
    expect(h.out()).toContain('claude --dangerously-load-development-channels server:buildit');
    expect(h.out()).not.toContain(SESSION_TOKENS.first);
    expect(await h.store.get(sessionKey(dir, api.url))).toBe(SESSION_TOKENS.first);
    // Polled at the server's interval.
    expect(h.waits).toEqual([5000, 5000]);
    // The connect flow sends no token.
    const sent = api.requests.filter((r) => r.path.startsWith('/v1/connect/'));
    expect(sent.map((r) => r.headers.authorization)).toEqual([undefined, undefined, undefined]);
  });

  it('saves only on an explicit yes: anything else may be someone else', async () => {
    for (const answer of ['n', '', 'yeah', 'no']) {
      const h = harness((n) => {
        if (n === 1) api.sessions.approve();
      }, answer);
      expect(await runConnect(options({ projects: ['DEMO', 'OPS'] }), h.io)).toBe(1);
      expect(h.out()).toContain(
        'Connected as Claude (Test User) in Example Org, projects DEMO, OPS',
      );
      expect(h.err()).toContain('Not saved, and the session was cancelled');
      expect(h.err()).toContain('someone else may have approved your code');
      // The token was used once, to end the session, and never kept.
      expect(api.sessions.sessions.get(SESSION_TOKENS.first)?.selfRevoked).toBe(true);
      expect(await h.store.get(sessionKey(dir, api.url))).toBeUndefined();
      expect(h.out() + h.err()).not.toContain(SESSION_TOKENS.first);
    }
    for (const answer of ['Y', ' yes ']) {
      const h = harness((n) => {
        if (n === 1) api.sessions.approve();
      }, answer);
      expect(await runConnect(options(), h.io)).toBe(0);
      expect(await h.store.get(sessionKey(dir, api.url))).toBe(SESSION_TOKENS.first);
      await h.store.delete(sessionKey(dir, api.url));
    }
  });

  it('says to revoke the session in the app when it could not cancel it', async () => {
    api.enqueueError('/v1/session', 'internal');
    const h = harness((n) => {
      if (n === 1) api.sessions.approve();
    }, 'n');
    expect(await runConnect(options(), h.io)).toBe(1);
    expect(h.err()).toContain('could not be cancelled (internal)');
    expect(h.err()).toContain('revoke the session "demo-folder" in buildIt.Social');
    expect(await h.store.get(sessionKey(dir, api.url))).toBeUndefined();
  });

  it('names the projects as approved, not as asked for', async () => {
    const h = harness((n) => {
      if (n === 1) api.sessions.approve(undefined, SESSION_TOKENS.first, ['OPS']);
    });
    expect(await runConnect(options({ projects: ['DEMO', 'OPS'] }), h.io)).toBe(0);
    expect(h.out()).toContain('in Example Org, project OPS; session');
  });

  it('with --yes, saves without asking (for scripts)', async () => {
    const h = harness((n) => {
      if (n === 1) api.sessions.approve();
    }, 'n');
    expect(await runConnect(options({ yes: true }), h.io)).toBe(0);
    expect(h.asked).toEqual([]);
    expect(h.out()).toContain('Connected as Claude (Test User)');
    expect(await h.store.get(sessionKey(dir, api.url))).toBe(SESSION_TOKENS.first);
  });

  it('slows down when asked', async () => {
    api.sessions.slowDownOnce = true;
    const h = harness((n) => {
      if (n === 3) api.sessions.approve();
    });
    expect(await runConnect(options(), h.io)).toBe(0);
    expect(h.waits).toEqual([5000, 10000, 5000]);
  });

  it('stops when the person denies it, saving nothing', async () => {
    const h = harness((n) => {
      if (n === 2) api.sessions.deny();
    });
    expect(await runConnect(options(), h.io)).toBe(1);
    expect(h.err()).toContain('denied');
    // The same answer covers an agent turned off, or an owner who left, after the approval.
    expect(h.err()).toContain('the agent was turned off or deleted');
    expect(await h.store.get(sessionKey(dir, api.url))).toBeUndefined();
  });

  it('stops when the code expires', async () => {
    const h = harness((n) => {
      if (n === 1) api.sessions.expire();
    });
    expect(await runConnect(options(), h.io)).toBe(1);
    expect(h.err()).toContain('expired');
  });

  it('gives up when the code expires, by the clock', async () => {
    let now = 0;
    const h = harness(() => {
      now += 301_000;
    });
    h.io.now = () => now;
    expect(await runConnect(options(), h.io)).toBe(1);
    expect(h.err()).toContain('expired before it was approved');
  });

  it('keeps a session that still works, and replaces one that was revoked', async () => {
    const h = harness((n) => {
      if (n === 1) api.sessions.approve(undefined, SESSION_TOKENS.second);
    });
    api.sessions.open(SESSION_TOKENS.first);
    await h.store.set(sessionKey(dir, api.url), SESSION_TOKENS.first);
    expect(await runConnect(options(), h.io)).toBe(0);
    expect(h.out()).toContain('already connected');
    expect(api.sessions.grants).toHaveLength(0);

    api.sessions.revoke(SESSION_TOKENS.first);
    expect(await runConnect(options(), h.io)).toBe(0);
    expect(h.out()).toContain('no longer accepted (token_revoked)');
    expect(await h.store.get(sessionKey(dir, api.url))).toBe(SESSION_TOKENS.second);
  });

  it('reports a refused start', async () => {
    api.enqueueError('/v1/connect/start', 'rate_limited', {
      retry_after: 3600,
      bucket: 'connect_starts_per_hour',
    });
    const h = harness();
    expect(await runConnect(options(), h.io)).toBe(1);
    expect(h.err()).toContain('Could not start connecting');
    expect(h.err()).toContain('started from this network in the last hour');
    expect(h.err()).toContain('about 60 minutes');
  });

  it('waits out a short Retry-After on start once, then goes on', async () => {
    api.enqueueError(
      '/v1/connect/start',
      'rate_limited',
      { retry_after: 30, bucket: 'connect_pending_per_address' },
      { headers: { 'Retry-After': '30' } },
    );
    const h = harness((n) => {
      if (n === 2) api.sessions.approve();
    });
    expect(await runConnect(options(), h.io)).toBe(0);
    expect(h.out()).toContain('asks to wait 30 s');
    expect(h.waits).toEqual([30_000, 5000]);
    expect(api.count('/v1/connect/start')).toBe(2);
  });

  it('explains too many codes waiting from this network', async () => {
    api.enqueueError('/v1/connect/start', 'rate_limited', {
      retry_after: 600,
      bucket: 'connect_pending_per_address',
    });
    const h = harness();
    expect(await runConnect(options(), h.io)).toBe(1);
    expect(h.err()).toContain('too many connections from this network are waiting for approval');
    expect(h.err()).toContain('about 10 minutes');
    expect(api.count('/v1/connect/start')).toBe(1);
  });
});

describe('disconnect', () => {
  it('cancels the session and forgets its token', async () => {
    const h = harness();
    const session = api.sessions.open(SESSION_TOKENS.first);
    await h.store.set(sessionKey(dir, api.url), SESSION_TOKENS.first);
    expect(await runDisconnect({ apiUrl: api.url, folder: dir }, h.io)).toBe(0);
    expect(session.selfRevoked).toBe(true);
    expect(await h.store.get(sessionKey(dir, api.url))).toBeUndefined();
    expect(h.out()).toContain('the session is cancelled in buildIt.Social');
    expect(await runDisconnect({ apiUrl: api.url, folder: dir }, h.io)).toBe(0);
    expect(h.out()).toContain('No session is saved');
  });
});

describe('disconnect, when the session already ended or the API is away', () => {
  it('forgets the token either way, and says what is left to do', async () => {
    const h = harness();
    api.sessions.open(SESSION_TOKENS.first);
    api.sessions.revoke(SESSION_TOKENS.first);
    await h.store.set(sessionKey(dir, api.url), SESSION_TOKENS.first);
    expect(await runDisconnect({ apiUrl: api.url, folder: dir }, h.io)).toBe(0);
    expect(h.out()).toContain('the session is cancelled in buildIt.Social');
    expect(await h.store.get(sessionKey(dir, api.url))).toBeUndefined();

    const h2 = harness();
    api.sessions.open(SESSION_TOKENS.second);
    api.enqueueError('/v1/session', 'unavailable');
    await h2.store.set(sessionKey(dir, api.url), SESSION_TOKENS.second);
    expect(await runDisconnect({ apiUrl: api.url, folder: dir }, h2.io)).toBe(0);
    expect(h2.out()).toContain('could not be cancelled in buildIt.Social (unavailable)');
    expect(await h2.store.get(sessionKey(dir, api.url))).toBeUndefined();
  });
});

describe('the API a folder is connected to', () => {
  it('is saved by connect and used by status and disconnect without --api-url', async () => {
    const h = harness((n) => {
      if (n === 1) api.sessions.approve();
    });
    expect(await runConnect(options(), h.io)).toBe(0);
    expect(await savedApiUrl(h.store, dir)).toBe(api.url);
    // Another BUILDIT_API_URL (or the default) doesn't matter: the saved one wins.
    const elsewhere = { apiUrl: 'https://api.example.com/functions/v1/agent-api', folder: dir };
    expect(await runStatus(elsewhere, h.io)).toBe(0);
    expect(h.out()).toContain(`API:      ${api.url}`);
    // --api-url still picks another deployment explicitly.
    expect(await runStatus({ ...elsewhere, apiUrlFlag: true }, h.io)).toBe(1);
    expect(await runDisconnect(elsewhere, h.io)).toBe(0);
    expect(await h.store.get(sessionKey(dir, api.url))).toBeUndefined();
    expect(await savedApiUrl(h.store, dir)).toBeUndefined();
  });
});

describe('the claude mcp add line', () => {
  it('runs the server the way connect ran: npx, or a local build', () => {
    expect(serverCommand('linux', '/opt/cache/.npm/_npx/abc/node_modules/.bin/buildit-mcp')).toBe(
      'claude mcp add buildit -- npx -y @kammcs/buildit-mcp@latest --channel',
    );
    expect(serverCommand('win32', undefined)).toBe(
      'claude mcp add buildit -- cmd /c npx -y "@kammcs/buildit-mcp@latest" --channel',
    );
    expect(serverCommand('linux', '/src/buildit-mcp/dist/index.js')).toBe(
      'claude mcp add buildit -- node "/src/buildit-mcp/dist/index.js" --channel',
    );
  });
});

describe('status', () => {
  it('shows the saved session, or that there is none', async () => {
    const h = harness();
    expect(await runStatus({ apiUrl: api.url, folder: dir }, h.io)).toBe(1);
    expect(h.out()).toContain('Not connected');

    api.sessions.open(SESSION_TOKENS.first, 'demo-folder');
    await h.store.set(sessionKey(dir, api.url), SESSION_TOKENS.first);
    expect(await runStatus({ apiUrl: api.url, folder: dir }, h.io)).toBe(0);
    expect(h.out()).toContain('Claude · demo-folder');
    expect(h.out()).toContain('Owner:    Test User');
    expect(h.out()).toContain('in Test Keychain');
    expect(h.out()).not.toContain(SESSION_TOKENS.first);

    api.sessions.revoke(SESSION_TOKENS.first);
    expect(await runStatus({ apiUrl: api.url, folder: dir }, h.io)).toBe(1);
    expect(h.out()).toContain('no longer accepts this session');
  });
});

describe('terminal safety', () => {
  it('strips control and direction characters from server text', () => {
    expect(plain('Evil\u001b[2J\u202Ename\r\nnext')).toBe('Evil [2J name next');
    expect(machineName('\u0007')).toBe('computer');
    expect(machineName('x'.repeat(100))).toHaveLength(64);
  });
});
