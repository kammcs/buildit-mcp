/**
 * The parts of the `codex app-server` protocol that the bridge uses.
 *
 * Derived from the TypeScript bindings that OpenAI Codex generates for its
 * app-server protocol (`codex app-server generate-ts --experimental`, Codex
 * 0.166.0), from https://github.com/openai/codex, Copyright OpenAI, licensed
 * under the Apache License, Version 2.0
 * (http://www.apache.org/licenses/LICENSE-2.0; a copy is in
 * test/fixtures/codex/LICENSE-codex). Changes: only the types and fields
 * the bridge sends or reads are kept, unions the bridge doesn't look into
 * are widened to `unknown`, and documentation was rewritten.
 *
 * Every type of a message the bridge receives is read tolerantly: fields
 * may be missing or added, and enums may grow (the app-server is
 * experimental and ships about weekly). `scripts/codex-schema.ts` checks
 * these names against the installed Codex's generated schema.
 */

/** A JSON-RPC id. The app-server numbers its own requests from 0. */
export type RequestId = string | number;

// ---------------------------------------------------------------------------
// The handshake
// ---------------------------------------------------------------------------

export interface ClientInfo {
  name: string;
  title: string | null;
  version: string;
}

export interface InitializeCapabilities {
  /** Opt into experimental methods and fields. */
  experimentalApi: boolean;
  /** Exact notification method names this connection doesn't want. */
  optOutNotificationMethods?: string[] | null;
}

export interface InitializeParams {
  clientInfo: ClientInfo;
  capabilities: InitializeCapabilities | null;
}

export interface InitializeResponse {
  /** `<clientInfo.name>/<codex version> (<platform>) ...`. */
  userAgent: string;
  codexHome?: string;
  platformFamily?: string;
  platformOs?: string;
}

// ---------------------------------------------------------------------------
// Threads and turns
// ---------------------------------------------------------------------------

/** `untrusted`, `on-request`, `never`, or a granular object. */
export type AskForApproval = 'untrusted' | 'on-request' | 'never' | Record<string, unknown>;

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** The thread's state; `active` carries what it waits for. */
export type ThreadStatus =
  | { type: 'notLoaded' }
  | { type: 'idle' }
  | { type: 'systemError' }
  | { type: 'active'; activeFlags: ThreadActiveFlag[] };

export type ThreadActiveFlag = 'waitingOnApproval' | 'waitingOnUserInput';

export interface Thread {
  id: string;
  status?: ThreadStatus;
  cwd?: string;
  cliVersion?: string;
}

export interface ThreadStartParams {
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  serviceName?: string | null;
  developerInstructions?: string | null;
  ephemeral?: boolean | null;
  /** Config overrides for this thread, by dotted key (as `-c` takes them). */
  config?: Record<string, unknown> | null;
}

export interface ThreadStartResponse {
  thread: Thread;
  model?: string;
}

export interface ThreadResumeParams {
  threadId: string;
  /** Leave `thread.turns` empty: the bridge never reads the history. */
  excludeTurns?: boolean;
  /** Config overrides for the resumed thread (the hosted tools' URL is new each run). */
  config?: Record<string, unknown> | null;
}

export type ThreadResumeResponse = ThreadStartResponse;

/** One input item of a turn. The bridge sends text (files and images come later). */
export type UserInput =
  { type: 'text'; text: string; text_elements: unknown[] } | { type: 'localImage'; path: string };

export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';

export interface TurnError {
  message: string;
  codexErrorInfo?: unknown;
}

export interface Turn {
  id: string;
  status: TurnStatus;
  error?: TurnError | null;
  items?: ThreadItem[];
}

export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
}

export interface TurnStartResponse {
  turn: Turn;
}

export interface TurnSteerParams {
  threadId: string;
  /** The turn the input is for: the server refuses it once that turn has ended. */
  expectedTurnId: string;
  input: UserInput[];
}

export interface TurnSteerResponse {
  turnId: string;
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

/** `commentary` notes, then the `final_answer`; null on older or other paths. */
export type MessagePhase = 'commentary' | 'partial_answer' | 'final_answer';

/**
 * An item of a turn. The bridge reads agent messages; every other type
 * (reasoning, commands, file changes, tool calls...) only counts as work.
 */
export type ThreadItem =
  | { type: 'agentMessage'; id: string; text: string; phase?: MessagePhase | null }
  | { type: string; id: string };

// ---------------------------------------------------------------------------
// Notifications the bridge reads
// ---------------------------------------------------------------------------

export interface TurnStartedNotification {
  threadId: string;
  turn: Turn;
}

export interface TurnCompletedNotification {
  threadId: string;
  turn: Turn;
}

export interface ItemStartedNotification {
  threadId: string;
  turnId: string;
  item: ThreadItem;
}

export interface ItemCompletedNotification {
  threadId: string;
  turnId: string;
  item: ThreadItem;
}

export interface ThreadStatusChangedNotification {
  threadId: string;
  status: ThreadStatus;
}

export interface ThreadClosedNotification {
  threadId: string;
}

export interface ErrorNotification {
  threadId: string;
  turnId: string;
  willRetry: boolean;
  error: TurnError;
}

export interface ServerRequestResolvedNotification {
  threadId: string;
  requestId: RequestId;
}

/**
 * The streaming notifications the bridge opts out of in `initialize`: it
 * reads only completed items.
 */
export const DELTA_NOTIFICATIONS: readonly string[] = [
  'item/agentMessage/delta',
  'item/plan/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
  'item/commandExecution/outputDelta',
  'item/fileChange/outputDelta',
  'command/exec/outputDelta',
  'process/outputDelta',
];

// ---------------------------------------------------------------------------
// Server requests (the app-server asks the client)
// ---------------------------------------------------------------------------

/** The server requests the bridge answers, and what each answer looks like. */
export interface ServerRequestResults {
  'item/commandExecution/requestApproval': {
    decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel' | Record<string, unknown>;
  };
  'item/fileChange/requestApproval': {
    decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel';
  };
  'item/permissions/requestApproval': {
    permissions: Record<string, unknown>;
    scope: 'turn' | 'session';
  };
  'mcpServer/elicitation/request': {
    action: 'accept' | 'decline' | 'cancel';
    content: unknown;
    _meta: unknown;
  };
  'item/tool/requestUserInput': { answers: Record<string, { answers: string[] }> };
  'item/tool/call': { contentItems: unknown[]; success: boolean };
  applyPatchApproval: { decision: unknown };
  execCommandApproval: { decision: unknown };
  'currentTime/read': { currentTimeAt: number };
}

export type AnsweredServerRequest = keyof ServerRequestResults;

/** Params every thread-scoped server request carries. */
export interface ServerRequestScope {
  threadId?: string;
  turnId?: string | null;
  itemId?: string;
}
