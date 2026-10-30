/**
 * A video's length and poster frame, for `reply`'s `files`, made with
 * ffprobe and ffmpeg when both are on the PATH. Without them (or when
 * either fails, is slow, or makes a poster over the contract's limits),
 * there is no poster and no length, and the file is shared as before:
 * nothing here ever refuses a file.
 *
 * The programs run safely:
 * - **No shell.** Each is spawned by its absolute path, found in the PATH's
 *   absolute folders only (never the current folder, never a `.cmd` or
 *   `.bat`, which would need a shell), with an argument array.
 * - **Paths as `file:` URLs** of absolute paths, so a name can't be read as
 *   an option or another protocol.
 * - **A timeout** for each run (and the tool call's own signal), after
 *   which the program is killed.
 * - **A temporary output**, in a folder the caller removes, written by
 *   ffmpeg with no metadata (`-map_metadata -1`), so the poster carries
 *   nothing but the frame.
 *
 * The poster is a JPEG of at most 320 px a side (never enlarged) and
 * 64 KiB, as the contract's `thumbnail` asks; a frame that is still over
 * 64 KiB at the lowest quality is dropped.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, rm, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';

/** The contract's limits for a video's poster. */
export const POSTER_MAX_BYTES = 64 * 1024;
export const POSTER_MAX_SIDE = 320;
/** The contract's limits for duration_ms. */
const DURATION_MAX_MS = 86_400_000;

/** How long ffprobe and ffmpeg may each take. */
export const PROBE_TIMEOUT_MS = 10_000;
export const FRAME_TIMEOUT_MS = 20_000;

/** The JPEG qualities tried in turn (ffmpeg's -q:v, 2 best to 31 worst). */
const QUALITIES = [4, 8, 14, 22, 31] as const;

/** At most this much of a program's output is kept. */
const MAX_STDOUT = 16 * 1024;

export type Spawner = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface PosterDeps {
  /** child_process.spawn (tests pass a mock). */
  spawn?: Spawner;
  /** Finds a program's absolute path on the PATH (tests pass one). */
  which?: (name: string) => Promise<string | undefined>;
}

export interface VideoPoster {
  /** The poster's path, in `dir`. */
  path: string;
  contentType: 'image/jpeg';
  size: number;
  width: number;
  height: number;
}

export interface VideoFacts {
  durationMs: number | undefined;
  poster: VideoPoster | undefined;
}

/**
 * The absolute path of `name` in the PATH's absolute folders, or undefined.
 * On Windows only `.exe` and `.com` count (a `.cmd` or `.bat` needs a shell).
 */
export async function findProgram(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  const win = platform === 'win32';
  const raw = (win ? (env.Path ?? env.PATH) : env.PATH) ?? '';
  const dirs = raw
    .split(win ? ';' : delimiter)
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d !== '' && isAbsolute(d));
  const names = win ? [`${name}.exe`, `${name}.com`] : [name];
  for (const dir of dirs) {
    for (const n of names) {
      const candidate = join(dir, n);
      try {
        const info = await stat(candidate);
        if (!info.isFile()) continue;
        if (!win) await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Not here.
      }
    }
  }
  return undefined;
}

/** Runs a program (no shell) and resolves with its exit code and first output; rejects on a spawn error or timeout. */
function run(
  spawn: Spawner,
  program: string,
  args: readonly string[],
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const limit = AbortSignal.timeout(timeoutMs);
    const both = signal === undefined ? limit : AbortSignal.any([signal, limit]);
    let child: ChildProcess;
    try {
      child = spawn(program, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: both,
        killSignal: 'SIGKILL',
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error('spawn failed'));
      return;
    }
    let out = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (out.length < MAX_STDOUT) out += chunk.slice(0, MAX_STDOUT - out.length);
    });
    // Drained and dropped: its text can name the file.
    child.stderr?.resume();
    let settled = false;
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (both.aborted) reject(new Error('timed out'));
      else resolve({ code, stdout: out });
    });
  });
}

/** A file's path as ffmpeg's `file:` URL protocol takes it (no option or protocol tricks). */
export function fileArg(path: string): string {
  return `file:${path}`;
}

/** The length in ms that ffprobe's `format=duration` gives, within the contract's range. */
export function parseDuration(stdout: string): number | undefined {
  const seconds = Number.parseFloat(stdout.trim().split(/\s+/)[0] ?? '');
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const ms = Math.round(seconds * 1000);
  if (ms < 1 || ms > DURATION_MAX_MS) return undefined;
  return ms;
}

