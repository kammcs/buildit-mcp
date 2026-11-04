/**
 * The app-server's own requests to the bridge, answered safely.
 *
 * Codex asks its client before it runs a command, changes files, widens
 * its permissions, runs an MCP tool or asks the person a question. Cards
 * for those come in a later version; until then every such request is
 * declined (the turn goes on without it, and Codex tells the person why),
 * and logged with its method and thread, never its content. Nothing is
 * ever approved here.
 *
 * The rest: `currentTime/read` is answered with this computer's clock;
 * requests for credentials or attestations, and methods this version
 * doesn't know, are answered "method not found". The bridge never touches
 * Codex's sign-in.
 */
import type { Logger } from '../log.js';
import type { AnsweredServerRequest, ServerRequestResults } from './protocol.js';
import { RPC_METHOD_NOT_FOUND, type RpcServerRequest, type ServerRequestAnswer } from './rpc.js';

/** What the person would be asked; a later version shows them as cards. */
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

/** Requests that mean "the person must decide": declined until cards exist. */
export const DECLINED_METHODS: readonly string[] = Object.keys(DECLINES);

export type ServerRequestOutcome = 'declined' | 'answered' | 'unsupported';

export interface ServerRequestRouter {
  /** Answers one server request. */
  handle(request: RpcServerRequest): Promise<ServerRequestAnswer>;
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
        'codex asked for an approval or an answer; declined (cards for these come in a later version)',
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
