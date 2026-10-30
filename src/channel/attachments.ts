/**
 * Attachments that come to the session: the files on the owner's messages,
 * downloaded by themselves before the message reaches Claude, and any file
 * of the session's threads fetched again with get_attachment.
 *
 * Each file is saved in the session's folder inside the project, so Claude
 * Code reads it as it reads any project file:
 * `<folder>/.claude/buildit-attachments/<session>/<message>/<name>`. The
 * folder holds a `.gitignore` of `*`, so nothing in it is committed; when
 * it can't be written, `<os temp>/buildit-mcp/<session>/<message>/` is
 * used instead. Folders are 0700, files 0600 and never executable, and
 * each file is marked as downloaded from the internet (the Windows zone
 * mark, the macOS quarantine flag). Names are cleaned (types.ts), the
 * saved path must stay inside its message's folder, and a file never
 * replaces another.
 *
 * The download link (create_session_attachment_link) is a bearer URL for
 * two minutes: it is used once, at once, and never logged, saved or shown.
 * A file already saved (the same file id and size, after a restart) is
 * used again, so nothing downloads twice.
 *
 * The automatic download takes files of at most 100 MiB each and 250 MiB
 * per message, within the session's daily budget, at most 3 at once and
 * 60 seconds per message; anything else is listed with why, for
 * get_attachment. Message folders older than 7 days are removed when the
 * server starts and every hour, the oldest first above 2 GiB, and the
 * session's folder when the session ends or the folder is disconnected.
 */
import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { ApiError, type ApiClient, type ApiRequestOptions } from '../api/client.js';
import type { CreateSessionAttachmentLinkResponse, SessionFile } from '../api/generated/schemas.js';
import { callOperation } from '../api/operations.js';
import { cleanFileName, numberedName } from '../files/types.js';
import { isInside } from '../files/paths.js';
import { downloadToFile, TransferError } from '../files/transfer.js';
import type { Logger } from '../log.js';
import { compareVersions } from '../version.js';

/** The agent API version that serves files. */
export const FILES_API = '1.11.0';

/** The operations the files features need. */
export const FILES_OPERATIONS = [
  'create_session_attachment_link',
  'create_session_upload',
  'complete_session_upload',
] as const;

/**
 * Whether this API serves files: get_meta says 1.11.0 or newer and lists
 * the three operations. Undefined when it hasn't said (no /v1/meta read).
 */
export function filesServed(api: ApiClient): boolean | undefined {
  const served = api.served;
  if (served === undefined) return undefined;
  if (compareVersions(served.apiVersion, FILES_API) < 0) return false;
  if (served.operations === undefined) return false;
  return FILES_OPERATIONS.every((op) => served.operations?.has(op) === true);
}

/** The folder, relative to the project, that holds the sessions' attachments. */
export const ATTACHMENTS_DIR = join('.claude', 'buildit-attachments');

/** The automatic download's caps. */
export const AUTO_FILE_MAX_BYTES = 100 * 1024 * 1024;
export const AUTO_MESSAGE_MAX_BYTES = 250 * 1024 * 1024;
export const AUTO_EVENT_MS = 60_000;
export const AUTO_PARALLEL = 3;
/** The largest file get_attachment fetches (the API's cap for a video). */
export const FETCH_MAX_BYTES = 250 * 1024 * 1024;
/** How long a message's folder is kept. */
export const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** The most the attachments folder holds before the oldest messages go. */
export const FOLDER_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** The cleanup's pace. */
export const CLEANUP_EVERY_MS = 60 * 60 * 1000;

/** The index of a message's folder: which file id was saved under which name. Never a URL. */
const INDEX_FILE = '.files.json';

/** What the link said of a file and its message (never the URL), kept with the saved copy. */
export interface LinkMeta {
  file: CreateSessionAttachmentLinkResponse['file'];
  message: CreateSessionAttachmentLinkResponse['message'];
}

interface IndexEntry {
  name: string;
  size: number;
  meta?: LinkMeta;
}

