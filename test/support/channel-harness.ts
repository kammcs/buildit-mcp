/**
 * A channel-mode server in process for tests: startStdio with --channel on
 * a pair of streams, an MCP client on the other end, and the notifications
 * it receives. The fake API's sessions play the person.
 */
import { PassThrough } from 'node:stream';

import {
  Client,
  ReadBuffer,
  serializeMessage,
  type JSONRPCMessage,
  type Transport,
} from '@modelcontextprotocol/client';

import { parseCli, type Config } from '../../src/config.js';
import { createLogger } from '../../src/log.js';
import { startStdio, type StdioOptions } from '../../src/transports/stdio.js';
import type { FakeApi } from './fake-api.js';
import { SESSION_TOKENS } from './fake-sessions.js';

/** A client transport over a pair of streams (the server's stdin and stdout). */
class StreamTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private readonly buffer = new ReadBuffer();

  constructor(
    private readonly fromServer: PassThrough,
    private readonly toServer: PassThrough,
  ) {}

  start(): Promise<void> {
    this.fromServer.on('data', (chunk: Buffer) => {
      this.buffer.append(chunk);
      for (let m = this.buffer.readMessage(); m !== null; m = this.buffer.readMessage()) {
        this.onmessage?.(m);
      }
    });
    return Promise.resolve();
  }

  send(message: JSONRPCMessage): Promise<void> {
    this.toServer.write(serializeMessage(message));
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.toServer.end();
    this.onclose?.();
    return Promise.resolve();
  }
}

export interface Notification {
  method: string;
  params?: { content?: string; meta?: Record<string, string> };
}

export async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

export function channelConfig(api: FakeApi, env: Record<string, string> = {}): Config {
  const action = parseCli(['--channel'], {
    BUILDIT_TOKEN: SESSION_TOKENS.first,
    BUILDIT_API_URL: api.url,
    ...env,
  });
  if (action.kind !== 'run') throw new Error('expected a run action');
  return action.config;
}

export interface ChannelClient {
  client: Client;
  notes: Notification[];
  logs: string[];
  close: () => Promise<void>;
}

export const channelNotes = (notes: Notification[]): Notification[] =>
  notes.filter((n) => n.method === 'notifications/claude/channel');

/** Starts a channel server against the fake; `stops` collects the closers for afterEach. */
export async function startChannel(
  api: FakeApi,
  stops: (() => Promise<void>)[],
  options: { config?: Config; stdio?: Partial<StdioOptions> } = {},
): Promise<ChannelClient> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const logs: string[] = [];
  const handle = startStdio(
    options.config ?? channelConfig(api),
    createLogger({ level: 'debug', sink: (l) => logs.push(l) }),
    {
      stdin,
      stdout,
      channelLoop: { intervalMs: 20 },
      ...options.stdio,
    },
  );
  const client = new Client({ name: 'claude-code', version: '2.1.312' });
  const notes: Notification[] = [];
  client.fallbackNotificationHandler = (n) => {
    notes.push(n as Notification);
    return Promise.resolve();
  };
  await client.connect(new StreamTransport(stdout, stdin));
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await handle.close();
    await client.close().catch(() => undefined);
  };
  stops.push(close);
  return { client, notes, logs, close };
}
