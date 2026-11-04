/**
 * Files in Codex sessions: attachments saved in the client-neutral
 * `.buildit/attachments/<session>/<message>/` (Claude Code's channel keeps
 * `.claude/`), the owner's images given to the model as `localImage`
 * inputs, `reply` with files through the hosted tool with every check,
 * and the cleanup.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ATTACHMENTS_DIR,
  BRIDGE_ATTACHMENTS_DIR,
  removeFolderAttachments,
} from '../src/channel/attachments.js';
import { imagesOf } from '../src/codex/bridge.js';
import { secretLocations } from '../src/files/paths.js';
import { CodexBench, waitFor } from './support/codex-run.js';
import { FakeApi } from './support/fake-api.js';
import { SESSION_TOKENS } from './support/fake-sessions.js';

let api: FakeApi;
let bench: CodexBench;

beforeAll(async () => {
  api = await new FakeApi().start();
});
afterAll(async () => {
  await api.close();
});
beforeEach(() => {
  api.reset();
  bench = new CodexBench(api);
});
afterEach(async () => {
  expect(await bench.cleanup()).toEqual([]);
  expect(api.violations).toEqual([]);
});

const token = SESSION_TOKENS.first;
const posts = () => api.sessions.session(token).messages;
type Input = { type: string; text?: string; path?: string }[];

const png = {
  name: 'shot.png',
  type: 'image/png',
  bytes: Buffer.from('a png'),
  kind: 'image' as const,
};
const notes = {
  name: 'notes.txt',
  type: 'text/plain',
  bytes: Buffer.from('some notes\n'),
  kind: 'text' as const,
};

describe('codex files: attachments in', () => {
  it('saves them under .buildit/attachments, and gives the images to the model as images', async () => {
    const s = api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    const r = await bench.start(codex);
    await waitFor(() => s.heartbeats.includes('online'));
    api.sessions.postFrom(token, 'Look at these', { files: [png, notes] });
    await waitFor(() => posts().some((m) => m.text === 'ok'));
    const input = codex.requests('turn/start')[0]!.input as Input;
    const session = r.state().session!.session.id;
    const base = join(bench.folder, BRIDGE_ATTACHMENTS_DIR);
    // The text lists both files by their saved paths.
    expect(input[0]!.type).toBe('text');
    expect(input[0]!.text).toContain(`${join(base, session)}${sep}`);
    expect(input[0]!.text).toContain('notes.txt');
    // Only the image goes in as an image, by its absolute path.
    const images = input.filter((i) => i.type === 'localImage');
    expect(images).toHaveLength(1);
    expect(images[0]!.path).toMatch(/shot\.png$/);
    expect(images[0]!.path!.startsWith(join(base, session))).toBe(true);
    expect(readFileSync(images[0]!.path!, 'utf8')).toBe('a png');
    expect(readFileSync(join(base, '.gitignore'), 'utf8')).toBe('*\n');
    // Nothing in Claude Code's folder.
    expect(existsSync(join(bench.folder, ATTACHMENTS_DIR))).toBe(false);
  });

  it("lists a forwarded message's image by its path, without giving it as an image", async () => {
    const s = api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    await bench.start(codex);
    await waitFor(() => s.heartbeats.includes('online'));
    api.sessions.postFrom(token, 'From a colleague', {
      files: [png],
      forwardedFrom: {
        user: { id: '00000000-0000-4000-8000-0000000000aa', name: 'Test Colleague' },
      },
    });
    await waitFor(() => posts().some((m) => m.text === 'ok'));
    const input = codex.requests('turn/start')[0]!.input as Input;
    expect(input.filter((i) => i.type === 'localImage')).toHaveLength(0);
    expect(input[0]!.text).toContain('shot.png');
  });

  it('takes images only of the types Codex reads, absolute, ten at most', () => {
    const file = (path: string, type = 'image/png', kind = 'image') => ({ path, type, kind });
    const abs = join(bench.folder, 'a.png');
    expect(imagesOf(undefined)).toEqual([]);
    expect(
      imagesOf({
        files: [
          file(abs),
          file('relative.png'),
          file(join(bench.folder, 'b.svg'), 'image/svg+xml'),
          file(join(bench.folder, 'c.txt'), 'text/plain', 'text'),
        ],
      }),
    ).toEqual([abs]);
    expect(imagesOf({ files: Array.from({ length: 12 }, () => file(abs)) })).toHaveLength(10);
  });
});

describe('codex files: reply with files, through the hosted tool', () => {
  it('posts a file from the folder, and refuses a secret store before any upload', async () => {
    const s = api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    writeFileSync(join(bench.folder, 'report.md'), '# Report\nAll good.\n');
    writeFileSync(join(bench.folder, '.env'), 'X=1\n');
    let refused = '';
    codex.onTurn = async (ctx) => {
      const client = await codex.mcp(ctx.threadId);
      const bad = await client.callTool({
        name: 'reply',
        arguments: { text: 'The env', files: ['.env'] },
      });
      refused = JSON.stringify(bad.content);
      const good = await client.callTool({
        name: 'reply',
        arguments: { text: 'The report', files: ['report.md'] },
      });
      expect(good.isError, JSON.stringify(good.content)).not.toBe(true);
      ctx.agentMessage('Shared.', 'final_answer');
      ctx.complete();
    };
    const r = await bench.start(codex);
    await waitFor(() => s.heartbeats.includes('online'));
    const thread = api.sessions.postFrom(token, 'Share the report');
    await waitFor(() => api.sessions.filePosts.length === 1);
    await r.bridge().idle();
    expect(refused).toContain("its name is a secret store's");
    expect(api.sessions.filePosts[0]).toMatchObject({ text: 'The report' });
    expect(posts().find((m) => m.text === 'The report')?.thread_id).toBe(thread);
    // The model replied there itself: the final answer isn't posted too.
    expect(posts().some((m) => m.text === 'Shared.')).toBe(false);
  });

  it("never shares from Codex's home", () => {
    const home = join(bench.dir, 'home');
    expect(secretLocations(home)).toContain(join(home, '.codex'));
  });
});

describe('codex files: cleanup', () => {
  it("disconnect removes both clients' attachments folders, and .buildit when it is left empty", async () => {
    const a = join(bench.folder, BRIDGE_ATTACHMENTS_DIR, 'session', 'message');
    const b = join(bench.folder, ATTACHMENTS_DIR, 'session', 'message');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(a, 'x.png'), 'x');
    writeFileSync(join(b, 'y.png'), 'y');
    await removeFolderAttachments(bench.folder);
    expect(existsSync(join(bench.folder, BRIDGE_ATTACHMENTS_DIR))).toBe(false);
    expect(existsSync(join(bench.folder, ATTACHMENTS_DIR))).toBe(false);
    expect(existsSync(join(bench.folder, '.buildit'))).toBe(false);
  });

  it('keeps .buildit when something else is in it', async () => {
    mkdirSync(join(bench.folder, BRIDGE_ATTACHMENTS_DIR), { recursive: true });
    writeFileSync(join(bench.folder, '.buildit', 'other.json'), '{}');
    await removeFolderAttachments(bench.folder);
    expect(existsSync(join(bench.folder, BRIDGE_ATTACHMENTS_DIR))).toBe(false);
    expect(existsSync(join(bench.folder, '.buildit', 'other.json'))).toBe(true);
  });

  it("removes the session's folder when the session ends", async () => {
    const s = api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    const r = await bench.start(codex);
    await waitFor(() => s.heartbeats.includes('online'));
    api.sessions.postFrom(token, 'Keep this', { files: [notes] });
    await waitFor(() => posts().some((m) => m.text === 'ok'));
    const session = join(bench.folder, BRIDGE_ATTACHMENTS_DIR, r.state().session!.session.id);
    expect(existsSync(session)).toBe(true);
    api.sessions.revoke(token);
    await waitFor(() => !existsSync(session), 6000);
    await r.done;
  });
});
