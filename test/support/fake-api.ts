/**
 * An in-process fake of the buildIt.Social agent API, for tests and the
 * local smoke scripts. It holds made-up data and never talks to a real
 * server.
 *
 * It is built on the generated contract (src/api/generated/):
 * - routes come from the contract's operations (method and path);
 * - each request's query and body are checked against the contract's exact
 *   schemas, so a tool that sends something the API would refuse fails its
 *   test, and the mismatch is recorded in `violations`;
 * - each response is checked against the contract's exact schema before it
 *   is sent, so the fake can't drift from the contract either;
 * - scope checks follow the contract's x-buildit-scope and implications;
 * - errors use the contract's codes, statuses and details.
 *
 * The data model is small but stateful (projects with a workflow, items,
 * comments, links, history, sprints, releases, channels with messages and
 * pages, and plans with their expiry, single use and staleness), so tools
 * can be tested end to end. `compat` makes it answer like an older API
 * (no error hints, no transition moves, no members route). Tests can
 * reach into `store` to add hostile content, `enqueue` scripts the next
 * answer for a path, and `serveExample` answers an operation with the
 * contract's own example.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  ERROR_HINTS,
  ERROR_STATUS,
  OPERATIONS,
  PLAN_SCOPES,
  type ErrorCode,
  type OperationId,
} from '../../src/api/generated/operations.js';
import {
  ErrorSchema,
  QUERY_SCHEMAS,
  REQUEST_SCHEMAS,
  RESPONSE_SCHEMAS,
  type Comment,
  type CustomFieldValue,
  type DescribeProjectResponse,
  type HistoryEvent,
  type ItemDetail,
  type ItemSearchResult,
  type ItemSummary,
  type Link,
  type MeResponse,
  type Message,
  type Page,
  type PageSummary,
  type PlanEffect,
  type ProjectSummary,
  type Release,
  type Sprint,
  type User,
  type WorkflowStatus,
} from '../../src/api/generated/strict.js';
import { expandScopes } from '../../src/toolsets/toolsets.js';

// ---------------------------------------------------------------------------
// Identities and tokens
// ---------------------------------------------------------------------------

/** A uuid made from a number, like the contract's examples. */
export const uid = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

export type FakeIdentity = MeResponse;

export interface RecordedRequest {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface ScriptedResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Wait this long before answering (for timeout tests). */
  delayMs?: number;
}

/** Test tokens. Made up; they only work against this fake. */
export const TOKENS = {
  full: 'buildit_pat_test_full_access',
  read: 'buildit_pat_test_read_only',
  none: 'buildit_pat_test_no_scopes',
  unknown: 'buildit_pat_test_not_issued',
} as const;

export const USERS = {
  me: { id: uid(1), display_name: 'Test User', email: 'test.user@example.com' },
  sam: { id: uid(2), display_name: 'Sam Example', email: 'sam@example.com' },
  alexOne: { id: uid(3), display_name: 'Alex Example', email: 'alex.one@example.com' },
  alexTwo: { id: uid(4), display_name: 'Alex Example', email: 'alex.two@example.com' },
} satisfies Record<string, User>;

const PROJECT_IDS = { DEMO: uid(10), OPS: uid(11) } as const;

export function sampleIdentity(
  scopes: string[],
  overrides: Partial<FakeIdentity> = {},
): FakeIdentity {
  return {
    user: { ...USERS.me },
    org: { id: uid(5), name: 'Example Org' },
    token: {
      id: uid(6),
      name: 'Test token',
      scopes: scopes as FakeIdentity['token']['scopes'],
      expires_at: '2030-01-01T00:00:00Z',
      created_at: '2026-10-01T00:00:00Z',
      limits: { projects: null, channels: null },
    },
    features: { projects: true },
    projects: [
      { id: PROJECT_IDS.DEMO, key: 'DEMO', name: 'Demo project' },
      { id: PROJECT_IDS.OPS, key: 'OPS', name: 'Operations' },
    ],
    rate_limits: {
      requests_per_minute: 120,
      writes_per_minute: 30,
      writes_per_day: 1000,
      org_requests_per_minute: 600,
    },
    ...overrides,
  };
}

export const DEFAULT_IDENTITIES: Record<string, FakeIdentity> = {
  [TOKENS.full]: sampleIdentity([
    'projects:write',
    'projects:delete',
    'projects:admin',
    'pages:write',
    'chat:read',
  ]),
  [TOKENS.read]: sampleIdentity(['projects:read']),
  [TOKENS.none]: sampleIdentity([]),
};

// ---------------------------------------------------------------------------
// The data model
// ---------------------------------------------------------------------------

interface FakeStatus {
  id: string;
  name: string;
  category: 'not_started' | 'started' | 'done' | 'canceled';
  initial?: boolean;
  /** Moves allowed from here: the status name and the fields the move requires. */
  allowed: { to: string; required_fields: string[] }[];
}

interface FakeType {
  id: string;
  name: string;
  level: 'epic' | 'standard' | 'subtask';
}

export interface FakeProject {
  id: string;
  key: string;
  name: string;
  members: string[];
  adminIds: string[];
  types: FakeType[];
  statuses: FakeStatus[];
  labels: { id: string; name: string }[];
  fields: { id: string; name: string; options: string[]; archived?: boolean }[];
  sprints: FakeSprint[];
  releases: FakeRelease[];
  estimateValues: number[];
  channelId: string;
  workflowId: string;
  /** false: any move between statuses, with the rules of `allowed`. Default true. */
  restrictTransitions?: boolean;
}

export interface FakeSprint {
  id: string;
  number: number;
  name: string;
  goal: string | null;
  state: 'planned' | 'active' | 'completed';
  startsOn: string | null;
  endsOn: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface FakeRelease {
  id: string;
  name: string;
  description: string | null;
  status: 'unreleased' | 'released' | 'archived';
  startDate: string | null;
  targetDate: string | null;
  releasedAt: string | null;
  notesPageId: string | null;
  /** The notes page's version when it was last generated. */
  notesVersion?: number;
}

export interface FakeChannel {
  id: string;
  name: string;
  description: string | null;
  visibility: 'public' | 'private';
  isOrgWide: boolean;
  isArchived: boolean;
  projectKey: string | null;
  memberIds: string[];
  /** Direct messages are never served. */
  direct: boolean;
}

export interface FakeMessage {
  id: string;
  channelId: string;
  authorId: string;
  body: string;
  /** The thread's root, for a reply. */
  parentId: string | null;
  createdAt: string;
  deleted: boolean;
  viaAgent: string | null;
}

export interface FakePage {
  id: string;
  channelId: string;
  title: string;
  body: string;
  parentId: string | null;
  position: number;
  isHome: boolean;
  version: number;
  createdAt: string;
  createdById: string;
  updatedAt: string;
  updatedById: string;
  viaAgent: string | null;
}

export interface FakePlan {
  handle: string;
  /** The token that proposed it; another token's handle reads as expired. */
  token: string;
  action: string;
  args: Record<string, unknown>;
  preview: { summary: string; effects: PlanEffect[]; item_count: number; warnings: string[] };
  expiresAt: number;
  usedAt: string | null;
  /** Item versions when proposed, to refuse a stale apply. */
  versions: Record<string, number>;
}

export interface FakeItem {
  id: string;
  project: string;
  number: number;
  typeId: string;
  statusId: string;
  title: string;
  description: string;
  descriptionVersion: number;
  version: number;
  priority: 'none' | 'low' | 'medium' | 'high' | 'urgent';
  assigneeId: string | null;
  reporterId: string;
  parentId: string | null;
  labels: string[];
  estimate: number | null;
  startDate: string | null;
  dueDate: string | null;
  sprintId: string | null;
  releaseId: string | null;
  order: number;
  custom: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface FakeComment {
  id: string;
  itemId: string;
  authorId: string;
  body: string;
  mentionIds: string[];
  createdAt: string;
  viaAgent: string | null;
}

export interface FakeLink {
  id: string;
  fromId: string;
  toId: string;
  kind: 'blocks' | 'relates' | 'duplicates';
}

export interface FakeStore {
  users: User[];
  projects: FakeProject[];
  items: FakeItem[];
  comments: FakeComment[];
  links: FakeLink[];
  events: (HistoryEvent & { itemId: string })[];
  channels: FakeChannel[];
  messages: FakeMessage[];
  pages: FakePage[];
  plans: FakePlan[];
}

let idCounter = 1000;
const nextId = (): string => uid(idCounter++);

function projectConfig(key: 'DEMO' | 'OPS', name: string, members: string[]): FakeProject {
  const base = key === 'DEMO' ? 100 : 200;
  const s = (n: number) => uid(base + n);
  return {
    id: PROJECT_IDS[key],
    key,
    name,
    members,
    adminIds: [USERS.me.id],
    types: [
      { id: s(1), name: 'Epic', level: 'epic' },
      { id: s(2), name: 'Story', level: 'standard' },
      { id: s(3), name: 'Bug', level: 'standard' },
      { id: s(4), name: 'Task', level: 'standard' },
      { id: s(5), name: 'Subtask', level: 'subtask' },
    ],
    statuses: [
      {
        id: s(11),
        name: 'To do',
        category: 'not_started',
        initial: true,
        allowed: [
          { to: 'In progress', required_fields: [] },
          { to: 'Canceled', required_fields: [] },
        ],
      },
      {
        id: s(12),
        name: 'In progress',
        category: 'started',
        allowed: [
          { to: 'In review', required_fields: [] },
          { to: 'To do', required_fields: [] },
        ],
      },
      {
        id: s(13),
        name: 'In review',
        category: 'started',
        allowed: [
          { to: 'Done', required_fields: ['assignee'] },
          { to: 'In progress', required_fields: [] },
        ],
      },
      {
        id: s(14),
        name: 'Done',
        category: 'done',
        allowed: [{ to: 'In progress', required_fields: [] }],
      },
      {
        id: s(15),
        name: 'Canceled',
        category: 'canceled',
        allowed: [{ to: 'To do', required_fields: [] }],
      },
    ],
    labels: [
      { id: s(21), name: 'backend' },
      { id: s(22), name: 'frontend' },
      { id: s(23), name: 'docs' },
    ],
    fields: [{ id: s(31), name: 'Severity', options: ['High', 'Low'] }],
    sprints: [
      {
        id: s(41),
        number: 3,
        name: 'Sprint 3',
        goal: 'Ship agent access',
        state: 'active',
        startsOn: '2026-10-01',
        endsOn: '2026-10-14',
        startedAt: '2026-10-01T09:00:00Z',
        completedAt: null,
      },
    ],
    releases: [
      {
        id: s(51),
        name: '1.0.1',
        description: 'Fixes for the first release.',
        status: 'unreleased',
        startDate: null,
        targetDate: '2026-10-31',
        releasedAt: null,
        notesPageId: null,
      },
    ],
    estimateValues: [1, 2, 3, 5, 8],
    channelId: uid(Number.parseInt(PROJECT_IDS[key].slice(-4), 16) + 50),
    workflowId: uid(Number.parseInt(PROJECT_IDS[key].slice(-4), 16) + 60),
  };
}

/** Channel, page and message ids of the seed. */
export const CHANNELS = {
  demo: uid(60),
  ops: uid(61),
  general: uid(62),
  secret: uid(63),
  dm: uid(64),
};
export const PAGES = { home: uid(8001), spec: uid(8002) };
export const MESSAGES = { root: uid(9001), reply: uid(9002), other: uid(9003) };

const T0 = '2026-10-01T09:00:00Z';

/**
 * The seed data: two projects; in DEMO an epic (DEMO-12) with two stories
 * (DEMO-42 in progress, DEMO-43 blocked by it), a bug in review (DEMO-44,
 * unassigned), a done task, a subtask, and a backlog of 30 items to page
 * through.
 */
export function seedStore(): FakeStore {
  const demo = projectConfig('DEMO', 'Demo project', [
    USERS.me.id,
    USERS.sam.id,
    USERS.alexOne.id,
    USERS.alexTwo.id,
  ]);
  const ops = projectConfig('OPS', 'Operations', [USERS.me.id]);
  const items: FakeItem[] = [];
  const type = (p: FakeProject, name: string) => p.types.find((t) => t.name === name)!.id;
  const status = (p: FakeProject, name: string) => p.statuses.find((t) => t.name === name)!.id;
  let order = 0;
  const add = (p: FakeProject, number: number, init: Partial<FakeItem> & { title: string }) => {
    const item: FakeItem = {
      id: uid(5000 + items.length),
      project: p.key,
      number,
      typeId: type(p, 'Story'),
      statusId: status(p, 'To do'),
      description: '',
      descriptionVersion: 1,
      version: 1,
      priority: 'none',
      assigneeId: null,
      reporterId: USERS.me.id,
      parentId: null,
      labels: [],
      estimate: null,
      startDate: null,
      dueDate: null,
      sprintId: null,
      releaseId: null,
      order: (order += 1000),
      custom: {},
      createdAt: T0,
      updatedAt: T0,
      ...init,
    };
    items.push(item);
    return item;
  };
  const epic = add(demo, 12, {
    title: 'Agent access',
    typeId: type(demo, 'Epic'),
    statusId: status(demo, 'In progress'),
    assigneeId: USERS.me.id,
    description: 'Let agents work with projects through a token.',
  });
  const story = add(demo, 42, {
    title: 'Share notices on Windows',
    statusId: status(demo, 'In progress'),
    priority: 'high',
    assigneeId: USERS.me.id,
    parentId: epic.id,
    labels: ['backend'],
    estimate: 3,
    dueDate: '2026-10-20',
    sprintId: demo.sprints[0]!.id,
    description: `Show a notice when a share ends.\n\ncc [@Sam Example](mention:${USERS.sam.id})`,
    descriptionVersion: 2,
    version: 7,
    custom: { Severity: 'High' },
    updatedAt: '2026-10-07T14:03:00Z',
  });
  const release = add(demo, 43, { title: 'Release 1.0.1', parentId: epic.id });
  add(demo, 44, {
    title: 'Crash on start',
    typeId: type(demo, 'Bug'),
    statusId: status(demo, 'In review'),
    labels: ['backend'],
    priority: 'urgent',
    releaseId: demo.releases[0]!.id,
  });
  add(demo, 45, {
    title: 'Write the docs',
    typeId: type(demo, 'Task'),
    statusId: status(demo, 'Done'),
  });
  add(demo, 46, {
    title: 'Add a tray notice',
    typeId: type(demo, 'Subtask'),
    parentId: story.id,
  });
  for (let n = 100; n < 130; n++) add(demo, n, { title: `Backlog item ${n}` });
  add(ops, 1, { title: 'Rotate the keys', assigneeId: USERS.me.id });

  return {
    users: Object.values(USERS).map((u) => ({ ...u })),
    projects: [demo, ops],
    items,
    comments: [
      {
        id: uid(6001),
        itemId: story.id,
        authorId: USERS.sam.id,
        body: 'Reproduced on Windows 11.',
        mentionIds: [],
        createdAt: '2026-10-05T10:00:00Z',
        viaAgent: null,
      },
      {
        id: uid(6002),
        itemId: story.id,
        authorId: USERS.me.id,
        body: 'Fixed in 4f2c1a9. @Sam Example can you check on Windows?',
        mentionIds: [USERS.sam.id],
        createdAt: '2026-10-07T14:03:00Z',
        viaAgent: 'Test token',
      },
    ],
    links: [{ id: uid(7001), fromId: story.id, toId: release.id, kind: 'blocks' }],
    events: [
      {
        itemId: story.id,
        id: 1,
        at: '2026-10-02T10:00:00Z',
        actor: { ...USERS.me },
        via_agent: null,
        kind: 'changed',
        field: 'status',
        old: status(demo, 'To do'),
        new: status(demo, 'In progress'),
        old_label: 'To do',
        new_label: 'In progress',
      },
    ],
    channels: [
      {
        id: CHANNELS.demo,
        name: 'Demo project',
        description: 'Where the demo project is discussed.',
        visibility: 'public',
        isOrgWide: false,
        isArchived: false,
        projectKey: 'DEMO',
        memberIds: demo.members,
        direct: false,
      },
      {
        id: CHANNELS.ops,
        name: 'Operations',
        description: null,
        visibility: 'private',
        isOrgWide: false,
        isArchived: false,
        projectKey: 'OPS',
        memberIds: ops.members,
        direct: false,
      },
      {
        id: CHANNELS.general,
        name: 'general',
        description: 'Everyone in the org.',
        visibility: 'public',
        isOrgWide: true,
        isArchived: false,
        projectKey: null,
        memberIds: Object.values(USERS).map((u) => u.id),
        direct: false,
      },
      {
        id: CHANNELS.secret,
        name: 'leadership',
        description: null,
        visibility: 'private',
        isOrgWide: false,
        isArchived: false,
        projectKey: null,
        memberIds: [USERS.sam.id],
        direct: false,
      },
      {
        id: CHANNELS.dm,
        name: 'Sam Example',
        description: null,
        visibility: 'private',
        isOrgWide: false,
        isArchived: false,
        projectKey: null,
        memberIds: [USERS.me.id, USERS.sam.id],
        direct: true,
      },
    ],
    messages: [
      {
        id: MESSAGES.root,
        channelId: CHANNELS.general,
        authorId: USERS.sam.id,
        body: 'Release 1.0.1 goes out on Friday. Any blockers?',
        parentId: null,
        createdAt: '2026-10-06T09:00:00Z',
        deleted: false,
        viaAgent: null,
      },
      {
        id: MESSAGES.reply,
        channelId: CHANNELS.general,
        authorId: USERS.me.id,
        body: 'DEMO-44 still needs a review.',
        parentId: MESSAGES.root,
        createdAt: '2026-10-06T09:30:00Z',
        deleted: false,
        viaAgent: null,
      },
      {
        id: MESSAGES.other,
        channelId: CHANNELS.general,
        authorId: USERS.alexOne.id,
        body: 'Standup moves to 10:00 tomorrow.',
        parentId: null,
        createdAt: '2026-10-07T08:00:00Z',
        deleted: false,
        viaAgent: null,
      },
      {
        id: uid(9004),
        channelId: CHANNELS.dm,
        authorId: USERS.sam.id,
        body: 'A direct message, never served.',
        parentId: null,
        createdAt: '2026-10-07T08:30:00Z',
        deleted: false,
        viaAgent: null,
      },
    ],
    pages: [
      {
        id: PAGES.home,
        channelId: CHANNELS.demo,
        title: 'Home',
        body: '# Demo project\n\nStart here.',
        parentId: null,
        position: 0,
        isHome: true,
        version: 3,
        createdAt: T0,
        createdById: USERS.me.id,
        updatedAt: '2026-10-05T12:00:00Z',
        updatedById: USERS.sam.id,
        viaAgent: null,
      },
      {
        id: PAGES.spec,
        channelId: CHANNELS.demo,
        title: 'Agent access spec',
        body: '## Goals\n\n- Tokens per person\n- Preview, then confirm',
        parentId: PAGES.home,
        position: 0,
        isHome: false,
        version: 1,
        createdAt: T0,
        createdById: USERS.me.id,
        updatedAt: T0,
        updatedById: USERS.me.id,
        viaAgent: null,
      },
    ],
    plans: [],
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class FakeError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly details: Record<string, unknown> = {},
    message?: string,
  ) {
    super(message ?? `The fake API refused the call (${code}).`);
  }
}

function errorBody(
  code: string,
  message: string,
  details: unknown = {},
  hint: string | undefined = (ERROR_HINTS as Record<string, string | undefined>)[code],
): unknown {
  return { error: { code, message, ...(hint === undefined ? {} : { hint }), details } };
}

// ---------------------------------------------------------------------------
// The fake
// ---------------------------------------------------------------------------

interface Route {
  id: OperationId;
  method: string;
  pattern: RegExp;
  params: readonly string[];
}

const ROUTES: Route[] = (Object.keys(OPERATIONS) as OperationId[]).map((id) => {
  const op = OPERATIONS[id];
  const pattern = new RegExp(`^${op.path.replace(/\{\w+\}/g, '([^/]+)')}$`);
  return { id, method: op.method, pattern, params: op.pathParams };
});

interface Handled {
  status: number;
  body: unknown;
}

interface Call {
  identity: FakeIdentity;
  /** The bearer token, which plans are bound to. */
  token: string;
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: Record<string, unknown>;
}

/** The contract's mention syntax: @email and @[Display Name]. */
const MENTION_EMAIL_RE = /(^|[^\w@.])@([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const MENTION_NAME_RE = /(^|[^\w@])@\[([^\][\r\n]{1,100})\]/g;

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}

function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string') return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      o?: unknown;
    };
    if (typeof parsed.o === 'number') return parsed.o;
  } catch {
    // Falls through to the error.
  }
  throw new FakeError('validation', {
    fields: [{ path: 'cursor', message: 'Not a cursor of this query.' }],
  });
}

