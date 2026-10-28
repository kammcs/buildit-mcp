/**
 * The fake API's agent sessions: the device-code connect flow and a
 * session's own conversation with its owner (made-up data, in memory).
 *
 * FakeApi routes the session operations here; their requests and responses
 * are checked against the contract like every other operation's. Tests
 * drive the person's side: `approve` or `deny` a code, `post` a message
 * from the owner (or someone else) into the session's events, and `revoke`
 * or `expire` a session.
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
} as const;

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
    text: string;
    thread_id: string | null;
    reply_to_id: string | null;
    created_at: string;
  }[];
  revokedAt?: string;
  expiredAt?: string;
  /** Ended by DELETE /v1/session. */
  selfRevoked?: boolean;
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
      | 'idempotency_conflict',
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
    const existing = s.messages.find((m) => m.id === id);
    if (existing) {
      if (existing.text !== text) throw new SessionRefusal('idempotency_conflict');
      return { status: 200, body: { created: false, message: this.messageOut(s, existing) } };
    }
    const message = {
      id,
      text,
      thread_id: threadId,
      reply_to_id: replyTo,
      created_at: this.host.now(),
    };
    s.messages.push(message);
    return { status: 201, body: { created: true, message: this.messageOut(s, message) } };
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
    options: { from?: { id: string; name: string }; threadId?: string; type?: string } = {},
  ): string {
    const s = this.sessions.get(token);
    if (!s) throw new Error('no session for this token');
    const messageId = randomUUID();
    const identity = this.identity(token);
    const user = options.from ?? { id: s.ownerId, name: s.ownerName };
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
        },
        user: { id: user.id, name: user.name, is_guest: false, locale: 'en' },
      },
    });
    return messageId;
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
      conversation_id: SESSION_IDS.dm,
      thread_id: m.thread_id,
      reply_to_id: m.reply_to_id,
      text: m.text,
      created_at: m.created_at,
      session: { id: s.id, label: s.label },
    };
  }
}