/** A JPEG's width and height, from its first start-of-frame marker. */
export function jpegSize(b: Uint8Array): { width: number; height: number } | undefined {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return undefined;
  const at = (n: number): number => b[n] ?? 0;
  const u16 = (n: number): number => (at(n) << 8) | at(n + 1);
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return undefined;
    const marker = at(i + 1);
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = u16(i + 2);
    if (len < 2) return undefined;
    const sof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (sof) {
      if (i + 9 > b.length) return undefined;
      const height = u16(i + 5);
      const width = u16(i + 7);
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    if (marker === 0xda || marker === 0xd9) return undefined;
    i += 2 + len;
  }
  return undefined;
}

/** ffprobe's arguments for a file's length. */
export function probeArgs(source: string): string[] {
  return [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    fileArg(source),
  ];
}

/** ffmpeg's arguments for one poster frame at `atSeconds`, at most 320 px a side, no metadata. */
export function frameArgs(
  source: string,
  output: string,
  atSeconds: number,
  quality: number,
): string[] {
  const side = POSTER_MAX_SIDE;
  return [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    atSeconds.toFixed(3),
    '-i',
    fileArg(source),
    '-map',
    '0:v:0',
    '-frames:v',
    '1',
    '-an',
    '-sn',
    '-dn',
    '-map_metadata',
    '-1',
    '-vf',
    `scale=w='min(${side},iw)':h='min(${side},ih)':force_original_aspect_ratio=decrease,format=yuvj420p`,
    '-c:v',
    'mjpeg',
    '-q:v',
    String(quality),
    '-f',
    'image2',
    '-update',
    '1',
    '-y',
    fileArg(output),
  ];
}

/** Where in the video the poster is taken: 1 s in, or a third of a shorter one. */
export function posterTime(durationMs: number | undefined): number {
  if (durationMs === undefined) return 0;
  return durationMs > 3000 ? 1 : durationMs / 3000;
}

/**
 * The video's length and a poster, written as `poster-<index>.jpg` in the
 * folder `dir` gives (a temporary folder the caller removes; asked for only
 * when both programs are found). Each is undefined when it can't be made;
 * this never throws.
 */
export async function videoFacts(
  source: string,
  dir: () => Promise<string>,
  index: number,
  options: PosterDeps & { signal?: AbortSignal | undefined } = {},
): Promise<VideoFacts> {
  const spawn = options.spawn ?? nodeSpawn;
  const which = options.which ?? ((name: string) => findProgram(name));
  const none: VideoFacts = { durationMs: undefined, poster: undefined };
  try {
    const [ffprobe, ffmpeg] = await Promise.all([which('ffprobe'), which('ffmpeg')]);
    if (ffprobe === undefined || ffmpeg === undefined) return none;
    let durationMs: number | undefined;
    try {
      const probe = await run(spawn, ffprobe, probeArgs(source), PROBE_TIMEOUT_MS, options.signal);
      if (probe.code === 0) durationMs = parseDuration(probe.stdout);
    } catch {
      // No length; the poster may still be made.
    }
    if (options.signal?.aborted === true) return none;
    const output = join(await dir(), `poster-${index}.jpg`);
    const at = posterTime(durationMs);
    const poster = await makePoster(spawn, ffmpeg, source, output, at, options.signal).catch(
      () => undefined,
    );
    return { durationMs, poster };
  } catch {
    return none;
  }
}

async function makePoster(
  spawn: Spawner,
  ffmpeg: string,
  source: string,
  output: string,
  at: number,
  signal: AbortSignal | undefined,
): Promise<VideoPoster | undefined> {
  for (const quality of QUALITIES) {
    await rm(output, { force: true });
    let r = await run(
      spawn,
      ffmpeg,
      frameArgs(source, output, at, quality),
      FRAME_TIMEOUT_MS,
      signal,
    );
    let bytes = r.code === 0 ? await readFile(output).catch(() => undefined) : undefined;
    if ((bytes === undefined || bytes.length === 0) && at > 0) {
      // No frame there (a short or odd file): the first frame instead.
      await rm(output, { force: true });
      r = await run(spawn, ffmpeg, frameArgs(source, output, 0, quality), FRAME_TIMEOUT_MS, signal);
      bytes = r.code === 0 ? await readFile(output).catch(() => undefined) : undefined;
      at = 0;
    }
    if (bytes === undefined || bytes.length === 0) break;
    if (bytes.length > POSTER_MAX_BYTES) continue;
    const size = jpegSize(bytes);
    if (size === undefined || size.width > POSTER_MAX_SIDE || size.height > POSTER_MAX_SIDE) break;
    return {
      path: output,
      contentType: 'image/jpeg',
      size: bytes.length,
      width: size.width,
      height: size.height,
    };
  }
  await rm(output, { force: true }).catch(() => undefined);
  return undefined;
}
