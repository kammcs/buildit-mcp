/**
 * The fake API's agent sessions: the device-code connect flow and a
 * session's own conversation with its owner (made-up data, in memory).
 *
 * FakeApi routes the session operations here; their requests and responses
 * are checked against the contract like every other operation's. Tests
 * drive the person's side: `approve` or `deny` a code, post a message
 * from the owner (or someone else, or one the owner forwarded) into the
 * session's events with `postFrom`, answer or close the session's cards
 * (`answerCard`, `closeCardBy`), assign a work item to the agent and take
 * it off (`assignItem`, `unassignItem`), mention it or reply in an item's
 * thread (`itemMessage`), and `revoke` or `expire` a session. For
 * handoffs: the owner's answer to a proposal's card (`resolveHandoff`), a
 * subtask handed to this session (`handOver`), and a handed subtask's
 * result (`childDone`).
 */
import { randomUUID } from 'node:crypto';

import type { SessionEvent } from '../../src/api/generated/strict.js';
import type { FakeIdentity } from './fake-api.js';
import { FakeFiles, type FakeFileInput } from './fake-files.js';

/** The session token format's public test vectors: well-formed, and never valid anywhere real. */
export const SESSION_TOKENS = {
  first: 'buildit_ags_003aUlTJC7tjlCTQj2uNU3MFagCXG9LRKRcwGkBIDlf3EfgbN',
  second: 'buildit_ags_yhjskwdA6OZ1AL1YmHWZWm8LLG7HjnuCA2j5rOw8Xp114zifR',
  zero: 'buildit_ags_00000000000000000000000000000000000000000003O9xIA',
} as const;

const u = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

export const SESSION_IDS = {
  agent: u(7001),
  installation: u(7002),
  dm: u(7003),
  stranger: u(7004),
  /** The DEMO project's channel, where its items' threads are. */
  demoChannel: u(7005),
  demoProject: u(7006),
} as const;

/** A work item as the fake's item events name it (made up). */
export interface FakeEventItem {
  id: string;
  key: string;
  title: string;
  description?: string;
  truncated?: boolean;
}

/** A made-up DEMO item for item events. */
export function demoItem(n: number, init: Partial<FakeEventItem> = {}): FakeEventItem {
  return { id: u(7100 + n), key: `DEMO-${n}`, title: `Item ${n}`, ...init };
}

/** One message of an item's thread, for an event's context. */
export interface FakeContextMessage {
  id?: string;
  text: string;
  author?: { kind: 'user' | 'app' | 'agent'; id: string; name: string };
  /** Written by the owner (default: by someone else). */
  fromOwner?: boolean;
  /** Written through this agent's token (the API then never says from_owner). */
  viaAgent?: string;
  /** Its files (put in the fake's files, so get_attachment can fetch them). */
  files?: FakeFileInput[];
}

export interface FakeSession {
  id: string;
  token: string;
  label: string;
  ownerId: string;
  ownerName: string;
  events: SessionEvent[];
  /** Positions are 1, 2, 3...: an event's position is its index + 1. */
  acked: number;
  /** Every ack's cursor, in order. */
  acks: number[];
  heartbeats: string[];
  messages: {
    id: string;
    /** Its conversation: the DM, or an item's project channel. */
    conversation_id?: string;
    text: string;
    thread_id: string | null;
    reply_to_id: string | null;
    created_at: string;
    /** The question card, as posted or last changed (null: none). */
    card?: Record<string, unknown> | null;
  }[];
  /** The session's cards by message id: their state and the answers. */
  cards: Map<string, FakeCard>;
  /** Every typing notice, in order. */
  typings: { thread_id: string | null; typing: boolean }[];
  /** Answer this many typing notices with 429 first. */
  typingRefusals: number;
  revokedAt?: string;
  expiredAt?: string;
  /** Ended by DELETE /v1/session. */
  selfRevoked?: boolean;
  /** The items whose threads this session works in, by item id. */
  items: Set<string>;
  /** The direct-message threads the owner wrote in (their root ids), oldest first. */
  dmThreads: string[];
  /** The tags the owner confirmed, and the session's own suggestion. */
  capabilities: string[];
  capabilitiesDetected: string[];
  /** Every PUT /v1/session/capabilities body's tags, in order. */
  suggestions: string[][];
  /** The handoffs this session proposed (asked) or was handed (target), by id. */
  handoffs: Map<string, FakeHandoff>;
}

/** A handoff in the fake, as the API answers it, and which side this session is on. */
export interface FakeHandoff {
  role: 'asked' | 'target';
  json: Record<string, unknown> & { id: string; status: string };
  /** A decline's reason, as sent. */
  declineReason?: string;
}

/** The item a handoff names (FakeApi looks it up in its store). */
export interface FakeHandoffItem {
  id: string;
  key: string;
  parent: { id: string; key: string } | null;
  needs: string[];
}

/** One of the session's cards in the fake: open or closed, and its answers. */
/** A tool approval in the fake: what was posted, and how it ended. */
export interface FakeApproval {
  /** The post's body, as received (tests check what was sent). */
  posted: Record<string, unknown>;
  toolName: string;
  status:
    | 'open'
    | 'approved'
    | 'approved_session'
    | 'denied'
    | 'expired'
    | 'answered_elsewhere'
    | 'stale'
    | 'closed';
  reason?: string;
  createdAt: string;
  closesAt: string;
  decidedAt?: string;
  decidedBy?: string;
  /** Every close the session asked for, in order. */
  closes: string[];
  /** The rule the server says it stored, when not the posted suggestion (tests). */
  storedRule?: unknown;
  /** The id the card.closed event's data.approval names, when not the card's (tests). */
  eventId?: string;
}

export interface FakeCard {
  kind: 'question' | 'plan' | 'approval' | 'handoff';
  /** A tool approval card's state. */
  approval?: FakeApproval;
  threadId: string | null;
  closedAt: string | null;
  closedBy: string | null;
  /** The plan's handle, for a plan card. */
  handle?: string;
  action?: string;
  responses: {
    id: string;
    revision: number;
    answer: Record<string, unknown>;
    status: 'recorded' | 'accepted' | 'rejected';
    note: string | null;
    created_at: string;
    updated_at: string;
  }[];
  /** Every PATCH of the card, in order (the whole new card). */
  updates: Record<string, unknown>[];
}

const ID_RE = /^[a-z0-9_]{1,40}$/;
// eslint-disable-next-line no-control-regex -- control characters are what it finds
const CONTROL_RE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/;

/**
 * The first path where a question card breaks the card schema's rules that
 * buildit-mcp must keep (a subset of the server's), or undefined.
 */