const lower = (s: string): string => s.toLowerCase();

/** The item fields as the API names them, mapped to the fake's own, for history. */
const HISTORY_FIELDS: Record<string, keyof FakeItem> = {
  title: 'title',
  description: 'description',
  type: 'typeId',
  parent: 'parentId',
  assignee: 'assigneeId',
  priority: 'priority',
  labels: 'labels',
  add_labels: 'labels',
  remove_labels: 'labels',
  estimate: 'estimate',
  start_date: 'startDate',
  due_date: 'dueDate',
  sprint: 'sprintId',
  fix_release: 'releaseId',
  custom: 'custom',
};

interface Example {
  paths: Record<
    string,
    Record<
      string,
      { responses: Record<string, { content?: Record<string, { example?: unknown }> }> }
    >
  >;
}

export class FakeApi {
  readonly requests: RecordedRequest[] = [];
  /** Requests or responses that broke the contract's exact schemas. Tests expect it empty. */
  readonly violations: string[] = [];
  identities: Record<string, FakeIdentity>;
  meta: Record<string, unknown> = {
    api_version: '1.0.0',
    min_mcp_version: '0.1.0',
    deprecations: [],
  };
  store: FakeStore = seedStore();
  private readonly queues = new Map<string, ScriptedResponse[]>();
  private readonly examples = new Set<OperationId>();
  private server: Server | undefined;
  private baseUrl = '';
  private clock = Date.parse('2026-10-07T15:00:00Z');
  /** Answer like an older API: without error hints, transition moves or the members route. */
  compat = { hints: true, moves: true, membersRoute: true };

  private readonly initialIdentities: Record<string, FakeIdentity>;

  constructor(identities: Record<string, FakeIdentity> = DEFAULT_IDENTITIES) {
    this.initialIdentities = structuredClone(identities);
    this.identities = structuredClone(identities);
  }

  /** The base URL to use as BUILDIT_API_URL. */
  get url(): string {
    return this.baseUrl;
  }

  /** Restores the seed data and the identities, and forgets requests, scripts, examples and violations. */
  reset(): void {
    this.store = seedStore();
    this.identities = structuredClone(this.initialIdentities);
    this.compat = { hints: true, moves: true, membersRoute: true };
    this.requests.length = 0;
    this.violations.length = 0;
    this.queues.clear();
    this.examples.clear();
  }

  /** Answer the next request to `path` with `response` instead of the normal behaviour. */
  enqueue(path: string, ...responses: ScriptedResponse[]): void {
    const queue = this.queues.get(path) ?? [];
    queue.push(...responses);
    this.queues.set(path, queue);
  }

  /**
   * Answer the next request to `path` with the API error `code`, its status
   * from the contract, and `details`. The body is checked against the
   * contract's error schema like the fake's own errors.
   */
  enqueueError(
    path: string,
    code: ErrorCode,
    details: Record<string, unknown> = {},
    options: { message?: string; headers?: Record<string, string> } = {},
  ): void {
    const body = errorBody(
      code,
      options.message ?? `The fake API refused the call (${code}).`,
      details,
    );
    const checked = ErrorSchema.safeParse(body);
    if (!checked.success) {
      this.violations.push(
        `scripted error ${code}: ${JSON.stringify(checked.error.issues.slice(0, 3))}`,
      );
    }
    this.enqueue(path, {
      status: ERROR_STATUS[code],
      body,
      ...(options.headers ? { headers: options.headers } : {}),
    });
  }

  /** How many requests reached `path` (for example /v1/me). */
  count(path: string): number {
    return this.requests.filter((r) => r.path === path).length;
  }

