/**
 * A fake `codex app-server` for tests: a scripted JSON-RPC peer on a pair
 * of streams, checked against the protocol subset vendored from Codex
 * (test/fixtures/codex/app-server-protocol.json, written by
 * `npm run codex:schema -- --write`).
 *
 * - Every message the bridge sends is validated: a request's method must be
 *   one the bridge is known to use and its params must match the schema; a
 *   notification must be a known client notification; an answer to a
 *   server request must match that request's response schema. Failures go
 *   to `violations` (tests expect it empty), never thrown.
 * - Everything the fake sends through notify() and request() is validated
 *   too (`selfViolations`), so the transcripts stay true to the protocol;
 *   sendRaw() skips that, for unknown methods and fields.
 * - It behaves like the real server where the bridge depends on it: no
 *   request before `initialize`; threads saved in the shared `CodexHome`
 *   only once a turn has started (resuming an unsaved one fails with "no
 *   rollout found"); `turn/start` while a turn runs joins it; `turn/steer`
 *   needs the running turn's id; `turn/interrupt` ends the turn as
 *   interrupted. Each turn plays `onTurn`, a transcript the test writes.
 * - stdin closing ends it, as the real one exits then.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';

import { Ajv, type ValidateFunction } from 'ajv';

import type { AppServerProcess, SpawnAppServer } from '../../src/codex/process.js';
import {
  deref,
  propertyAt,
  type JsonObject,
  type VendoredProtocol,
} from '../../scripts/codex-protocol.js';

export const PROTOCOL: VendoredProtocol = JSON.parse(
  readFileSync(new URL('../fixtures/codex/app-server-protocol.json', import.meta.url), 'utf8'),
) as VendoredProtocol;

const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema(PROTOCOL, 'codex');
const compiled = new Map<string, ValidateFunction>();

/** Validates data against a `#/definitions/...` ref of the vendored subset; the errors, or []. */
export function schemaErrors(ref: string, data: unknown): string[] {
  let v = compiled.get(ref);
  if (v === undefined) {
    const got = ajv.getSchema(`codex${ref}`);
    if (got === undefined) return [`no schema ${ref}`];
    v = got;
    compiled.set(ref, v);
  }
  if (v(data)) return [];
  return (v.errors ?? []).slice(0, 5).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`);
}

/**
 * Fields the schema doesn't declare (it allows extra ones, so ajv can't
 * tell): the bridge must send only fields Codex knows. Nested objects are
 * checked too, unless their schema is an open map.
 */
export function unknownFields(ref: string, data: unknown, path = ''): string[] {
  const node = deref(PROTOCOL, ref);
  return node === undefined ? [`no schema ${ref}`] : unknownIn(node, data, path);
}

function unknownIn(node: JsonObject, data: unknown, path: string): string[] {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const prop = propertyAt(PROTOCOL, node, [key]);
    if (prop === undefined) {
      out.push(`${path}/${key} is not a field Codex knows`);
      continue;
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const target = typeof prop.$ref === 'string' ? deref(PROTOCOL, prop.$ref) : prop;
      const anyOf = target?.anyOf;
      const objectBranch = Array.isArray(anyOf)
        ? anyOf.find((b) => b !== null && typeof b === 'object' && !Array.isArray(b) && '$ref' in b)
        : undefined;
      const branchRef = (objectBranch as JsonObject | undefined)?.$ref;
      const resolved = typeof branchRef === 'string' ? deref(PROTOCOL, branchRef) : target;
      if (
        resolved !== undefined &&
        resolved.properties !== undefined &&
        resolved.additionalProperties === undefined
      ) {
        out.push(...unknownIn(resolved, value, `${path}/${key}`));
      }
    }
  }
  return out;
}

/** The Codex home: which threads are saved, across fake restarts. */
export class CodexHome {
  readonly saved = new Set<string>();
}

type Json = Record<string, unknown>;

/** A message the bridge sent, as parsed. */
export interface Received {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface TurnContext {
  threadId: string;
  turnId: string;
  /** The first input, then each steer's (and each turn/start that joined). */
  inputs: unknown[][];
  /** Aborted when the turn was interrupted. */
  signal: AbortSignal;
  /** An agent message: item/started, then item/completed. */
  agentMessage(text: string, phase: 'final_answer' | 'commentary' | null): void;
  /** A reasoning item (work, nothing to post). */
  reasoning(): void;
  /** thread/status/changed to active with these flags. */
  status(flags: ('waitingOnApproval' | 'waitingOnUserInput')[]): void;
  /** A server request to the bridge; settles with its answer. */
  request(method: string, params: Json): Promise<Received>;
  /** Waits until the turn has `n` inputs (steers). */
  inputsReach(n: number): Promise<void>;
  /** Waits for the turn's interruption. */
  interrupted(): Promise<void>;
  /** Ends the turn (default completed). The default transcript calls it; a script must too. */
  complete(status?: 'completed' | 'failed', error?: { message: string }): void;
  /** The real items of the turn's completion (sent in turn/completed's turn.items). */
  completeWithItems(items: Json[]): void;
}

export type TurnScript = (ctx: TurnContext) => void | Promise<void>;

/** The default transcript: a commentary note, then the final answer "ok". */
export const replyWith =
  (text: string): TurnScript =>
  (ctx) => {
    ctx.agentMessage('Looking at it.', 'commentary');
    ctx.agentMessage(text, 'final_answer');
    ctx.complete();
  };

interface FakeThread {
  id: string;
  cwd: string;
  turn: { id: string; inputs: unknown[][]; abort: AbortController; done: boolean } | undefined;
  turns: number;
}

export interface FakeCodexOptions {
  /** The version in the user agent (default 0.166.0). */
  version?: string;
  /** Send turn/started before the turn/start answer (the real server may). */
  startedFirst?: boolean;
}

export class FakeAppServer {
  readonly violations: string[] = [];
  readonly selfViolations: string[] = [];
  readonly received: Received[] = [];
  /** The args the bridge started the app-server with. */
  args: readonly string[] | undefined;
  onTurn: TurnScript = replyWith('ok');
  /** Answer thread/resume with this error instead (tests). */
  failResume: { code: number; message: string } | undefined;
  /** Answer turn/start with these errors first (tests). */
  failTurnStart: { code: number; message: string }[] = [];
  /** Never answer turn/start (tests: the app-server dies meanwhile). */
  hangTurnStart = false;
  /** Answer turn/steer with these errors first (tests: the turn ended meanwhile). */
  failSteer: { code: number; message: string }[] = [];
  private readonly threads = new Map<string, FakeThread>();
  private initialized = false;
  private nextServerId = 0;
  private readonly pendingServer = new Map<
    number,
    { method: string; threadId: string | undefined; resolve: (r: Received) => void }
  >();
  private readonly toBridge = new PassThrough();
  private readonly fromBridge = new PassThrough();
  private exitedResolve!: (code: number | null) => void;
  private readonly exitedPromise = new Promise<number | null>((r) => (this.exitedResolve = r));
  private ended = false;
  private readonly waiters = new Set<() => void>();

  constructor(
    readonly home: CodexHome = new CodexHome(),
    private readonly options: FakeCodexOptions = {},
  ) {
    createInterface({ input: this.fromBridge }).on('line', (line) => {
      this.onLine(line);
    });
    this.fromBridge.on('end', () => {
      this.exit(0);
    });
  }

  /** The spawner the bridge is given: one process (this fake). */
  readonly spawn: SpawnAppServer = (args) => {
    this.args = args;
    return this.process;
  };

  readonly process: AppServerProcess = {
    stdout: this.toBridge,
    stdin: this.fromBridge,
    exited: this.exitedPromise,
    stop: async () => {
      this.fromBridge.end();
      return this.exitedPromise;
    },
  };

  /** The params of every request the bridge sent with this method. */
  requests(method: string): Json[] {
    return this.received
      .filter((r) => r.method === method && r.id !== undefined)
      .map((r) => r.params as Json);
  }

  /** Notifications the bridge sent, by method. */
  notifications(method: string): Received[] {
    return this.received.filter((r) => r.method === method && r.id === undefined);
  }

  /** Waits until a check holds (each message re-checks). */
  async until(check: () => boolean, ms = 3000): Promise<void> {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error('timed out waiting for the fake app-server');
      await new Promise<void>((resolve) => {
        const done = (): void => {
          this.waiters.delete(done);
          resolve();
        };
        this.waiters.add(done);
        setTimeout(done, 10);
      });
    }
  }

  /** A notification to the bridge, validated against its schema. */
  notify(method: string, params: Json): void {
    const ref = PROTOCOL['x-methods'].serverNotifications[method]?.params;
    if (ref === undefined) this.selfViolations.push(`notification ${method}: not in the subset`);
    else for (const e of schemaErrors(ref, params)) this.selfViolations.push(`${method} ${e}`);
    // The real server adds emittedAtMs to every notification, outside params.
    this.write({ method, params, emittedAtMs: Date.now() });
  }

  /** Anything, unchecked (unknown methods and fields). */
  sendRaw(message: Json): void {
    this.write(message);
  }

  /** A raw line (junk, for the parser). */
  sendLine(line: string): void {
    if (!this.ended) this.toBridge.write(`${line}\n`);
  }

  /** A server request to the bridge, validated; settles with the bridge's answer. */
  request(method: string, params: Json): Promise<Received> {
    const ref = PROTOCOL['x-methods'].serverRequests[method]?.params;
    if (ref !== undefined)
      for (const e of schemaErrors(ref, params)) this.selfViolations.push(`${method} ${e}`);
    const id = this.nextServerId++;
    return new Promise((resolve) => {
      const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
      this.pendingServer.set(id, { method, threadId, resolve });
      this.write({ id, method, params });
    });
  }

  /** The process ends (a crash, when called by a test). */
  exit(code: number | null = 1): void {
    if (this.ended) return;
    this.ended = true;
    this.toBridge.end();
    this.exitedResolve(code);
  }

  private write(message: Json): void {
    if (this.ended) return;
    this.toBridge.write(JSON.stringify(message) + '\n');
  }

  private answer(id: string | number, method: string, result: Json): void {
    const ref = PROTOCOL['x-methods'].clientRequests[method]?.result;
    if (ref !== undefined)
      for (const e of schemaErrors(ref, result)) this.selfViolations.push(`${method} result ${e}`);
    this.write({ id, result });
  }

  private fail(id: string | number, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  private onLine(line: string): void {
    if (line.trim() === '') return;
    let m: Received & Json;
    try {
      m = JSON.parse(line) as Received & Json;
    } catch {
      this.violations.push('a line that is not JSON');
      return;
    }
    this.received.push(m);
    for (const w of [...this.waiters]) w();
    const hasId = typeof m.id === 'string' || typeof m.id === 'number';
    if (typeof m.method === 'string' && hasId) {
      this.onRequest(m.id!, m.method, m.params);
    } else if (typeof m.method === 'string') {
      if (PROTOCOL['x-methods'].clientNotifications[m.method] === undefined) {
        this.violations.push(`notification ${m.method}: not a client notification the bridge uses`);
      }
      if (m.method === 'initialized') this.initialized = true;
    } else if (hasId) {
      this.onAnswer(m);
    } else {
      this.violations.push('a message of no kind');
    }
  }

  private onAnswer(m: Received): void {
    const pending = this.pendingServer.get(Number(m.id));
    if (pending === undefined) {
      this.violations.push(`an answer to no server request (${String(m.id)})`);
      return;
    }
    this.pendingServer.delete(Number(m.id));
    if (m.error !== undefined) {
      const e = m.error as Json;
      if (typeof e.code !== 'number' || typeof e.message !== 'string') {
        this.violations.push(`${pending.method}: a malformed error answer`);
      }
    } else {
      const ref = PROTOCOL['x-methods'].serverRequests[pending.method]?.result;
      if (ref === undefined)
        this.violations.push(`${pending.method}: answered, but the bridge doesn't answer it`);
      else
        for (const e of schemaErrors(ref, m.result))
          this.violations.push(`${pending.method} answer ${e}`);
    }
    pending.resolve(m);
    // As the real server does once a request is answered.
    if (pending.threadId !== undefined) {
      this.notify('serverRequest/resolved', {
        threadId: pending.threadId,
        requestId: Number(m.id),
      });
    }
  }

  private onRequest(id: string | number, method: string, params: unknown): void {
    const ref = PROTOCOL['x-methods'].clientRequests[method]?.params;
    if (ref === undefined) {
      this.violations.push(`request ${method}: not a method the bridge is known to use`);
    } else {
      for (const e of schemaErrors(ref, params)) this.violations.push(`${method} ${e}`);
      for (const e of unknownFields(ref, params)) this.violations.push(`${method} ${e}`);
    }
    const p = (params ?? {}) as Json;
    if (method === 'initialize') {
      const info = (p.clientInfo ?? {}) as Json;
      const name = typeof info.name === 'string' ? info.name : 'client';
      const version = typeof info.version === 'string' ? info.version : '0.0.0';
      this.answer(id, method, {
        userAgent: `${name}/${this.options.version ?? '0.166.0'} (Test OS; x86_64) test (${name}; ${version})`,
        codexHome: '/tmp/codex-home',
        platformFamily: 'unix',
        platformOs: 'linux',
      });
      return;
    }
    if (!this.initialized) {
      this.violations.push(`${method} before initialized`);
      this.fail(id, -32600, 'Not initialized');
      return;
    }
    switch (method) {
      case 'thread/start': {
        const thread: FakeThread = {
          id: randomUUID(),
          cwd: typeof p.cwd === 'string' ? p.cwd : '/tmp/work',
          turn: undefined,
          turns: 0,
        };
        this.threads.set(thread.id, thread);
        this.answer(id, method, threadResponse(thread));
        // The bridge doesn't read thread/started (not in the subset): sent unchecked.
        this.sendRaw({ method: 'thread/started', params: { thread: threadObject(thread) } });
        return;
      }
      case 'thread/resume': {
        const threadId = String(p.threadId);
        if (this.failResume !== undefined) {
          this.fail(id, this.failResume.code, this.failResume.message);
          return;
        }
        if (!this.home.saved.has(threadId)) {
          this.fail(id, -32600, `no rollout found for thread id ${threadId}`);
          return;
        }
        const thread: FakeThread = this.threads.get(threadId) ?? {
          id: threadId,
          cwd: '/tmp/work',
          turn: undefined,
          turns: 1,
        };
        this.threads.set(threadId, thread);
        this.answer(id, method, threadResponse(thread));
        return;
      }
      case 'turn/start':
        this.turnStart(id, p);
        return;
      case 'turn/steer': {
        const thread = this.threads.get(String(p.threadId));
        const turn = thread?.turn;
        const refused = this.failSteer.shift();
        if (refused !== undefined) {
          this.fail(id, refused.code, refused.message);
          return;
        }
        if (turn === undefined || turn.done) {
          this.fail(id, -32600, 'no active turn to steer');
          return;
        }
        if (p.expectedTurnId !== turn.id) {
          this.fail(id, -32600, 'expectedTurnId does not match the active turn');
          return;
        }
        turn.inputs.push(p.input as unknown[]);
        this.answer(id, method, { turnId: turn.id });
        this.userMessage(thread!, p.input as unknown[]);
        return;
      }
      case 'turn/interrupt': {
        const thread = this.threads.get(String(p.threadId));
        const turn = thread?.turn;
        if (turn === undefined || turn.done || turn.id !== p.turnId) {
          this.fail(id, -32600, 'no such active turn');
          return;
        }
        this.answer(id, method, {});
        turn.abort.abort();
        this.finish(thread!, 'interrupted');
        return;
      }
      default:
        this.fail(id, -32601, `method not found: ${method}`);
    }
  }

  private turnStart(id: string | number, p: Json): void {
    const thread = this.threads.get(String(p.threadId));
    if (thread === undefined) {
      this.fail(id, -32600, 'thread not loaded');
      return;
    }
    if (this.hangTurnStart) return;
    const failure = this.failTurnStart.shift();
    if (failure !== undefined) {
      this.fail(id, failure.code, failure.message);
      return;
    }
    const input = p.input as unknown[];
    if (thread.turn !== undefined && !thread.turn.done) {
      // A turn runs: the input joins it (the real server steers it in).
      thread.turn.inputs.push(input);
      this.answer(id, 'turn/start', { turn: turnObject(thread.turn.id, 'inProgress') });
      this.userMessage(thread, input);
      return;
    }
    const turn = { id: randomUUID(), inputs: [input], abort: new AbortController(), done: false };
    thread.turn = turn;
    thread.turns++;
    this.home.saved.add(thread.id);
    const started = (): void => {
      this.notify('turn/started', { threadId: thread.id, turn: turnObject(turn.id, 'inProgress') });
      this.notify('thread/status/changed', {
        threadId: thread.id,
        status: { type: 'active', activeFlags: [] },
      });
    };
    if (this.options.startedFirst === true) started();
    this.answer(id, 'turn/start', { turn: turnObject(turn.id, 'inProgress') });
    if (this.options.startedFirst !== true) started();
    this.userMessage(thread, input);
    void this.play(thread, turn);
  }

  private userMessage(thread: FakeThread, input: unknown[]): void {
    const turn = thread.turn!;
    const item = { type: 'userMessage', id: randomUUID(), content: input, clientId: null };
    this.notify('item/started', {
      threadId: thread.id,
      turnId: turn.id,
      item,
      startedAtMs: Date.now(),
    });
    this.notify('item/completed', {
      threadId: thread.id,
      turnId: turn.id,
      item,
      completedAtMs: Date.now(),
    });
  }

  private async play(thread: FakeThread, turn: NonNullable<FakeThread['turn']>): Promise<void> {
    const live = (): boolean => !turn.done && !this.ended;
    const emitItem = (item: Json): void => {
      if (!live()) return;
      // An agent message starts empty (the real server fills it in with deltas, which the bridge opts out of).
      this.notify('item/started', {
        threadId: thread.id,
        turnId: turn.id,
        item: item.type === 'agentMessage' ? { ...item, text: '' } : item,
        startedAtMs: Date.now(),
      });
      this.notify('item/completed', {
        threadId: thread.id,
        turnId: turn.id,
        item,
        completedAtMs: Date.now(),
      });
    };
    const ctx: TurnContext = {
      threadId: thread.id,
      turnId: turn.id,
      inputs: turn.inputs,
      signal: turn.abort.signal,
      agentMessage: (text, phase) => {
        emitItem({
          type: 'agentMessage',
          id: `msg_${randomUUID()}`,
          text,
          phase,
          memoryCitation: null,
          delivery: null,
          questions: null,
        });
      },
      reasoning: () => {
        emitItem({ type: 'reasoning', id: `rs_${randomUUID()}`, summary: [], content: [] });
      },
      status: (flags) => {
        if (!live()) return;
        this.notify('thread/status/changed', {
          threadId: thread.id,
          status: { type: 'active', activeFlags: flags },
        });
      },
      request: (method, params) =>
        this.request(method, { threadId: thread.id, turnId: turn.id, ...params }),
      inputsReach: async (n) => {
        await this.until(() => turn.inputs.length >= n || turn.abort.signal.aborted);
      },
      interrupted: () =>
        new Promise<void>((resolve) => {
          if (turn.abort.signal.aborted) resolve();
          else
            turn.abort.signal.addEventListener(
              'abort',
              () => {
                resolve();
              },
              { once: true },
            );
        }),
      complete: (status = 'completed', error) => {
        if (!live()) return;
        this.finish(thread, status, error);
      },
      completeWithItems: (items) => {
        if (!live()) return;
        this.finish(thread, 'completed', undefined, items);
      },
    };
    try {
      await this.onTurn(ctx);
    } catch (err) {
      this.selfViolations.push(`transcript failed: ${String(err)}`);
    }
  }

  private finish(
    thread: FakeThread,
    status: 'completed' | 'failed' | 'interrupted',
    error?: { message: string },
    items: Json[] = [],
  ): void {
    const turn = thread.turn;
    if (turn === undefined || turn.done) return;
    turn.done = true;
    this.notify('turn/completed', {
      threadId: thread.id,
      turn: {
        ...turnObject(turn.id, status, items),
        ...(error === undefined ? {} : { error: { message: error.message, codexErrorInfo: null } }),
      },
    });
    this.notify('thread/status/changed', { threadId: thread.id, status: { type: 'idle' } });
  }
}

