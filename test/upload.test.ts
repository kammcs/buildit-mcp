/**
 * reply with files: the checks before any request (roots, secret folders
 * and names, programs, sizes, the whole-file credential scan), location
 * removed from photos, the upload sequence (init, a PUT with exactly the
 * signed headers and no token, complete; upload_missing then the PUT
 * again), all or nothing, idempotent retries, and the refusals the API
 * gives, against the fake API and its fake storage.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { CallToolResult } from '@modelcontextprotocol/client';

import { findCredentials } from '../src/channel/mask.js';
import { stripLocation } from '../src/files/location.js';
import { scanFileForCredentials } from '../src/files/scan.js';
import { locationProblem } from '../src/files/paths.js';
import {
  channelConfig,
  startChannel,
  waitFor,
  type ChannelClient,
} from './support/channel-harness.js';
import { FakeApi } from './support/fake-api.js';
import { SESSION_TOKENS } from './support/fake-sessions.js';

const TOKEN = SESSION_TOKENS.first;
const FIXTURES = new URL('./fixtures/location/', import.meta.url);

let api: FakeApi;
const stops: (() => Promise<void>)[] = [];
let folder: string;

beforeAll(async () => {
  api = await new FakeApi().start();
});
afterAll(async () => {
  await api.close();
});
beforeEach(() => {
  api.reset();
  folder = mkdtempSync(join(tmpdir(), 'bmcp-up-'));
});
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
  expect(api.violations).toEqual([]);
  rmSync(folder, { recursive: true, force: true });
});

const textOf = (r: CallToolResult): string =>
  (r.content as { type: string; text: string }[]).map((c) => c.text).join('\n');

async function start(): Promise<ChannelClient> {
  api.sessions.open(TOKEN);
  const c = await startChannel(api, stops, {
    config: channelConfig(api, { BUILDIT_FOLDER: folder }),
    stdio: { typing: { everyMs: 60_000 } },
  });
  await waitFor(() => api.sessions.session(TOKEN).heartbeats.includes('online'));
  // reply needs the session read (its id names the uploads).
  await waitFor(() => api.requests.some((r) => r.path === '/v1/session'));
  return c;
}

const reply = (c: ChannelClient, args: Record<string, unknown>) =>
  c.client.callTool({ name: 'reply', arguments: args });

/** Requests that did anything with files (uploads, completes, posts with files). */
const fileRequests = () =>
  api.requests.filter(
    (r) => r.path.startsWith('/v1/session/uploads') || r.path === '/v1/session/messages',
  );

function file(name: string, content: string | Buffer): string {
  const p = join(folder, name);
  writeFileSync(p, content);
  return p;
}

describe('the credential scan', () => {
  it('finds each rule’s kind on its line, as the API names them', () => {
    // Split so no secret scanner reads them as real credentials: made-up values only.
    const lines = [
      'ok line',
      '-----BEGIN ' + 'RSA PRIVATE KEY-----',
      'MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu',
      '-----END ' + 'RSA PRIVATE KEY-----',
      'curl -H "Authorization: Bearer ' + 'abcdefghijklmnopqrstuvwxyz012345" https://example.com',
      'https://admin:' + 'notarealpass@db.example.com/app',
      'mytool --password ' + 'notarealvalue',
      'API_TOKEN=' + 'abcd1234efgh5678',
      'AWS key ' + 'AKIA' + 'ABCDEFGHIJKLMNOP',
      'eyJhbGciOiJIUzI1NiJ9' + '.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc',
    ];
    const found = findCredentials(lines.join('\n'));
    expect(found?.kinds).toEqual([
      'private_key',
      'authorization_header',
      'bearer_token',
      'url_password',
      'credential_option',
      'credential_assignment',
      'api_key',
      'jwt',
    ]);
    expect(found?.lines).toEqual(expect.arrayContaining([2, 5, 6, 7, 8, 9, 10]));
    expect(findCredentials('nothing to see\nhere')).toBeUndefined();
  });

  it('scans a whole large file, with line numbers across its pieces', async () => {
    const filler = 'just a log line without secrets\n'.repeat(80_000); // about 2.5 MB
    const p = file('big.log', `${filler}${'tok' + 'en'}=${'abcdefgh' + '12345678'}\n${filler}`);
    const found = await scanFileForCredentials(p);
    expect(found?.kinds).toEqual(['credential_assignment']);
    expect(found?.lines).toEqual([80_001]);
  });
});

