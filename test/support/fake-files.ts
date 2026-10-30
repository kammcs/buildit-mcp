/**
 * The fake API's files for sessions: the files on messages (with their
 * bytes), download links, uploads, and a fake storage served by the same
 * HTTP server under /_storage/ (presigned-style URLs that take no token).
 * Everything is made up; tests script refusals through the public fields.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import type { ErrorCode } from '../../src/api/generated/operations.js';
import type { SessionFile } from '../../src/api/generated/schemas.js';

/** A refusal in the contract's terms (the fake API turns it into the error envelope). */
export class FilesRefusal extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

/** A file to put on a fake message. */
export interface FakeFileInput {
  name: string;
  type?: string;
  bytes?: Buffer;
  /** The size the event announces (default: the bytes' length); a big file without bytes. */
  size?: number;
  kind?: 'image' | 'video' | 'text' | 'other';
  duration_ms?: number;
  /** Not ready yet (still uploading). */
  pending?: boolean;
}

interface StoredFile {
  file: SessionFile;
  bytes: Buffer | undefined;
  pending: boolean;
}

interface MessageFiles {
  threadId: string | null;
  sessionToken: string;
  files: StoredFile[];
  author: { kind: 'user' | 'app'; id: string | null; name: string } | null;
  fromOwner: boolean;
  forwardedFrom: { user: { id: string; name: string } | null; app: null } | null;
}

export interface FakeUpload {
  id: string;
  token: string;
  threadId: string | null;
  fileName: string;
  contentType: string;
  size: number;
  status: 'uploading' | 'ready' | 'posted';
  bytes: Buffer | undefined;
  kind: 'image' | 'video' | 'text' | 'other';
}

/** One request to the fake storage: never a token, the tests check. */
export interface StorageRequest {
  method: string;
  kind: 'get' | 'put';
  headers: Record<string, string | string[] | undefined>;
  bytes: number;
}

const SECRET = [
  /^\.env.*$/s,
  /^.*\.pem$/s,
  /^.*\.key$/s,
  /^.*\.p12$/s,
  /^.*\.pfx$/s,
  /^.*\.kdbx$/s,
  /^id_rsa.*$/s,
  /^id_ed25519.*$/s,
  /^id_ecdsa.*$/s,
  /^\.npmrc$/s,
  /^\.netrc$/s,
  /^\.pgpass$/s,
];

function kindOf(type: string): FakeUpload['kind'] {
  if (type.startsWith('image/') && !type.endsWith('+xml')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('text/') || type === 'application/json') return 'text';
  return 'other';
}

export class FakeFiles {
  readonly messages = new Map<string, MessageFiles>();
  readonly uploads = new Map<string, FakeUpload>();
  /** Every link request, in order: its body. */
  readonly links: Record<string, unknown>[] = [];
  /** Every storage request, in order. */
  readonly storage: StorageRequest[] = [];
  /** Bytes each session token may still download today. */
  readonly downBudget = new Map<string, number>();
  /** The next completes' refusals, in order (tests). */
  readonly completeRefusals: { code: ErrorCode; details?: Record<string, unknown> }[] = [];
  /** Accept this many PUTs without storing them (the next complete is upload_missing). */
  dropPuts = 0;
  /** Delay each download's body by this long (tests of the timeout). */
  getDelayMs = 0;
  /** Every complete's upload id, in order. */
  readonly completes: string[] = [];
  private readonly tickets = new Map<
    string,
    { kind: 'get'; fileId: string; messageId: string } | { kind: 'put'; uploadId: string }
  >();

  constructor(private readonly storageBase: () => string) {}

  reset(): void {
    this.messages.clear();
    this.uploads.clear();
    this.links.length = 0;
    this.storage.length = 0;
    this.downBudget.clear();
    this.completeRefusals.length = 0;
    this.completes.length = 0;
    this.dropPuts = 0;
    this.getDelayMs = 0;
    this.tickets.clear();
  }

  /** Puts files on a message; returns them as events carry them. */
  add(
    messageId: string,
    inputs: readonly FakeFileInput[],
    meta: Omit<MessageFiles, 'files'>,
  ): SessionFile[] {
    const files = inputs.map((input, position): StoredFile => {
      const type = input.type ?? 'application/octet-stream';
      const bytes = input.bytes ?? (input.size === undefined ? Buffer.from(input.name) : undefined);
      return {
        file: {
          id: randomUUID(),
          name: input.name,
          type,
          size_bytes: input.size ?? bytes?.length ?? 0,
          kind: input.kind ?? kindOf(type),
          ...(input.duration_ms === undefined ? {} : { duration_ms: input.duration_ms }),
          position,
        },
        bytes,
        pending: input.pending === true,
      };
    });
    this.messages.set(messageId, { ...meta, files });
    return files.map((f) => f.file);
  }

