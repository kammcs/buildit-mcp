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
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';

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

const COMPARED = ['threadId', 'expectedTurnId', 'turnId', 'excludeTurns'] as const;

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

  readonly spawn: SpawnAppServer = () => this.process;

  /** The next message the recording expects from the bridge (undefined: none left). */
  get expecting(): FixtureRecord | undefined {
    return this.records[this.position]?.dir === 'out' ? this.records[this.position] : undefined;
  }

  /** Whether every recorded message was played. */
  get done(): boolean {
    return this.position >= this.records.length;
  }

  private onBridge(line: string): void {
    const sent = JSON.parse(line) as Record<string, unknown>;
    const expected = this.expecting;
    const method = typeof sent.method === 'string' ? sent.method : undefined;
    this.validate(sent, method);
    if (expected === undefined) {
      this.violations.push(
        `the bridge sent ${method ?? 'an answer'}, the recording expected nothing`,
      );
      return;
    }
    const e = expected.msg;
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
      if (inputText(sent) !== inputText(e)) {
        this.violations.push(
          `${method}: input ${JSON.stringify(inputText(sent))}, the recording has ${JSON.stringify(inputText(e))}`,
        );
      }
    }
    if (e.id !== undefined && sent.id !== undefined) this.ids.set(e.id, sent.id);
    this.position++;
    // The server's recorded messages, up to the bridge's next one.
    while (this.records[this.position]?.dir === 'in') {
      const msg = { ...this.records[this.position]!.msg };
      if (msg.method === undefined && this.ids.has(msg.id)) msg.id = this.ids.get(msg.id);
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