// The shapes below follow a real app-server's (test/fixtures/codex/smoke-0.166.0.jsonl).
function turnObject(id: string, status: string, items: Json[] = []): Json {
  return {
    id,
    rootTurnId: id,
    items,
    itemsView: items.length > 0 ? 'summary' : 'notLoaded',
    status,
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
}

function threadObject(thread: FakeThread): Json {
  return {
    id: thread.id,
    sessionId: thread.id,
    cliVersion: '0.166.0',
    createdAt: 1_793_000_000,
    updatedAt: 1_793_000_000,
    cwd: thread.cwd,
    environments: [
      { environmentId: 'local', cwd: thread.cwd, runtimeWorkspaceRoots: [thread.cwd] },
    ],
    extra: null,
    forkedFromId: null,
    parentThreadId: null,
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    historyMode: 'paginated',
    modelProvider: 'openai',
    model: 'test-model',
    reasoningEffort: 'low',
    recencyAt: 1_793_000_000,
    path: null,
    originator: 'buildit_mcp',
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    daybreakEnabled: null,
    preview: '',
    projectId: null,
    source: 'vscode',
    status: { type: 'idle' },
    turns: [],
  };
}

function threadResponse(thread: FakeThread): Json {
  return {
    thread: threadObject(thread),
    model: 'test-model',
    modelProvider: 'openai',
    cwd: thread.cwd,
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: { type: 'readOnly', networkAccess: false },
  };
}