  /** POST /v1/session/attachments/link */
  link(token: string, body: Record<string, unknown>, nowMs: number): unknown {
    this.links.push(body);
    const messageId = String(body.message_id);
    const m = this.messages.get(messageId);
    const notFound = (): FilesRefusal =>
      new FilesRefusal('attachment_not_found', {
        message_id: messageId,
        file_id: typeof body.file_id === 'string' ? body.file_id : null,
      });
    if (m === undefined || m.sessionToken !== token) throw notFound();
    let stored: StoredFile | undefined;
    if (typeof body.file_id === 'string') {
      stored = m.files.find((f) => f.file.id === body.file_id);
      if (stored === undefined) throw notFound();
    } else if (m.files.length === 1) {
      stored = m.files[0];
    } else {
      throw new FilesRefusal('file_required', { message_id: messageId, files: m.files.length });
    }
    if (stored === undefined) throw notFound();
    if (stored.pending) throw new FilesRefusal('not_ready', { file_id: stored.file.id });
    const left = this.downBudget.get(token) ?? 2 * 1024 ** 3;
    const resetsAt = new Date(Math.ceil(nowMs / 86_400_000) * 86_400_000).toISOString();
    if (stored.file.size_bytes > left) {
      throw new FilesRefusal('budget_exceeded', {
        kind: 'download',
        limit_bytes: 2 * 1024 ** 3,
        used_bytes: 2 * 1024 ** 3 - left,
        limit_files: 500,
        used_files: 0,
        resets_at: resetsAt,
      });
    }
    this.downBudget.set(token, left - stored.file.size_bytes);
    const ticket = randomBytes(12).toString('hex');
    this.tickets.set(ticket, { kind: 'get', fileId: stored.file.id, messageId });
    const variant = body.variant === 'thumbnail' ? 'thumbnail' : 'original';
    const file: Record<string, unknown> = { ...stored.file };
    delete file.position;
    delete file.alt;
    return {
      url: `${this.storageBase()}/_storage/${ticket}?X-Amz-Credential=FAKECRED&X-Amz-Signature=fakesignature${ticket}`,
      method: 'GET',
      expires_at: new Date(nowMs + 120_000).toISOString(),
      variant,
      file,
      message: {
        id: messageId,
        thread_id: m.threadId,
        author: m.author,
        from_owner: m.fromOwner,
        via_agent: null,
        forwarded: m.forwardedFrom !== null,
        forwarded_from:
          m.forwardedFrom === null ? null : { message_id: randomUUID(), ...m.forwardedFrom },
      },
      budget: { down_bytes_left: left - stored.file.size_bytes, resets_at: resetsAt },
    };
  }

  private putFor(upload: FakeUpload, nowMs: number) {
    const ticket = randomBytes(12).toString('hex');
    this.tickets.set(ticket, { kind: 'put', uploadId: upload.id });
    return {
      url: `${this.storageBase()}/_storage/${ticket}?X-Amz-Signature=fakeputsignature${ticket}`,
      method: 'PUT' as const,
      headers: { 'Content-Type': upload.contentType, 'Content-Length': String(upload.size) },
      expires_at: new Date(nowMs + 600_000).toISOString(),
    };
  }

  private uploadOut(u: FakeUpload, nowMs: number) {
    return {
      id: u.id,
      file_name: u.fileName,
      content_type: u.contentType,
      size_bytes: u.size,
      kind: u.kind,
      status: u.status,
      thread_id: u.threadId,
      ...(u.status === 'uploading' ? { put: this.putFor(u, nowMs) } : {}),
    };
  }

  /** POST /v1/session/uploads */
  createUpload(
    token: string,
    body: Record<string, unknown>,
    nowMs: number,
  ): { status: number; body: unknown } {
    const id = String(body.id);
    const name = String(body.file_name);
    const type = String(body.content_type).split(';')[0]?.trim().toLowerCase() ?? '';
    const size = Number(body.size_bytes);
    const threadId = typeof body.thread_id === 'string' ? body.thread_id : null;
    const existing = this.uploads.get(id);
    if (existing !== undefined) {
      if (existing.token !== token || existing.fileName !== name || existing.size !== size) {
        throw new FilesRefusal('idempotency_conflict', { idempotency_key: id });
      }
      return { status: 200, body: { created: false, upload: this.uploadOut(existing, nowMs) } };
    }
    const bare = name.replace(/[. ]+$/, '').toLowerCase();
    if (/\.(exe|msi|dmg|apk|app|pkg)$/.test(bare) || type === 'application/x-msdownload') {
      throw new FilesRefusal('blocked_type');
    }
    if (SECRET.some((re) => re.test(bare))) throw new FilesRefusal('name_not_allowed');
    const max = type.startsWith('video/') ? 250 * 1024 * 1024 : 100 * 1024 * 1024;
    if (size > max) throw new FilesRefusal('too_large', { max_bytes: max });
    const upload: FakeUpload = {
      id,
      token,
      threadId,
      fileName: name,
      contentType: type,
      size,
      status: 'uploading',
      bytes: undefined,
      kind: kindOf(type),
    };
    this.uploads.set(id, upload);
    return { status: 201, body: { created: true, upload: this.uploadOut(upload, nowMs) } };
  }

