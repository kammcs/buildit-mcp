/**
 * The session token store: the key (folder and API origin), the fallback
 * file, and the keychain with its fallback, on a keychain fake.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  FileTokenStore,
  KEYRING_SERVICE,
  KeyringTokenStore,
  openTokenStore,
  sessionKey,
  type KeyringEntry,
  type KeyringFactory,
} from '../src/secrets/keychain.js';

const API = 'https://api.example.com/functions/v1/agent-api';
const TOKEN = 'buildit_ags_test_token_for_the_store';
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'buildit-mcp-store-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An in-memory keychain; `broken` makes every call fail, as without a Secret Service. */
function fakeKeyring(broken = false): { factory: KeyringFactory; entries: Map<string, string> } {
  const entries = new Map<string, string>();
  const fail = (): never => {
    throw new Error('Platform secure storage failure: no Secret Service');
  };
  const factory: KeyringFactory = (service, account): KeyringEntry => {
    const id = `${service}/${account}`;
    return {
      getPassword: () => (broken ? fail() : Promise.resolve(entries.get(id) ?? null)),
      setPassword: (password) => {
        if (broken) fail();
        entries.set(id, password);
        return Promise.resolve();
      },
      deletePassword: () => (broken ? fail() : Promise.resolve(entries.delete(id))),
    };
  };
  return { factory, entries };
}

describe('sessionKey', () => {
  it('is a hex SHA-256, one per folder and API origin', () => {
    const dir = tempDir();
    const key = sessionKey(dir, API, 'linux');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionKey(dir, `${API}/`, 'linux')).toBe(key);
    // The origin counts, the path doesn't.
    expect(sessionKey(dir, 'https://api.example.com/other', 'linux')).toBe(key);
    expect(sessionKey(dir, 'https://api2.example.com/functions/v1/agent-api', 'linux')).not.toBe(
      key,
    );
    expect(sessionKey(join(dir, 'sub'), API, 'linux')).not.toBe(key);
    expect(sessionKey(join(dir, 'sub', '..'), API, 'linux')).toBe(key);
  });

  it('folds case on Windows and macOS only', () => {
    const upper = '/Projects/Demo';
    const lower = '/projects/demo';
    expect(sessionKey(upper, API, 'win32')).toBe(sessionKey(lower, API, 'win32'));
    expect(sessionKey(upper, API, 'darwin')).toBe(sessionKey(lower, API, 'darwin'));
    expect(sessionKey(upper, API, 'linux')).not.toBe(sessionKey(lower, API, 'linux'));
  });
});

describe('FileTokenStore', () => {
  it('saves, reads and removes tokens, in a file only the user can read', async () => {
    const file = join(tempDir(), 'nested', 'sessions.json');
    const store = new FileTokenStore(file);
    expect(await store.get('a')).toBeUndefined();
    await store.set('a', TOKEN);
    await store.set('b', 'another');
    expect(await store.get('a')).toBe(TOKEN);
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(await store.delete('a')).toBe(true);
    expect(await store.delete('a')).toBe(false);
    expect(await store.get('a')).toBeUndefined();
    expect(await store.get('b')).toBe('another');
  });
});

describe('KeyringTokenStore', () => {
  it('keeps tokens in the keychain under the service, not in the file', async () => {
    const { factory, entries } = fakeKeyring();
    const file = new FileTokenStore(join(tempDir(), 'sessions.json'));
    const warnings: string[] = [];
    const store = new KeyringTokenStore(factory, file, (w) => warnings.push(w), 'Test Keychain');
    await store.set('k1', TOKEN);
    expect(entries.get(`${KEYRING_SERVICE}/k1`)).toBe(TOKEN);
    expect(await file.get('k1')).toBeUndefined();
    expect(await store.get('k1')).toBe(TOKEN);
    expect(store).toMatchObject({ kind: 'keyring', location: 'Test Keychain' });
    expect(await store.delete('k1')).toBe(true);
    expect(await store.get('k1')).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('falls back to the file, with one warning, when the keychain fails', async () => {
    const { factory } = fakeKeyring(true);
    const path = join(tempDir(), 'sessions.json');
    const file = new FileTokenStore(path);
    const warnings: string[] = [];
    const store = new KeyringTokenStore(factory, file, (w) => warnings.push(w), 'Test Keychain');
    await store.set('k1', TOKEN);
    expect(await file.get('k1')).toBe(TOKEN);
    expect(await store.get('k1')).toBe(TOKEN);
    expect(store).toMatchObject({ kind: 'file', location: path });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(path);
    expect(warnings[0]).not.toContain(TOKEN);
    expect(await store.delete('k1')).toBe(true);
    expect(await file.get('k1')).toBeUndefined();
  });
});

describe('openTokenStore', () => {
  it('uses the file when the keychain package is missing, and says so', async () => {
    const warnings: string[] = [];
    const path = join(tempDir(), 'sessions.json');
    const store = await openTokenStore({
      warn: (w) => warnings.push(w),
      keyring: () => Promise.resolve(undefined),
      file: path,
      env: {},
    });
    expect(store).toMatchObject({ kind: 'file', location: path });
    expect(warnings[0]).toContain('@napi-rs/keyring');
  });

  it('uses the file without a warning when BUILDIT_TOKEN_STORE=file', async () => {
    const warnings: string[] = [];
    const store = await openTokenStore({
      warn: (w) => warnings.push(w),
      keyring: () => Promise.resolve(fakeKeyring().factory),
      file: join(tempDir(), 'sessions.json'),
      env: { BUILDIT_TOKEN_STORE: 'file' },
    });
    expect(store.kind).toBe('file');
    expect(warnings).toEqual([]);
  });

  it('uses the keychain when it loads', async () => {
    const store = await openTokenStore({
      warn: () => undefined,
      keyring: () => Promise.resolve(fakeKeyring().factory),
      file: join(tempDir(), 'sessions.json'),
      env: {},
      platform: 'darwin',
    });
    expect(store).toMatchObject({ kind: 'keyring', location: 'the macOS Keychain' });
  });
});