export function questionCardProblem(card: unknown, nowMs: number): string | undefined {
  if (card === null || typeof card !== 'object' || Array.isArray(card)) return '(card)';
  const c = card as Record<string, unknown>;
  const counted = { ...c };
  delete counted.private;
  if (Buffer.byteLength(JSON.stringify(counted), 'utf8') > 16_384) return '(card)';
  if ('source' in c) return 'source';
  if (c.v !== 1) return 'v';
  const line = (v: unknown, max: number): boolean =>
    typeof v === 'string' &&
    v.length >= 1 &&
    Array.from(v).length <= max &&
    !/[\n\r]/.test(v) &&
    !CONTROL_RE.test(v);
  const text = (v: unknown, max: number): boolean =>
    typeof v === 'string' && v.length >= 1 && Array.from(v).length <= max && !CONTROL_RE.test(v);
  const header = c.header as Record<string, unknown> | undefined;
  if (header !== undefined) {
    if (!line(header.title, 150)) return 'header.title';
    if (header.subtitle !== undefined && !line(header.subtitle, 150)) return 'header.subtitle';
  }
  const body = (c.body ?? []) as Record<string, unknown>[];
  let elements = body.length;
  for (const [i, b] of body.entries()) {
    if (b.type === 'text' && !text(b.text, 2000)) return `body[${i}].text`;
    if (b.type === 'context' && !line(b.text, 300)) return `body[${i}].text`;
    if (b.type === 'facts') {
      const items = b.items as Record<string, unknown>[];
      if (!Array.isArray(items) || items.length < 1 || items.length > 10) return `body[${i}].items`;
      for (const [j, f] of items.entries()) {
        if (!line(f.label, 40)) return `body[${i}].items[${j}].label`;
        if (!line(f.value, 200)) return `body[${i}].items[${j}].value`;
      }
    }
  }
  const inputs = (c.inputs ?? []) as Record<string, unknown>[];
  const actions = (c.actions ?? []) as Record<string, unknown>[];
  elements += inputs.length + actions.length;
  if (elements > 25) return '(card)';
  for (const [i, input] of inputs.entries()) {
    if (typeof input.id !== 'string' || !ID_RE.test(input.id)) return `inputs[${i}].id`;
    if (!line(input.label, 150)) return `inputs[${i}].label`;
    if (input.type === 'choice') {
      const options = input.options as Record<string, unknown>[];
      if (!Array.isArray(options) || options.length < 2 || options.length > 10)
        return `inputs[${i}].options`;
      for (const [j, o] of options.entries()) {
        if (typeof o.id !== 'string' || !ID_RE.test(o.id)) return `inputs[${i}].options[${j}].id`;
        if (!line(o.label, 80)) return `inputs[${i}].options[${j}].label`;
        if (o.description !== undefined && !text(o.description, 2000)) {
          return `inputs[${i}].options[${j}].description`;
        }
        const extra = Object.keys(o).filter((k) => !['id', 'label', 'description'].includes(k));
        if (extra.length > 0) return `inputs[${i}].options[${j}].${extra[0]}`;
      }
    } else if (input.type === 'text_input') {
      if (input.placeholder !== undefined && !line(input.placeholder, 150)) {
        return `inputs[${i}].placeholder`;
      }
      const max = input.max_length;
      if (typeof max !== 'number' || max < 1 || max > 2000) return `inputs[${i}].max_length`;
      if (input.multiline !== undefined && typeof input.multiline !== 'boolean') {
        return `inputs[${i}].multiline`;
      }
    } else {
      return `inputs[${i}].type`;
    }
  }
  const buttons = actions.filter((a) => a.type === 'button');
  const submits = actions.filter((a) => a.type === 'submit');
  if (buttons.length > 5) return 'actions';
  if (inputs.length > 0 && (buttons.length > 0 || submits.length !== 1)) return 'actions';
  if (inputs.length === 0 && (buttons.length === 0 || submits.length > 0)) return 'actions';
  for (const [i, a] of actions.entries()) {
    if (!line(a.label, 30)) return `actions[${i}].label`;
    if (a.type === 'button' && (typeof a.id !== 'string' || !ID_RE.test(a.id)))
      return `actions[${i}].id`;
  }
  if (c.private !== undefined && Buffer.byteLength(JSON.stringify(c.private), 'utf8') > 2048) {
    return 'private';
  }
  const r = c.responses as Record<string, unknown> | undefined;
  if (r === undefined) return 'responses';
  const want = {
    mode: 'once',
    visibility: 'private',
    results: 'hidden',
    guests: false,
    confirm: true,
  };
  for (const [k, v] of Object.entries(want)) if (r[k] !== v) return `responses.${k}`;
  const closes = typeof r.closes_at === 'string' ? Date.parse(r.closes_at) : NaN;
  if (!(closes > nowMs) || closes > nowMs + 24 * 3600_000) return 'responses.closes_at';
  return undefined;
}

export interface FakeGrant {
  deviceCode: string;
  userCode: string;
  label: string;
  machine: string;
  client: string;
  projects: string[];
  status: 'pending' | 'approved' | 'denied' | 'consumed' | 'expired';
  /** The token the approval will hand out. */
  token?: string;
  /** The project keys the approval chose, when it changed the ones asked for. */
  approvedProjects?: string[];
  /** The capability tags connect_start sent (undefined: none). */
  capabilities?: string[];
  lastPolledAt?: number;
}

/** What the fake API lends the sessions: its identities and its clock. */
export interface SessionHost {
  identities: Record<string, FakeIdentity>;
  now(): string;
  clockMs(): number;
  /** The fake storage's origin (presigned-style URLs). */
  storageBase(): string;
  /** An item by key or id, for handoffs (undefined: none). */
  findItem?(ref: string): FakeHandoffItem | undefined;
}

