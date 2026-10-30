/**
 * A video's length and poster for reply's files (src/files/poster.ts):
 * with a mocked spawn, the programs found on the PATH only, run with no
 * shell and argument arrays, the output read from a temporary file, the
 * contract's limits (320 px, 64 KiB), and nothing at all, never an error,
 * without the programs or when they fail or time out; then one real run,
 * skipped when ffmpeg isn't installed.
 */
import { spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { prepareFiles, type CheckedFile } from '../src/channel/upload.js';
import {
  findProgram,
  jpegSize,
  parseDuration,
  POSTER_MAX_BYTES,
  posterTime,
  videoFacts,
  type Spawner,
} from '../src/files/poster.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bmcp-poster-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A minimal JPEG header: SOI, an APP0 segment, then SOF0 with the size, padded to `bytes`. */
function fakeJpeg(width: number, height: number, bytes = 2000): Buffer {
  const head = Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
  ]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, bytes - head.length))]);
}

interface Call {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
}

/**
 * A mock spawn: `ffprobe` prints `probeOut`; `ffmpeg` writes the next of
 * `frames` to its output (the last argument, a file: path). Records calls.
 */
function mockSpawn(script: {
  probeOut?: string;
  frames?: (Buffer | undefined)[];
  error?: NodeJS.ErrnoException;
  hang?: boolean;
}): { spawn: Spawner; calls: Call[] } {
  const calls: Call[] = [];
  const frames = [...(script.frames ?? [])];
  const spawn: Spawner = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { stdout, stderr });
    const close = (code: number): void => {
      stdout.end();
      stderr.end();
      setImmediate(() => child.emit('close', code));
    };
    options.signal?.addEventListener('abort', () => {
      const err = new Error('The operation was aborted') as NodeJS.ErrnoException;
      err.name = 'AbortError';
      child.emit('error', err);
      close(1);
    });
    setImmediate(() => {
      if (script.error !== undefined) {
        child.emit('error', script.error);
        return;
      }
      if (script.hang === true) return;
      if (command.includes('ffprobe')) {
        stdout.write(script.probeOut ?? '');
        close(0);
        return;
      }
      const frame = frames.shift();
      const out = String(args.at(-1)).replace(/^file:/, '');
      if (frame === undefined) {
        close(1);
        return;
      }
      writeFileSync(out, frame);
      close(0);
    });
    return child;
  };
  return { spawn, calls };
}

const which = (name: string): Promise<string | undefined> => Promise.resolve(`/opt/tools/${name}`);
const folder = () => Promise.resolve(dir);
const source = () => join(dir, 'clip.mp4');