  /** POST /v1/session/uploads/{id}/complete */
  complete(token: string, id: string): unknown {
    this.completes.push(id);
    const u = this.uploads.get(id);
    if (u === undefined || u.token !== token) {
      throw new FilesRefusal('not_found', { kind: 'upload', ref: id });
    }
    if (u.status === 'uploading') {
      if (u.bytes === undefined) throw new FilesRefusal('upload_missing');
      const refusal = this.completeRefusals.shift();
      if (refusal !== undefined) {
        this.uploads.delete(id);
        throw new FilesRefusal(refusal.code, refusal.details ?? {});
      }
      if (u.bytes.length !== u.size) {
        this.uploads.delete(id);
        throw new FilesRefusal('upload_mismatch', { mismatch: 'size' });
      }
      u.status = 'ready';
    }
    return {
      upload: {
        id: u.id,
        status: u.status === 'posted' ? 'posted' : 'ready',
        content_type: u.contentType,
        kind: u.kind,
        size_bytes: u.size,
        thumbnail: u.kind === 'image',
      },
    };
  }

  /** post_session_message's files: checked and marked posted; the groups to post, in order. */
  postFiles(token: string, threadId: string | null, ids: readonly string[]): FakeUpload[][] {
    const uploads = ids.map((id) => {
      const u = this.uploads.get(id);
      if (u === undefined || u.token !== token) {
        throw new FilesRefusal('not_found', { kind: 'upload', ref: id });
      }
      if (u.status === 'uploading') throw new FilesRefusal('not_ready', { file_id: id });
      if (u.status === 'posted') throw new FilesRefusal('upload_used', { upload_id: id });
      if (u.threadId !== threadId)
        throw new FilesRefusal('upload_thread_mismatch', { upload_id: id });
      return u;
    });
    for (const u of uploads) u.status = 'posted';
    const media = uploads.filter((u) => u.kind === 'image' || u.kind === 'video');
    const others = uploads.filter((u) => u.kind !== 'image' && u.kind !== 'video');
    return media.length > 0 ? [media, ...others.map((u) => [u])] : others.map((u) => [u]);
  }

  /** The fake storage: a GET of a file, or a PUT of an upload's bytes. */
  async serve(
    method: string,
    ticket: string,
    headers: Record<string, string | string[] | undefined>,
    body: Buffer,
  ): Promise<{ status: number; body: Buffer }> {
    const t = this.tickets.get(ticket);
    this.storage.push({
      method,
      kind: t?.kind ?? 'get',
      headers: { ...headers },
      bytes: body.length,
    });
    if (t === undefined) return { status: 403, body: Buffer.from('<Error>AccessDenied</Error>') };
    if (t.kind === 'get' && method === 'GET') {
      this.tickets.delete(ticket);
      const stored = this.messages.get(t.messageId)?.files.find((f) => f.file.id === t.fileId);
      if (this.getDelayMs > 0) await new Promise((r) => setTimeout(r, this.getDelayMs));
      return { status: 200, body: stored?.bytes ?? Buffer.alloc(stored?.file.size_bytes ?? 0) };
    }
    if (t.kind === 'put' && method === 'PUT') {
      const u = this.uploads.get(t.uploadId);
      if (u === undefined) return { status: 403, body: Buffer.alloc(0) };
      // A presigned PUT is signed with its type and length: anything else is refused.
      if (
        headers['content-type'] !== u.contentType ||
        headers['content-length'] !== String(u.size)
      ) {
        return { status: 403, body: Buffer.from('<Error>SignatureDoesNotMatch</Error>') };
      }
      if (this.dropPuts > 0) {
        this.dropPuts--;
        return { status: 200, body: Buffer.alloc(0) };
      }
      u.bytes = body;
      return { status: 200, body: Buffer.alloc(0) };
    }
    return { status: 405, body: Buffer.alloc(0) };
  }
}
