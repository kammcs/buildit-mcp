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
 * thread (`itemMessage`), and `revoke` or `expire` a session.
 */
import { randomUUID } from 'node:crypto';

import type { SessionEvent } from '../../src/api/generated/strict.js';
import type { FakeIdentity } from './fake-api.js';

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
}

/** One of the session's cards in the fake: open or closed, and its answers. */
export interface FakeCard {
  kind: 'question' | 'plan';
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
  lastPolledAt?: number;
}

/** What the fake API lends the sessions: its identities and its clock. */
export interface SessionHost {
  identities: Record<string, FakeIdentity>;
  now(): string;
  clockMs(): number;
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
      | 'rate_limited',
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
  /** The interval connect_start and authorization_pending ask for. */
  interval = 5;
  /** Answer the next connect_poll with slow_down. */
  slowDownOnce = false;
  private next = 0;

  constructor(private readonly host: SessionHost) {}

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
        },
        agent: { id: SESSION_IDS.agent, name: 'Claude' },
        owner: { id: s.ownerId, name: s.ownerName },
        org: { id: identity.org.id, name: identity.org.name },
        dm: { conversation_id: SESSION_IDS.dm },
        poll_interval_s: this.interval,
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
    if (s.cards.get(id)?.kind === 'plan')
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
      if (card.kind === 'plan')
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
          status: { id: u(7202), key: 'todo', name: 'To do', category: 'not_started' },
        },
        bound_reason: 'assigned' as const,
        bound_at: at,
        last_owner_message_at: at,
        open_cards: cards,
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
      messages: messages.map((m) => ({
        id: m.id ?? randomUUID(),
        author: m.author ?? {
          kind: 'user',
          id: m.fromOwner ? s.ownerId : SESSION_IDS.stranger,
          name: m.fromOwner ? s.ownerName : 'Sam Example',
        },
        from_owner: m.fromOwner ?? false,
        text: m.text,
        created_at: this.host.now(),
      })),
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
    } = {},
  ): string {
    const s = this.session(token);
    s.items.add(item.id);
    const user = options.from ?? { id: s.ownerId, name: s.ownerName };
    const messageId = randomUUID();
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
  unassignItem(token: string, item: FakeEventItem, reason = 'unassigned'): void {
    const s = this.session(token);
    s.items.delete(item.id);
    for (const card of s.cards.values()) {
      if (card.threadId === item.id && !card.closedAt) {
        card.closedAt = this.host.now();
        card.closedBy = 'unassigned';
      }
    }
    this.event(s, 'work_item.unassigned', {
      ...this.itemData(item, false),
      assignment: this.assignment(s),
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
      /** The owner forwarded this message; its first author, a person or an app (or neither). */
      forwardedFrom?: {
        user?: { id: string; name: string } | null;
        app?: { id: string; name: string } | null;
      };
    } = {},
  ): string {
    const s = this.sessions.get(token);
    if (!s) throw new Error('no session for this token');
    const messageId = randomUUID();
    const identity = this.identity(token);
    const user = options.from ?? { id: s.ownerId, name: s.ownerName };
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
        card?.kind === 'plan'
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

  private live(token: string): FakeSession {
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