  /** Answer every call of `id` with the contract's own example response. */
  serveExample(id: OperationId): void {
    this.examples.add(id);
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}/functions/v1/agent-api`;
    return this;
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      server.closeAllConnections();
    });
  }

  private send(res: ServerResponse, response: ScriptedResponse): void {
    const body = response.body === undefined ? '' : JSON.stringify(response.body);
    res.writeHead(response.status, {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...response.headers,
    });
    res.end(body);
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }

  /** Moves the fake's clock forward (to expire plans). */
  advance(ms: number): void {
    this.clock += ms;
  }

  private now(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake');
    const prefix = '/functions/v1/agent-api';
    const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
    const method = req.method ?? 'GET';
    const raw = await this.readBody(req);
    let body: unknown = undefined;
    let badJson = false;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw) as unknown;
      } catch {
        badJson = true;
      }
    }
    this.requests.push({ method, path, query: url.search, headers: { ...req.headers }, body });

    const scripted = this.queues.get(path)?.shift();
    if (scripted) {
      if (scripted.delayMs) await new Promise((r) => setTimeout(r, scripted.delayMs));
      if (!res.destroyed) this.send(res, scripted);
      return;
    }
    if (badJson) {
      this.send(res, { status: 400, body: errorBody('bad_request', 'The body is not JSON.') });
      return;
    }

    if (method === 'GET' && path === '/v1/meta') {
      this.send(res, { status: 200, body: this.meta });
      return;
    }

    const auth = req.headers.authorization ?? '';
    const token = /^Bearer (.+)$/.exec(auth)?.[1];
    const identity = token === undefined ? undefined : this.identities[token];
    if (!identity) {
      this.send(res, {
        status: 401,
        body: errorBody('token_invalid', 'The token is missing, malformed or unknown.'),
      });
      return;
    }

    const matches = ROUTES.map((r) => ({ r, m: r.pattern.exec(path) })).filter(
      (x): x is { r: Route; m: RegExpExecArray } => x.m !== null,
    );
    const match = matches.find((x) => x.r.method === method);
    if (!match) {
      if (matches.length > 0) {
        this.send(res, {
          status: 405,
          body: errorBody('method_not_allowed', 'This path does not take that method.', {
            allowed: matches.map((x) => x.r.method),
          }),
        });
      } else {
        this.send(res, {
          status: 404,
          body: errorBody('not_found', `No route for ${method} ${path}.`, {
            kind: 'route',
            ref: path,
          }),
        });
      }
      return;
    }
    const route = match.r;
    const params: Record<string, string> = {};
    route.params.forEach((name, i) => {
      params[name] = decodeURIComponent(match.m[i + 1] ?? '');
    });

    try {
      const op = OPERATIONS[route.id];
      if (route.id === 'list_project_members' && !this.compat.membersRoute) {
        this.send(res, {
          status: 404,
          body: errorBody('not_found', `No route for ${method} ${path}.`, {
            kind: 'route',
            ref: path,
          }),
        });
        return;
      }
      if (op.scope !== 'plan_action') this.checkScopes(op.requiredScopes, identity);
      if (op.hints.needs_projects && !identity.features.projects) {
        throw new FakeError('projects_off');
      }

      const query = this.parseQuery(route.id, url.searchParams);
      const requestSchema = REQUEST_SCHEMAS[route.id];
      let parsedBody: Record<string, unknown> = {};
      if (requestSchema !== null) {
        const checked = requestSchema.safeParse(body ?? {});
        if (!checked.success) {
          this.violations.push(
            `${route.id} request: ${JSON.stringify(checked.error.issues.slice(0, 3))}`,
          );
          throw new FakeError('validation', {
            fields: checked.error.issues.slice(0, 20).map((i) => ({
              path: i.path.join('.') || '(body)',
              message: i.message,
            })),
          });
        }
        parsedBody = checked.data;
      }

      const handled = this.examples.has(route.id)
        ? this.example(route.id)
        : this.dispatch(route.id, {
            identity,
            token: token ?? '',
            params,
            query,
            body: parsedBody,
          });

      const checked = RESPONSE_SCHEMAS[route.id].safeParse(handled.body);
      if (!checked.success) {
        this.violations.push(
          `${route.id} response: ${JSON.stringify(checked.error.issues.slice(0, 3))}`,
        );
        this.send(res, {
          status: 500,
          body: errorBody('internal', 'The fake broke the contract.'),
        });
        return;
      }
      this.send(res, { status: handled.status, body: handled.body });
    } catch (err) {
      if (err instanceof FakeError) {
        const errBody = errorBody(
          err.code,
          err.message,
          err.details,
          this.compat.hints ? undefined : '',
        ) as { error: { hint?: string } };
        if (!this.compat.hints) delete errBody.error.hint;
        const checkedError = ErrorSchema.safeParse(errBody);
        if (!checkedError.success) {
          this.violations.push(
            `${route.id} error ${err.code}: ${JSON.stringify(checkedError.error.issues.slice(0, 3))}`,
          );
        }
        this.send(res, { status: ERROR_STATUS[err.code], body: errBody });
        return;
      }
      this.violations.push(`${route.id} crashed: ${String(err)}`);
      this.send(res, { status: 500, body: errorBody('internal', 'The fake crashed.') });
    }
  }

  private parseQuery(id: OperationId, search: URLSearchParams): Record<string, unknown> {
    const arrays = new Set<string>(OPERATIONS[id].arrayQueryParams);
    const raw: Record<string, unknown> = {};
    for (const key of new Set(search.keys())) {
      raw[key] = arrays.has(key) ? search.getAll(key) : search.get(key);
    }
    const checked = QUERY_SCHEMAS[id].safeParse(raw);
    if (!checked.success) {
      this.violations.push(`${id} query: ${JSON.stringify(checked.error.issues.slice(0, 3))}`);
      throw new FakeError('validation', {
        fields: checked.error.issues.slice(0, 20).map((i) => ({
          path: i.path.join('.') || '(query)',
          message: i.message,
        })),
      });
    }
    return checked.data;
  }

  private example(id: OperationId): Handled {
    const doc = JSON.parse(
      readFileSync(new URL('../../openapi/openapi.json', import.meta.url), 'utf8'),
    ) as Example;
    const op = OPERATIONS[id];
    const responses = doc.paths[op.path]?.[op.method.toLowerCase()]?.responses ?? {};
    for (const status of op.statuses) {
      const example = responses[String(status)]?.content?.['application/json']?.example;
      if (example !== undefined) return { status, body: example };
    }
    throw new Error(`no example for ${id}`);
  }

  // -------------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------------

  private user(id: string): User {
    const u = this.store.users.find((x) => x.id === id);
    if (!u) throw new Error(`no user ${id}`);
    return u;
  }

  private project(ref: string, identity: FakeIdentity): FakeProject {
    const p = this.store.projects.find((x) => lower(x.key) === lower(ref) || x.id === ref);
    if (!p) throw new FakeError('not_found', { kind: 'project', ref });
    const limited = identity.token.limits.projects;
    if (limited && !limited.some((l) => l.id === p.id)) {
      throw new FakeError('outside_limits', { kind: 'project', ref });
    }
    return p;
  }

  private projectOf(item: FakeItem): FakeProject {
    return this.store.projects.find((p) => p.key === item.project)!;
  }

  private item(ref: string, identity: FakeIdentity): FakeItem {
    const clean = ref.replace(/^#/, '');
    const m = /^([A-Za-z][A-Za-z0-9]{1,5})-(\d+)$/.exec(clean);
    const item = m
      ? this.store.items.find(
          (i) => lower(i.project) === lower(m[1] ?? '') && i.number === Number(m[2]),
        )
      : this.store.items.find((i) => i.id === lower(clean));
    if (!item) throw new FakeError('not_found', { kind: 'item', ref });
    this.project(item.project, identity);
    return item;
  }

  private resolveUser(ref: string, project: FakeProject, identity: FakeIdentity): string {
    if (lower(ref) === 'me') return identity.user.id;
    const members = project.members.map((id) => this.user(id));
    const byEmail = members.find((u) => u.email !== null && lower(u.email) === lower(ref));
    if (byEmail) return byEmail.id;
    const byId = members.find((u) => u.id === lower(ref));
    if (byId) return byId.id;
    const byName = members.filter((u) => lower(u.display_name) === lower(ref));
    if (byName.length === 1) return byName[0]!.id;
    if (byName.length > 1) {
      throw new FakeError('ambiguous', {
        kind: 'user',
        ref,
        candidates: byName.map((u) => ({ id: u.id, label: u.email ?? u.id })),
      });
    }
    throw new FakeError('not_found', { kind: 'user', ref });
  }

  private status(project: FakeProject, ref: string): FakeStatus {
    const s = project.statuses.find((x) => lower(x.name) === lower(ref) || x.id === ref);
    if (!s) throw new FakeError('not_found', { kind: 'status', ref });
    return s;
  }

  private type(project: FakeProject, ref: string): FakeType {
    const t = project.types.find((x) => lower(x.name) === lower(ref) || x.id === ref);
    if (!t) throw new FakeError('not_found', { kind: 'type', ref });
    return t;
  }

  private label(project: FakeProject, ref: string): string {
    const l = project.labels.find((x) => lower(x.name) === lower(ref));
    if (!l) throw new FakeError('not_found', { kind: 'label', ref });
    return l.name;
  }

  private sprint(project: FakeProject, ref: string): string {
    const s = project.sprints.find(
      (x) =>
        (lower(ref) === 'active' && x.state === 'active') ||
        String(x.number) === ref ||
        lower(x.name) === lower(ref) ||
        x.id === ref,
    );
    if (!s) throw new FakeError('not_found', { kind: 'sprint', ref });
    return s.id;
  }

  private customValues(
    project: FakeProject,
    custom: unknown,
    target: Record<string, string>,
  ): void {
    for (const [name, value] of Object.entries((custom ?? {}) as Record<string, unknown>)) {
      const field = project.fields.find((f) => lower(f.name) === lower(name));
      if (!field) throw new FakeError('not_found', { kind: 'field', ref: name });
      if (value === null) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- a map of field values
        delete target[field.name];
        continue;
      }
      const option = field.options.find(
        (o) => typeof value === 'string' && lower(o) === lower(value),
      );
      if (!option) {
        throw new FakeError('validation', {
          fields: [{ path: `custom.${name}`, message: `Allowed: ${field.options.join(', ')}.` }],
        });
      }
      target[field.name] = option;
    }
  }

  // -------------------------------------------------------------------------
  // Rendering (the contract's shapes)
  // -------------------------------------------------------------------------

  private projectBrief(p: FakeProject) {
    return { id: p.id, key: p.key, name: p.name };
  }

  private statusBrief(s: FakeStatus) {
    return { id: s.id, name: s.name, category: s.category };
  }

  private statusOf(i: FakeItem): FakeStatus {
    return this.projectOf(i).statuses.find((s) => s.id === i.statusId)!;
  }

  private summary(i: FakeItem): ItemSummary {
    const p = this.projectOf(i);
    const t = p.types.find((x) => x.id === i.typeId)!;
    const s = this.statusOf(i);
    const parent = i.parentId ? this.store.items.find((x) => x.id === i.parentId) : undefined;
    const sprint = p.sprints.find((x) => x.id === i.sprintId);
    const release = p.releases.find((x) => x.id === i.releaseId);
    return {
      id: i.id,
      key: `${i.project}-${i.number}`,
      number: i.number,
      project: this.projectBrief(p),
      type: { id: t.id, name: t.name, level: t.level },
      status: this.statusBrief(s),
      title: i.title,
      priority: i.priority,
      assignee: i.assigneeId ? this.user(i.assigneeId) : null,
      reporter: this.user(i.reporterId),
      parent: parent
        ? { id: parent.id, key: `${parent.project}-${parent.number}`, title: parent.title }
        : null,
      initiative: null,
      labels: i.labels.map((name) => {
        const l = p.labels.find((x) => x.name === name)!;
        return { id: l.id, name: l.name, color: null };
      }),
      estimate: i.estimate,
      start_date: i.startDate,
      due_date: i.dueDate,
      sprint: sprint
        ? { id: sprint.id, number: sprint.number, name: sprint.name, state: sprint.state }
        : null,
      fix_release: release ? { id: release.id, name: release.name, status: release.status } : null,
      rank: `a${i.order.toString(36).padStart(8, '0')}`,
      version: i.version,
      description_version: i.descriptionVersion,
      created_at: i.createdAt,
      updated_at: i.updatedAt,
      started_at: null,
      completed_at: s.category === 'done' ? i.updatedAt : null,
      canceled_at: s.category === 'canceled' ? i.updatedAt : null,
    };
  }

  private customOut(i: FakeItem): CustomFieldValue[] {
    const p = this.projectOf(i);
    return Object.entries(i.custom).map(([name, value]) => {
      const f = p.fields.find((x) => x.name === name)!;
      return { field_id: f.id, field: f.name, kind: 'single_select', value };
    });
  }

  private detail(i: FakeItem, full: boolean): ItemDetail {
    const cut = !full && i.description.length > 2000;
    return {
      ...this.summary(i),
      description: cut ? i.description.slice(0, 2000) : i.description,
      description_truncated: cut,
      custom: this.customOut(i),
    };
  }

  private comment(c: FakeComment): Comment {
    return {
      id: c.id,
      author: this.user(c.authorId),
      body: c.body,
      mentions: c.mentionIds.map((id) => this.user(id)),
      created_at: c.createdAt,
      edited_at: null,
      via_agent: c.viaAgent,
    };
  }

  private linkFrom(item: FakeItem, l: FakeLink): Link {
    const outgoing = l.fromId === item.id;
    const other = this.store.items.find((x) => x.id === (outgoing ? l.toId : l.fromId))!;
    const kind: Link['kind'] =
      l.kind === 'relates'
        ? 'relates'
        : outgoing
          ? l.kind
          : l.kind === 'blocks'
            ? 'blocked_by'
            : 'duplicated_by';
    return {
      id: l.id,
      kind,
      item: {
        id: other.id,
        key: `${other.project}-${other.number}`,
        title: other.title,
        status: this.statusBrief(this.statusOf(other)),
      },
    };
  }

  private ordered(items: FakeItem[]): FakeItem[] {
    return [...items].sort((a, b) => a.order - b.order);
  }

  /** One write: the version moves once, and each changed field gets a history event. */
  private recordWrite(
    item: FakeItem,
    identity: FakeIdentity,
    changes: [field: string, old: unknown, value: unknown][],
  ): void {
    item.version += 1;
    item.updatedAt = this.now();
    for (const [field, old, value] of changes) {
      this.store.events.push({
        itemId: item.id,
        id: this.store.events.length + 1,
        at: item.updatedAt,
        actor: identity.user,
        via_agent: identity.token.name,
        kind: 'changed',
        field,
        old: old ?? null,
        new: value ?? null,
        old_label: this.historyLabel(old),
        new_label: this.historyLabel(value),
      });
    }
  }

  /** A history value as people read it: names for ids, lists joined, the rest as text. */
  private historyLabel(value: unknown): string | null {
    if (value === null || value === undefined || value === '') return null;
    if (Array.isArray(value)) return value.length > 0 ? value.map(String).join(',') : null;
    if (typeof value === 'string') {
      const user = this.store.users.find((u) => u.id === value);
      if (user) return user.display_name;
      for (const p of this.store.projects) {
        const named =
          p.statuses.find((x) => x.id === value) ??
          p.types.find((x) => x.id === value) ??
          p.sprints.find((x) => x.id === value) ??
          p.releases.find((x) => x.id === value);
        if (named) return named.name;
      }
      const item = this.store.items.find((i) => i.id === value);
      if (item) return `${item.project}-${item.number}`;
      return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return JSON.stringify(value);
  }

  // -------------------------------------------------------------------------
  // Operations
  // -------------------------------------------------------------------------

  private dispatch(id: OperationId, call: Call): Handled {
    switch (id) {
      case 'get_me':
        return { status: 200, body: call.identity };
      case 'list_projects':
        return this.listProjects(call);
      case 'describe_project':
        return this.describeProject(call);
      case 'search_items':
        return this.searchItems(call);
      case 'get_item':
        return this.getItem(call);
      case 'list_comments':
        return this.listComments(call);
      case 'create_item':
        return this.createItem(call);
      case 'update_item':
        return this.updateItem(call);
      case 'transition_item':
        return this.transitionItem(call);
      case 'add_comment':
        return this.addComment(call);
      case 'add_link':
        return this.addLink(call);
      case 'remove_link':
        return this.removeLink(call);
      case 'rank_item':
        return this.rankItem(call);
      case 'list_project_members':
        return this.listProjectMembers(call);
      case 'list_sprints':
        return this.listSprints(call);
      case 'create_sprint':
        return this.createSprint(call);
      case 'start_sprint':
        return this.startSprint(call);
      case 'complete_sprint':
        return this.completeSprint(call);
      case 'add_sprint_items':
        return this.sprintItems(call, true);
      case 'remove_sprint_items':
        return this.sprintItems(call, false);
      case 'list_releases':
        return this.listReleases(call);
      case 'create_release':
        return this.createRelease(call);
      case 'release_version':
        return this.releaseVersion(call);
      case 'generate_release_notes':
        return this.releaseNotes(call);
      case 'add_release_items':
        return this.releaseItems(call, true);
      case 'remove_release_items':
        return this.releaseItems(call, false);
      case 'list_channels':
        return this.listChannels(call);
      case 'list_channel_messages':
        return this.listChannelMessages(call);
      case 'get_thread':
        return this.getThread(call);
      case 'list_pages':
        return this.listPages(call);
      case 'get_page':
        return this.getPage(call);
      case 'create_page':
        return this.createPage(call);
      case 'update_page':
        return this.updatePage(call);
      case 'get_workflow':
        return this.getWorkflow(call);
      case 'list_work_types':
        return this.listWorkTypes(call);
      case 'create_plan':
        return this.createPlan(call);
      case 'apply_plan':
        return this.applyPlan(call);
      default:
        throw new FakeError(
          'not_found',
          { kind: 'route', ref: id },
          `The fake does not implement ${id}.`,
        );
    }
  }

  private counts(p: FakeProject) {
    const counts = { not_started: 0, started: 0, done: 0, canceled: 0 };
    for (const i of this.store.items.filter((x) => x.project === p.key)) {
      counts[this.statusOf(i).category] += 1;
    }
    return counts;
  }

  private projectSummary(p: FakeProject): ProjectSummary {
    return {
      ...this.projectBrief(p),
      channel: { id: uid(Number.parseInt(p.id.slice(-4), 16) + 50), name: p.name },
      archived: false,
      template_key: 'software',
      sprints_enabled: true,
      releases_enabled: true,
      estimate_scale: 'points',
      item_counts: this.counts(p),
    };
  }

  private listProjects({ identity, query }: Call): Handled {
    const limited = identity.token.limits.projects;
    const projects = this.store.projects.filter(
      (p) => !limited || limited.some((l) => l.id === p.id),
    );
    const offset = decodeCursor(query.cursor);
    const limit = (query.limit as number | undefined) ?? 25;
    const page = projects.slice(offset, offset + limit).map((p) => this.projectSummary(p));
    const next = offset + limit < projects.length ? encodeCursor(offset + limit) : null;
    return { status: 200, body: { items: page, next_cursor: next } };
  }

  /**
   * The moves allowed from a status: its listed ones, or, when the workflow
   * doesn't restrict transitions, every other status (with the listed rules).
   */
  private movesFrom(p: FakeProject, s: FakeStatus): FakeStatus['allowed'] {
    if (p.restrictTransitions !== false) return s.allowed;
    return p.statuses
      .filter((other) => other.id !== s.id)
      .map((other) => ({
        to: other.name,
        required_fields:
          s.allowed.find((a) => lower(a.to) === lower(other.name))?.required_fields ?? [],
      }));
  }

  private describeProject({ identity, params }: Call): Handled {
    const p = this.project(params.key ?? '', identity);
    const workflowId = p.workflowId;
    const statuses: WorkflowStatus[] = p.statuses.map((s, position) => ({
      id: s.id,
      name: s.name,
      system_key: null,
      category: s.category,
      color: null,
      position,
      is_initial: s.initial === true,
      board_column: s.name,
      allowed: this.movesFrom(p, s).map((a) => ({ ...a, admins_only: false })),
    }));
    const body: DescribeProjectResponse = {
      project: {
        ...this.projectSummary(p),
        estimate_values: p.estimateValues,
        time_zone: 'America/Toronto',
        default_type: 'Story',
      },
      types: p.types.map((t) => ({
        id: t.id,
        name: t.name,
        system_key: null,
        level: t.level,
        icon: null,
        color: null,
        workflow: { id: workflowId, name: 'Software' },
      })),
      workflows: [
        {
          id: workflowId,
          name: 'Software',
          system_key: null,
          restrict_transitions: p.restrictTransitions !== false,
          types: p.types.map((t) => t.name),
          statuses,
        },
      ],
      board_columns: p.statuses.map((s, position) => ({
        id: uid(Number.parseInt(s.id.slice(-4), 16) + 3000),
        name: s.name,
        position,
        wip_limit: null,
        statuses: [s.name],
      })),
      labels: p.labels.map((l) => ({ id: l.id, name: l.name, color: null })),
      fields: p.fields.map((f, position) => ({
        id: f.id,
        name: f.name,
        kind: 'single_select',
        options: f.options.map((label, n) => ({ id: `o${n + 1}`, label, color: null })),
        types: null,
        required_on_create: false,
        position,
      })),
      members: p.members.map((id) => ({
        ...this.user(id),
        role: id === USERS.me.id ? 'owner' : 'member',
        is_project_admin: p.adminIds.includes(id),
      })),
    };
    return { status: 200, body };
  }

  private searchItems({ identity, query }: Call): Handled {
    const list = (key: string) => (query[key] as string[] | undefined)?.map(lower);
    const limited = identity.token.limits.projects;
    let items = this.store.items.filter(
      (i) => !limited || limited.some((l) => l.id === this.projectOf(i).id),
    );
    const projects = list('project');
    if (projects) {
      for (const key of projects) this.project(key, identity);
      items = items.filter((i) => projects.includes(lower(i.project)));
    }
    const typeNames = list('type');
    if (typeNames) {
      items = items.filter((i) =>
        typeNames.includes(lower(this.projectOf(i).types.find((t) => t.id === i.typeId)!.name)),
      );
    }
    const statusNames = list('status');
    if (statusNames)
      items = items.filter((i) => statusNames.includes(lower(this.statusOf(i).name)));
    const categories = list('category');
    if (categories) items = items.filter((i) => categories.includes(this.statusOf(i).category));
    const priorities = list('priority');
    if (priorities) items = items.filter((i) => priorities.includes(i.priority));
    const assignees = query.assignee as string[] | undefined;
    if (assignees) {
      items = items.filter((i) =>
        assignees.some((a) =>
          lower(a) === 'none'
            ? i.assigneeId === null
            : i.assigneeId === this.resolveUser(a, this.projectOf(i), identity),
        ),
      );
    }
    const labels = list('label');
    if (labels) items = items.filter((i) => i.labels.some((l) => labels.includes(lower(l))));
    if (typeof query.sprint === 'string') {
      const ref = query.sprint;
      items = items.filter((i) =>
        lower(ref) === 'none'
          ? i.sprintId === null
          : i.sprintId === this.sprint(this.projectOf(i), ref),
      );
    }
    if (typeof query.parent === 'string') {
      const parent = this.item(query.parent, identity);
      items = items.filter((i) => i.parentId === parent.id);
    }
    if (typeof query.updated_since === 'string') {
      const since = Date.parse(query.updated_since);
      items = items.filter((i) => Date.parse(i.updatedAt) > since);
    }
    const full = query.detail === 'full';
    const render = (i: FakeItem): ItemSearchResult => ({
      ...this.summary(i),
      ...(full ? { description: i.description, custom: this.customOut(i) } : {}),
    });

    if (typeof query.q === 'string') {
      const words = lower(query.q).split(/\s+/).filter(Boolean);
      const hits = items
        .filter((i) => {
          const hay = lower(`${i.project}-${i.number} ${i.title} ${i.description}`);
          return words.every((w) => hay.includes(w));
        })
        .slice(0, 50);
      return {
        status: 200,
        body: {
          items: hits.map((i, n) => {
            const at = lower(i.description).indexOf(words[0] ?? '');
            return {
              ...render(i),
              match: {
                score: 1 / (n + 1),
                title_highlight: i.title,
                snippet: at >= 0 ? i.description.slice(Math.max(0, at - 40), at + 80) : null,
              },
            };
          }),
          next_cursor: null,
        },
      };
    }

    const sort = (query.sort as string[] | undefined) ?? ['rank'];
    const sortKey = (i: FakeItem, field: string): string | number => {
      switch (field) {
        case 'number':
          return i.number;
        case 'title':
          return lower(i.title);
        case 'updated_at':
          return i.updatedAt;
        case 'created_at':
          return i.createdAt;
        case 'due_date':
          return i.dueDate ?? '9999';
        case 'estimate':
          return i.estimate ?? -1;
        default:
          return i.order;
      }
    };
    items = [...items].sort((a, b) => {
      for (const s of sort) {
        const desc = s.startsWith('-');
        const field = desc ? s.slice(1) : s;
        const ka = sortKey(a, field);
        const kb = sortKey(b, field);
        if (ka !== kb) return (ka < kb ? -1 : 1) * (desc ? -1 : 1);
      }
      return a.order - b.order;
    });
    const offset = decodeCursor(query.cursor);
    const limit = (query.limit as number | undefined) ?? 25;
    const page = items.slice(offset, offset + limit);
    const next = offset + limit < items.length ? encodeCursor(offset + limit) : null;
    return { status: 200, body: { items: page.map(render), next_cursor: next } };
  }

  private getItem({ identity, params, query }: Call): Handled {
    const item = this.item(params.key ?? '', identity);
    const full = query.detail === 'full';
    const comments = this.store.comments.filter((c) => c.itemId === item.id);
    const latest = comments.slice(-(full ? 20 : 5));
    const older = comments.length - latest.length;
    const history = this.store.events
      .filter((e) => e.itemId === item.id)
      .reverse()
      .slice(0, 50)
      .map(({ itemId: _itemId, ...e }) => e);
    return {
      status: 200,
      body: {
        item: this.detail(item, full),
        children: this.ordered(this.store.items.filter((i) => i.parentId === item.id)).map((i) =>
          this.summary(i),
        ),
        links: this.store.links
          .filter((l) => l.fromId === item.id || l.toId === item.id)
          .map((l) => this.linkFrom(item, l)),
        comments: latest.map((c) => this.comment(c)),
        comments_next_cursor: older > 0 ? encodeCursor(latest.length) : null,
        ...(query.include_history === 'true' ? { history } : {}),
      },
    };
  }

  private listComments({ identity, params, query }: Call): Handled {
    const item = this.item(params.key ?? '', identity);
    let comments = this.store.comments.filter((c) => c.itemId === item.id);
    if (query.order === 'desc') comments = [...comments].reverse();
    const offset = decodeCursor(query.cursor);
    const limit = (query.limit as number | undefined) ?? 25;
    const page = comments.slice(offset, offset + limit);
    const next = offset + limit < comments.length ? encodeCursor(offset + limit) : null;
    return { status: 200, body: { items: page.map((c) => this.comment(c)), next_cursor: next } };
  }

  private createItem({ identity, body }: Call): Handled {
    const b = body as {
      project?: string;
      parent?: string;
      type?: string;
      title: string;
      description?: string;
      status?: string;
      assignee?: string;
      priority?: FakeItem['priority'];
      labels?: string[];
      estimate?: number;
      start_date?: string;
      due_date?: string;
      sprint?: string;
      fix_release?: string;
      custom?: Record<string, unknown>;
      position?: { before?: string; after?: string };
      idempotency_key?: string;
    };
    if (b.idempotency_key) {
      const existing = this.store.items.find((i) => i.id === b.idempotency_key);
      if (existing) {
        return { status: 200, body: { item: this.detail(existing, true), created: false } };
      }
      if (this.store.comments.some((c) => c.id === b.idempotency_key)) {
        throw new FakeError('idempotency_conflict', { idempotency_key: b.idempotency_key });
      }
    }
    const parent = b.parent ? this.item(b.parent, identity) : undefined;
    const p = parent ? this.projectOf(parent) : this.project(b.project ?? '', identity);
    const parentLevel = parent ? p.types.find((t) => t.id === parent.typeId)!.level : undefined;
    const type = b.type
      ? this.type(p, b.type)
      : this.type(p, parentLevel === 'standard' ? 'Subtask' : 'Story');
    const fits =
      parentLevel === undefined ||
      (parentLevel === 'epic' && type.level === 'standard') ||
      (parentLevel === 'standard' && type.level === 'subtask');
    if (!fits) {
      throw new FakeError('validation', {
        fields: [
          {
            path: 'parent',
            message: 'An epic holds standard items; a standard item holds subtasks.',
          },
        ],
      });
    }
    if (b.estimate !== undefined && !p.estimateValues.includes(b.estimate)) {
      throw new FakeError('validation', {
        fields: [{ path: 'estimate', message: `Allowed: ${p.estimateValues.join(', ')}.` }],
      });
    }
    const initial = p.statuses.find((s) => s.initial)!;
    const now = this.now();
    const custom: Record<string, string> = {};
    this.customValues(p, b.custom, custom);
    const projectItems = this.store.items.filter((i) => i.project === p.key);
    const item: FakeItem = {
      id: b.idempotency_key ?? randomUUID(),
      project: p.key,
      number: Math.max(0, ...projectItems.map((i) => i.number)) + 1,
      typeId: type.id,
      statusId: b.status ? this.status(p, b.status).id : initial.id,
      title: b.title.trim(),
      description: b.description ? this.storeMentions(b.description, p, identity) : '',
      descriptionVersion: 1,
      version: 1,
      priority: b.priority ?? 'none',
      assigneeId: b.assignee ? this.resolveUser(b.assignee, p, identity) : null,
      reporterId: identity.user.id,
      parentId: parent?.id ?? null,
      labels: (b.labels ?? []).map((l) => this.label(p, l)),
      estimate: b.estimate ?? null,
      startDate: b.start_date ?? null,
      dueDate: b.due_date ?? null,
      sprintId: b.sprint ? this.sprint(p, b.sprint) : null,
      releaseId: b.fix_release ? this.release(p, b.fix_release).id : null,
      order: Math.max(0, ...this.store.items.map((i) => i.order)) + 1000,
      custom,
      createdAt: now,
      updatedAt: now,
    };
    this.store.items.push(item);
    if (b.position) this.place(item, b.position, identity);
    this.store.events.push({
      itemId: item.id,
      id: this.store.events.length + 1,
      at: now,
      actor: identity.user,
      via_agent: identity.token.name,
      kind: 'created',
      field: null,
      old: null,
      new: null,
      old_label: null,
      new_label: null,
    });
    return { status: 201, body: { item: this.detail(item, true), created: true } };
  }

  /** Descriptions store mentions as [@Name](mention:<uuid>). */
  private storeMentions(text: string, p: FakeProject, identity: FakeIdentity): string {
    const link = (ref: string) => {
      const u = this.user(this.resolveUser(ref, p, identity));
      return `[@${u.display_name}](mention:${u.id})`;
    };
    return text
      .replace(MENTION_EMAIL_RE, (_m, pre: string, email: string) => `${pre}${link(email)}`)
      .replace(MENTION_NAME_RE, (_m, pre: string, name: string) => `${pre}${link(name)}`);
  }

  private checkVersion(item: FakeItem, ifVersion: unknown): void {
    if (typeof ifVersion === 'number' && ifVersion !== item.version) {
      throw new FakeError(
        'conflict',
        {
          kind: 'item',
          current: { version: item.version, description_version: item.descriptionVersion },
        },
        'It changed since you read it.',
      );
    }
  }

  private updateItem({ identity, params, body }: Call): Handled {
    const item = this.item(params.key ?? '', identity);
    const p = this.projectOf(item);
    const b = body;
    this.checkVersion(item, b.if_version);
    const fields = Object.keys(b).filter((k) => k !== 'if_version');
    if (fields.length === 0) {
      throw new FakeError('validation', {
        fields: [{ path: '(body)', message: 'Nothing to change.' }],
      });
    }
    if (b.status !== undefined && b.type === undefined) {
      throw new FakeError('validation', {
        fields: [{ path: 'status', message: 'Change the status with a transition.' }],
      });
    }
    const before: FakeItem = { ...item, labels: [...item.labels], custom: { ...item.custom } };
    if (typeof b.title === 'string') item.title = b.title.trim();
    const d = b.description as
      { mode: 'append' | 'replace'; text: string; description_version?: number } | undefined;
    if (d) {
      if (d.mode === 'replace' && d.description_version !== item.descriptionVersion) {
        throw new FakeError(
          'conflict',
          {
            kind: 'description',
            current: { version: item.version, description_version: item.descriptionVersion },
          },
          'The description changed since you read it.',
        );
      }
      const text = this.storeMentions(d.text, p, identity);
      item.description =
        d.mode === 'append' && item.description ? `${item.description}\n\n${text}` : text;
      item.descriptionVersion += 1;
    }
    if (typeof b.type === 'string') item.typeId = this.type(p, b.type).id;
    if ('parent' in b) {
      item.parentId = b.parent === null ? null : this.item(b.parent as string, identity).id;
    }
    if ('assignee' in b) {
      item.assigneeId =
        b.assignee === null ? null : this.resolveUser(b.assignee as string, p, identity);
    }
    if (typeof b.priority === 'string') item.priority = b.priority as FakeItem['priority'];
    if (Array.isArray(b.labels)) item.labels = (b.labels as string[]).map((l) => this.label(p, l));
    if (Array.isArray(b.add_labels)) {
      for (const l of b.add_labels as string[]) {
        const name = this.label(p, l);
        if (!item.labels.includes(name)) item.labels.push(name);
      }
    }
    if (Array.isArray(b.remove_labels)) {
      const remove = (b.remove_labels as string[]).map((l) => this.label(p, l));
      item.labels = item.labels.filter((l) => !remove.includes(l));
    }
    if ('estimate' in b) {
      if (b.estimate !== null && !p.estimateValues.includes(b.estimate as number)) {
        throw new FakeError('validation', {
          fields: [{ path: 'estimate', message: `Allowed: ${p.estimateValues.join(', ')}.` }],
        });
      }
      item.estimate = b.estimate as number | null;
    }
    if ('start_date' in b) item.startDate = b.start_date as string | null;
    if ('due_date' in b) item.dueDate = b.due_date as string | null;
    if ('sprint' in b)
      item.sprintId = b.sprint === null ? null : this.sprint(p, b.sprint as string);
    if ('fix_release' in b) {
      item.releaseId = b.fix_release === null ? null : this.release(p, b.fix_release as string).id;
    }
    if (b.custom !== undefined) this.customValues(p, b.custom, item.custom);
    this.recordWrite(
      item,
      identity,
      fields.map((f) => {
        const key = HISTORY_FIELDS[f] ?? 'title';
        return [f, before[key], item[key]];
      }),
    );
    return { status: 200, body: { item: this.detail(item, true) } };
  }

  private transitionItem({ identity, params, body }: Call): Handled {
    const item = this.item(params.key ?? '', identity);
    const p = this.projectOf(item);
    const b = body as {
      status: string;
      comment?: string;
      set?: Record<string, unknown>;
      if_version?: number;
    };
    this.checkVersion(item, b.if_version);
    const from = this.statusOf(item);
    const to = this.status(p, b.status);
    if (to.id !== from.id) {
      const moves = this.movesFrom(p, from);
      const move = moves.find((a) => lower(a.to) === lower(to.name));
      if (!move) {
        throw new FakeError(
          'transition_not_allowed',
          {
            from: from.name,
            to: to.name,
            allowed: moves.map((a) => a.to),
            required_fields: [],
            admins_only: false,
            ...(this.compat.moves
              ? {
                  moves: moves.map((a) => ({
                    to: a.to,
                    to_id: this.status(p, a.to).id,
                    required_fields: a.required_fields,
                    admins_only: false,
                  })),
                }
              : {}),
          },
          `${p.key}-${item.number} can't move from ${from.name} to ${to.name}.`,
        );
      }
      const set = b.set ?? {};
      const assignee =
        'assignee' in set
          ? set.assignee === null
            ? null
            : this.resolveUser(set.assignee as string, p, identity)
          : item.assigneeId;
      const missing = move.required_fields.filter((f) => f === 'assignee' && assignee === null);
      if (missing.length > 0) {
        throw new FakeError(
          'field_required',
          { fields: missing },
          `Moving to ${to.name} needs ${missing.join(', ')}.`,
        );
      }
      item.assigneeId = assignee;
      if ('estimate' in set) item.estimate = set.estimate as number | null;
      if ('due_date' in set) item.dueDate = set.due_date as string | null;
      item.statusId = to.id;
      this.recordWrite(item, identity, [['status', from.name, to.name]]);
    }
    let comment: Comment | null = null;
    if (b.comment)
      comment = this.comment(this.postComment(item, b.comment, identity, randomUUID()));
    return { status: 200, body: { item: this.summary(item), comment } };
  }

  private postComment(
    item: FakeItem,
    text: string,
    identity: FakeIdentity,
    id: string,
  ): FakeComment {
    const p = this.projectOf(item);
    const mentionIds: string[] = [];
    const mention = (ref: string) => {
      const u = this.user(this.resolveUser(ref, p, identity));
      if (!mentionIds.includes(u.id)) mentionIds.push(u.id);
      return `@${u.display_name}`;
    };
    const body = text
      .replace(MENTION_EMAIL_RE, (_m, pre: string, email: string) => `${pre}${mention(email)}`)
      .replace(MENTION_NAME_RE, (_m, pre: string, name: string) => `${pre}${mention(name)}`);
    const c: FakeComment = {
      id,
      itemId: item.id,
      authorId: identity.user.id,
      body,
      mentionIds,
      createdAt: this.now(),
      viaAgent: identity.token.name,
    };
    this.store.comments.push(c);
    return c;
  }

  private addComment({ identity, params, body }: Call): Handled {
    const item = this.item(params.key ?? '', identity);
    const b = body as { body: string; idempotency_key?: string };
    if (b.idempotency_key) {
      const existing = this.store.comments.find((c) => c.id === b.idempotency_key);
      if (existing) {
        if (existing.itemId !== item.id) {
          throw new FakeError('idempotency_conflict', { idempotency_key: b.idempotency_key });
        }
        return { status: 200, body: { comment: this.comment(existing), created: false } };
      }
    }
    const c = this.postComment(item, b.body, identity, b.idempotency_key ?? randomUUID());
    return { status: 201, body: { comment: this.comment(c), created: true } };
  }

  private addLink({ identity, params, body }: Call): Handled {
    const item = this.item(params.key ?? '', identity);
    const b = body as { kind: Link['kind']; target: string };
    const target = this.item(b.target, identity);
    if (target.id === item.id) {
      throw new FakeError('validation', {
        fields: [{ path: 'target', message: 'An item cannot link to itself.' }],
      });
    }
    const [fromId, toId, kind]: [string, string, FakeLink['kind']] =
      b.kind === 'blocked_by'
        ? [target.id, item.id, 'blocks']
        : b.kind === 'duplicated_by'
          ? [target.id, item.id, 'duplicates']
          : [item.id, target.id, b.kind];
    const existing = this.store.links.find(
      (l) =>
        l.kind === kind &&
        ((l.fromId === fromId && l.toId === toId) ||
          (kind === 'relates' && l.fromId === toId && l.toId === fromId)),
    );
    if (existing) {
      return { status: 200, body: { link: this.linkFrom(item, existing), created: false } };
    }
    const link: FakeLink = { id: nextId(), fromId, toId, kind };
    this.store.links.push(link);
    return { status: 201, body: { link: this.linkFrom(item, link), created: true } };
  }

  private removeLink({ identity, params }: Call): Handled {
    const item = this.item(params.key ?? '', identity);
    const id = lower(params.id ?? '');
    const index = this.store.links.findIndex(
      (l) => l.id === id && (l.fromId === item.id || l.toId === item.id),
    );
    if (index >= 0) this.store.links.splice(index, 1);
    return { status: 200, body: { id, removed: index >= 0 } };
  }

  private place(
    item: FakeItem,
    position: { before?: string; after?: string },
    identity: FakeIdentity,
  ): void {
    const ref = position.before ?? position.after;
    if (ref === undefined || (position.before !== undefined && position.after !== undefined)) {
      throw new FakeError('validation', {
        fields: [{ path: '(body)', message: 'Give exactly one of before and after.' }],
      });
    }
    const target = this.item(ref, identity);
    if (target.project !== item.project) {
      throw new FakeError('validation', {
        fields: [
          { path: position.before ? 'before' : 'after', message: 'Rank within one project.' },
        ],
      });
    }
    const list = this.ordered(
      this.store.items.filter((i) => i.project === item.project && i.id !== item.id),
    );
    const at = list.findIndex((i) => i.id === target.id) + (position.after ? 1 : 0);
    list.splice(at, 0, item);
    list.forEach((i, n) => {
      i.order = (n + 1) * 1000;
    });
  }

  private rankItem({ identity, params, body }: Call): Handled {
    const item = this.item(params.key ?? '', identity);
    this.place(item, body, identity);
    this.recordWrite(item, identity, [['rank', null, null]]);
    return { status: 200, body: { item: this.summary(item) } };
  }

  // -------------------------------------------------------------------------
  // Members
  // -------------------------------------------------------------------------

  private listProjectMembers({ identity, params, query }: Call): Handled {
    const p = this.project(params.key ?? '', identity);
    const q = typeof query.q === 'string' ? lower(query.q) : undefined;
    const members = p.members
      .map((id) => this.user(id))
      .filter(
        (u) =>
          q === undefined ||
          lower(u.display_name).includes(q) ||
          (u.email !== null && lower(u.email).includes(q)),
      )
      .sort((a, b) =>
        a.display_name === b.display_name
          ? a.id < b.id
            ? -1
            : 1
          : a.display_name < b.display_name
            ? -1
            : 1,
      )
      .map((u) => ({
        ...u,
        role: u.id === USERS.me.id ? ('owner' as const) : ('member' as const),
        is_project_admin: p.adminIds.includes(u.id),
      }));
    return { status: 200, body: this.page(members, query) };
  }

  /** One page of a list, with the fake's offset cursor. */
  private page<T>(
    list: T[],
    query: Record<string, unknown>,
  ): { items: T[]; next_cursor: string | null } {
    const offset = decodeCursor(query.cursor);
    const limit = (query.limit as number | undefined) ?? 25;
    return {
      items: list.slice(offset, offset + limit),
      next_cursor: offset + limit < list.length ? encodeCursor(offset + limit) : null,
    };
  }

  // -------------------------------------------------------------------------
  // Sprints and releases
  // -------------------------------------------------------------------------

  private sprintOf(p: FakeProject, ref: string): FakeSprint {
    const id = this.sprint(p, ref);
    return p.sprints.find((x) => x.id === id)!;
  }

  private release(p: FakeProject, ref: string): FakeRelease {
    const r = p.releases.find((x) => lower(x.name) === lower(ref) || x.id === lower(ref));
    if (!r) throw new FakeError('not_found', { kind: 'release', ref });
    return r;
  }

  private requireAdmin(p: FakeProject, identity: FakeIdentity): void {
    if (!p.adminIds.includes(identity.user.id)) {
      throw new FakeError(
        'forbidden',
        { reason: 'admins_only' },
        'Only project admins can do that.',
      );
    }
  }

  private sprintOut(p: FakeProject, s: FakeSprint): Sprint {
    const items = this.store.items.filter((i) => i.project === p.key && i.sprintId === s.id);
    return {
      id: s.id,
      number: s.number,
      name: s.name,
      goal: s.goal,
      state: s.state,
      starts_on: s.startsOn,
      ends_on: s.endsOn,
      started_at: s.startedAt,
      completed_at: s.completedAt,
      item_count: items.length,
      done_count: items.filter((i) => this.statusOf(i).category === 'done').length,
    };
  }

  private releaseOut(p: FakeProject, r: FakeRelease): Release {
    const items = this.store.items.filter((i) => i.project === p.key && i.releaseId === r.id);
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      status: r.status,
      start_date: r.startDate,
      target_date: r.targetDate,
      released_at: r.releasedAt,
      notes_page_id: r.notesPageId,
      item_count: items.length,
      done_count: items.filter((i) => this.statusOf(i).category === 'done').length,
    };
  }

  private listSprints({ identity, params, query }: Call): Handled {
    const p = this.project(params.key ?? '', identity);
    const states = query.state as string[] | undefined;
    const sprints = [...p.sprints]
      .filter((s) => !states || states.includes(s.state))
      .sort((a, b) => b.number - a.number)
      .map((s) => this.sprintOut(p, s));
    return { status: 200, body: this.page(sprints, query) };
  }

  private createSprint({ identity, params, body }: Call): Handled {
    const p = this.project(params.key ?? '', identity);
    const b = body as { name: string; goal?: string; starts_on?: string; ends_on?: string };
    if (p.sprints.some((s) => lower(s.name) === lower(b.name))) {
      throw new FakeError('validation', {
        fields: [{ path: 'name', message: 'A sprint of this project already has that name.' }],
      });
    }
    const sprint: FakeSprint = {
      id: nextId(),
      number: Math.max(0, ...p.sprints.map((s) => s.number)) + 1,
      name: b.name.trim(),
      goal: b.goal ?? null,
      state: 'planned',
      startsOn: b.starts_on ?? null,
      endsOn: b.ends_on ?? null,
      startedAt: null,
      completedAt: null,
    };
    p.sprints.push(sprint);
    return { status: 201, body: { sprint: this.sprintOut(p, sprint) } };
  }

  private startSprint({ identity, params, body }: Call): Handled {
    const p = this.project(params.key ?? '', identity);
    this.requireAdmin(p, identity);
    const sprint = this.sprintOf(p, params.sprint ?? '');
    const b = body as { starts_on?: string; ends_on?: string; goal?: string };
    if (sprint.state !== 'planned') {
      throw new FakeError('validation', {
        fields: [{ path: 'sprint', message: `The sprint is ${sprint.state}, not planned.` }],
      });
    }
    if (p.sprints.some((s) => s.state === 'active')) {
      throw new FakeError('validation', {
        fields: [{ path: 'sprint', message: 'Another sprint is active; complete it first.' }],
      });
    }
    sprint.state = 'active';
    sprint.startedAt = this.now();
    if (b.starts_on) sprint.startsOn = b.starts_on;
    if (b.ends_on) sprint.endsOn = b.ends_on;
    if (b.goal !== undefined) sprint.goal = b.goal;
    return { status: 200, body: { sprint: this.sprintOut(p, sprint) } };
  }

  private completeSprint({ identity, params, body }: Call): Handled {
    const p = this.project(params.key ?? '', identity);
    this.requireAdmin(p, identity);
    const sprint = this.sprintOf(p, params.sprint ?? '');
    if (sprint.state !== 'active') {
      throw new FakeError('validation', {
        fields: [{ path: 'sprint', message: 'Only the active sprint can be completed.' }],
      });
    }
    const carryTo = (body as { carry_to?: 'next' | 'new' | 'backlog' }).carry_to ?? 'next';
    const items = this.store.items.filter((i) => i.project === p.key && i.sprintId === sprint.id);
    const done = items.filter((i) => this.statusOf(i).category === 'done');
    const open = items.filter((i) => !['done', 'canceled'].includes(this.statusOf(i).category));
    let target: FakeSprint | undefined;
    if (carryTo === 'next') target = p.sprints.find((s) => s.state === 'planned');
    if (carryTo === 'new' || (carryTo === 'next' && !target)) {
      const number = Math.max(0, ...p.sprints.map((x) => x.number)) + 1;
      target = {
        id: nextId(),
        number,
        name: `Sprint ${number}`,
        goal: null,
        state: 'planned',
        startsOn: null,
        endsOn: null,
        startedAt: null,
        completedAt: null,
      };
      p.sprints.push(target);
    }
    for (const i of open) i.sprintId = target?.id ?? null;
    sprint.state = 'completed';
    sprint.completedAt = this.now();
    const points = (list: FakeItem[]) => list.reduce((n, i) => n + (i.estimate ?? 0), 0);
    return {
      status: 200,
      body: {
        sprint: this.sprintOut(p, sprint),
        committed_count: items.length,
        committed_points: points(items),
        completed_count: done.length,
        completed_points: points(done),
        carried_count: open.length,
        carried_to: target
          ? { id: target.id, number: target.number, name: target.name, state: target.state }
          : null,
      },
    };
  }

  /** The items of a planning call, all in the project. */
  private planningItems(p: FakeProject, refs: string[], identity: FakeIdentity): FakeItem[] {
    return refs.map((ref) => {
      const item = this.item(ref, identity);
      if (item.project !== p.key) {
        throw new FakeError('validation', {
          fields: [{ path: 'items', message: `${ref} is not in ${p.key}.` }],
        });
      }
      return item;
    });
  }

  private brief(i: FakeItem) {
    return { id: i.id, key: `${i.project}-${i.number}`, title: i.title };
  }

  private sprintItems({ identity, params, body }: Call, add: boolean): Handled {
    const p = this.project(params.key ?? '', identity);
    const sprint = this.sprintOf(p, params.sprint ?? '');
    const items = this.planningItems(p, (body as { items: string[] }).items, identity);
    const changed: FakeItem[] = [];
    for (const item of items) {
      const target = add ? sprint.id : null;
      if (!add && item.sprintId !== sprint.id) continue;
      if (item.sprintId === target) continue;
      const old = item.sprintId;
      item.sprintId = target;
      this.recordWrite(item, identity, [['sprint', old, target]]);
      changed.push(item);
    }
    return {
      status: 200,
      body: { sprint: this.sprintOut(p, sprint), changed: changed.map((i) => this.brief(i)) },
    };
  }

  private listReleases({ identity, params, query }: Call): Handled {
    const p = this.project(params.key ?? '', identity);
    const statuses = query.status as string[] | undefined;
    const releases = p.releases
      .filter((r) => !statuses || statuses.includes(r.status))
      .map((r) => this.releaseOut(p, r));
    return { status: 200, body: this.page(releases, query) };
  }

  private createRelease({ identity, params, body }: Call): Handled {
    const p = this.project(params.key ?? '', identity);
    const b = body as {
      name: string;
      description?: string;
      start_date?: string;
      target_date?: string;
    };
    if (p.releases.some((r) => lower(r.name) === lower(b.name))) {
      throw new FakeError('validation', {
        fields: [{ path: 'name', message: 'A release of this project already has that name.' }],
      });
    }
    const release: FakeRelease = {
      id: nextId(),
      name: b.name.trim(),
      description: b.description ?? null,
      status: 'unreleased',
      startDate: b.start_date ?? null,
      targetDate: b.target_date ?? null,
      releasedAt: null,
      notesPageId: null,
    };
    p.releases.push(release);
    return { status: 201, body: { release: this.releaseOut(p, release) } };
  }

  private releaseVersion({ identity, params, body }: Call): Handled {
    const p = this.project(params.key ?? '', identity);
    this.requireAdmin(p, identity);
    const release = this.release(p, params.release ?? '');
    const b = body as { released_on?: string; move_open_to?: string };
    if (release.status === 'released') {
      return { status: 200, body: { release: this.releaseOut(p, release) } };
    }
    const moveTo = b.move_open_to ? this.release(p, b.move_open_to) : undefined;
    for (const item of this.store.items.filter((i) => i.releaseId === release.id)) {
      if (['done', 'canceled'].includes(this.statusOf(item).category)) continue;
      const old = item.releaseId;
      item.releaseId = moveTo?.id ?? null;
      this.recordWrite(item, identity, [['fix_release', old, item.releaseId]]);
    }
    release.status = 'released';
    release.releasedAt = b.released_on ? `${b.released_on}T00:00:00Z` : this.now();
    return { status: 200, body: { release: this.releaseOut(p, release) } };
  }

  private releaseNotes({ identity, params, body }: Call): Handled {
    const p = this.project(params.key ?? '', identity);
    const release = this.release(p, params.release ?? '');
    const b = body as { locale?: string; page_version?: number };
    const items = this.store.items.filter((i) => i.releaseId === release.id);
    const text = [
      `# ${release.name}`,
      '',
      ...items.map((i) => `- ${i.project}-${i.number} ${i.title}`),
    ].join('\n');
    const existing = this.store.pages.find((x) => x.id === release.notesPageId);
    if (existing) {
      const edited = existing.version !== (release.notesVersion ?? existing.version);
      if (edited && b.page_version !== existing.version) {
        return {
          status: 200,
          body: {
            page_id: existing.id,
            page_version: existing.version,
            created: false,
            overwrote_edits: false,
            needs_confirmation: true,
          },
        };
      }
      existing.body = text;
      existing.version += 1;
      existing.updatedAt = this.now();
      existing.updatedById = identity.user.id;
      existing.viaAgent = identity.token.name;
      release.notesVersion = existing.version;
      return {
        status: 200,
        body: {
          page_id: existing.id,
          page_version: existing.version,
          created: false,
          overwrote_edits: edited,
          needs_confirmation: false,
          markdown: text,
        },
      };
    }
    const page = this.newPage(p.channelId, `Release notes ${release.name}`, text, null, identity);
    release.notesPageId = page.id;
    release.notesVersion = page.version;
    return {
      status: 200,
      body: {
        page_id: page.id,
        page_version: page.version,
        created: true,
        overwrote_edits: false,
        needs_confirmation: false,
        markdown: text,
      },
    };
  }

  private releaseItems({ identity, params, body }: Call, add: boolean): Handled {
    const p = this.project(params.key ?? '', identity);
    const release = this.release(p, params.release ?? '');
    const items = this.planningItems(p, (body as { items: string[] }).items, identity);
    const changed: FakeItem[] = [];
    for (const item of items) {
      const target = add ? release.id : null;
      if (!add && item.releaseId !== release.id) continue;
      if (item.releaseId === target) continue;
      const old = item.releaseId;
      item.releaseId = target;
      this.recordWrite(item, identity, [['fix_release', old, target]]);
      changed.push(item);
    }
    return {
      status: 200,
      body: { release: this.releaseOut(p, release), changed: changed.map((i) => this.brief(i)) },
    };
  }

  // -------------------------------------------------------------------------
  // Channels, messages and pages
  // -------------------------------------------------------------------------

  /** A channel the user belongs to (never a direct message), within the token's limits. */
  private channel(ref: string, identity: FakeIdentity): FakeChannel {
    const c = this.store.channels.find(
      (x) =>
        !x.direct &&
        x.memberIds.includes(identity.user.id) &&
        (x.id === lower(ref) || lower(x.name) === lower(ref)),
    );
    if (!c) throw new FakeError('not_found', { kind: 'channel', ref });
    const limited = identity.token.limits.channels;
    if (limited && !limited.some((l) => l.id === c.id)) {
      throw new FakeError('outside_limits', { kind: 'channel', ref });
    }
    return c;
  }

  private channelOut(c: FakeChannel) {
    const project = this.store.projects.find((p) => p.key === c.projectKey);
    const last = this.store.messages
      .filter((m) => m.channelId === c.id)
      .map((m) => m.createdAt)
      .sort()
      .pop();
    return {
      id: c.id,
      name: c.name,
      description: c.description,
      visibility: c.visibility,
      is_org_wide: c.isOrgWide,
      is_archived: c.isArchived,
      project: project ? this.projectBrief(project) : null,
      last_message_at: last ?? null,
    };
  }

  private listChannels({ identity, query }: Call): Handled {
    const limited = identity.token.limits.channels;
    const channels = this.store.channels
      .filter((c) => !c.direct && c.memberIds.includes(identity.user.id))
      .filter((c) => query.include_archived === 'true' || !c.isArchived)
      .filter((c) => !limited || limited.some((l) => l.id === c.id))
      .sort((a, b) => (lower(a.name) < lower(b.name) ? -1 : 1))
      .map((c) => this.channelOut(c));
    return { status: 200, body: this.page(channels, query) };
  }

  private messageOut(m: FakeMessage): Message {
    const replies = this.store.messages.filter((r) => r.parentId === m.id);
    return {
      id: m.id,
      channel_id: m.channelId,
      author: this.user(m.authorId),
      kind: 'text',
      body: m.deleted ? '' : m.body,
      code: null,
      code_language: null,
      file: null,
      mentions: [],
      reply_count: replies.length,
      last_reply_at:
        replies
          .map((r) => r.createdAt)
          .sort()
          .pop() ?? null,
      created_at: m.createdAt,
      edited_at: null,
      deleted: m.deleted,
      via_agent: m.viaAgent,
    };
  }

  private listChannelMessages({ identity, params, query }: Call): Handled {
    const c = this.channel(params.channel ?? '', identity);
    const since = typeof query.since === 'string' ? Date.parse(query.since) : undefined;
    const messages = this.store.messages
      .filter((m) => m.channelId === c.id && m.parentId === null)
      .filter((m) => since === undefined || Date.parse(m.createdAt) > since)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((m) => this.messageOut(m));
    return { status: 200, body: this.page(messages, query) };
  }

  private getThread({ identity, params, query }: Call): Handled {
    const root = this.store.messages.find((m) => m.id === lower(params.id ?? ''));
    if (!root || root.parentId !== null) {
      throw new FakeError('not_found', { kind: 'message', ref: params.id ?? '' });
    }
    const c = this.store.channels.find((x) => x.id === root.channelId)!;
    if (c.direct || !c.memberIds.includes(identity.user.id)) {
      throw new FakeError('not_found', { kind: 'message', ref: params.id ?? '' });
    }
    this.channel(c.id, identity);
    const replies = this.store.messages
      .filter((m) => m.parentId === root.id)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .map((m) => this.messageOut(m));
    const page = this.page(replies, query);
    return {
      status: 200,
      body: { root: this.messageOut(root), replies: page.items, next_cursor: page.next_cursor },
    };
  }

  private pageSummary(x: FakePage): PageSummary {
    return {
      id: x.id,
      title: x.title,
      parent_id: x.parentId,
      position: x.position,
      is_home: x.isHome,
      version: x.version,
      updated_at: x.updatedAt,
      updated_by: this.user(x.updatedById),
      updated_via_agent: x.viaAgent,
    };
  }

  private pageOut(x: FakePage): Page {
    const c = this.store.channels.find((ch) => ch.id === x.channelId)!;
    return {
      ...this.pageSummary(x),
      channel: { id: c.id, name: c.name },
      body: x.body,
      created_at: x.createdAt,
      created_by: this.user(x.createdById),
    };
  }

  /** A page in a channel the user can reach. */
  private pageRef(id: string, identity: FakeIdentity): FakePage {
    const x = this.store.pages.find((pg) => pg.id === lower(id));
    if (!x) throw new FakeError('not_found', { kind: 'page', ref: id });
    try {
      this.channel(x.channelId, identity);
    } catch (err) {
      if (err instanceof FakeError && err.code === 'not_found') {
        throw new FakeError('not_found', { kind: 'page', ref: id });
      }
      throw err;
    }
    return x;
  }

  private listPages({ identity, params, query }: Call): Handled {
    const c = this.channel(params.channel ?? '', identity);
    const pages = this.store.pages
      .filter((x) => x.channelId === c.id)
      .sort((a, b) =>
        (a.parentId ?? '') === (b.parentId ?? '')
          ? a.position - b.position
          : (a.parentId ?? '') < (b.parentId ?? '')
            ? -1
            : 1,
      )
      .map((x) => this.pageSummary(x));
    return { status: 200, body: this.page(pages, query) };
  }

  private getPage({ identity, params }: Call): Handled {
    return { status: 200, body: { page: this.pageOut(this.pageRef(params.id ?? '', identity)) } };
  }

  private newPage(
    channelId: string,
    title: string,
    body: string,
    parentId: string | null,
    identity: FakeIdentity,
    id: string = randomUUID(),
    position?: number,
  ): FakePage {
    const now = this.now();
    const siblings = this.store.pages.filter(
      (x) => x.channelId === channelId && x.parentId === parentId,
    );
    const page: FakePage = {
      id,
      channelId,
      title,
      body,
      parentId,
      position: position ?? siblings.length,
      isHome: false,
      version: 1,
      createdAt: now,
      createdById: identity.user.id,
      updatedAt: now,
      updatedById: identity.user.id,
      viaAgent: identity.token.name,
    };
    this.store.pages.push(page);
    return page;
  }

  private createPage({ identity, params, body }: Call): Handled {
    const c = this.channel(params.channel ?? '', identity);
    const b = body as {
      title: string;
      body?: string;
      parent_id?: string;
      position?: number;
      idempotency_key?: string;
    };
    if (b.idempotency_key) {
      const key = lower(b.idempotency_key);
      const existing = this.store.pages.find((x) => x.id === key);
      if (existing) {
        if (existing.channelId !== c.id) {
          throw new FakeError('idempotency_conflict', { idempotency_key: b.idempotency_key });
        }
        return { status: 200, body: { page: this.pageOut(existing), created: false } };
      }
      if (
        this.store.items.some((i) => i.id === key) ||
        this.store.comments.some((x) => x.id === key)
      ) {
        throw new FakeError('idempotency_conflict', { idempotency_key: b.idempotency_key });
      }
    }
    if (b.parent_id !== undefined) {
      const parent = this.store.pages.find((x) => x.id === lower(b.parent_id ?? ''));
      if (!parent || parent.channelId !== c.id) {
        throw new FakeError('validation', {
          fields: [{ path: 'parent_id', message: 'Not a page of this channel.' }],
        });
      }
    }
    const page = this.newPage(
      c.id,
      b.title,
      b.body ?? '',
      b.parent_id ? lower(b.parent_id) : null,
      identity,
      b.idempotency_key ? lower(b.idempotency_key) : randomUUID(),
      b.position,
    );
    return { status: 201, body: { page: this.pageOut(page), created: true } };
  }

  private updatePage({ identity, params, body }: Call): Handled {
    const x = this.pageRef(params.id ?? '', identity);
    const b = body as {
      version: number;
      title?: string;
      body?: string;
      parent_id?: string | null;
      position?: number;
    };
    if (b.version !== x.version) {
      throw new FakeError(
        'conflict',
        { kind: 'page', current: { version: x.version } },
        'The page changed since you read it.',
      );
    }
    if (b.title !== undefined) x.title = b.title;
    if (b.body !== undefined) x.body = b.body;
    if (b.parent_id !== undefined) x.parentId = b.parent_id === null ? null : lower(b.parent_id);
    if (b.position !== undefined) x.position = b.position;
    x.version += 1;
    x.updatedAt = this.now();
    x.updatedById = identity.user.id;
    x.viaAgent = identity.token.name;
    return { status: 200, body: { page: this.pageOut(x) } };
  }

  // -------------------------------------------------------------------------
  // Admin reads
  // -------------------------------------------------------------------------

  private transitionId(from: FakeStatus, n: number): string {
    return uid(0x100000 + Number.parseInt(from.id.slice(-6), 16) * 16 + n);
  }

  private getWorkflow({ identity, params }: Call): Handled {
    const p = this.project(params.key ?? '', identity);
    this.requireAdmin(p, identity);
    const ref = params.workflow ?? '';
    if (lower(ref) !== 'software' && lower(ref) !== p.workflowId) {
      throw new FakeError('not_found', { kind: 'workflow', ref });
    }
    const described = this.describeProject({
      identity,
      token: '',
      params: { key: p.key },
      query: {},
      body: {},
    }).body as DescribeProjectResponse;
    const workflow = described.workflows[0]!;
    return {
      status: 200,
      body: {
        project: this.projectBrief(p),
        workflow,
        board_columns: described.board_columns.map((b) => ({ id: b.id, name: b.name })),
        fields: p.fields.map((f) => ({ id: f.id, name: f.name })),
        types: p.types.map((t) => ({ id: t.id, name: t.name })),
        workflow_def: {
          workflow: {
            id: p.workflowId,
            name: 'Software',
            restrict_transitions: p.restrictTransitions !== false,
          },
          statuses: p.statuses.map((s, position) => ({
            id: s.id,
            name: s.name,
            category: s.category,
            position,
            is_initial: s.initial === true,
          })),
          transitions: p.statuses.flatMap((s) =>
            s.allowed.map((a, n) => ({
              id: this.transitionId(s, n),
              from_status_id: s.id,
              to_status_id: this.status(p, a.to).id,
              required_fields: a.required_fields,
              admins_only: false,
            })),
          ),
          type_ids: p.types.map((t) => t.id),
        },
      },
    };
  }

  private listWorkTypes({ identity }: Call): Handled {
    const demo = this.store.projects[0]!;
    const types = demo.types.map((t, position) => ({
      id: t.id,
      name: t.name,
      system_key: null,
      level: t.level,
      icon: null,
      color: null,
      position,
      archived: false,
      projects: this.store.projects
        .filter((p) => p.types.some((x) => x.name === t.name))
        .filter((p) => {
          const limited = identity.token.limits.projects;
          return !limited || limited.some((l) => l.id === p.id);
        })
        .map((p) => ({
          project: this.projectBrief(p),
          workflow: { id: p.workflowId, name: 'Software' },
        })),
    }));
    return { status: 200, body: { items: types } };
  }

  // -------------------------------------------------------------------------
  // Plans
  // -------------------------------------------------------------------------

  private checkPlanScope(action: string, identity: FakeIdentity): void {
    const scopes = (PLAN_SCOPES as Record<string, readonly string[] | undefined>)[action] ?? [];
    this.checkScopes(scopes, identity);
  }

  /** Every scope must be granted (implications count); the first missing one is reported. */
  private checkScopes(scopes: readonly string[], identity: FakeIdentity): void {
    const granted = expandScopes(identity.token.scopes);
    const missing = scopes.find((s) => !granted.has(s));
    if (missing !== undefined) {
      throw new FakeError(
        'scope_missing',
        { scope: missing, granted: identity.token.scopes },
        `This token lacks the ${missing} scope.`,
      );
    }
  }

  private effect(
    op: PlanEffect['op'],
    kind: PlanEffect['kind'],
    target: string,
    id: string | null,
    before: unknown,
    after: unknown,
  ): PlanEffect {
    return { op, kind, target, id, before, after };
  }

  private createPlan({ identity, token, body }: Call): Handled {
    const { action, args } = body as { action: string; args: Record<string, unknown> };
    this.checkPlanScope(action, identity);
    const versions: Record<string, number> = {};
    const track = (i: FakeItem) => (versions[i.id] = i.version);
    const key = (i: FakeItem) => `${i.project}-${i.number}`;
    let preview: FakePlan['preview'];
    switch (action) {
      case 'delete_item': {
        const item = this.item(args.item as string, identity);
        const children = this.store.items.filter((i) => i.parentId === item.id);
        [item, ...children].forEach(track);
        preview = {
          summary: `Deletes ${key(item)}${children.length > 0 ? ` and its ${children.length} child item(s)` : ''}: "${item.title}".`,
          effects: [item, ...children].map((i) =>
            this.effect('delete', 'item', key(i), i.id, { title: i.title }, null),
          ),
          item_count: 1 + children.length,
          warnings: children.length > 0 ? ['Its children are deleted with it.'] : [],
        };
        break;
      }
      case 'move_item': {
        const item = this.item(args.item as string, identity);
        const to = this.project(args.project as string, identity);
        if (to.key === item.project) {
          throw new FakeError('validation', {
            fields: [{ path: 'args.project', message: 'The item is already in that project.' }],
          });
        }
        track(item);
        const next =
          Math.max(
            0,
            ...this.store.items.filter((i) => i.project === to.key).map((i) => i.number),
          ) + 1;
        preview = {
          summary: `Moves ${key(item)} to ${to.key} as ${to.key}-${next}.`,
          effects: [
            this.effect(
              'move',
              'item',
              key(item),
              item.id,
              { key: key(item) },
              { key: `${to.key}-${next}` },
            ),
          ],
          item_count: 1,
          warnings: [],
        };
        break;
      }
      case 'bulk_update': {
        const items = (args.items as string[]).map((ref) => this.item(ref, identity));
        const patch = args.patch as Record<string, unknown>;
        if (typeof patch.status === 'string') {
          for (const i of items) this.status(this.projectOf(i), patch.status);
        }
        items.forEach(track);
        const fields = Object.keys(patch).join(', ');
        // Each item's values before, for the fields the patch sets.
        const current = (i: FakeItem, field: string): unknown => {
          switch (field) {
            case 'status':
              return this.statusOf(i).name;
            case 'priority':
              return i.priority;
            case 'assignee':
              return i.assigneeId === null ? null : (this.user(i.assigneeId).email ?? null);
            case 'estimate':
              return i.estimate;
            default:
              return null;
          }
        };
        preview = {
          summary: `Updates ${items.length} item(s): ${fields}.`,
          effects: items.map((i) =>
            this.effect(
              'update',
              'item',
              key(i),
              i.id,
              Object.fromEntries(Object.keys(patch).map((f) => [f, current(i, f)])),
              patch,
            ),
          ),
          item_count: items.length,
          warnings: [],
        };
        break;
      }
      case 'archive_status': {
        const p = this.project(args.project as string, identity);
        this.requireAdmin(p, identity);
        const status = this.status(p, args.status as string);
        const replacement = this.status(p, args.replacement as string);
        const moved = this.store.items.filter(
          (i) => i.project === p.key && i.statusId === status.id,
        );
        moved.forEach(track);
        preview = {
          summary: `Archives the status "${status.name}" in ${p.key}; ${moved.length} item(s) move to "${replacement.name}".`,
          effects: [
            this.effect('archive', 'status', status.name, status.id, null, null),
            ...moved.map((i) =>
              this.effect(
                'transition',
                'item',
                key(i),
                i.id,
                { status: status.name },
                { status: replacement.name },
              ),
            ),
          ],
          item_count: moved.length,
          warnings: [],
        };
        break;
      }
      case 'workflow_change': {
        const p = this.project(args.project as string, identity);
        this.requireAdmin(p, identity);
        const def = args.workflow_def as {
          workflow: { id: string; name: string; restrict_transitions?: boolean | null };
          statuses?: unknown[];
          transitions?: { id: string; from_status_id?: string | null; to_status_id: string }[];
        };
        if (def.workflow.id !== p.workflowId) {
          throw new FakeError('not_found', { kind: 'workflow', ref: def.workflow.id });
        }
        // Effects as the API reports them: the workflow's settings, then transitions added or removed.
        const restrict = p.restrictTransitions !== false;
        const nameOf = (id: string | null | undefined): string =>
          id === null || id === undefined
            ? 'any status'
            : (p.statuses.find((s) => s.id === id)?.name ?? id);
        const existing = new Map(
          p.statuses.flatMap((s) =>
            s.allowed.map((a, n) => [this.transitionId(s, n), `${s.name} → ${a.to}`] as const),
          ),
        );
        const sent = def.transitions ?? [];
        const effects: PlanEffect[] = [];
        const newRestrict = def.workflow.restrict_transitions;
        if (typeof newRestrict === 'boolean' && newRestrict !== restrict) {
          effects.push(
            this.effect(
              'update',
              'workflow',
              `workflow ${def.workflow.name}`,
              def.workflow.id,
              { restrict_transitions: restrict },
              { restrict_transitions: newRestrict },
            ),
          );
        }
        for (const t of sent) {
          if (!existing.has(t.id)) {
            effects.push(
              this.effect(
                'create',
                'transition',
                `${nameOf(t.from_status_id)} → ${nameOf(t.to_status_id)}`,
                t.id,
                null,
                null,
              ),
            );
          }
        }
        for (const [id, label] of existing) {
          if (!sent.some((t) => t.id === id)) {
            effects.push(this.effect('delete', 'transition', label, id, null, null));
          }
        }
        if (effects.length === 0) {
          effects.push(
            this.effect('update', 'workflow', def.workflow.name, def.workflow.id, null, null),
          );
        }
        preview = {
          summary: `Changes the workflow "${def.workflow.name}" of ${p.key}: ${def.statuses?.length ?? 0} statuses, ${def.transitions?.length ?? 0} transitions.`,
          effects,
          item_count: 0,
          warnings: [],
        };
        break;
      }
      case 'work_type_change': {
        const op = args.op as 'create' | 'update' | 'archive' | 'restore';
        const demo = this.store.projects[0]!;
        const name = (args.name ?? args.type) as string;
        if (op !== 'create') this.type(demo, args.type as string);
        preview = {
          summary: `${op === 'create' ? 'Creates' : op === 'update' ? 'Updates' : op === 'archive' ? 'Archives' : 'Restores'} the work type "${name}".`,
          effects: [this.effect(op, 'type', name, null, null, null)],
          item_count: 0,
          warnings: [],
        };
        break;
      }
      case 'field_change': {
        const p = this.project(args.project as string, identity);
        this.requireAdmin(p, identity);
        const op = args.op as 'create' | 'update' | 'archive' | 'restore';
        if (
          op !== 'create' &&
          !p.fields.some((f) => lower(f.name) === lower(args.field as string))
        ) {
          throw new FakeError('not_found', { kind: 'field', ref: args.field as string });
        }
        const name = (args.name ?? args.field) as string;
        preview = {
          summary: `${op === 'create' ? 'Creates' : op === 'update' ? 'Updates' : op === 'archive' ? 'Archives' : 'Restores'} the field "${name}" in ${p.key}.`,
          effects: [this.effect(op, 'field', name, null, null, null)],
          item_count: 0,
          warnings: [],
        };
        break;
      }
      case 'label_change': {
        const p = this.project(args.project as string, identity);
        this.requireAdmin(p, identity);
        const op = args.op as 'create' | 'update' | 'delete';
        if (op === 'create' && p.labels.some((l) => lower(l.name) === lower(args.name as string))) {
          throw new FakeError('validation', {
            fields: [
              { path: 'args.name', message: 'A label of this project already has that name.' },
            ],
          });
        }
        const label = op === 'create' ? undefined : this.label(p, args.label as string);
        const using = label
          ? this.store.items.filter((i) => i.project === p.key && i.labels.includes(label))
          : [];
        using.forEach(track);
        const name = (args.name ?? label) as string;
        preview = {
          summary:
            op === 'create'
              ? `Creates the label "${name}" in ${p.key}.`
              : op === 'update'
                ? `Renames or recolors the label "${label ?? ''}" in ${p.key}.`
                : `Deletes the label "${label ?? ''}" in ${p.key}; ${using.length} item(s) lose it.`,
          effects: [this.effect(op, 'label', name, null, null, null)],
          item_count: using.length,
          warnings: [],
        };
        break;
      }
      default:
        throw new FakeError('validation', {
          fields: [{ path: 'action', message: 'Unknown action.' }],
        });
    }
    const handle = randomBytes(24).toString('base64url');
    const expiresAt = this.clock + 10 * 60_000;
    this.store.plans.push({
      handle,
      token,
      action,
      args,
      preview,
      expiresAt,
      usedAt: null,
      versions,
    });
    return {
      status: 201,
      body: { handle, action, preview, expires_at: new Date(expiresAt).toISOString() },
    };
  }

  private applyPlan({ identity, token, params }: Call): Handled {
    const handle = params.handle ?? '';
    const plan = this.store.plans.find((x) => x.handle === handle);
    if (!plan) throw new FakeError('not_found', { kind: 'plan', ref: handle });
    // Another token's plan reads as unknown, like a handle that never existed.
    if (plan.token !== token) throw new FakeError('not_found', { kind: 'plan', ref: handle });
    if (plan.usedAt !== null) {
      throw new FakeError(
        'plan_used',
        { handle, used_at: plan.usedAt },
        'This plan was already applied.',
      );
    }
    if (this.clock > plan.expiresAt) {
      throw new FakeError('plan_expired', { handle }, 'This plan expired (plans last 10 minutes).');
    }
    this.checkPlanScope(plan.action, identity);
    const changed = Object.entries(plan.versions)
      .map(([id, version]) => ({ item: this.store.items.find((i) => i.id === id), id, version }))
      .filter((x) => !x.item || x.item.version !== x.version)
      .map((x) => ({
        kind: 'item' as const,
        ref: x.item ? `${x.item.project}-${x.item.number}` : x.id,
      }));
    if (changed.length > 0) {
      throw new FakeError(
        'plan_stale',
        { handle, changed },
        'Something changed since the preview.',
      );
    }
    const args = plan.args;
    let result: Record<string, unknown>;
    switch (plan.action) {
      case 'delete_item': {
        const ids = Object.keys(plan.versions);
        const deleted = this.store.items.filter((i) => ids.includes(i.id));
        this.store.items = this.store.items.filter((i) => !ids.includes(i.id));
        this.store.links = this.store.links.filter(
          (l) => !ids.includes(l.fromId) && !ids.includes(l.toId),
        );
        result = { action: 'delete_item', deleted: deleted.map((i) => this.brief(i)) };
        break;
      }
      case 'move_item': {
        const item = this.item(args.item as string, identity);
        const to = this.project(args.project as string, identity);
        const oldKey = `${item.project}-${item.number}`;
        const typeName = this.projectOf(item).types.find((t) => t.id === item.typeId)?.name;
        item.number =
          Math.max(
            0,
            ...this.store.items.filter((i) => i.project === to.key).map((i) => i.number),
          ) + 1;
        item.project = to.key;
        item.typeId = to.types.find((t) => t.name === typeName)?.id ?? to.types[1]!.id;
        item.statusId = to.statuses.find((s) => s.initial)!.id;
        item.sprintId = null;
        item.releaseId = null;
        item.labels = [];
        item.parentId = null;
        this.recordWrite(item, identity, [['project', oldKey, `${to.key}-${item.number}`]]);
        result = { action: 'move_item', item: this.summary(item), old_key: oldKey };
        break;
      }
      case 'bulk_update': {
        const patch = args.patch as Record<string, unknown>;
        const items = (args.items as string[]).map((ref) => this.item(ref, identity));
        for (const item of items) {
          const p = this.projectOf(item);
          if (typeof patch.status === 'string') item.statusId = this.status(p, patch.status).id;
          if ('assignee' in patch) {
            item.assigneeId =
              patch.assignee === null
                ? null
                : this.resolveUser(patch.assignee as string, p, identity);
          }
          if (typeof patch.priority === 'string')
            item.priority = patch.priority as FakeItem['priority'];
          if (Array.isArray(patch.add_labels)) {
            for (const l of patch.add_labels as string[]) {
              const n = this.label(p, l);
              if (!item.labels.includes(n)) item.labels.push(n);
            }
          }
          this.recordWrite(
            item,
            identity,
            Object.keys(patch).map((f) => [f, null, null]),
          );
        }
        result = { action: 'bulk_update', items: items.map((i) => this.summary(i)) };
        break;
      }
      case 'archive_status': {
        const p = this.project(args.project as string, identity);
        const status = this.status(p, args.status as string);
        const replacement = this.status(p, args.replacement as string);
        const moved = this.store.items.filter(
          (i) => i.project === p.key && i.statusId === status.id,
        );
        for (const i of moved) {
          i.statusId = replacement.id;
          this.recordWrite(i, identity, [['status', status.id, replacement.id]]);
        }
        p.statuses = p.statuses.filter((s) => s.id !== status.id);
        for (const s of p.statuses)
          s.allowed = s.allowed.filter((a) => lower(a.to) !== lower(status.name));
        result = { action: 'archive_status', moved_items: moved.length };
        break;
      }
      case 'workflow_change': {
        const p = this.project(args.project as string, identity);
        const def = args.workflow_def as {
          workflow: { id: string; restrict_transitions?: boolean | null };
          transitions?: { id: string; from_status_id?: string | null; to_status_id: string }[];
        };
        if (typeof def.workflow.restrict_transitions === 'boolean') {
          p.restrictTransitions = def.workflow.restrict_transitions;
        }
        // New transitions between two statuses are added (the fake keeps no others).
        const known = new Set(
          p.statuses.flatMap((s) => s.allowed.map((_a, n) => this.transitionId(s, n))),
        );
        for (const t of def.transitions ?? []) {
          const from = p.statuses.find((s) => s.id === t.from_status_id);
          const to = p.statuses.find((s) => s.id === t.to_status_id);
          if (known.has(t.id) || !from || !to) continue;
          if (!from.allowed.some((a) => lower(a.to) === lower(to.name))) {
            from.allowed.push({ to: to.name, required_fields: [] });
          }
        }
        result = { action: 'workflow_change', workflow_id: def.workflow.id };
        break;
      }
      case 'work_type_change': {
        const demo = this.store.projects[0]!;
        let id: string;
        if (args.op === 'create') {
          id = nextId();
          demo.types.push({
            id,
            name: args.name as string,
            level: (args.level as FakeType['level'] | undefined) ?? 'standard',
          });
        } else {
          const t = this.type(demo, args.type as string);
          if (args.op === 'update' && typeof args.name === 'string') t.name = args.name;
          id = t.id;
        }
        result = { action: 'work_type_change', type_id: id };
        break;
      }
      case 'field_change': {
        const p = this.project(args.project as string, identity);
        let id: string;
        if (args.op === 'create') {
          id = nextId();
          p.fields.push({
            id,
            name: args.name as string,
            options: ((args.options as { label: string }[] | undefined) ?? []).map((o) => o.label),
          });
        } else {
          const f = p.fields.find((x) => lower(x.name) === lower(args.field as string))!;
          if (args.op === 'update' && typeof args.name === 'string') f.name = args.name;
          if (args.op === 'archive') f.archived = true;
          if (args.op === 'restore') f.archived = false;
          id = f.id;
        }
        result = { action: 'field_change', field_id: id };
        break;
      }
      case 'label_change': {
        const p = this.project(args.project as string, identity);
        let id: string;
        if (args.op === 'create') {
          id = nextId();
          p.labels.push({ id, name: args.name as string });
        } else {
          const l = p.labels.find((x) => lower(x.name) === lower(args.label as string))!;
          id = l.id;
          if (args.op === 'update' && typeof args.name === 'string') {
            for (const i of this.store.items)
              i.labels = i.labels.map((n) => (n === l.name ? (args.name as string) : n));
            l.name = args.name;
          }
          if (args.op === 'delete') {
            p.labels = p.labels.filter((x) => x.id !== l.id);
            for (const i of this.store.items.filter((x) => x.labels.includes(l.name))) {
              i.labels = i.labels.filter((n) => n !== l.name);
              this.recordWrite(i, identity, [['labels', null, null]]);
            }
          }
        }
        result = { action: 'label_change', label_id: id };
        break;
      }
      default:
        throw new Error(`unknown action ${plan.action}`);
    }
    plan.usedAt = this.now();
    return { status: 200, body: { handle, action: plan.action, applied_at: plan.usedAt, result } };
  }
}
