/**
 * The JSON-RPC connection to `codex app-server` over stdio.
 *
 * The app-server speaks JSON-RPC 2.0 without the `"jsonrpc"` field (it
 * accepts and ignores one), one JSON object per line. It sends responses
 * to the client's requests (id + result or error), notifications (method,
 * no id), and its own requests (id + method), which the client answers
 * with a response carrying the same id. Its ids are numbers from 0, so
 * they share no space with ours: a message's kind is told by its fields.
 *
 * Lines that aren't JSON objects are logged (their length, never their
 * content) and skipped. Nothing here logs params or results: they carry
 * what people wrote.
 */
import type { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';

import type { Logger } from '../log.js';
import type { RequestId } from './protocol.js';

export interface RpcNotification {
  method: string;
  params: unknown;
}

export interface RpcServerRequest {
  id: RequestId;
  method: string;
  params: unknown;
}

/** An error answer from the app-server (or one the bridge sends back). */
export class RpcError extends Error {
  override name = 'RpcError';
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(`${method}: ${code} ${message}`);
  }
}

/** The connection closed (the app-server exited, or close()) before an answer came. */
export class RpcClosedError extends Error {
  override name = 'RpcClosedError';
}

/** JSON-RPC's codes. */
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INTERNAL_ERROR = -32603;

/**
 * What a server request handler returns: the result, an error to send
 * back, or `none` when no answer is owed any more (the app-server said the
 * request was resolved otherwise). A handler that throws is answered with
 * an internal error.
 */
export type ServerRequestAnswer =
  { result: unknown } | { error: { code: number; message: string } } | { none: true };

export type ServerRequestHandler = (request: RpcServerRequest) => Promise<ServerRequestAnswer>;

export interface ConnectionOptions {
  logger: Logger;
  /** The longest a request waits for its answer (default 60 s; turns answer at once). */
  timeoutMs?: number;
}

export class AppServerConnection {
  private nextId = 1;
  private readonly pending = new Map<
    RequestId,
    {
      method: string;
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly listeners = new Set<(n: RpcNotification) => void>();
  private handler: ServerRequestHandler = (r) =>
    Promise.resolve({
      error: { code: RPC_METHOD_NOT_FOUND, message: `${r.method} is not supported` },
    });
  private isClosed = false;
  private readonly closedListeners = new Set<() => void>();
  private readonly timeoutMs: number;

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly options: ConnectionOptions,
  ) {
    this.timeoutMs = options.timeoutMs ?? 60_000;
    const lines = createInterface({ input, crlfDelay: Infinity });
    lines.on('line', (line) => {
      this.onLine(line);
    });
    lines.on('close', () => {
      this.markClosed('the app-server closed its output');
    });
    output.on('error', (err) => {
      this.options.logger.warn('codex app-server input failed', { error: err });
      this.markClosed('the app-server input failed');
    });
  }

  /** Whether the connection has closed. */
  get closed(): boolean {
    return this.isClosed;
  }

  /** Told once when the connection closes. */
  onClose(listener: () => void): void {
    if (this.isClosed) {
      listener();
      return;
    }
    this.closedListeners.add(listener);
  }

  /** Sends a request and waits for its answer: an RpcError for an error answer. */
  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.isClosed)
      return Promise.reject(new RpcClosedError(`${method}: the connection is closed`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(method, RPC_INTERNAL_ERROR, 'no answer in time'));
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      this.write({ id, method, params });
    });
  }

  /** Sends a notification. */
  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  /** Listens to the app-server's notifications; returns the unsubscriber. */
  onNotification(listener: (n: RpcNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Who answers the app-server's own requests (default: method not found). */
  onServerRequest(handler: ServerRequestHandler): void {
    this.handler = handler;
  }

  /** Ends the app-server's input (it exits when stdin closes). */
  close(): void {
    if (!this.output.writableEnded) this.output.end();
    this.markClosed('closed');
  }

  private markClosed(reason: string): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new RpcClosedError(`${p.method}: ${reason}`));
    }
    this.pending.clear();
    for (const listener of this.closedListeners) listener();
    this.closedListeners.clear();
  }

  private write(message: object): void {
    if (this.isClosed || this.output.writableEnded) return;
    this.output.write(JSON.stringify(message) + '\n');
  }

  private onLine(line: string): void {
    if (line.trim() === '') return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.options.logger.warn('codex app-server sent a line that is not JSON', {
        length: line.length,
      });
      return;
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      this.options.logger.warn('codex app-server sent a message that is not an object');
      return;
    }
    const m = message as Record<string, unknown>;
    const id = m.id;
    const hasId = typeof id === 'string' || typeof id === 'number';
    const method = typeof m.method === 'string' ? m.method : undefined;
    if (hasId && method === undefined) {
      this.onResponse(id, m);
      return;
    }
    if (hasId && method !== undefined) {
      this.onServerRequestMessage({ id, method, params: m.params });
      return;
    }
    if (method !== undefined) {
      const n: RpcNotification = { method, params: m.params };
      for (const listener of [...this.listeners]) {
        try {
          listener(n);
        } catch (err) {
          this.options.logger.error('codex notification handler failed', { method, error: err });
        }
      }
      return;
    }
    this.options.logger.warn('codex app-server sent a message of no known kind');
  }

  private onResponse(id: RequestId, m: Record<string, unknown>): void {
    const pending = this.pending.get(id);
    if (pending === undefined) {
      this.options.logger.debug('codex answer for no pending request', { id });
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    const error = m.error;
    if (error !== undefined && error !== null) {
      const e = (typeof error === 'object' ? error : {}) as Record<string, unknown>;
      pending.reject(
        new RpcError(
          pending.method,
          typeof e.code === 'number' ? e.code : RPC_INTERNAL_ERROR,
          typeof e.message === 'string' ? e.message : 'error',
          e.data,
        ),
      );
      return;
    }
    pending.resolve(m.result);
  }

  private onServerRequestMessage(request: RpcServerRequest): void {
    let answer: Promise<ServerRequestAnswer>;
    try {
      answer = this.handler(request);
    } catch (err) {
      answer = Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    answer.then(
      (a) => {
        if ('none' in a) return;
        this.write(
          'result' in a ? { id: request.id, result: a.result } : { id: request.id, error: a.error },
        );
      },
      (err: unknown) => {
        this.options.logger.error('codex server request handler failed', {
          method: request.method,
          error: err,
        });
        this.write({
          id: request.id,
          error: { code: RPC_INTERNAL_ERROR, message: 'the client could not answer' },
        });
      },
    );
  }
}
