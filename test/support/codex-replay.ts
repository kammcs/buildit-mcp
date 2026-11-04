/**
 * Plays a recorded smoke run back to the bridge (fixtures written by
 * scripts/codex-fixture.ts from a real app-server's transcript).
 *
 * A replay is one app-server process of the recording (from one
 * `initialize` to the next). Each message the bridge sends must be the next
 * one the recording shows the bridge sending: the same method and, for the
 * turn methods, the same thread, turn and input text. Then the app-server's
 * recorded messages up to the bridge's next one are sent back, with the
 * answers' ids changed to the bridge's. So the bridge meets the real
 * server's stream, and any decision it makes differently (a start where
 * the recording steered, another turn, another order) is a violation.
 * The bridge's messages are also checked against the vendored schema, and
 * the server's recorded ones too (`serverViolations`).
 *
 * What the real Codex did outside the stream is played by `onRecord`, a
 * hook awaited before each recorded server message is sent: the parity
 * run's MCP tool calls, for example, which Codex made to the bridge's
 * hosted tools between an mcpToolCall item's start and its end
 * (`mcpCall` makes such a call as Codex would: the thread's URL from the
 * bridge's own thread/start, the secret from the environment it started
 * the app-server with). The bridge's answers to the recorded server
 * requests must match the recording's (accept or decline).
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import type { AppServerProcess, SpawnAppServer } from '../../src/codex/process.js';
import { PROTOCOL, schemaErrors, unknownFields } from './fake-codex.js';

export interface FixtureRecord {
  dir: 'in' | 'out';
  ms: number;
  msg: Record<string, unknown>;
}

/** The fixture's records, split into one list per app-server process. */
export function loadReplay(name: string): FixtureRecord[][] {
  const records = readFileSync(new URL(`../fixtures/codex/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as FixtureRecord);
  const runs: FixtureRecord[][] = [];
  for (const r of records) {
    if (r.dir === 'out' && r.msg.method === 'initialize') runs.push([]);
    runs.at(-1)?.push(r);
  }
  return runs;
}

/** A turn method's text input. */
export function inputText(msg: Record<string, unknown>): string | undefined {
  const params = msg.params as { input?: { text?: unknown }[] } | undefined;
  const text = params?.input?.[0]?.text;
  return typeof text === 'string' ? text : undefined;
}

/**
 * The person's words of a turn's text: its first paragraph (an
 * attachments block after it holds this run's paths and block ids).
 */
export function promptOf(msg: Record<string, unknown>): string | undefined {
  return inputText(msg)?.split('\n\n')[0];
}

/** A turn method's input item types (text, localImage...). */
export function inputTypes(msg: Record<string, unknown>): string {
  const params = msg.params as { input?: { type?: unknown }[] } | undefined;
  return (params?.input ?? []).map((i) => String(i.type)).join(',');
}

/** An answer to a server request that decides something (an approval's). */
function decisionOf(msg: Record<string, unknown>): string | undefined {
  const r = msg.result;
  if (r === null || typeof r !== 'object') return undefined;
  if ('decision' in r) return JSON.stringify(r.decision);
  if ('action' in r) return JSON.stringify(r.action);
  if ('permissions' in r) return JSON.stringify(r.permissions);
  return undefined;
}

const COMPARED = ['threadId', 'expectedTurnId', 'turnId', 'excludeTurns'] as const;

/**
 * Requests the bridge sends that the recording predates, and the answer
 * each gets here (outside the recording: its position doesn't move).
 * Newer free reads only; a turn method is never in this list.
 */
export const NEWER_REQUESTS: Readonly<Record<string, unknown>> = {
  'config/read': { config: { approval_policy: null, approvals_reviewer: null }, origins: {} },
};

export class ReplayAppServer {
  readonly violations: string[] = [];
  readonly serverViolations: string[] = [];
  private position = 0;
  private readonly ids = new Map<unknown, unknown>();
  private readonly toBridge = new PassThrough();
  private readonly fromBridge = new PassThrough();
  private exitedResolve!: (code: number | null) => void;
  private readonly exited = new Promise<number | null>((r) => (this.exitedResolve = r));
  private ended = false;
  /** The environment the bridge started the app-server with (the hosted tools' secret). */
  env: Readonly<Record<string, string>> = {};
  /** The config of the bridge's thread/start (its hosted tools' entry). */
  private threadConfig: Record<string, unknown> | undefined;
  /** Awaited before each recorded server message is sent (what Codex did outside the stream). */
  onRecord: ((msg: Record<string, unknown>) => Promise<void>) | undefined;
  private pumping: Promise<void> = Promise.resolve();
  private readonly clients: Client[] = [];

  constructor(private readonly records: readonly FixtureRecord[]) {
    createInterface({ input: this.fromBridge }).on('line', (line) => {
      this.onBridge(line);
    });
    this.fromBridge.on('end', () => {
      this.ended = true;
      this.toBridge.end();
      this.exitedResolve(0);
    });
  }

  readonly process: AppServerProcess = {
    stdout: this.toBridge,
    stdin: this.fromBridge,
    exited: this.exited,
    stop: async () => {
      this.fromBridge.end();
      return this.exited;
    },
  };

  readonly spawn: SpawnAppServer = (_args, env = {}) => {
    this.env = env;
    return this.process;
  };

  /** Calls a hosted tool as Codex does, on the thread the bridge started. */
  async mcpCall(name: string, args: Record<string, unknown>): Promise<unknown> {
    const entry = this.threadConfig?.['mcp_servers.buildit'] as Record<string, unknown> | undefined;
    if (entry === undefined) throw new Error('the bridge started no thread with its tools');
    const secret = this.env[String(entry.bearer_token_env_var)] ?? '';
    const client = new Client({ name: 'codex-replay', version: '0.166.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(String(entry.url)), {
        requestInit: { headers: { Authorization: `Bearer ${secret}` } },
      }),
    );
    this.clients.push(client);
    try {
      return await client.callTool({ name, arguments: args });
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  /** The next message the recording expects from the bridge (undefined: none left). */
  get expecting(): FixtureRecord | undefined {
    return this.records[this.position]?.dir === 'out' ? this.records[this.position] : undefined;
  }

  /** Whether every recorded message was played. */
  get done(): boolean {
    return this.position >= this.records.length;
  }

  /** The newer requests the bridge sent, answered outside the recording. */
  readonly newer: string[] = [];

  private onBridge(line: string): void {
    const sent = JSON.parse(line) as Record<string, unknown>;
    const expected = this.expecting;
    const method = typeof sent.method === 'string' ? sent.method : undefined;
    this.validate(sent, method);
    if (
      method !== undefined &&
      sent.id !== undefined &&
      method !== expected?.msg.method &&
      method in NEWER_REQUESTS
    ) {
      this.newer.push(method);
      if (!this.ended) {
        this.toBridge.write(JSON.stringify({ id: sent.id, result: NEWER_REQUESTS[method] }) + '\n');
      }
      return;
    }
    if (expected === undefined) {
      this.violations.push(
        `the bridge sent ${method ?? 'an answer'}, the recording expected nothing`,
      );
      return;
    }
    const e = expected.msg;
    if (method === 'thread/start') {
      this.threadConfig = ((sent.params ?? {}) as { config?: Record<string, unknown> }).config;
    }
    if (method === undefined && decisionOf(e) !== decisionOf(sent)) {
      this.violations.push(
        `an answer ${String(decisionOf(sent))}, the recording has ${String(decisionOf(e))}`,
      );
    }
    if (e.method !== method) {
      this.violations.push(
        `the bridge sent ${method ?? 'an answer'}, the recording has ${String(e.method)}`,
      );
    } else if (method !== undefined) {
      const a = (sent.params ?? {}) as Record<string, unknown>;
      const b = (e.params ?? {}) as Record<string, unknown>;
      for (const k of COMPARED) {
        if (a[k] !== b[k]) {
          this.violations.push(
            `${method}: ${k} ${String(a[k])}, the recording has ${String(b[k])}`,
          );
        }
      }
      if (promptOf(sent) !== promptOf(e)) {
        this.violations.push(
          `${method}: input ${JSON.stringify(promptOf(sent))}, the recording has ${JSON.stringify(promptOf(e))}`,
        );
      }
      if (inputTypes(sent) !== inputTypes(e)) {
        this.violations.push(
          `${method}: input types ${inputTypes(sent)}, the recording has ${inputTypes(e)}`,
        );
      }
    }
    if (e.id !== undefined && sent.id !== undefined) this.ids.set(e.id, sent.id);
    this.position++;
    // The server's recorded messages, up to the bridge's next one (after each one's hook).
    this.pumping = this.pumping.then(() => this.pump());
  }

  private async pump(): Promise<void> {
    while (this.records[this.position]?.dir === 'in') {
      const msg = { ...this.records[this.position]!.msg };
      if (msg.method === undefined && this.ids.has(msg.id)) msg.id = this.ids.get(msg.id);
      if (this.onRecord !== undefined) {
        try {
          await this.onRecord(msg);
        } catch (err) {
          this.violations.push(`the replay's hook failed: ${String(err)}`);
        }
      }
      this.checkServer(msg);
      if (!this.ended) this.toBridge.write(JSON.stringify(msg) + '\n');
      this.position++;
    }
  }

  private validate(sent: Record<string, unknown>, method: string | undefined): void {
    if (method === undefined) return;
    if (sent.id === undefined) {
      if (PROTOCOL['x-methods'].clientNotifications[method] === undefined) {
        this.violations.push(`notification ${method}: not one the bridge uses`);
      }
      return;
    }
    const ref = PROTOCOL['x-methods'].clientRequests[method]?.params;
    if (ref === undefined) {
      this.violations.push(`request ${method}: not one the bridge uses`);
      return;
    }
    for (const e of [...schemaErrors(ref, sent.params), ...unknownFields(ref, sent.params)]) {
      this.violations.push(`${method} ${e}`);
    }
  }

  /** The recorded server messages against the schema (the subset's methods only). */
  private checkServer(msg: Record<string, unknown>): void {
    const method = typeof msg.method === 'string' ? msg.method : undefined;
    if (method === undefined) {
      const sentMethod = [...this.records.slice(0, this.position)]
        .reverse()
        .find((r) => r.dir === 'out' && this.ids.get(r.msg.id) === msg.id)?.msg.method;
      const ref =
        typeof sentMethod === 'string'
          ? PROTOCOL['x-methods'].clientRequests[sentMethod]?.result
          : undefined;
      if (ref !== undefined && msg.result !== undefined) {
        for (const e of schemaErrors(ref, msg.result))
          this.serverViolations.push(`${String(sentMethod)} result ${e}`);
      }
      return;
    }
    const ref = PROTOCOL['x-methods'].serverNotifications[method]?.params;
    if (ref !== undefined) {
      for (const e of schemaErrors(ref, msg.params)) this.serverViolations.push(`${method} ${e}`);
    }
  }
}