export class SessionRefusal extends Error {
  constructor(
    readonly code:
      | 'session_token_required'
      | 'token_revoked'
      | 'token_expired'
      | 'authorization_pending'
      | 'slow_down'
      | 'access_denied'
      | 'expired_token'
      | 'validation'
      | 'thread_other_session'
      | 'thread_not_bound'
      | 'idempotency_conflict'
      | 'card_invalid'
      | 'card_closed'
      | 'not_own_message'
      | 'response_changed'
      | 'not_found'
      | 'rate_limited'
      | 'too_many_open'
      | 'approvals_off'
      | 'outside_reach'
      | 'unavailable'
      | 'handoff_not_allowed'
      | 'not_parent_session'
      | 'handoff_exists'
      | 'handoff_closed'
      | 'no_target',
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

const CONSONANTS = 'BCDFGHJKLMNPQRSTVWXZ';
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export class FakeSessions {
  readonly grants: FakeGrant[] = [];
  readonly sessions = new Map<string, FakeSession>();
  /** The sessions' files: messages' attachments, links, uploads and the fake storage. */
  readonly files: FakeFiles;
  /** The interval connect_start and authorization_pending ask for. */
  interval = 5;
  /** Answer the next connect_poll with slow_down. */
  slowDownOnce = false;
  private next = 0;

  constructor(private readonly host: SessionHost) {
    this.files = new FakeFiles(() => host.storageBase());
  }

  private code(alphabet: string, length: number): string {
    this.next++;
    let out = '';
    let n = this.next * 7919;
    for (let i = 0; i < length; i++) {
      out += alphabet.charAt((n + i * 31) % alphabet.length);
      n = Math.floor(n / 3) + 17;
    }
    return out;
  }

  // -- the operations ------------------------------------------------------

  start(body: Record<string, unknown>): { status: number; body: unknown } {
    const user = this.code(CONSONANTS, 8);
    const grant: FakeGrant = {
      deviceCode: this.code(BASE62, 43),
      userCode: `${user.slice(0, 4)}-${user.slice(4)}`,
      label: String(body.label),
      machine: String(body.machine),
      client: String(body.client),
      projects: (body.projects as string[]).map((p) => p.toUpperCase()),
      status: 'pending',
      ...(Array.isArray(body.capabilities) ? { capabilities: body.capabilities as string[] } : {}),
    };
    this.grants.push(grant);
    return {
      status: 201,
      body: {
        device_code: grant.deviceCode,
        user_code: grant.userCode,
        verification_uri: 'https://app.example.com/connect',
        verification_uri_complete: `https://app.example.com/connect?code=${grant.userCode}`,
        interval: this.interval,
        expires_in: 600,
      },
    };
  }

  poll(body: Record<string, unknown>): { status: number; body: unknown } {
    const grant = this.grants.find((g) => g.deviceCode === body.device_code);
    if (!grant || grant.status === 'expired' || grant.status === 'consumed') {
      throw new SessionRefusal('expired_token');
    }
    if (grant.status === 'denied') throw new SessionRefusal('access_denied');
    if (grant.status === 'pending') {
      grant.lastPolledAt = this.host.clockMs();
      if (this.slowDownOnce) {
        this.slowDownOnce = false;
        throw new SessionRefusal('slow_down', { interval: this.interval + 5 });
      }
      throw new SessionRefusal('authorization_pending', { interval: this.interval });
    }
    grant.status = 'consumed';
    const token = grant.token ?? SESSION_TOKENS.first;
    const session = this.open(token, grant.label);
    return {
      status: 200,
      body: {
        token,
        expires_at: '2026-11-27T10:00:00.000Z',
        session: {
          id: session.id,
          label: session.label,
          // As approved: the asked-for projects the owner can see, unless the approval changed them.
          projects: this.identity(token)
            .projects.filter((p) => (grant.approvedProjects ?? grant.projects).includes(p.key))
            .map((p) => ({ id: p.id, key: p.key })),
        },
        agent: { id: SESSION_IDS.agent, name: 'Claude' },
        owner: { id: session.ownerId, name: session.ownerName },
        org: { id: this.identity(token).org.id, name: this.identity(token).org.name },
      },
    };
  }

  info(token: string): { status: number; body: unknown } {
    const s = this.live(token);
    const identity = this.identity(token);
    return {
      status: 200,
      body: {
        session: {
          id: s.id,
          label: s.label,
          machine: 'TEST-MACHINE',
          client: 'Claude Code',
          scopes: identity.token.scopes,
          project_ids: identity.projects.map((p) => p.id),
          channel_ids: [],
          approved_at: '2026-10-07T12:00:00.000Z',
          last_seen_at: null,
          expires_at: '2026-11-27T10:00:00.000Z',
          capabilities: s.capabilities,
          capabilities_detected: s.capabilitiesDetected,
        },
        agent: { id: SESSION_IDS.agent, name: 'Claude' },
        owner: { id: s.ownerId, name: s.ownerName },
        org: { id: identity.org.id, name: identity.org.name },
        dm: { conversation_id: SESSION_IDS.dm },
        poll_interval_s: this.interval,
        files_budget: {
          down_bytes_left: this.files.downBudget.get(token) ?? 2 * 1024 ** 3,
          up_bytes_left: 1024 ** 3,
          resets_at: '2026-10-08T00:00:00.000Z',
        },
      },
    };
  }

  events(token: string, query: Record<string, unknown>): { status: number; body: unknown } {
    const s = this.live(token);
    const cursor = typeof query.cursor === 'number' ? query.cursor : s.acked;
    if (cursor > s.events.length) {
      throw new SessionRefusal('validation', {
        fields: [{ path: 'cursor', message: 'Past the last event.' }],
      });
    }
    const limit = typeof query.limit === 'number' ? query.limit : 100;
    const page = s.events.slice(cursor, cursor + limit).map((e) => ({ ...e, attempt: 1 }));
    return {
      status: 200,
      body: {
        events: page,
        cursor: cursor + page.length,
        more: cursor + page.length < s.events.length,
      },
    };
  }

  ack(token: string, body: Record<string, unknown>): { status: number; body: unknown } {
    const s = this.live(token);
    const cursor = Number(body.cursor);
    if (cursor > s.events.length) {
      throw new SessionRefusal('validation', {
        fields: [{ path: 'cursor', message: 'Past the last event.' }],
      });
    }
    const acked = Math.max(0, cursor - s.acked);
    s.acked = Math.max(s.acked, cursor);
    s.acks.push(cursor);
    return { status: 200, body: { acked, cursor: s.acked } };
  }

  post(token: string, body: Record<string, unknown>): { status: number; body: unknown } {
    const s = this.live(token);
    const id = String(body.id);
    const fileIds = Array.isArray(body.files) ? (body.files as string[]) : undefined;
    if (fileIds !== undefined) return this.postWithFiles(s, id, body, fileIds);
    const text = String(body.text);
    if (text.trim() === '' || text.length > 4000) {
      throw new SessionRefusal('validation', {
        fields: [{ path: 'text', message: 'The text must be 1 to 4000 characters.' }],
      });
    }
    const threadId = typeof body.thread_id === 'string' ? body.thread_id : null;
    const replyTo = typeof body.reply_to_id === 'string' ? body.reply_to_id : null;
    if (threadId !== null && this.otherSessionThreads.has(threadId)) {
      throw new SessionRefusal('thread_other_session', { thread_id: threadId });
    }
    // An item's thread: only one this session works in.
    const inItem = threadId !== null && this.itemIds.has(threadId);
    if (inItem && !s.items.has(threadId)) {
      throw new SessionRefusal('thread_not_bound', { thread_id: threadId });
    }
    const existing = s.messages.find((m) => m.id === id);
    if (existing) {
      if (existing.text !== text) throw new SessionRefusal('idempotency_conflict');
      return { status: 200, body: { created: false, message: this.messageOut(s, existing) } };
    }
    const card = body.card as Record<string, unknown> | undefined;
    if (card !== undefined) this.checkCard(card);
    if (this.refusePosts > 0) {
      this.refusePosts--;
      throw new SessionRefusal('card_invalid', {
        errors: [{ path: 'responses', message: 'Refused by the test.' }],
      });
    }
    const message = {
      id,
      conversation_id: inItem ? SESSION_IDS.demoChannel : SESSION_IDS.dm,
      text,
      thread_id: threadId,
      reply_to_id: replyTo,
      created_at: this.host.now(),
      card: card ?? null,
    };
    s.messages.push(message);
    if (card !== undefined) {
      s.cards.set(id, {
        kind: 'question',
        threadId,
        closedAt: null,
        closedBy: null,
        responses: [],
        updates: [],
      });
    }
    return { status: 201, body: { created: true, message: this.messageOut(s, message) } };
  }

  /** Every post with files, in order: the groups of upload ids each message carried. */
  readonly filePosts: { id: string; text: string | undefined; groups: string[][] }[] = [];

  /** post_session_message with files: one message per group (the text with the first). */
  private postWithFiles(
    s: FakeSession,
    id: string,
    body: Record<string, unknown>,
    fileIds: string[],
  ): { status: number; body: unknown } {
    const threadId = typeof body.thread_id === 'string' ? body.thread_id : null;
    const text = typeof body.text === 'string' ? body.text : undefined;
    const existing = s.messages.find((m) => m.id === id);
    if (existing) {
      const messages = s.messages.filter((m) => m.id === id || m.id.startsWith(id.slice(0, 24)));
      return {
        status: 200,
        body: {
          created: false,
          message: this.messageOut(s, existing),
          messages: (messages.length > 0 ? messages : [existing]).map((m) => this.messageOut(s, m)),
        },
      };
    }
    if (body.card !== undefined) {
      throw new SessionRefusal('validation', {
        fields: [{ path: 'files', message: 'files and card cannot go together.' }],
      });
    }
    const inItem = threadId !== null && this.itemIds.has(threadId);
    if (inItem && !s.items.has(threadId)) {
      throw new SessionRefusal('thread_not_bound', { thread_id: threadId });
    }
    const groups = this.files.postFiles(s.token, threadId, fileIds);
    this.filePosts.push({ id, text, groups: groups.map((g) => g.map((u) => u.id)) });
    const out = groups.map((group, i) => {
      const message = {
        id: i === 0 ? id : `${id.slice(0, 24)}${String(i).padStart(12, '0')}`,
        conversation_id: inItem ? SESSION_IDS.demoChannel : SESSION_IDS.dm,
        text: i === 0 ? (text ?? '') : '',
        thread_id: threadId,
        reply_to_id: null,
        created_at: this.host.now(),
        card: null,
      };
      s.messages.push(message);
      return this.messageOut(s, message);
    });
    return { status: 201, body: { created: true, message: out[0], messages: out } };
  }

  // -- tool approvals ----------------------------------------------------------

  /** Refusals the next approval posts get, in order (tests): an error code and its details. */
  readonly approvalRefusals: { code: string; details: Record<string, unknown> }[] = [];
  /** How many open approvals a session may have (the server's 10). */
  approvalsOpenMax = 10;
  /** Posts stored and then answered with a 503 (the session doesn't learn it was stored; tests). */
  approvalStoreThenFail = 0;
  /** Closes answered with a 503 (tests). */
  approvalCloseFailures = 0;

  /** POST /v1/session/approvals */
  postApproval(token: string, body: Record<string, unknown>): { status: number; body: unknown } {
    const s = this.live(token);
    const id = String(body.id);
    const existing = s.cards.get(id);
    if (existing?.approval !== undefined) {
      // The same id for another call (another tool, tool call id or details) is refused.
      const before = existing.approval.posted;
      const digest = (b: Record<string, unknown>): string =>
        JSON.stringify([b.tool_name, b.tool_use_id, b.description, b.fields, b.more_fields]);
      if (digest(before) !== digest(body)) {
        throw new SessionRefusal('idempotency_conflict', { idempotency_key: id });
      }
      const m = s.messages.find((x) => x.id === id);
      if (!m) throw new Error('approval without its message');
      return {
        status: 200,
        body: {
          created: false,
          message: this.messageOut(s, m),
          approval: this.approvalJson(id, existing),
        },
      };
    }
    for (const other of this.sessions.values()) {
      if (other !== s && other.cards.has(id)) {
        throw new SessionRefusal('not_own_message', { message_id: id });
      }
    }
    if (s.messages.some((m) => m.id === id)) throw new SessionRefusal('idempotency_conflict');
    const refusal = this.approvalRefusals.shift();
    if (refusal !== undefined) {
      throw new SessionRefusal(refusal.code as SessionRefusal['code'], refusal.details);
    }
    const open = [...s.cards.values()].filter((c) => c.approval?.status === 'open').length;
    if (open >= this.approvalsOpenMax) throw new SessionRefusal('too_many_open', { open });
    const threadId = typeof body.thread_id === 'string' ? body.thread_id : null;
    if (threadId !== null && this.otherSessionThreads.has(threadId)) {
      throw new SessionRefusal('thread_other_session', { thread_id: threadId });
    }
    const inItem = threadId !== null && this.itemIds.has(threadId);
    if (inItem && !s.items.has(threadId)) {
      throw new SessionRefusal('thread_not_bound', { thread_id: threadId });
    }
    const toolName = String(body.tool_name);
    const now = this.host.now();
    const message = {
      id,
      conversation_id: inItem ? SESSION_IDS.demoChannel : SESSION_IDS.dm,
      text: `Claude wants to use \`${toolName}\``,
      thread_id: threadId,
      reply_to_id: null,
      created_at: now,
      card: { v: 2, source: 'agent_approval' },
    };
    s.messages.push(message);
    const card: FakeCard = {
      kind: 'approval',
      threadId,
      closedAt: null,
      closedBy: null,
      responses: [],
      updates: [],
      approval: {
        posted: body,
        toolName,
        status: 'open',
        createdAt: now,
        closesAt: new Date(Date.parse(now) + (Number(body.wait_s) + 60) * 1000).toISOString(),
        closes: [],
      },
    };
    s.cards.set(id, card);
    if (this.approvalStoreThenFail > 0) {
      this.approvalStoreThenFail--;
      throw new SessionRefusal('unavailable', {});
    }
    return {
      status: 201,
      body: {
        created: true,
        message: this.messageOut(s, message),
        approval: this.approvalJson(id, card),
      },
    };
  }

  /** The session's own approval card, or not_found. */
  private ownApproval(s: FakeSession, id: string): FakeCard & { approval: FakeApproval } {
    const card = s.cards.get(id);
    if (card?.approval === undefined) {
      throw new SessionRefusal('not_found', { kind: 'approval', ref: id });
    }
    return card as FakeCard & { approval: FakeApproval };
  }

  /** GET /v1/session/approvals/{id} */
  getApproval(token: string, id: string): { status: number; body: unknown } {
    const s = this.live(token);
    return { status: 200, body: { approval: this.approvalJson(id, this.ownApproval(s, id)) } };
  }

  /** POST /v1/session/approvals/{id}/close */
  closeApproval(
    token: string,
    id: string,
    body: Record<string, unknown>,
  ): { status: number; body: unknown } {
    const s = this.live(token);
    if (this.approvalCloseFailures > 0) {
      this.approvalCloseFailures--;
      throw new SessionRefusal('unavailable', {});
    }
    const card = this.ownApproval(s, id);
    const reason = String(body.reason);
    card.approval.closes.push(reason);
    if (card.approval.status === 'open') {
      const ends: Record<string, [FakeApproval['status'], string | undefined]> = {
        answered_elsewhere: ['answered_elsewhere', undefined],
        stale: ['stale', undefined],
        expired: ['expired', 'client'],
        interrupted: ['closed', 'interrupted'],
        session_ended: ['closed', 'session_ended'],
      };
      const [status, why] = ends[reason] ?? ['closed', 'interrupted'];
      card.approval.status = status;
      if (why !== undefined) card.approval.reason = why;
      this.close(s, id, 'app');
    }
    return { status: 200, body: { approval: this.approvalJson(id, card) } };
  }

  /**
   * The owner taps Approve, Allow for this session, or Deny (tests).
   * `withEvent: false`: the verdict is stored but its event never reaches the session.
   */
  decideApproval(
    token: string,
    id: string,
    action: 'approve' | 'approve_session' | 'deny',
    options: { withEvent?: boolean; storedRule?: unknown; eventApprovalId?: string } = {},
  ): void {
    const s = this.session(token);
    const card = this.ownApproval(s, id);
    if (card.approval.status !== 'open') throw new Error('the approval is not open');
    card.approval.status =
      action === 'approve'
        ? 'approved'
        : action === 'approve_session'
          ? 'approved_session'
          : 'denied';
    card.approval.decidedAt = this.host.now();
    card.approval.decidedBy = s.ownerId;
    // The server's stored rule differs from what the session sent (tests of a mismatch).
    if (options.storedRule !== undefined) card.approval.storedRule = options.storedRule;
    // The event names another approval than its card (tests).
    if (options.eventApprovalId !== undefined) card.approval.eventId = options.eventApprovalId;
    if (options.withEvent === false) {
      card.closedAt = this.host.now();
      card.closedBy = 'owner';
      return;
    }
    this.close(s, id, 'owner');
  }

  /** The server ends an open approval: expiry (time), the session's end, a deleted message (tests). */
  endApproval(
    token: string,
    id: string,
    closedBy: 'time' | 'session_ended' | 'deleted' | 'removed' | 'unassigned' | 'switched_off',
  ): void {
    const s = this.session(token);
    const card = this.ownApproval(s, id);
    if (card.approval.status !== 'open') return;
    if (closedBy === 'time') {
      card.approval.status = 'expired';
      card.approval.reason = 'time';
    } else {
      card.approval.status = 'closed';
      card.approval.reason = closedBy;
    }
    this.close(s, id, closedBy);
  }

  /** The approvals a session posted (tests), oldest first. */
  approvals(token: string): (FakeApproval & { id: string })[] {
    const s = this.session(token);
    return [...s.cards.entries()]
      .filter(([, c]) => c.approval !== undefined)
      .map(([id, c]) => ({ id, ...(c.approval as FakeApproval) }));
  }

  private approvalJson(id: string, card: FakeCard): Record<string, unknown> {
    const a = card.approval as FakeApproval;
    return {
      id,
      status: a.status,
      ...(a.reason === undefined ? {} : { reason: a.reason }),
      tool_name: a.toolName,
      thread_id: card.threadId,
      created_at: a.createdAt,
      closes_at: a.closesAt,
      ...(a.decidedAt === undefined ? {} : { decided_at: a.decidedAt }),
    };
  }

  private approvalOutcome(id: string, card: FakeCard): Record<string, unknown> {
    const a = card.approval as FakeApproval;
    const rule = a.storedRule ?? a.posted.suggestion;
    return {
      id: a.eventId ?? id,
      outcome: a.status === 'open' ? 'closed' : a.status,
      ...(a.reason === undefined ? {} : { reason: a.reason }),
      ...(a.decidedBy === undefined ? {} : { decided_by: a.decidedBy }),
      ...(a.decidedAt === undefined ? {} : { decided_at: a.decidedAt }),
      ...(a.status === 'approved_session' && rule !== undefined ? { rule } : {}),
    };
  }

  /** Posts refused before they are made (tests). */
  refusePosts = 0;

  private checkCard(card: Record<string, unknown>): void {
    // Cards are built with the real clock (the fake clock only times plans).
    const path = questionCardProblem(card, Date.now());
    if (path !== undefined) {
      throw new SessionRefusal('card_invalid', {
        errors: [{ path, message: 'The card is invalid at this path.' }],
      });
    }
  }

  /** The session's own message, or the refusal. */
  private own(s: FakeSession, id: string): FakeSession['messages'][number] {
    const m = s.messages.find((x) => x.id === id);
    if (!m) throw new SessionRefusal('not_found', { kind: 'message', ref: id });
    const kind = s.cards.get(id)?.kind;
    if (kind === 'plan' || kind === 'approval')
      throw new SessionRefusal('not_own_message', { message_id: id });
    return m;
  }

  /** PATCH /v1/session/messages/{id} */
  update(
    token: string,
    id: string,
    body: Record<string, unknown>,
  ): { status: number; body: unknown } {
    const s = this.live(token);
    const m = this.own(s, id);
    if (body.text === undefined && body.card === undefined) {
      throw new SessionRefusal('validation', {
        fields: [{ path: 'card', message: 'Give text or card.' }],
      });
    }
    if (typeof body.text === 'string') m.text = body.text;
    if (body.card !== undefined) {
      const state = s.cards.get(id);
      if (state?.closedAt) throw new SessionRefusal('card_closed', { message_id: id });
      if (body.card !== null) this.checkCard(body.card as Record<string, unknown>);
      m.card = body.card as Record<string, unknown> | null;
      state?.updates.push(body.card as Record<string, unknown>);
    }
    return { status: 200, body: { message: this.messageOut(s, m) } };
  }

  /** POST /v1/session/messages/{id}/card/close */
  closeCard(token: string, id: string): { status: number; body: unknown } {
    const s = this.live(token);
    this.own(s, id);
    const state = s.cards.get(id);
    if (!state) {
      throw new SessionRefusal('validation', { fields: [{ path: 'id', message: 'No card.' }] });
    }
    if (state.closedAt) throw new SessionRefusal('card_closed', { message_id: id });
    this.close(s, id, 'app');
    return { status: 200, body: { closed_at: state.closedAt } };
  }

  /** PATCH /v1/session/responses/{id} */
  answer(
    token: string,
    responseId: string,
    body: Record<string, unknown>,
  ): { status: number; body: unknown } {
    const s = this.live(token);
    for (const [messageId, card] of s.cards) {
      const r = card.responses.find((x) => x.id === responseId);
      if (!r) continue;
      if (card.kind === 'plan' || card.kind === 'approval')
        throw new SessionRefusal('not_own_message', { message_id: messageId });
      if (card.closedAt) throw new SessionRefusal('card_closed', { message_id: messageId });
      if (body.revision !== r.revision) {
        throw new SessionRefusal('response_changed', { response_id: r.id, revision: r.revision });
      }
      r.status = body.status === 'accepted' ? 'accepted' : 'rejected';
      r.note = typeof body.note === 'string' ? body.note : null;
      r.updated_at = this.host.now();
      // Accepting an answer to a question closes its card.
      if (r.status === 'accepted') this.close(s, messageId, 'app');
      return {
        status: 200,
        body: {
          response: {
            id: r.id,
            message_id: messageId,
            revision: r.revision,
            status: r.status,
            answer: r.answer,
            note: r.note,
            created_at: r.created_at,
            updated_at: r.updated_at,
          },
        },
      };
    }
    throw new SessionRefusal('not_found', { kind: 'response', ref: responseId });
  }

  /** POST /v1/session/typing */
  typing(token: string, body: Record<string, unknown>): { status: number; body: unknown } {
    const s = this.live(token);
    if (s.typingRefusals > 0) {
      s.typingRefusals--;
      throw new SessionRefusal('rate_limited', {
        retry_after: 30,
        bucket: 'session_typing_per_minute',
      });
    }
    s.typings.push({
      thread_id: typeof body.thread_id === 'string' ? body.thread_id : null,
      typing: body.typing !== false,
    });
    return { status: 204, body: undefined };
  }

  /** A plan card (FakeApi's post_plan_card): the message and its card. */
  postPlanCard(
    token: string,
    init: { id: string; threadId: string | null; handle: string; action: string; text: string },
  ): FakeSession['messages'][number] {
    const s = this.live(token);
    const existing = s.messages.find((m) => m.id === init.id);
    if (existing) return existing;
    const message = {
      id: init.id,
      text: init.text,
      thread_id: init.threadId,
      reply_to_id: null,
      created_at: this.host.now(),
      card: null,
    };
    s.messages.push(message);
    s.cards.set(init.id, {
      kind: 'plan',
      threadId: init.threadId,
      closedAt: null,
      closedBy: null,
      handle: init.handle,
      action: init.action,
      responses: [],
      updates: [],
    });
    return message;
  }

  /** The session message as the contract answers it (FakeApi's post_plan_card). */
  messageBody(token: string, id: string): unknown {
    const s = this.live(token);
    const m = s.messages.find((x) => x.id === id);
    if (!m) throw new Error('no such message');
    return this.messageOut(s, m);
  }

  /** DELETE /v1/session: the session ends itself. */
  revokeSelf(token: string): { status: number; body: unknown } {
    const s = this.live(token);
    s.revokedAt = '2026-10-07T16:00:00.000Z';
    s.selfRevoked = true;
    return { status: 204, body: undefined };
  }

  heartbeat(token: string, body: Record<string, unknown>): { status: number; body: unknown } {
    const s = this.live(token);
    s.heartbeats.push(String(body.state));
    return { status: 200, body: { state: body.state, last_seen_at: this.host.now() } };
  }

  // -- capabilities and handoffs ----------------------------------------------

  /** The session a handoff card offers (made-up: another of the owner's sessions). */
  static readonly TARGET = {
    kind: 'session' as const,
    agent: { id: SESSION_IDS.agent, name: 'Claude' },
    session: { id: u(7301), label: 'mac-mini' },
    online: true,
  };

  /** PUT /v1/session/capabilities: only the suggestion changes, never the confirmed tags. */
  setCapabilities(token: string, body: Record<string, unknown>): { status: number; body: unknown } {
    const s = this.live(token);
    const raw = body.detected as string[];
    s.suggestions.push([...raw]);
    const tags = [...new Set(raw.map((t) => t.trim().toLowerCase()))];
    if (tags.some((t) => !/^[a-z0-9][a-z0-9+._-]{0,31}$/.test(t)) || tags.length > 20) {
      throw new SessionRefusal('validation', {
        fields: [{ path: 'detected', message: 'Not a capability tag, or more than 20.' }],
      });
    }
    s.capabilitiesDetected = tags.sort();
    return {
      status: 200,
      body: { capabilities: s.capabilities, capabilities_detected: s.capabilitiesDetected },
    };
  }

  /** POST /v1/session/handoffs: a subtask of an item with a parent and Needs gets a card. */
  proposeHandoff(token: string, body: Record<string, unknown>): { status: number; body: unknown } {
    const s = this.live(token);
    const id = String(body.id);
    const ref = String(body.item).replace(/^#/, '').toUpperCase();
    const item = this.host.findItem?.(ref);
    const replay = s.handoffs.get(id);
    if (replay !== undefined) {
      const same = item !== undefined && (replay.json.item as { id: string }).id === item.id;
      if (!same) throw new SessionRefusal('idempotency_conflict');
      return { status: 200, body: { handoff: replay.json, created: false } };
    }
    if (item === undefined) {
      throw new SessionRefusal('not_found', { kind: 'item', ref: String(body.item) });
    }
    if (item.parent === null) throw new SessionRefusal('not_parent_session', { item_id: item.id });
    if (item.needs.length === 0) {
      throw new SessionRefusal('handoff_not_allowed', { reason: 'needs_missing' });
    }
    const live = [...s.handoffs.values()].find(
      (h) =>
        h.role === 'asked' &&
        (h.json.item as { id: string }).id === item.id &&
        (h.json.status === 'proposed' || h.json.status === 'handed'),
    );
    if (live !== undefined)
      throw new SessionRefusal('handoff_exists', { handoff_id: live.json.id });
    const cardId = randomUUID();
    s.cards.set(cardId, {
      kind: 'handoff',
      threadId: item.id,
      closedAt: null,
      closedBy: null,
      responses: [],
      updates: [],
    });
    const json = {
      id,
      item: { id: item.id, key: item.key },
      parent: item.parent,
      needs: item.needs,
      status: 'proposed',
      card_message_id: cardId,
      closes_at: '2026-10-14T15:00:00.000Z',
      targets: [FakeSessions.TARGET],
    };
    s.handoffs.set(id, { role: 'asked', json });
    return { status: 201, body: { handoff: json, created: true } };
  }

  private ownHandoff(s: FakeSession, id: string): FakeHandoff {
    const h = s.handoffs.get(id);
    if (h === undefined) throw new SessionRefusal('not_found', { kind: 'handoff', ref: id });
    return h;
  }

  /** GET /v1/session/handoffs/{id} */
  getHandoff(token: string, id: string): { status: number; body: unknown } {
    const s = this.live(token);
    return { status: 200, body: { handoff: this.ownHandoff(s, id).json } };
  }

  /** POST /v1/session/handoffs/{id}/close: the asking session withdraws its open proposal. */
  closeHandoff(token: string, id: string): { status: number; body: unknown } {
    const s = this.live(token);
    const h = this.ownHandoff(s, id);
    if (h.role !== 'asked') throw new SessionRefusal('not_found', { kind: 'handoff', ref: id });
    if (h.json.status !== 'proposed') {
      throw new SessionRefusal('handoff_closed', { handoff_id: id });
    }
    h.json.status = 'withdrawn';
    h.json.outcome = 'withdrawn';
    const card = s.cards.get(String(h.json.card_message_id));
    if (card) {
      card.closedAt = this.host.now();
      card.closedBy = 'withdrawn';
    }
    return { status: 200, body: { handoff: h.json } };
  }

  /** POST /v1/session/handoffs/{id}/decline: the target hands the subtask back. */
  declineHandoff(
    token: string,
    id: string,
    body: Record<string, unknown>,
  ): { status: number; body: unknown } {
    const s = this.live(token);
    const h = this.ownHandoff(s, id);
    if (h.role !== 'target') throw new SessionRefusal('not_found', { kind: 'handoff', ref: id });
    const reason = String(body.reason).trim();
    if (reason.length === 0 || reason.length > 1000) {
      throw new SessionRefusal('validation', {
        fields: [{ path: 'reason', message: '1 to 1,000 characters.' }],
      });
    }
    if (h.json.status !== 'handed') throw new SessionRefusal('handoff_closed', { handoff_id: id });
    h.json.status = 'declined';
    h.declineReason = reason;
    return { status: 200, body: { handoff: h.json } };
  }

  /**
   * The owner answers this session's proposal: the card closes with
   * data.handoff (applied, with the target and queued; or another outcome).
   */
  resolveHandoff(
    token: string,
    id: string,
    outcome: 'applied' | 'cancelled' | 'expired' | 'stale' | 'withdrawn' | 'closed',
    options: { queued?: boolean; reason?: string; forget?: boolean } = {},
  ): void {
    const s = this.session(token);
    const h = this.ownHandoff(s, id);
    const cardId = String(h.json.card_message_id);
    const card = s.cards.get(cardId);
    if (!card) throw new Error('no card for that handoff');
    const target = {
      kind: 'session',
      agent: FakeSessions.TARGET.agent,
      session: FakeSessions.TARGET.session,
    };
    h.json.status = outcome === 'applied' ? 'handed' : outcome;
    h.json.outcome = outcome;
    if (outcome === 'applied') {
      h.json.target = target;
      h.json.queued = options.queued ?? false;
    }
    if (options.reason !== undefined) h.json.reason = options.reason;
    card.closedAt = this.host.now();
    card.closedBy =
      outcome === 'applied' || outcome === 'cancelled'
        ? 'owner'
        : outcome === 'expired'
          ? 'time'
          : 'app';
    this.event(s, 'card.closed', {
      ...this.cardData(s, cardId),
      closed_by: card.closedBy,
      closed_at: card.closedAt,
      respondents: outcome === 'applied' || outcome === 'cancelled' ? 1 : 0,
      counts: null,
      private: null,
      handoff: {
        id,
        item: h.json.item,
        outcome,
        ...(options.reason === undefined ? {} : { reason: options.reason }),
        ...(outcome === 'applied' ? { target, queued: options.queued ?? false } : {}),
      },
    });
    // A server process that restarted knows nothing of it (tests of the lookup).
    if (options.forget === true) s.handoffs.delete(id);
  }

  /**
   * The owner hands this session a subtask another session proposed: a
   * work_item.assigned with data.handoff; the session works in its thread.
   */
  handOver(
    token: string,
    item: FakeEventItem,
    options: {
      id?: string;
      parent?: { id: string; key: string };
      needs?: string[];
      from?: { agent: { id: string; name: string }; session: { id: string; label: string } | null };
      queued?: boolean;
      context?: FakeContextMessage[];
    } = {},
  ): string {
    const s = this.session(token);
    const id = options.id ?? randomUUID();
    const parent = options.parent ?? { id: u(7401), key: 'DEMO-1' };
    const needs = options.needs ?? ['ios', 'macos'];
    s.items.add(item.id);
    s.handoffs.set(id, {
      role: 'target',
      json: {
        id,
        item: { id: item.id, key: item.key },
        parent,
        needs,
        status: 'handed',
        card_message_id: randomUUID(),
        closes_at: '2026-10-14T15:00:00.000Z',
        targets: [FakeSessions.TARGET],
        target: {
          kind: 'session',
          agent: FakeSessions.TARGET.agent,
          session: { id: s.id, label: s.label },
        },
        queued: options.queued ?? false,
        outcome: 'applied',
      },
    });
    this.event(s, 'work_item.assigned', {
      ...this.itemData(item, true),
      assignment: this.assignment(s),
      context: this.context(s, options.context ?? []),
      user: { id: s.ownerId, name: s.ownerName, is_guest: false, locale: 'en' },
      handoff: {
        id,
        parent,
        from: options.from ?? {
          agent: { id: SESSION_IDS.agent, name: 'Claude' },
          session: { id: u(7302), label: 'windows-desktop' },
        },
        needs,
        queued: options.queued ?? false,
      },
    });
    return id;
  }

  /**
   * A subtask this session handed on reached In review or Done, was handed
   * back, or its handoff ended: work_item.child_done about the parent.
   */
  childDone(
    token: string,
    parent: FakeEventItem,
    child: { id: string; key: string; title: string },
    outcome: 'in_review' | 'done' | 'declined' | 'ended',
    options: {
      handoffId?: string;
      reason?: string;
      result?: {
        text: string;
        author?: { kind: 'user' | 'app' | 'agent'; id: string | null; name: string };
        viaAgent?: string | null;
        fromOwner?: boolean;
      } | null;
    } = {},
  ): void {
    const s = this.session(token);
    const data = this.itemData(parent, false);
    const r = options.result;
    this.event(s, 'work_item.child_done', {
      channel: data.channel,
      project: data.project,
      item: data.item,
      child: {
        id: child.id,
        key: child.key,
        title: child.title,
        status:
          outcome === 'done'
            ? { key: 'done', name: null, category: 'done' }
            : outcome === 'in_review'
              ? { key: 'in_review', name: null, category: 'started' }
              : { key: 'todo', name: null, category: 'not_started' },
      },
      handoff: {
        id: options.handoffId ?? randomUUID(),
        needs: ['ios', 'macos'],
        target: { agent: FakeSessions.TARGET.agent, session: FakeSessions.TARGET.session },
      },
      outcome,
      reason: options.reason ?? null,
      result:
        r === undefined || r === null
          ? null
          : {
              untrusted: true,
              message: {
                id: randomUUID(),
                author: r.author ?? { kind: 'user', id: s.ownerId, name: s.ownerName },
                from_owner: r.fromOwner ?? false,
                via_agent: r.viaAgent === undefined ? 'Claude' : r.viaAgent,
                text: r.text,
                created_at: this.host.now(),
              },
            },
    });
  }

  // -- the person's side -----------------------------------------------------

  /** Threads that belong to another session of the agent (replies there are refused). */
  readonly otherSessionThreads = new Set<string>();
  /** Every item id the fake's item events named (their threads are items' threads). */
  private readonly itemIds = new Set<string>();
  /** The items the fake's item events named, by id. */
  private readonly itemsById = new Map<string, FakeEventItem>();

  /** GET /v1/session/threads: the items' threads, then the direct message's, newest first. */
  threads(token: string): { status: number; body: unknown } {
    const s = this.live(token);
    const at = this.host.now();
    const items = [...s.items].reverse().map((id) => {
      const item = this.itemsById.get(id);
      const cards = [...s.cards.values()].filter((c) => c.threadId === id && !c.closedAt).length;
      return {
        thread_id: id,
        conversation_id: SESSION_IDS.demoChannel,
        kind: 'item' as const,
        item: {
          id,
          key: item?.key ?? 'DEMO-0',
          title: item?.title ?? '',
          status: { id: u(7202), key: 'todo', name: null, category: 'not_started' },
        },
        bound_reason: 'assigned' as const,
        bound_at: at,
        last_owner_message_at: at,
        open_cards: cards,
        handoff: ((): { id: string; role: 'target' | 'asked'; status: string } | null => {
          const h = [...s.handoffs.values()].find(
            (x) => x.role === 'target' && (x.json.item as { id: string }).id === id,
          );
          if (h !== undefined) return { id: h.json.id, role: 'target', status: h.json.status };
          // As the server: for the session's own item, its newest proposal of a subtask, a live one first.
          const asked = [...s.handoffs.values()]
            .filter(
              (x) => x.role === 'asked' && (x.json.parent as { id: string } | null)?.id === id,
            )
            .reverse();
          const live = (x: FakeHandoff) =>
            x.json.status === 'proposed' || x.json.status === 'handed';
          const a = asked.find(live) ?? asked[0];
          return a === undefined ? null : { id: a.json.id, role: 'asked', status: a.json.status };
        })(),
      };
    });
    const dms = [...s.dmThreads].reverse().map((id) => ({
      thread_id: id,
      conversation_id: SESSION_IDS.dm,
      kind: 'dm' as const,
      item: null,
      bound_reason: 'posted' as const,
      bound_at: at,
      last_owner_message_at: at,
      open_cards: 0,
      handoff: null,
    }));
    return { status: 200, body: { threads: [...items, ...dms] } };
  }

  /** The item event's shared data: the channel, project and item. */
  private itemData(item: FakeEventItem, withExcerpt: boolean): Record<string, unknown> {
    this.itemIds.add(item.id);
    this.itemsById.set(item.id, item);
    return {
      channel: { id: SESSION_IDS.demoChannel, name: 'demo' },
      project: { id: SESSION_IDS.demoProject, key: item.key.split('-')[0] ?? 'DEMO' },
      item: {
        id: item.id,
        key: item.key,
        title: item.title,
        type: { id: u(7201), key: 'story', name: 'Story' },
        status: { id: u(7202), key: 'todo', name: 'To do', category: 'not_started' },
        created_at: '2026-10-07T12:00:00.000Z',
        ...(withExcerpt
          ? {
              description_excerpt: item.description ?? '',
              description_truncated: item.truncated ?? false,
            }
          : {}),
      },
    };
  }

  private assignment(s: FakeSession): Record<string, unknown> {
    return {
      agent: { id: SESSION_IDS.agent, name: 'Claude' },
      owner: { id: s.ownerId, name: s.ownerName },
      by: { id: s.ownerId, name: s.ownerName, is_guest: false, locale: 'en' },
      at: this.host.now(),
    };
  }

  private context(s: FakeSession, messages: FakeContextMessage[]): Record<string, unknown> {
    return {
      untrusted: true,
      messages: messages.map((m) => {
        const id = m.id ?? randomUUID();
        const author = m.author ?? {
          kind: 'user' as const,
          id: m.fromOwner ? s.ownerId : SESSION_IDS.stranger,
          name: m.fromOwner ? s.ownerName : 'Sam Example',
        };
        const fromOwner = (m.fromOwner ?? false) && m.viaAgent === undefined;
        const files =
          m.files === undefined
            ? undefined
            : this.files.add(id, m.files, {
                threadId: null,
                sessionToken: s.token,
                author: {
                  kind: author.kind === 'agent' ? 'app' : author.kind,
                  id: author.id,
                  name: author.name,
                },
                fromOwner,
                forwardedFrom: null,
              });
        return {
          id,
          author,
          from_owner: fromOwner,
          ...(m.viaAgent === undefined ? {} : { via_agent: m.viaAgent }),
          text: m.text,
          created_at: this.host.now(),
          ...(files === undefined ? {} : { files }),
        };
      }),
    };
  }

  /**
   * The owner assigns an item to the agent, routed to this session: it
   * works in the item's thread from now on (`owner` false: an assignment
   * naming someone else as the owner, which the session must drop).
   */
  assignItem(
    token: string,
    item: FakeEventItem,
    options: { context?: FakeContextMessage[]; owner?: { id: string; name: string } } = {},
  ): void {
    const s = this.session(token);
    s.items.add(item.id);
    const assignment = this.assignment(s);
    if (options.owner) assignment.owner = options.owner;
    this.event(s, 'work_item.assigned', {
      ...this.itemData(item, true),
      assignment,
      context: this.context(s, options.context ?? []),
      user: { id: s.ownerId, name: s.ownerName, is_guest: false, locale: 'en' },
    });
  }

  /**
   * A message in an item's thread: app.mentioned (`mention`) or
   * message.posted, from the owner unless `from` says otherwise; the
   * session then works in that thread. Returns the message id.
   */
  itemMessage(
    token: string,
    item: FakeEventItem,
    text: string,
    options: {
      mention?: boolean;
      from?: { id: string; name: string };
      context?: FakeContextMessage[];
      forwardedFrom?: { user?: { id: string; name: string } | null };
      /** Written through an agent's token, in the sender's name. */
      viaAgent?: string;
      files?: FakeFileInput[];
    } = {},
  ): string {
    const s = this.session(token);
    s.items.add(item.id);
    const user = options.from ?? { id: s.ownerId, name: s.ownerName };
    const messageId = randomUUID();
    const files =
      options.files === undefined
        ? undefined
        : this.files.add(messageId, options.files, {
            threadId: item.id,
            sessionToken: s.token,
            author: { kind: 'user', id: user.id, name: user.name },
            fromOwner: user.id === s.ownerId,
            forwardedFrom:
              options.forwardedFrom === undefined
                ? null
                : { user: options.forwardedFrom.user ?? null, app: null },
          });
    this.event(s, options.mention ? 'app.mentioned' : 'message.posted', {
      ...this.itemData(item, true),
      assignment: this.assignment(s),
      context: this.context(s, options.context ?? []),
      message: {
        id: messageId,
        thread_id: item.id,
        reply_to_id: null,
        text,
        mentions: [],
        has_card: false,
        created_at: this.host.now(),
        edited_at: null,
        forwarded: options.forwardedFrom !== undefined,
        forwarded_from:
          options.forwardedFrom === undefined
            ? null
            : {
                message_id: randomUUID(),
                user: options.forwardedFrom.user ?? null,
                app: null,
              },
        ...(options.viaAgent === undefined ? {} : { via_agent: options.viaAgent }),
        ...(files === undefined ? {} : { files }),
      },
      user: { id: user.id, name: user.name, is_guest: false, locale: 'en' },
    });
    return messageId;
  }

  /**
   * The agent is taken off the item: the session no longer works in its
   * thread, its open cards there close (their events go dead on the
   * server, so none arrive), and the session gets work_item.unassigned.
   */
  unassignItem(
    token: string,
    item: FakeEventItem,
    reason = 'unassigned',
    options: { withoutAssignment?: boolean } = {},
  ): void {
    const s = this.session(token);
    s.items.delete(item.id);
    for (const card of s.cards.values()) {
      if (card.threadId === item.id && !card.closedAt) {
        card.closedAt = this.host.now();
        card.closedBy = 'unassigned';
        if (card.approval?.status === 'open') {
          card.approval.status = 'closed';
          card.approval.reason = 'unassigned';
        }
      }
    }
    this.event(s, 'work_item.unassigned', {
      ...this.itemData(item, false),
      // Null when the session worked on it through a mention or a hand-on, not an assignment.
      assignment: options.withoutAssignment === true ? null : this.assignment(s),
      reason,
      user: { id: s.ownerId, name: s.ownerName, is_guest: false, locale: 'en' },
    });
  }

  /** Approves the pending code (the latest by default), handing out `token`. */
  approve(userCode?: string, token: string = SESSION_TOKENS.first, projects?: string[]): void {
    const grant = this.pending(userCode);
    grant.status = 'approved';
    grant.token = token;
    if (projects) grant.approvedProjects = projects;
  }

  deny(userCode?: string): void {
    this.pending(userCode).status = 'denied';
  }

  expire(userCode?: string): void {
    this.pending(userCode).status = 'expired';
  }

  /** A session for `token` (as if connected earlier), owned by the identity's user. */
  open(token: string, label = 'demo-folder'): FakeSession {
    const identity = this.identity(token);
    const session: FakeSession = {
      id: randomUUID(),
      token,
      label,
      ownerId: identity.user.id,
      ownerName: identity.user.display_name,
      events: [],
      acked: 0,
      acks: [],
      heartbeats: [],
      messages: [],
      cards: new Map(),
      typings: [],
      typingRefusals: 0,
      items: new Set(),
      dmThreads: [],
      capabilities: [],
      capabilitiesDetected: [],
      suggestions: [],
      handoffs: new Map(),
    };
    this.sessions.set(token, session);
    return session;
  }

  /**
   * Adds a message.posted event: from the owner unless `from` names someone
   * else, top-level unless `threadId` is given. Returns the message id.
   */
  postFrom(
    token: string,
    text: string,
    options: {
      from?: { id: string; name: string };
      threadId?: string;
      type?: string;
      /** The sender's locale (default en). */
      locale?: string;
      /** Written through an agent's token, in the sender's name. */
      viaAgent?: string;
      /** The owner forwarded this message; its first author, a person or an app (or neither). */
      forwardedFrom?: {
        user?: { id: string; name: string } | null;
        app?: { id: string; name: string } | null;
      };
      /** The message's attachments. */
      files?: FakeFileInput[];
    } = {},
  ): string {
    const s = this.sessions.get(token);
    if (!s) throw new Error('no session for this token');
    const messageId = randomUUID();
    const identity = this.identity(token);
    const user = options.from ?? { id: s.ownerId, name: s.ownerName };
    const files =
      options.files === undefined
        ? undefined
        : this.files.add(messageId, options.files, {
            threadId: options.threadId ?? null,
            sessionToken: s.token,
            author: { kind: 'user', id: user.id, name: user.name },
            fromOwner: user.id === s.ownerId,
            forwardedFrom:
              options.forwardedFrom === undefined
                ? null
                : { user: options.forwardedFrom.user ?? null, app: null },
          });
    const root = options.threadId ?? messageId;
    if (user.id === s.ownerId && !s.dmThreads.includes(root)) s.dmThreads.push(root);
    s.events.push({
      v: 1,
      id: randomUUID(),
      type: (options.type ?? 'message.posted') as SessionEvent['type'],
      created_at: this.host.now(),
      org: { id: identity.org.id },
      app: { id: SESSION_IDS.agent, installation_id: SESSION_IDS.installation },
      attempt: 1,
      session: { id: s.id, label: s.label },
      data: {
        channel: { id: SESSION_IDS.dm, name: null },
        message: {
          id: messageId,
          thread_id: options.threadId ?? null,
          reply_to_id: null,
          text,
          mentions: [],
          has_card: false,
          created_at: this.host.now(),
          edited_at: null,
          forwarded: options.forwardedFrom !== undefined,
          forwarded_from:
            options.forwardedFrom === undefined
              ? null
              : {
                  message_id: randomUUID(),
                  user: options.forwardedFrom.user ?? null,
                  app: options.forwardedFrom.app ?? null,
                },
          ...(options.viaAgent === undefined ? {} : { via_agent: options.viaAgent }),
          ...(files === undefined ? {} : { files }),
        },
        user: { id: user.id, name: user.name, is_guest: false, locale: options.locale ?? 'en' },
      },
    } as SessionEvent);
    return messageId;
  }

  /** The session of a token (tests). */
  session(token: string): FakeSession {
    const s = this.sessions.get(token);
    if (!s) throw new Error('no session for this token');
    return s;
  }

  /** The event envelope of the session. */
  private event(s: FakeSession, type: SessionEvent['type'], data: Record<string, unknown>): void {
    const identity = this.identity(s.token);
    s.events.push({
      v: 1,
      id: randomUUID(),
      type,
      created_at: this.host.now(),
      org: { id: identity.org.id },
      app: { id: SESSION_IDS.agent, installation_id: SESSION_IDS.installation },
      attempt: 1,
      session: { id: s.id, label: s.label },
      data,
    } as SessionEvent);
  }

  private cardData(s: FakeSession, messageId: string): Record<string, unknown> {
    const card = s.cards.get(messageId);
    return {
      channel: { id: SESSION_IDS.dm, name: null },
      message: { id: messageId, thread_id: card?.threadId ?? null },
      card:
        card?.kind === 'plan' || card?.kind === 'approval'
          ? { visibility: 'private', results: 'hidden', mode: 'once', confirm: false }
          : { visibility: 'private', results: 'hidden', mode: 'once', confirm: true },
    };
  }

  /** Closes a card and adds its card.closed event (plan: the outcome). */
  close(s: FakeSession, messageId: string, closedBy: string, plan?: Record<string, unknown>): void {
    const card = s.cards.get(messageId);
    if (!card || card.closedAt) return;
    card.closedAt = this.host.now();
    card.closedBy = closedBy;
    this.event(s, 'card.closed', {
      ...this.cardData(s, messageId),
      closed_by: closedBy,
      closed_at: card.closedAt,
      respondents: card.responses.length,
      counts: null,
      private: null,
      ...(plan === undefined ? {} : { plan }),
      ...(card.approval === undefined ? {} : { approval: this.approvalOutcome(messageId, card) }),
    });
  }

  /**
   * The person (the owner unless `from` says otherwise) answers a card: a
   * new response, or a new revision of a rejected one. Returns its id.
   */
  answerCard(
    token: string,
    messageId: string,
    answer: Record<string, unknown>,
    options: { from?: { id: string; name: string }; locale?: string } = {},
  ): string {
    const s = this.session(token);
    const card = s.cards.get(messageId);
    if (!card) throw new Error('no card on that message');
    const now = this.host.now();
    let r = card.responses[card.responses.length - 1];
    if (r && r.status !== 'accepted') {
      r.revision += 1;
      r.answer = answer;
      r.status = 'recorded';
      r.updated_at = now;
    } else {
      r = {
        id: randomUUID(),
        revision: 1,
        answer,
        status: 'recorded',
        note: null,
        created_at: now,
        updated_at: now,
      };
      card.responses.push(r);
    }
    const user = options.from ?? { id: s.ownerId, name: s.ownerName };
    this.event(s, 'card.response', {
      ...this.cardData(s, messageId),
      response: {
        id: r.id,
        revision: r.revision,
        answer,
        created_at: r.created_at,
        updated_at: r.updated_at,
      },
      user: { id: user.id, name: user.name, is_guest: false, locale: options.locale ?? 'en' },
      pseudonym: null,
      private: null,
    });
    return r.id;
  }

  /** The card closes without an answer: by time, the owner, the session's end, ... */
  closeCardBy(token: string, messageId: string, closedBy: string): void {
    this.close(this.session(token), messageId, closedBy);
  }

  /** The card's message, as the fake keeps it (tests). */
  message(token: string, id: string): FakeSession['messages'][number] | undefined {
    return this.session(token).messages.find((m) => m.id === id);
  }

  revoke(token: string): void {
    const s = this.sessions.get(token);
    if (s) s.revokedAt = '2026-10-07T16:00:00.000Z';
  }

  expireSession(token: string): void {
    const s = this.sessions.get(token);
    if (s) s.expiredAt = '2026-10-07T16:00:00.000Z';
  }

  /** Throws the token's refusal when it is a revoked or expired session token. */
  checkToken(token: string): void {
    const s = this.sessions.get(token);
    if (s?.revokedAt) throw new SessionRefusal('token_revoked', { revoked_at: s.revokedAt });
    if (s?.expiredAt) throw new SessionRefusal('token_expired', { expired_at: s.expiredAt });
  }

  // -- helpers ---------------------------------------------------------------

  private pending(userCode?: string): FakeGrant {
    const grant =
      userCode === undefined
        ? [...this.grants].reverse().find((g) => g.status === 'pending')
        : this.grants.find((g) => g.userCode === userCode);
    if (!grant) throw new Error('no pending grant');
    return grant;
  }

  private identity(token: string): FakeIdentity {
    const identity = this.host.identities[token];
    if (!identity) throw new Error('the fake has no identity for this session token');
    return identity;
  }

  live(token: string): FakeSession {
    const s = this.sessions.get(token);
    if (!s) throw new SessionRefusal('session_token_required');
    this.checkToken(token);
    return s;
  }

  private messageOut(s: FakeSession, m: FakeSession['messages'][number]) {
    return {
      id: m.id,
      conversation_id: m.conversation_id ?? SESSION_IDS.dm,
      thread_id: m.thread_id,
      reply_to_id: m.reply_to_id,
      text: m.text,
      created_at: m.created_at,
      session: { id: s.id, label: s.label },
    };
  }
}