describe('videoFacts with a mocked spawn', () => {
  it('reads the length and makes a poster, with no shell, argument arrays and file: paths', async () => {
    const { spawn, calls } = mockSpawn({
      probeOut: '4.250000\n',
      frames: [fakeJpeg(320, 180)],
    });
    const facts = await videoFacts(source(), folder, 0, { spawn, which });
    expect(facts.durationMs).toBe(4250);
    expect(facts.poster).toMatchObject({
      contentType: 'image/jpeg',
      size: 2000,
      width: 320,
      height: 180,
      path: join(dir, 'poster-0.jpg'),
    });
    expect(existsSync(facts.poster!.path)).toBe(true);
    expect(calls.map((c) => c.command)).toEqual(['/opt/tools/ffprobe', '/opt/tools/ffmpeg']);
    for (const c of calls) {
      expect(c.options.shell).toBe(false);
      expect(Array.isArray(c.args)).toBe(true);
      expect(c.options.signal).toBeInstanceOf(AbortSignal);
      expect(c.options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
      expect(c.args).toContain(`file:${source()}`);
    }
    const ffmpeg = calls[1]!.args;
    expect(ffmpeg).toEqual(expect.arrayContaining(['-nostdin', '-map_metadata', '-1', '-an']));
    expect(ffmpeg.at(-1)).toBe(`file:${join(dir, 'poster-0.jpg')}`);
    // 1 s in for a video longer than 3 s.
    expect(ffmpeg[ffmpeg.indexOf('-ss') + 1]).toBe('1.000');
    expect(ffmpeg.join(' ')).toContain('min(320,iw)');
  });

  it('sends nothing, and never runs anything, without ffprobe or ffmpeg on the PATH', async () => {
    const { spawn, calls } = mockSpawn({ probeOut: '4\n', frames: [fakeJpeg(320, 180)] });
    let asked = false;
    const facts = await videoFacts(
      source(),
      () => {
        asked = true;
        return folder();
      },
      0,
      {
        spawn,
        which: (name) => Promise.resolve(name === 'ffmpeg' ? '/opt/tools/ffmpeg' : undefined),
      },
    );
    expect(facts).toEqual({ durationMs: undefined, poster: undefined });
    expect(calls).toHaveLength(0);
    expect(asked).toBe(false);
  });

  it('lowers the quality until the poster fits 64 KiB, and drops one that never does', async () => {
    const big = fakeJpeg(320, 180, POSTER_MAX_BYTES + 1);
    const fits = mockSpawn({ probeOut: '10', frames: [big, big, fakeJpeg(320, 180, 30_000)] });
    const ok = await videoFacts(source(), folder, 1, { ...fits, which });
    expect(ok.poster?.size).toBe(30_000);
    const qualities = fits.calls.slice(1).map((c) => c.args[c.args.indexOf('-q:v') + 1]);
    expect(qualities).toEqual(['4', '8', '14']);

    const never = mockSpawn({ probeOut: '10', frames: Array.from({ length: 5 }, () => big) });
    const none = await videoFacts(source(), folder, 2, { ...never, which });
    expect(none.poster).toBeUndefined();
    expect(none.durationMs).toBe(10_000);
    expect(existsSync(join(dir, 'poster-2.jpg'))).toBe(false);
  });

  it('drops a poster over 320 px, and tries the first frame when there is none at 1 s', async () => {
    const wide = mockSpawn({ probeOut: '10', frames: [fakeJpeg(640, 360)] });
    expect((await videoFacts(source(), folder, 0, { ...wide, which })).poster).toBeUndefined();

    const late = mockSpawn({ probeOut: '10', frames: [undefined, fakeJpeg(200, 100)] });
    const r = await videoFacts(source(), folder, 0, { ...late, which });
    expect(r.poster).toMatchObject({ width: 200, height: 100 });
    const at = late.calls.slice(1).map((c) => c.args[c.args.indexOf('-ss') + 1]);
    expect(at).toEqual(['1.000', '0.000']);
  });

  it('gives nothing, never an error, when a program fails to start or is aborted', async () => {
    const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    const failed = mockSpawn({ error: enoent });
    expect(await videoFacts(source(), folder, 0, { ...failed, which })).toEqual({
      durationMs: undefined,
      poster: undefined,
    });

    const hung = mockSpawn({ hang: true });
    const controller = new AbortController();
    const pending = videoFacts(source(), folder, 0, {
      ...hung,
      which,
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort();
    }, 20);
    expect(await pending).toEqual({ durationMs: undefined, poster: undefined });
  });

  it('keeps no length that is out of the contract’s range', () => {
    expect(parseDuration('95.0')).toBe(95_000);
    expect(parseDuration('N/A')).toBeUndefined();
    expect(parseDuration('0')).toBeUndefined();
    expect(parseDuration('90000')).toBeUndefined();
    expect(posterTime(undefined)).toBe(0);
    expect(posterTime(1500)).toBe(0.5);
    expect(jpegSize(fakeJpeg(12, 34))).toEqual({ width: 12, height: 34 });
    expect(jpegSize(Buffer.from('not a jpeg'))).toBeUndefined();
  });
});

describe('prepareFiles', () => {
  const video = (path: string): CheckedFile => ({
    given: path,
    path,
    name: 'clip.webm',
    size: 4,
    contentType: 'video/webm',
    media: undefined,
  });

  it('adds a video’s length and poster, and nothing to other files or without the programs', async () => {
    const clip = join(dir, 'clip.webm');
    writeFileSync(clip, 'webm');
    const log = join(dir, 'run.log');
    writeFileSync(log, 'ok\n');
    const text: CheckedFile = { ...video(log), name: 'run.log', contentType: 'text/plain' };
    const { spawn, calls } = mockSpawn({ probeOut: '2', frames: [fakeJpeg(320, 240)] });
    const with_ = await prepareFiles([video(clip), text], { spawn, which });
    try {
      expect(with_.files[0]).toMatchObject({ durationMs: 2000, poster: { width: 320 } });
      expect(with_.files[1]?.poster).toBeUndefined();
      expect(with_.temp).toBeDefined();
      expect(calls).toHaveLength(2);
    } finally {
      if (with_.temp !== undefined) rmSync(with_.temp, { recursive: true, force: true });
    }
    const without = await prepareFiles([video(clip)], {
      spawn,
      which: () => Promise.resolve(undefined),
    });
    expect(without.files[0]?.durationMs).toBeUndefined();
    expect(without.files[0]?.poster).toBeUndefined();
    expect(without.temp).toBeUndefined();
  });
});

describe('findProgram', () => {
  it('looks only in absolute PATH folders, and on Windows only at .exe and .com', async () => {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'ffmpeg.cmd'), '@echo off');
    writeFileSync(join(bin, 'ffprobe.exe'), 'MZ');
    expect(await findProgram('ffmpeg', { Path: bin }, 'win32')).toBeUndefined();
    expect(await findProgram('ffprobe', { Path: `.;${bin}` }, 'win32')).toBe(
      join(bin, 'ffprobe.exe'),
    );
    expect(await findProgram('ffprobe', { Path: 'bin' }, 'win32')).toBeUndefined();
    if (process.platform !== 'win32') {
      writeFileSync(join(bin, 'ffmpeg'), '#!/bin/sh\n');
      expect(await findProgram('ffmpeg', { PATH: bin }, 'linux')).toBeUndefined();
      chmodSync(join(bin, 'ffmpeg'), 0o755);
      expect(await findProgram('ffmpeg', { PATH: bin }, 'linux')).toBe(join(bin, 'ffmpeg'));
    }
  });
});

const ffmpeg = await findProgram('ffmpeg');
const ffprobe = await findProgram('ffprobe');

describe.skipIf(ffmpeg === undefined || ffprobe === undefined)('with the real ffmpeg', () => {
  it('reads a 4 s video’s length and makes a 320 px JPEG poster under 64 KiB', async () => {
    const clip = join(dir, 'clip.mp4');
    const made = spawnSync(
      ffmpeg!,
      [
        '-nostdin',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=1280x720:rate=10',
        '-t',
        '4',
        '-pix_fmt',
        'yuv420p',
        clip,
      ],
      { timeout: 30_000 },
    );
    expect(made.status).toBe(0);
    const facts = await videoFacts(clip, folder, 0);
    expect(facts.durationMs).toBeGreaterThanOrEqual(3900);
    expect(facts.durationMs).toBeLessThanOrEqual(4100);
    expect(facts.poster).toMatchObject({ contentType: 'image/jpeg', width: 320, height: 180 });
    expect(facts.poster!.size).toBeLessThanOrEqual(POSTER_MAX_BYTES);
  }, 30_000);
});
