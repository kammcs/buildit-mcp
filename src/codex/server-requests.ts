/**
 * The app-server's own requests to the bridge, answered safely.
 *
 * Codex asks its client before it runs a command, changes files, widens
 * its permissions, runs an MCP tool or asks the person a question. The
 * approvals become cards (approvals.ts), which hand everything else here:
 * what this version can't show the person (questions, elicitations that
 * aren't an MCP tool's approval, dynamic tools, the old v1 approvals), and,
 * when the bridge runs without cards, the approvals too. Each is declined
 * (the turn goes on without it, and Codex tells the person why), and
 * logged with its method and thread, never its content. Nothing is ever
 * approved here.
 *
 * The rest: `currentTime/read` is answered with this computer's clock;
 * requests for credentials or attestations, and methods this version
 * doesn't know, are answered "method not found". The bridge never touches
 * Codex's sign-in.
 */
import type { Logger } from '../log.js';
import type { AnsweredServerRequest, ServerRequestResults } from './protocol.js';
import {
  RPC_METHOD_NOT_FOUND,
  type RpcNotification,
  type RpcServerRequest,
  type ServerRequestAnswer,
} from './rpc.js';

/** The safe answer to each request the person would decide: no, nothing, or none. */
const DECLINES: { [M in AnsweredServerRequest]?: ServerRequestResults[M] } = {
  'item/commandExecution/requestApproval': { decision: 'decline' },
  'item/fileChange/requestApproval': { decision: 'decline' },
  // No permission granted, for this turn only.
  'item/permissions/requestApproval': { permissions: {}, scope: 'turn' },
  'mcpServer/elicitation/request': { action: 'decline', content: null, _meta: null },
  // No answers: the question stays unanswered.
  'item/tool/requestUserInput': { answers: {} },
  // The bridge registers no dynamic tools.
  'item/tool/call': { contentItems: [], success: false },
  applyPatchApproval: {
    decision: { denied: { rejection: 'Approvals are not available in this session yet.' } },
  },
  execCommandApproval: {
    decision: { denied: { rejection: 'Approvals are not available in this session yet.' } },
  },
};

/** Requests that mean "the person must decide": declined when they reach this router. */
export const DECLINED_METHODS: readonly string[] = Object.keys(DECLINES);

export type ServerRequestOutcome = 'declined' | 'answered' | 'unsupported';

export interface ServerRequestRouter {
  /** Answers one server request. */
  handle(request: RpcServerRequest): Promise<ServerRequestAnswer>;
  /** Sees every notification first (the file changes' diffs, resolved requests). */
  observe?(n: RpcNotification): void;
  /** Ends every wait: the app-server is gone, or the bridge stops. */
  closeAll?(): void;
}

/** The answers of this version: declines, the clock, and "method not found". */
export class DecliningServerRequests implements ServerRequestRouter {
  constructor(
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
    /** Told of every request's outcome (tests, and the bridge's counters). */
    private readonly onOutcome?: (method: string, outcome: ServerRequestOutcome) => void,
  ) {}

  handle(request: RpcServerRequest): Promise<ServerRequestAnswer> {
    const params = (
      request.params !== null && typeof request.params === 'object' ? request.params : {}
    ) as Record<string, unknown>;
    const thread = typeof params.threadId === 'string' ? params.threadId : undefined;
    const decline = DECLINES[request.method as AnsweredServerRequest];
    if (decline !== undefined) {
      this.logger.warn(
        'codex asked for something this bridge cannot show the person yet; declined',
        { method: request.method, codex_thread: thread },
      );
      this.onOutcome?.(request.method, 'declined');
      return Promise.resolve({ result: decline });
    }
    if (request.method === 'currentTime/read') {
      this.onOutcome?.(request.method, 'answered');
      const result: ServerRequestResults['currentTime/read'] = {
        currentTimeAt: Math.floor(this.now() / 1000),
      };
      return Promise.resolve({ result });
    }
    this.logger.info('codex server request not supported', { method: request.method });
    this.onOutcome?.(request.method, 'unsupported');
    return Promise.resolve({
      error: { code: RPC_METHOD_NOT_FOUND, message: `${request.method} is not supported` },
    });
  }
}