/** Why a file wasn't downloaded by itself. */
export type NotFetched =
  | 'over_file_cap'
  | 'over_message_cap'
  | 'budget'
  | 'timeout'
  | 'no_scope'
  | 'files_off'
  | 'not_served'
  | 'not_found'
  | 'failed';

/** What became of one file of a message. */
export type AttachmentOutcome =
  | { file: SessionFile; path: string }
  | { file: SessionFile; path?: undefined; reason: NotFetched; detail?: string };

/** Whose data a fetched file is, from the link's answer. */
export interface FetchedFrom {
  author: string | null;
  author_kind: string | null;
  from_owner: boolean;
  forwarded: boolean;
  forwarded_from: string | null;
}

export interface Fetched {
  path: string;
  file: {
    id: string;
    name: string;
    type: string;
    size_bytes: number;
    kind: string;
  };
  variant: 'original' | 'thumbnail';
  from: FetchedFrom;
  reused: boolean;
}

export interface AttachmentStoreOptions {
  api: ApiClient;
  logger: Logger;
  /** The project folder the session is connected for. */
  folder: string;
  /** The session's id (its folder's name). */
  sessionId: string;
  /** Bytes this session may still download today, when the session said. */
  budgetLeft?: number | undefined;
  /** For tests: the clock. */
  now?: () => number;
  /** For tests: the temp folder of the fallback. */
  tmp?: string;
}

const SAFE_ID = /^[0-9a-fA-F-]{1,64}$/;

/** A file's size in plain words (KB, MB, GB, decimal, as the app shows them). */
export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1000;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${units[u]}`;
}

/** A length as m:ss (or h:mm:ss). */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** Runs `tasks` with at most `limit` at once. */
async function inParallel(limit: number, tasks: (() => Promise<void>)[]): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const task = tasks[next++];
      await task?.();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
}

/** Marks a saved file as downloaded from the internet. Best effort. */
async function markFromWeb(path: string, now: number): Promise<void> {
  if (process.platform === 'win32') {
    // The alternate data stream Windows' browsers write: zone 3, the internet.
    await writeFile(`${path}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n').catch(
      () => undefined,
    );
  } else if (process.platform === 'darwin') {
    const flag = `0081;${Math.floor(now / 1000).toString(16)};buildit-mcp;`;
    await new Promise<void>((done) => {
      execFile('xattr', ['-w', 'com.apple.quarantine', flag, path], { timeout: 5000 }, () => {
        done();
      });
    });
  }
}