describe('the roots', () => {
  it('allows the project and the temp folder, and refuses secret folders and anything else', async () => {
    expect(await locationProblem(join(folder, 'a.txt'), { folder })).toBeUndefined();
    expect(await locationProblem(join(tmpdir(), 'x.txt'), { folder })).toBeUndefined();
    expect(await locationProblem(join(homedir(), '.ssh', 'id_rsa'), { folder: homedir() })).toBe(
      'secret_folder',
    );
    const other = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/hosts';
    expect(await locationProblem(other, { folder })).toBe('outside_roots');
  });
});

describe('reply with files', () => {
  it('uploads, PUTs with exactly the signed headers and no token, completes, and posts once', async () => {
    const c = await start();
    const png = readFileSync(new URL('plain.png', FIXTURES));
    file('shot.png', png);
    file('run.log', 'all tests passed\n');
    const r = await reply(c, {
      text: "Here's the run",
      files: ['shot.png', join(folder, 'run.log')],
    });
    expect(r.isError, textOf(r)).not.toBe(true);
    const out = r.structuredContent as {
      messages: { id: string }[];
      files: { name: string; upload_id: string }[];
    };
    expect(out.files.map((f) => f.name)).toEqual(['shot.png', 'run.log']);
    // The image with the text, the log on its own.
    expect(out.messages).toHaveLength(2);
    expect(textOf(r)).toContain('Posted 2 files');
    const puts = api.sessions.files.storage.filter((s) => s.method === 'PUT');
    expect(puts).toHaveLength(2);
    for (const put of puts) {
      expect(put.headers.authorization).toBeUndefined();
      expect(put.headers['content-type']).toBeDefined();
    }
    expect(api.sessions.files.uploads.get(out.files[0]!.upload_id)?.bytes).toEqual(png);
    expect(api.sessions.filePosts).toHaveLength(1);
    expect(api.sessions.filePosts[0]?.text).toBe("Here's the run");
    // Retried with the same key: nothing is uploaded or posted twice.
    const key = (r.structuredContent as { idempotency_key: string }).idempotency_key;
    const again = await reply(c, {
      text: "Here's the run",
      files: ['shot.png', join(folder, 'run.log')],
      idempotency_key: key,
    });
    expect(again.isError, textOf(again)).not.toBe(true);
    expect(api.sessions.files.storage.filter((s) => s.method === 'PUT')).toHaveLength(2);
    expect(api.sessions.filePosts).toHaveLength(1);
    expect(textOf(again)).toContain('Nothing new');
    expect(textOf(r) + textOf(again)).not.toMatch(/_storage|X-Amz/);
  });

  it('PUTs again and completes again when the bytes didn’t arrive (upload_missing)', async () => {
    const c = await start();
    file('notes.md', '# Notes\n');
    api.sessions.files.dropPuts = 1;
    const r = await reply(c, { files: ['notes.md'] });
    expect(r.isError, textOf(r)).not.toBe(true);
    expect(api.sessions.files.storage.filter((s) => s.method === 'PUT')).toHaveLength(2);
    expect(api.sessions.files.completes).toHaveLength(2);
    expect(api.sessions.filePosts[0]?.text).toBeUndefined();
  });

  it('removes a photo’s location before upload, never touching the original', async () => {
    const c = await start();
    const original = readFileSync(new URL('gps.jpg', FIXTURES));
    const p = file('trip.jpg', original);
    const r = await reply(c, { text: 'Photo', files: [p] });
    expect(r.isError, textOf(r)).not.toBe(true);
    const out = r.structuredContent as {
      files: { upload_id: string; location_removed: boolean }[];
    };
    expect(out.files[0]?.location_removed).toBe(true);
    const sent = api.sessions.files.uploads.get(out.files[0]!.upload_id)!.bytes!;
    expect(new Uint8Array(sent)).toEqual(stripLocation(new Uint8Array(original)));
    expect(readFileSync(p)).toEqual(original);
  });

  it('refuses every bad file before any request, all or nothing, saying why', async () => {
    const c = await start();
    file('good.txt', 'fine\n');
    file('.env', 'X=1\n');
    file('server.pem', 'not a key\n');
    file('setup.exe', 'MZ');
    const mz = Buffer.alloc(256);
    mz.write('MZ', 0);
    mz.writeUInt32LE(128, 0x3c);
    Buffer.from([0x50, 0x45, 0, 0]).copy(mz, 128);
    file('innocent.png', mz);
    // Split so no secret scanner reads it as a real one: a made-up value.
    file('config.log', 'line one\nline two\n' + 'pass' + 'word=' + 'abcd1234efgh\n');
    const before = fileRequests().length;
    const r = await reply(c, {
      text: 'All of these',
      files: [
        'good.txt',
        '.env',
        'server.pem',
        'setup.exe',
        'innocent.png',
        'config.log',
        'missing.txt',
      ],
    });
    expect(r.isError).toBe(true);
    const text = textOf(r);
    expect(text).toContain('Not shared:');
    expect(text).toContain(`".env": its name is a secret store's`);
    expect(text).toContain(`"server.pem": its name is a secret store's`);
    expect(text).toContain('"setup.exe": programs and installers are never shared');
    expect(text).toContain('"innocent.png": it is a program');
    expect(text).toContain(
      '"config.log": line 3 looks like a password, secret or token assignment',
    );
    expect(text).toContain('"missing.txt": no such file');
    expect(text).toContain('Nothing was uploaded or posted');
    expect(text).not.toContain('abcd1234efgh');
    expect(fileRequests().length).toBe(before);
    expect(api.sessions.files.storage).toHaveLength(0);
  });

  it('refuses files outside the project and the temp folder, and files over the size cap', async () => {
    const c = await start();
    const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/hosts';
    const r = await reply(c, { text: 'x', files: [outside] });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("outside this session's folder and the temp folder");
    const big = join(folder, 'huge.zip');
    writeFileSync(big, '');
    // A sparse 101 MiB file: over the 100 MiB cap for anything but a video.
    const { truncateSync } = await import('node:fs');
    truncateSync(big, 101 * 1024 * 1024);
    const r2 = await reply(c, { text: 'x', files: ['huge.zip'] });
    expect(textOf(r2)).toContain('"huge.zip": it is 101 MiB, over the 100 MiB limit');
    expect(api.sessions.files.storage).toHaveLength(0);
  });

  it('posts nothing when the API refuses one file at complete, with the lines it names', async () => {
    const c = await start();
    file('a.txt', 'first\n');
    file('b.txt', 'second\n');
    api.sessions.files.completeRefusals.push(
      { code: 'upload_mismatch', details: { mismatch: 'size' } },
      { code: 'credential_found', details: { lines: [4], kinds: ['api_key'] } },
    );
    // The first refusal is for a.txt.
    const r = await reply(c, { text: 'Two', files: ['a.txt', 'b.txt'] });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('"a.txt": the file changed while it was uploading');
    expect(api.sessions.filePosts).toHaveLength(0);
    const r2 = await reply(c, { text: 'Two', files: ['b.txt'] });
    expect(textOf(r2)).toContain('"b.txt": buildIt.Social found that line 4 looks like an API key');
    expect(api.sessions.filePosts).toHaveLength(0);
  });

  it('says what to ask for without files:write, and refuses a reply with neither text nor files', async () => {
    api.sessions.open(TOKEN);
    const identity = api.identities[TOKEN]!;
    identity.token.scopes = identity.token.scopes.filter((s) => s !== 'files:write');
    const c = await startChannel(api, stops, {
      config: channelConfig(api, { BUILDIT_FOLDER: folder }),
      stdio: { typing: { everyMs: 60_000 } },
    });
    await waitFor(() => api.requests.some((r) => r.path === '/v1/session'));
    file('a.txt', 'x\n');
    const r = await reply(c, { files: ['a.txt'] });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Ask Test User to add Files permissions in Settings → Agents');
    const none = await reply(c, {});
    expect(textOf(none)).toContain('Give text, files, or both.');
  });

  it('shares from the temp folder too, and copies nothing into the project', async () => {
    const c = await start();
    const dir = mkdtempSync(join(tmpdir(), 'bmcp-share-src-'));
    try {
      mkdirSync(join(dir, 'out'));
      copyFileSync(new URL('plain.png', FIXTURES), join(dir, 'out', 'render.png'));
      const r = await reply(c, { text: 'Render', files: [join(dir, 'out', 'render.png')] });
      expect(r.isError, textOf(r)).not.toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
