/**
 * The two requests that don't go to the agent API: the GET of a presigned
 * download URL and the PUT of a presigned upload URL. They go straight to
 * storage, so they never carry the token (no Authorization header), and
 * the PUT sends exactly the signed headers with the file streamed from disk.
 *
 * A presigned URL is a bearer URL for its few minutes: it is never logged,
 * written to disk or shown to Claude, and an error never repeats it.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** A failed transfer: an HTTP status from storage, or a local reason. Never the URL. */
export class TransferError extends Error {
  constructor(
    readonly reason: 'status' | 'too_large' | 'short' | 'network' | 'timeout' | 'url',
    readonly status?: number,
  ) {
    super(
      reason === 'status'
        ? `storage answered HTTP ${status ?? 0}`
        : reason === 'too_large'
          ? 'the download is larger than the file'
          : reason === 'short'
            ? 'the download ended early'
            : reason === 'timeout'
              ? 'the transfer timed out'
              : reason === 'url'
                ? 'the storage URL is not one this server uses'
                : 'the network failed',
    );
    this.name = 'TransferError';
  }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** The URL, if storage may be reached there: https, or http on this computer (a local stack). */
function storageUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TransferError('url');
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return url;
  throw new TransferError('url');
}

function send(
  url: URL,
  method: 'GET' | 'PUT',
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
): { req: ReturnType<typeof httpRequest>; response: Promise<IncomingMessage> } {
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const req = request(url, { method, headers, ...(signal ? { signal } : {}) });
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    req.on('response', resolve);
    req.on('error', (err: Error) => {
      reject(
        signal?.aborted === true || err.name === 'AbortError'
          ? new TransferError('timeout')
          : new TransferError('network'),
      );
    });
  });
  return { req, response };
}

/** Reads and drops a response's body (at most 64 KiB kept, as text). */
async function readSmall(res: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res) {
    const b = chunk as Buffer;
    if (size < 65_536) chunks.push(b);
    size += b.length;
  }
  return Buffer.concat(chunks).toString('utf8').slice(0, 65_536);
}

/**
 * GETs `url` into a new file at `dest` (created 0600, never over an
 * existing file), stopping when more than `maxBytes` arrive. Returns the
 * bytes written. With `exactBytes`, a shorter or longer body fails. The
 * partial file is removed on any failure.
 */
export async function downloadToFile(
  rawUrl: string,
  dest: string,
  options: { maxBytes: number; exactBytes?: number; signal?: AbortSignal },
): Promise<number> {
  const url = storageUrl(rawUrl);
  const { req, response } = send(url, 'GET', { Accept: '*/*' }, options.signal);
  req.end();
  let written = 0;
  try {
    const res = await response;
    if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
      await readSmall(res).catch(() => '');
      throw new TransferError('status', res.statusCode);
    }
    const counter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        written += chunk.length;
        if (written > options.maxBytes) done(new TransferError('too_large'));
        else done(null, chunk);
      },
    });
    await pipeline(res, counter, createWriteStream(dest, { flags: 'wx', mode: 0o600 }), {
      ...(options.signal ? { signal: options.signal } : {}),
    }).catch((err: unknown) => {
      if (err instanceof TransferError) throw err;
      throw new TransferError(options.signal?.aborted === true ? 'timeout' : 'network');
    });
    if (options.exactBytes !== undefined && written !== options.exactBytes) {
      throw new TransferError(written < options.exactBytes ? 'short' : 'too_large');
    }
    return written;
  } catch (err) {
    req.destroy();
    await rm(dest, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * PUTs the file at `source` (`size` bytes) to `url` with exactly `headers`
 * (the signed Content-Type and Content-Length), streamed, and no
 * Authorization header. `onBytes` hears the bytes sent so far.
 */
export async function uploadFile(
  rawUrl: string,
  headers: Readonly<Record<string, string>>,
  source: string,
  size: number,
  options: { signal?: AbortSignal; onBytes?: (sent: number) => void } = {},
): Promise<void> {
  const url = storageUrl(rawUrl);
  const sent: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    // Never a credential of ours: storage's signature is the only one.
    if (name.toLowerCase() === 'authorization') continue;
    sent[name] = value;
  }
  if (!Object.keys(sent).some((k) => k.toLowerCase() === 'content-length')) {
    sent['Content-Length'] = String(size);
  }
  const { req, response } = send(url, 'PUT', sent, options.signal);
  let count = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      count += chunk.length;
      options.onBytes?.(count);
      done(null, chunk);
    },
  });
  const body = pipeline(createReadStream(source), counter, req).catch(() => {
    // The response (or its error) says what happened.
  });
  try {
    const res = await response;
    await readSmall(res).catch(() => '');
    await body;
    if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
      throw new TransferError('status', res.statusCode);
    }
  } catch (err) {
    req.destroy();
    throw err;
  }
}
