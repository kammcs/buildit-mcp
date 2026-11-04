/**
 * The part of the `codex app-server` protocol the bridge relies on: the
 * methods it sends and reads, and the fields it fills in or reads in each.
 *
 * `npm run codex:schema` checks it against an installed Codex's generated
 * schema (each method and field must be there; changes in the types they
 * use are listed), and writes the vendored subset the tests validate
 * against (test/fixtures/codex/). Keep it in step with protocol.ts and the
 * bridge: a field the bridge starts to use goes here too.
 */
import { DELTA_NOTIFICATIONS } from './protocol.js';

export interface MethodUse {
  /** Fields the bridge fills in (params of what it sends, results of what it answers). */
  sends?: readonly string[];
  /** Fields the bridge reads (results of its requests, params of what it receives). */
  reads?: readonly string[];
}

/** Types whose variants or values the bridge looks into. */
export interface TypeUse {
  /** A definition, as `<name>` or `v2/<name>`. */
  ref: string;
  /** A oneOf branch, by its `type` (ThreadItem's agentMessage, ThreadStatus's active). */
  variant?: string;
  fields?: readonly string[];
  /** Enum values the bridge compares with. */
  values?: readonly string[];
}

export interface BridgeSurface {
  /** Requests the bridge sends, with the definition of their result. */
  clientRequests: Record<string, MethodUse & { result: string }>;
  clientNotifications: readonly string[];
  serverNotifications: Record<string, MethodUse>;
  /** Server requests the bridge answers, with the definition of its answer. */
  serverRequests: Record<string, MethodUse & { result: string }>;
  /** Notifications the bridge opts out of: they must still exist. */
  optedOut: readonly string[];
  types: readonly TypeUse[];
}