export class AttachmentStore {
  /** Bytes this session may still download today, as the API last said (undefined: not known). */
  budgetLeft: number | undefined;
  private readonly now: () => number;
  private readonly tmp: string;
  /** Where the session's files go once the project folder was found unwritable. */
  private fallback = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: AttachmentStoreOptions) {
    this.budgetLeft = options.budgetLeft;
    this.now = options.now ?? Date.now;
    this.tmp = options.tmp ?? tmpdir();
    if (!SAFE_ID.test(options.sessionId)) throw new Error('bad session id');
  }

  /** The folder of all sessions' attachments in the project. */
  get base(): string {
    return join(this.options.folder, ATTACHMENTS_DIR);
  }

  /** The fallback folder of all sessions' attachments. */
  get tmpBase(): string {
    return join(this.tmp, 'buildit-mcp');
  }

  /** This session's folder (the project's, or the fallback). */
  get root(): string {
    return join(this.fallback ? this.tmpBase : this.base, this.options.sessionId);
  }

  /** Makes a folder (0700), refusing a symlink in its place. */
  private async folder(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const s = await lstat(path);
    if (s.isSymbolicLink() || !s.isDirectory()) throw new Error('not a folder');
  }

  /** The folder of one message's files, made with its parents and the .gitignore. */
  async messageFolder(messageId: string): Promise<string> {
    if (!SAFE_ID.test(messageId)) throw new Error('bad message id');
    if (!this.fallback) {
      try {
        await this.folder(this.base);
        const ignore = join(this.base, '.gitignore');
        await writeFile(ignore, '*\n', { flag: 'wx', mode: 0o600 }).catch((err: unknown) => {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        });
        await this.folder(join(this.base, this.options.sessionId));
      } catch {
        this.fallback = true;
        this.options.logger.warn(
          'the project folder is not writable; attachments are saved in the temp folder',
        );
      }
    }
    if (this.fallback) await this.folder(join(this.tmpBase, this.options.sessionId));
    const dir = join(this.root, messageId);
    await this.folder(dir);
    return dir;
  }

  private async readIndex(dir: string): Promise<Record<string, IndexEntry>> {
    try {
      const raw = JSON.parse(await readFile(join(dir, INDEX_FILE), 'utf8')) as unknown;
      return raw !== null && typeof raw === 'object' ? (raw as Record<string, IndexEntry>) : {};
    } catch {
      return {};
    }
  }

  /** A file saved before (the same id, variant and size), when it is still there. */
  private async saved(
    messageId: string,
    fileId: string,
    variant: 'original' | 'thumbnail',
    size: number | undefined,
  ): Promise<{ path: string; meta: LinkMeta | undefined } | undefined> {
    const dir = join(this.root, messageId);
    const entry = (await this.readIndex(dir))[`${fileId}:${variant}`];
    if (entry === undefined || typeof entry.name !== 'string') return undefined;
    const path = join(dir, entry.name);
    if (!isInside(dir, resolve(path))) return undefined;
    try {
      const s = await lstat(path);
      if (!s.isFile() || s.size !== entry.size) return undefined;
      if (size !== undefined && s.size !== size) return undefined;
      return { path, meta: entry.meta };
    } catch {
      return undefined;
    }
  }

  /** A free name in `dir` for `name`: `name`, else `name (1).ext`, `name (2).ext`... */
  private async freeName(dir: string, name: string): Promise<string> {
    const taken = new Set((await readdir(dir).catch(() => [])).map((n) => n.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let n = 1; n < 1000; n++) {
      const other = numberedName(name, n);
      if (!taken.has(other.toLowerCase())) return other;
    }
    return numberedName(name, this.now());
  }

  /**
   * Fetches one file of a message into its folder: a reused copy, else a
   * link (counted against the budget) and the download. Throws ApiError
   * (the link refused) or TransferError (the download failed).
   */
  async fetch(
    messageId: string,
    request: {
      fileId?: string | undefined;
      variant?: 'original' | 'thumbnail';
      auto: boolean;
      /** The size the event gave, to reuse a saved copy without asking. */
      size?: number | undefined;
      maxBytes?: number;
      signal?: AbortSignal | undefined;
      apiOptions?: ApiRequestOptions;
    },
  ): Promise<{ path: string; reused: boolean; meta: LinkMeta | undefined }> {
    const variant = request.variant ?? 'original';
    if (request.fileId !== undefined) {
      const found = await this.saved(messageId, request.fileId, variant, request.size);
      if (found !== undefined) return { path: found.path, reused: true, meta: found.meta };
    }
    const link = await callOperation(
      this.options.api,
      'create_session_attachment_link',
      {
        body: {
          message_id: messageId,
          ...(request.fileId === undefined ? {} : { file_id: request.fileId }),
          ...(variant === 'original' ? {} : { variant }),
          ...(request.auto ? { auto: true } : {}),
        },
      },
      { ...request.apiOptions, ...(request.signal ? { signal: request.signal } : {}) },
    );
    this.budgetLeft = link.budget.down_bytes_left;
    const size = variant === 'original' ? link.file.size_bytes : undefined;
    const meta: LinkMeta = { file: link.file, message: link.message };
    const again = await this.saved(messageId, link.file.id, variant, size);
    if (again !== undefined) return { path: again.path, reused: true, meta };
    const dir = await this.messageFolder(messageId);
    const clean = cleanFileName(link.file.name);
    const wanted = variant === 'thumbnail' ? `thumbnail - ${clean}` : clean;
    const name = await this.freeName(dir, cleanFileName(wanted));
    const path = join(dir, name);
    if (!isInside(dir, resolve(path))) throw new TransferError('url');
    const part = join(dir, `.${link.file.id}.part`);
    await rm(part, { force: true });
    await downloadToFile(link.url, part, {
      maxBytes: request.maxBytes ?? FETCH_MAX_BYTES,
      ...(size === undefined ? {} : { exactBytes: size }),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    await rename(part, path);
    await markFromWeb(path, this.now());
    const index = await this.readIndex(dir);
    index[`${link.file.id}:${variant}`] = { name, size: (await stat(path)).size, meta };
    await writeFile(join(dir, INDEX_FILE), JSON.stringify(index), { mode: 0o600 });
    return { path, reused: false, meta };
  }

  /**
   * The automatic download of an event's own message: each file within the
   * caps and the budget, at most AUTO_PARALLEL at once, within
   * AUTO_EVENT_MS. Never throws: a file that fails is listed with why.
   */
  async autoDownload(
    messageId: string,
    files: readonly SessionFile[],
    options: { signal?: AbortSignal; deadlineMs?: number } = {},
  ): Promise<AttachmentOutcome[]> {
    const sorted = [...files].sort((a, b) => a.position - b.position);
    const outcomes = new Map<string, AttachmentOutcome>();
    const deadline = AbortSignal.timeout(options.deadlineMs ?? AUTO_EVENT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    let reserved = 0;
    const tasks: (() => Promise<void>)[] = [];
    let stop: NotFetched | undefined;
    for (const file of sorted) {
      if (file.size_bytes > AUTO_FILE_MAX_BYTES) {
        outcomes.set(file.id, { file, reason: 'over_file_cap' });
        continue;
      }
      if (reserved + file.size_bytes > AUTO_MESSAGE_MAX_BYTES) {
        outcomes.set(file.id, { file, reason: 'over_message_cap' });
        continue;
      }
      reserved += file.size_bytes;
      tasks.push(async () => {
        if (stop !== undefined) {
          outcomes.set(file.id, { file, reason: stop });
          return;
        }
        if (signal.aborted) {
          outcomes.set(file.id, { file, reason: 'timeout' });
          return;
        }
        const saved = await this.saved(messageId, file.id, 'original', file.size_bytes);
        if (saved !== undefined) {
          outcomes.set(file.id, { file, path: saved.path });
          return;
        }
        if (this.budgetLeft !== undefined && file.size_bytes > this.budgetLeft) {
          outcomes.set(file.id, { file, reason: 'budget' });
          return;
        }
        // Reserved now, so the downloads running at once don't spend the same bytes (the link says what's left).
        if (this.budgetLeft !== undefined) this.budgetLeft -= file.size_bytes;
        try {
          const r = await this.fetch(messageId, {
            fileId: file.id,
            auto: true,
            size: file.size_bytes,
            maxBytes: AUTO_FILE_MAX_BYTES,
            signal,
          });
          outcomes.set(file.id, { file, path: r.path });
        } catch (err) {
          const reason = this.notFetched(err, signal);
          if (reason === 'no_scope' || reason === 'files_off' || reason === 'not_served') {
            stop = reason;
          }
          if (reason === 'budget') this.budgetLeft = 0;
          outcomes.set(file.id, {
            file,
            reason,
            ...(err instanceof ApiError ? { detail: err.code } : {}),
          });
          this.options.logger.info('attachment not downloaded', {
            message_id: messageId,
            file_id: file.id,
            reason,
            ...(err instanceof ApiError ? { code: err.code } : {}),
          });
        }
      });
    }
    await inParallel(AUTO_PARALLEL, tasks);
    return sorted.map((file) => outcomes.get(file.id) ?? { file, reason: 'failed' });
  }

  private notFetched(err: unknown, signal: AbortSignal): NotFetched {
    if (err instanceof ApiError) {
      switch (err.code) {
        case 'budget_exceeded':
          return 'budget';
        case 'scope_missing':
          return 'no_scope';
        case 'files_off':
          return 'files_off';
        case 'attachment_not_found':
          return 'not_found';
        default:
          return err.status === 404 &&
            (err.details as { kind?: unknown } | undefined)?.kind === 'route'
            ? 'not_served'
            : 'failed';
      }
    }
    if (err instanceof TransferError && err.reason === 'timeout') return 'timeout';
    return signal.aborted ? 'timeout' : 'failed';
  }

  /**
   * Removes message folders older than KEEP_MS, then the oldest while all
   * of them hold more than FOLDER_MAX_BYTES, in the project's folder and
   * the fallback, for every session. Best effort.
   */
  async cleanup(): Promise<{ removed: number }> {
    let removed = 0;
    const messages: { path: string; mtime: number; size: number }[] = [];
    for (const base of [this.base, this.tmpBase]) {
      const sessions = await readdir(base, { withFileTypes: true }).catch(() => []);
      for (const s of sessions) {
        if (!s.isDirectory() || !SAFE_ID.test(s.name)) continue;
        const sessionDir = join(base, s.name);
        const entries = await readdir(sessionDir, { withFileTypes: true }).catch(() => []);
        for (const m of entries) {
          if (!m.isDirectory() || !SAFE_ID.test(m.name)) continue;
          const path = join(sessionDir, m.name);
          const info = await stat(path).catch(() => undefined);
          if (info === undefined) continue;
          let size = 0;
          for (const f of await readdir(path).catch(() => [])) {
            size += (await stat(join(path, f)).catch(() => undefined))?.size ?? 0;
          }
          messages.push({ path, mtime: info.mtimeMs, size });
        }
      }
    }
    const now = this.now();
    messages.sort((a, b) => a.mtime - b.mtime);
    let total = messages.reduce((n, m) => n + m.size, 0);
    for (const m of messages) {
      if (now - m.mtime <= KEEP_MS && total <= FOLDER_MAX_BYTES) continue;
      await rm(m.path, { recursive: true, force: true }).catch(() => undefined);
      total -= m.size;
      removed++;
    }
    if (removed > 0) this.options.logger.info('attachments cleaned up', { removed });
    return { removed };
  }

  /** Cleans up now and every hour, until stop(). */
  startCleanup(): void {
    void this.cleanup();
    this.timer = setInterval(() => void this.cleanup(), CLEANUP_EVERY_MS);
    this.timer.unref();
  }

  stopCleanup(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Removes this session's folder, in the project and the fallback (the session ended). */
  async removeSession(): Promise<void> {
    this.stopCleanup();
    for (const base of [this.base, this.tmpBase]) {
      await rm(join(base, this.options.sessionId), { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }
}

/**
 * Removes every session's attachments of a project folder (disconnect):
 * its `.claude/buildit-attachments` folder. The fallback folders in the
 * temp folder are removed when their own session ends, or after 7 days.
 */
export async function removeFolderAttachments(folder: string): Promise<void> {
  await rm(join(folder, ATTACHMENTS_DIR), { recursive: true, force: true }).catch(() => undefined);
}

/** Why a file wasn't downloaded, in plain words for Claude. */
export function notFetchedWords(reason: NotFetched, owner: string): string {
  switch (reason) {
    case 'over_file_cap':
      return 'not downloaded by itself: over 100 MiB';
    case 'over_message_cap':
      return "not downloaded by itself: the message's files are over 250 MiB together";
    case 'budget':
      return "not downloaded: this session's download budget for today is used up";
    case 'timeout':
      return 'still downloading after 60 seconds, so not saved';
    case 'no_scope':
      return `not downloaded: this session can't read files. Ask ${owner} to add Files permissions in Settings → Agents`;
    case 'files_off':
      return 'not downloaded: files are turned off on this buildIt.Social server';
    case 'not_served':
      return 'not downloaded: this buildIt.Social server is too old to send files';
    case 'not_found':
      return 'not downloaded: the file is gone (deleted, or no longer in reach)';
    case 'failed':
      return 'not downloaded: the download failed';
  }
}
