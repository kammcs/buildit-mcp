/**
 * Sharing local files in a reply: the checks, then the upload, then one post.
 *
 * 1. **Checks, before any network call**, for every file: it resolves (its
 *    real path, symlinks followed) to a regular file inside the session's
 *    folder or the OS temp folder, and not in a secret folder; its name is
 *    not a secret store's; it is not a program (by its extension, its type
 *    or its first bytes); it is within the size cap for its type; and a
 *    text file passes the whole-file credential scan. One refusal refuses
 *    the reply: nothing is uploaded or posted, and the error says why.
 * 2. **Location** is removed from photos and videos into a temporary copy
 *    (the original is never touched), as the app does for a person's.
 * 3. **Each file** is uploaded: create_session_upload, a streamed PUT with
 *    exactly the signed headers (no Authorization), complete_session_upload
 *    (nothing uploaded yet, upload_missing: the PUT once more, then complete
 *    again). A refusal there stops the reply too, so nothing is posted.
 * 4. **One post**, post_session_message with the text and the uploads.
 *
 * Upload ids are UUIDv5s of the session, the reply's idempotency key, the
 * file's place and its real path, so a retry of the same reply neither
 * uploads nor posts twice.
 */
import { lstat, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { ApiError, type ApiClient, type ApiRequestOptions } from '../api/client.js';
import type { PostSessionMessageResponse } from '../api/generated/schemas.js';
import type { OperationIO } from '../api/generated/strict.js';
import { callOperation } from '../api/operations.js';
import { ToolInputError } from '../errors.js';
import {
  copyWithPatches,
  isHeifContainer,
  isMovie,
  LocationUnreadableError,
  stripLocation,
  videoLocationPatches,
} from '../files/location.js';
import { locationProblem } from '../files/paths.js';
import { describeFinding, scanFileForCredentials } from '../files/scan.js';
import { TransferError, uploadFile } from '../files/transfer.js';
import {
  cleanFileName,
  contentTypeFor,
  formatMiB,
  isBlockedFile,
  isProgramHeader,
  isSecretName,
  maxBytesFor,
  readsAsText,
  sniffImage,
} from '../files/types.js';
import { uuidV5 } from '../tools/ask.js';

/** The most files a reply takes (a message's set). */
export const REPLY_MAX_FILES = 10;

/** The UUIDv5 namespace of a session's upload ids. */
const UPLOAD_NAMESPACE = '6f1c2b8e-3d4a-5e9f-8b7c-1a2d3e4f5a6b';

/** How many first bytes the checks read. */
const HEAD_BYTES = 8 * 1024;

/** A local file that passed the checks. */
export interface CheckedFile {
  /** As Claude gave it. */
  given: string;
  /** Its real path. */
  path: string;
  /** The name readers see. */
  name: string;
  size: number;
  contentType: string;
  /** Whether its location is looked for: a photo or a video. */
  media: 'photo' | 'video' | undefined;
}

/** Reads a file's first bytes. */
async function head(path: string, n = HEAD_BYTES): Promise<Uint8Array> {
  const handle = await open(path, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await handle.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** The refusal of a whole reply: every file's problem, and that nothing was sent. */
function refused(problems: string[]): ToolInputError {
  return new ToolInputError(
    `Not shared: ${problems.join(' ')} Nothing was uploaded or posted; fix that and send the reply again (or leave that file out).`,
  );
}

/** Whether a file is a photo or a video whose location is looked for. */
function mediaOf(contentType: string, first: Uint8Array): CheckedFile['media'] {
  if (sniffImage(first) !== undefined || isHeifContainer(first)) return 'photo';
  if (
    contentType.startsWith('image/') &&
    (contentType === 'image/tiff' ||
      contentType.endsWith('heic') ||
      contentType.endsWith('heif') ||
      contentType === 'image/avif')
  ) {
    return 'photo';
  }
  if (isMovie(first)) return 'video';
  return undefined;
}

/**
 * Step 1: the checks of every file, before any network call. Throws one
 * ToolInputError that names each refused file and why.
 */
export async function checkFiles(
  given: readonly string[],
  folder: string,
  signal?: AbortSignal,
): Promise<CheckedFile[]> {
  const problems: string[] = [];
  const checked: CheckedFile[] = [];
  const seen = new Set<string>();
  for (const raw of given) {
    const shown = JSON.stringify(raw.length > 200 ? `${raw.slice(0, 200)}…` : raw);
    const fail = (why: string): void => {
      problems.push(`${shown}: ${why}.`);
    };
    let path: string;
    try {
      path = await realpath(resolve(folder, raw));
    } catch {
      fail('no such file');
      continue;
    }
    const info = await lstat(path).catch(() => undefined);
    if (info === undefined || !info.isFile()) {
      fail('not a regular file');
      continue;
    }
    if (seen.has(path)) {
      fail('the same file is given twice');
      continue;
    }
    seen.add(path);
    const where = await locationProblem(path, { folder });
    if (where === 'secret_folder') {
      fail(
        "it's in a folder that holds credentials (such as .ssh or .aws), which are never shared",
      );
      continue;
    }
    if (where === 'outside_roots') {
      fail(
        "it is outside this session's folder and the temp folder; copy it into the project (or the temp folder) first if it should be shared",
      );
      continue;
    }
    const name = cleanFileName(basename(path));
    if (isSecretName(basename(path)) || isSecretName(basename(raw))) {
      fail(
        "its name is a secret store's (.env files, keys, certificates, password databases), which are never shared",
      );
      continue;
    }
    const contentType = contentTypeFor(name);
    if (isBlockedFile(name, contentType)) {
      fail(
        'programs and installers are never shared; share the source or a document about it instead',
      );
      continue;
    }
    const first = await head(path);
    if (isProgramHeader(first)) {
      fail('it is a program (its first bytes say so), and programs are never shared');
      continue;
    }
    const max = maxBytesFor(contentType);
    if (info.size > max) {
      fail(
        `it is ${formatMiB(info.size)}, over the ${formatMiB(max)} limit for this type; compress or split it`,
      );
      continue;
    }
    if (readsAsText(contentType, first)) {
      const finding = await scanFileForCredentials(path, signal);
      if (finding !== undefined) {
        fail(`${describeFinding(finding)}. Remove it and try again`);
        continue;
      }
    }
    checked.push({
      given: raw,
      path,
      name,
      size: info.size,
      contentType,
      media: mediaOf(contentType, first),
    });
  }
  if (problems.length > 0) throw refused(problems);
  return checked;
}

/** A file to upload: the original, or a copy without its location. */
export interface PreparedFile extends CheckedFile {
  source: string;
  sourceSize: number;
  stripped: boolean;
}

/**
 * Step 2: location removed from photos and videos into copies in a new
 * temporary folder (returned, to be removed after). A photo or video whose
 * metadata can't be read is refused, never sent with its location.
 */
export async function prepareFiles(
  files: readonly CheckedFile[],
): Promise<{ files: PreparedFile[]; temp: string | undefined }> {
  let temp: string | undefined;
  const tempDir = async (): Promise<string> => {
    temp ??= await mkdtemp(join(tmpdir(), 'buildit-mcp-share-'));
    return temp;
  };
  const out: PreparedFile[] = [];
  const problems: string[] = [];
  try {
    for (const [i, f] of files.entries()) {
      try {
        if (f.media === 'photo') {
          const bytes = new Uint8Array(await readFile(f.path));
          const clean = stripLocation(bytes);
          if (clean !== bytes) {
            const copy = join(await tempDir(), `${i}-${f.name}`);
            await writeFile(copy, clean, { flag: 'wx', mode: 0o600 });
            out.push({ ...f, source: copy, sourceSize: clean.length, stripped: true });
            continue;
          }
        } else if (f.media === 'video') {
          const patches = await videoLocationPatches(f.path);
          if (patches.length > 0) {
            const copy = join(await tempDir(), `${i}-${f.name}`);
            await copyWithPatches(f.path, copy, patches);
            out.push({ ...f, source: copy, sourceSize: f.size, stripped: true });
            continue;
          }
        }
        out.push({ ...f, source: f.path, sourceSize: f.size, stripped: false });
      } catch (err) {
        if (err instanceof LocationUnreadableError) {
          problems.push(
            `${JSON.stringify(f.given)}: its metadata can't be read, so its location can't be removed; export it again (or as another format) and share that.`,
          );
        } else {
          throw err;
        }
      }
    }
  } catch (err) {
    if (temp !== undefined) await rm(temp, { recursive: true, force: true });
    throw err;
  }
  if (problems.length > 0) {
    if (temp !== undefined) await rm(temp, { recursive: true, force: true });
    throw refused(problems);
  }
  return { files: out, temp };
}

/** What a refusal at upload means, for the file it names. */
function uploadRefusal(err: ApiError, f: PreparedFile, owner: string): ToolInputError | undefined {
  const d = (err.details ?? {}) as Record<string, unknown>;
  const name = JSON.stringify(f.given);
  switch (err.code) {
    case 'scope_missing':
      return new ToolInputError(
        `Not shared: this session can't share files. Ask ${owner} to add Files permissions in Settings → Agents, then send the reply again. Nothing was posted.`,
      );
    case 'session_token_required':
      return new ToolInputError(
        'Not shared: files can be shared only from a connected session (buildit-mcp connect), not with a personal access token. Nothing was posted.',
      );
    case 'files_off':
      return new ToolInputError(
        'Not shared: files are turned off on this buildIt.Social server. Describe the file in text instead. Nothing was posted.',
      );
    case 'credential_found': {
      const lines = Array.isArray(d.lines) ? (d.lines as number[]) : [];
      const kinds = Array.isArray(d.kinds) ? (d.kinds as string[]) : [];
      return refused([
        `${name}: buildIt.Social found that ${describeFinding({ lines, kinds })}. Remove it and try again.`,
      ]);
    }
    case 'location_found':
      return refused([`${name}: buildIt.Social found location metadata left in the photo.`]);
    case 'name_not_allowed':
      return refused([`${name}: its name is a secret store's, which is never shared.`]);
    case 'blocked_type':
      return refused([`${name}: programs and installers are never shared.`]);
    case 'too_large':
      return refused([`${name}: it is over the size limit for its type.`]);
    case 'upload_mismatch':
      return refused([`${name}: the file changed while it was uploading; send the reply again.`]);
    case 'budget_exceeded':
      return new ToolInputError(
        `Not shared: this session's upload budget for today is used up${typeof d.resets_at === 'string' ? ` (it resets at ${d.resets_at})` : ''}. Nothing was posted.`,
      );
    case 'too_many_pending':
      return new ToolInputError(
        'Not shared: this session has too many uploads waiting to be posted; they expire within the hour. Try again later. Nothing was posted.',
      );
    default:
      return undefined;
  }
}

export interface ShareOptions {
  api: ApiClient;
  apiOptions: ApiRequestOptions;
  sessionId: string;
  owner: string;
  /** The reply's idempotency key (the post's id). */
  key: string;
  threadId: string | undefined;
  signal?: AbortSignal | undefined;
  progress?: ((message: string) => Promise<void>) | undefined;
}

/** The upload id of a reply's nth file. */
export function uploadId(sessionId: string, key: string, index: number, path: string): string {
  return uuidV5(`${sessionId}\n${key}\n${index}\n${path}`, UPLOAD_NAMESPACE);
}

/** How long a PUT may take (its URL works 10 minutes). */
const PUT_TIMEOUT_MS = 10 * 60 * 1000;

/** Step 3: one file's upload, to ready. Returns its id. */
async function uploadOne(
  f: PreparedFile,
  index: number,
  total: number,
  o: ShareOptions,
): Promise<string> {
  const id = uploadId(o.sessionId, o.key, index, f.path);
  const body: OperationIO['create_session_upload']['body'] = {
    id,
    ...(o.threadId === undefined ? {} : { thread_id: o.threadId }),
    file_name: f.name,
    content_type: f.contentType,
    size_bytes: f.sourceSize,
  };
  const init = () => callOperation(o.api, 'create_session_upload', { body }, o.apiOptions);
  const put = async (upload: Awaited<ReturnType<typeof init>>['upload']): Promise<void> => {
    if (upload.put === undefined)
      throw new ToolInputError('The API gave no upload URL; send the reply again.');
    await o.progress?.(`Uploading ${f.name} (${index + 1} of ${total})`);
    let last = Date.now();
    await uploadFile(upload.put.url, upload.put.headers, f.source, f.sourceSize, {
      signal: AbortSignal.any([
        ...(o.signal ? [o.signal] : []),
        AbortSignal.timeout(PUT_TIMEOUT_MS),
      ]),
      onBytes: (sent) => {
        if (Date.now() - last < 10_000) return;
        last = Date.now();
        void o.progress?.(
          `Uploading ${f.name}: ${Math.floor((sent / Math.max(1, f.sourceSize)) * 100)}%`,
        );
      },
    });
  };
  const complete = () =>
    callOperation(o.api, 'complete_session_upload', { path: { id }, body: {} }, o.apiOptions);
  const first = await init();
  if (first.upload.status !== 'uploading') return id;
  await put(first.upload);
  try {
    await complete();
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== 'upload_missing') throw err;
    // The bytes didn't arrive: a fresh URL (the same id), the PUT again, then complete again.
    const again = await init();
    if (again.upload.status === 'uploading') {
      await put(again.upload);
      await complete();
    }
  }
  return id;
}

/**
 * Steps 3 and 4: uploads every prepared file, then posts them with the
 * text in one post_session_message. Any refusal stops before the post.
 */
export async function shareFiles(
  files: readonly PreparedFile[],
  post: Omit<OperationIO['post_session_message']['body'], 'id' | 'files' | 'thread_id'>,
  o: ShareOptions,
): Promise<{ response: PostSessionMessageResponse; ids: string[] }> {
  const ids: string[] = [];
  for (const [i, f] of files.entries()) {
    try {
      ids.push(await uploadOne(f, i, files.length, o));
    } catch (err) {
      if (err instanceof ApiError) {
        const plain = uploadRefusal(err, f, o.owner);
        if (plain !== undefined) throw plain;
      }
      if (err instanceof TransferError) {
        throw new ToolInputError(
          `Not shared: uploading ${JSON.stringify(f.given)} failed (${err.message}). Nothing was posted; send the reply again with the same idempotency_key.`,
        );
      }
      throw err;
    }
  }
  const response = await callOperation(
    o.api,
    'post_session_message',
    {
      body: {
        id: o.key,
        ...post,
        ...(o.threadId === undefined ? {} : { thread_id: o.threadId }),
        files: ids,
      },
    },
    o.apiOptions,
  );
  return { response, ids };
}