export const BRIDGE_SURFACE: BridgeSurface = {
  clientRequests: {
    initialize: {
      result: 'InitializeResponse',
      sends: [
        'clientInfo.name',
        'clientInfo.title',
        'clientInfo.version',
        'capabilities.experimentalApi',
        'capabilities.optOutNotificationMethods',
      ],
      reads: ['userAgent'],
    },
    'thread/start': {
      result: 'v2/ThreadStartResponse',
      sends: ['cwd', 'serviceName', 'developerInstructions', 'config'],
      reads: ['thread.id', 'approvalPolicy', 'approvalsReviewer'],
    },
    'thread/resume': {
      result: 'v2/ThreadResumeResponse',
      sends: ['threadId', 'excludeTurns', 'cwd', 'config'],
      reads: ['thread.id', 'approvalPolicy', 'approvalsReviewer'],
    },
    'turn/start': {
      result: 'v2/TurnStartResponse',
      sends: ['threadId', 'input', 'collaborationMode'],
      reads: ['turn.id'],
    },
    'turn/steer': {
      result: 'v2/TurnSteerResponse',
      sends: ['threadId', 'expectedTurnId', 'input'],
      reads: ['turnId'],
    },
    'turn/interrupt': {
      result: 'v2/TurnInterruptResponse',
      sends: ['threadId', 'turnId'],
    },
    'thread/unsubscribe': {
      result: 'v2/ThreadUnsubscribeResponse',
      sends: ['threadId'],
      reads: ['status'],
    },
    'skills/extraRoots/set': {
      result: 'v2/SkillsExtraRootsSetResponse',
      sends: ['extraRoots'],
    },
    'skills/list': {
      result: 'v2/SkillsListResponse',
      sends: ['cwds', 'forceReload'],
      reads: ['data'],
    },
    'config/read': {
      result: 'v2/ConfigReadResponse',
      sends: ['cwd'],
      reads: ['config.approval_policy', 'config.approvals_reviewer'],
    },
  },
  clientNotifications: ['initialized'],
  serverNotifications: {
    'thread/started': {
      reads: ['thread.id', 'thread.parentThreadId', 'thread.agentNickname', 'thread.agentRole'],
    },
    'turn/started': { reads: ['threadId', 'turn.id'] },
    'turn/plan/updated': { reads: ['threadId', 'turnId', 'explanation', 'plan'] },
    'turn/completed': {
      reads: ['threadId', 'turn.id', 'turn.status', 'turn.error', 'turn.items'],
    },
    'item/started': { reads: ['threadId', 'turnId', 'item'] },
    'item/completed': { reads: ['threadId', 'turnId', 'item'] },
    'thread/status/changed': { reads: ['threadId', 'status'] },
    'thread/closed': { reads: ['threadId'] },
    error: { reads: ['threadId', 'turnId', 'willRetry', 'error'] },
    'serverRequest/resolved': { reads: ['threadId', 'requestId'] },
  },
  serverRequests: {
    'item/commandExecution/requestApproval': {
      result: 'CommandExecutionRequestApprovalResponse',
      reads: [
        'threadId',
        'itemId',
        'approvalId',
        'kind',
        'command',
        'commandActions',
        'cwd',
        'reason',
        'networkApprovalContext',
        'additionalPermissions',
        'availableDecisions',
      ],
      sends: ['decision'],
    },
    'item/fileChange/requestApproval': {
      result: 'FileChangeRequestApprovalResponse',
      reads: ['threadId', 'itemId', 'reason', 'grantRoot'],
      sends: ['decision'],
    },
    'item/permissions/requestApproval': {
      result: 'PermissionsRequestApprovalResponse',
      reads: ['threadId', 'itemId', 'cwd', 'reason', 'permissions'],
      sends: ['permissions', 'scope'],
    },
    'mcpServer/elicitation/request': {
      result: 'McpServerElicitationRequestResponse',
      reads: ['threadId', 'serverName'],
      sends: ['action', 'content', '_meta'],
    },
    'item/tool/requestUserInput': {
      result: 'ToolRequestUserInputResponse',
      reads: ['threadId', 'itemId', 'questions'],
      sends: ['answers'],
    },
    'item/tool/call': {
      result: 'DynamicToolCallResponse',
      reads: ['threadId'],
      sends: ['contentItems', 'success'],
    },
    applyPatchApproval: { result: 'ApplyPatchApprovalResponse', sends: ['decision'] },
    execCommandApproval: { result: 'ExecCommandApprovalResponse', sends: ['decision'] },
    'currentTime/read': {
      result: 'CurrentTimeReadResponse',
      reads: ['threadId'],
      sends: ['currentTimeAt'],
    },
  },
  optedOut: DELTA_NOTIFICATIONS,
  types: [
    { ref: 'v2/ThreadItem', variant: 'agentMessage', fields: ['id', 'text', 'phase'] },
    { ref: 'v2/ThreadStatus', variant: 'active', fields: ['activeFlags'] },
    { ref: 'v2/ThreadActiveFlag', values: ['waitingOnApproval', 'waitingOnUserInput'] },
    { ref: 'v2/TurnStatus', values: ['completed', 'interrupted', 'failed'] },
    { ref: 'v2/MessagePhase', values: ['commentary', 'final_answer'] },
    { ref: 'v2/UserInput', variant: 'text', fields: ['text', 'text_elements'] },
    { ref: 'v2/UserInput', variant: 'localImage', fields: ['path'] },
    { ref: 'v2/UserInput', variant: 'skill', fields: ['name', 'path'] },
    {
      ref: 'v2/ThreadItem',
      variant: 'collabAgentToolCall',
      fields: ['senderThreadId', 'receiverThreadIds'],
    },
    { ref: 'v2/ThreadItem', variant: 'subAgentActivity', fields: ['agentThreadId', 'agentPath'] },
    { ref: 'v2/SkillsListEntry', fields: ['skills'] },
    { ref: 'v2/ThreadItem', variant: 'plan', fields: ['id', 'text'] },
    {
      ref: 'ToolRequestUserInputQuestion',
      fields: ['id', 'header', 'question', 'isOther', 'isSecret', 'options'],
    },
    { ref: 'ToolRequestUserInputOption', fields: ['label', 'description'] },
    { ref: 'ToolRequestUserInputAnswer', fields: ['answers'] },
    { ref: 'v2/TurnPlanStep', fields: ['step', 'status'] },
    { ref: 'v2/TurnPlanStepStatus', values: ['pending', 'inProgress', 'completed'] },
    { ref: 'v2/CollaborationMode', fields: ['mode', 'settings'] },
    { ref: 'v2/ModeKind', values: ['plan', 'default'] },
    { ref: 'v2/Settings', fields: ['model', 'reasoning_effort', 'developer_instructions'] },
    { ref: 'v2/SkillMetadata', fields: ['name', 'path', 'enabled'] },
    { ref: 'v2/TurnError', fields: ['message', 'codexErrorInfo'] },
    { ref: 'CommandExecutionApprovalDecision', values: ['accept', 'decline'] },
    { ref: 'FileChangeApprovalDecision', values: ['accept', 'decline'] },
    { ref: 'McpServerElicitationAction', values: ['accept', 'decline'] },
    { ref: 'PermissionGrantScope', values: ['turn'] },
    { ref: 'CommandExecutionApprovalKind', values: ['command', 'writeStdin'] },
    { ref: 'NetworkApprovalContext', fields: ['host', 'protocol'] },
    { ref: 'v2/ThreadItem', variant: 'fileChange', fields: ['id', 'changes'] },
    { ref: 'v2/FileUpdateChange', fields: ['path', 'kind', 'diff'] },
    { ref: 'v2/PatchChangeKind', variant: 'update', fields: ['move_path'] },
    { ref: 'v2/RequestPermissionProfile', fields: ['network', 'fileSystem'] },
    { ref: 'v2/AdditionalFileSystemPermissions', fields: ['read', 'write', 'entries'] },
    { ref: 'v2/AdditionalNetworkPermissions', fields: ['enabled'] },
    { ref: 'v2/ApprovalsReviewer', values: ['user', 'auto_review', 'guardian_subagent'] },
    { ref: 'v2/AskForApproval', values: ['never'] },
  ],
};
