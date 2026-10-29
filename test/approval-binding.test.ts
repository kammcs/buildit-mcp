/**
 * A tool approval's verdict is for one tool call only. Claude can call the
 * plugin's hook tools itself (approve, tool_seen), so these check that an
 * allow it obtains for one input never becomes the allow for another, that
 * "Allow for this session" grants only the rule the owner was shown, for the
 * tool that asks, that fallback ids can't be guessed, and the hardening
 * around them: a post that may have been stored is closed, the journal
 * merges and is written whole, the hooks under --read-only, and an event
 * that names another approval.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { CallToolResult } from '@modelcontextprotocol/client';

import { inputHash } from '../src/channel/tool-ring.js';
import { CardWaiters } from '../src/channel/waiters.js';
import { uuidV5 } from '../src/tools/ask.js';
import {
  APPROVE_NAMESPACE,
  approvalIdForToolUse,
  denyText,
  permissionAllow,
  permissionDeny,
} from '../src/tools/approve.js';
import {
  channelConfig,
  channelNotes,
  startChannel,
  waitFor,
  type ChannelClient,
} from './support/channel-harness.js';
import { FakeApi } from './support/fake-api.js';
import { SESSION_TOKENS } from './support/fake-sessions.js';

const TOKEN = SESSION_TOKENS.first;
const j = (...p: string[]): string => p.join('');
const R = (s: string, n: number): string => s.repeat(n);

let api: FakeApi;
const stops: (() => Promise<void>)[] = [];
let dir: string;

beforeAll(async () => {
  api = await new FakeApi().start();
});
afterAll(async () => {
  await api.close();
});
beforeEach(() => {
  api.reset();
  dir = mkdtempSync(join(tmpdir(), 'buildit-mcp-binding-'));
});
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
  rmSync(dir, { recursive: true, force: true });
  expect(api.violations).toEqual([]);
});

const session = () => api.sessions.session(TOKEN);
const approvals = () => api.sessions.approvals(TOKEN);
const textOf = (r: CallToolResult): string =>
  (r.content as { type: string; text: string }[]).map((c) => c.text).join('\n');
const journalPath = (): string => join(dir, 'session.approvals.json');
const journalIds = (): string[] =>
  (JSON.parse(readFileSync(journalPath(), 'utf8')) as { open: { id: string }[] }).open.map(
    (e) => e.id,
  );

async function start(
  options: { env?: Record<string, string>; journal?: boolean } = {},
): Promise<ChannelClient> {
  return startChannel(api, stops, {
    config: channelConfig(api, options.env),
    stdio: {
      approve: { msPerSecond: 2 },
      typing: { everyMs: 60_000 },
      ...(options.journal === true ? { approvalJournal: journalPath() } : {}),
    },
  });
}

async function started(options: Parameters<typeof start>[0] = {}): Promise<ChannelClient> {
  api.sessions.open(TOKEN);
  const c = await start(options);
  await waitFor(() => session().heartbeats.includes('online'));
  api.sessions.postFrom(TOKEN, 'Go on.');
  await waitFor(() => channelNotes(c.notes).length === 1);
  return c;
}

const call = (c: ChannelClient, name: string, args: Record<string, unknown>) =>
  c.client.callTool({ name, arguments: args });

function approve(
  c: ChannelClient,
  init: { input: unknown; tool_use_id?: string; tool_name?: string; suggestions?: unknown },
) {
  return call(c, 'approve', {
    tool_name: init.tool_name ?? 'Bash',
    tool_input: JSON.stringify(init.input),
    tool_use_id: init.tool_use_id ?? '',
    agent_id: '',
    agent_type: '',
    session_id: 'claude-session-1',
    prompt_id: 'prompt-1',
    suggestions: JSON.stringify(init.suggestions ?? []),
  });
}

async function posted(n = 1) {
  await waitFor(() => approvals().length >= n);
  return approvals()[n - 1]!;
}

/** The call's result, or "waiting" when it hasn't answered within `ms`. */
async function soon(p: Promise<CallToolResult>, ms = 300): Promise<CallToolResult | 'waiting'> {
  return Promise.race([
    p,
    new Promise<'waiting'>((resolve) => {
      setTimeout(() => {
        resolve('waiting');
      }, ms);
    }),
  ]);
}

const DECOY = { command: 'echo hello', description: 'Say hello' };
const REAL = { command: 'rm -rf ./build', description: 'Clean the build' };
const RULE = {
  type: 'addRules',
  rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
  behavior: 'allow',
  destination: 'session',
};

describe('a verdict is for its own tool call only', () => {
  it("an allow for a decoy never answers the real call, even with the decoy's tool call id planted", async () => {
    const c = await started();
    // Claude calls approve itself with a harmless input and the id of a call it will make.
    const decoy = approve(c, { input: DECOY, tool_use_id: 'toolu_real' });
    const a = await posted(1);
    api.sessions.decideApproval(TOKEN, a.id, 'approve');
    expect(textOf(await decoy)).toBe(permissionAllow());
    // It plants that id for the real input, then the real permission request comes.
    await call(c, 'tool_seen', {
      tool_name: 'Bash',
      tool_input: JSON.stringify(REAL),
      tool_use_id: 'toolu_real',
      agent_id: '',
    });
    const real = approve(c, { input: REAL });
    // No allow: a new card, for the real input, waits for the owner.
    expect(await soon(real)).toBe('waiting');
    const b = await posted(2);
    expect(b.id).not.toBe(a.id);
    expect(b.id).toBe(approvalIdForToolUse('toolu_real', '', 'Bash', inputHash(REAL)));
    expect(b.posted.fields).toEqual([{ key: 'command', value: 'rm -rf ./build' }]);
    api.sessions.decideApproval(TOKEN, b.id, 'deny');
    expect(textOf(await real)).toBe(permissionDeny(denyText('denied', session().ownerName, 59)));
  });

  it('a call naming the same tool call id with another input is another card', async () => {
    const c = await started();
    const one = approve(c, { input: DECOY, tool_use_id: 'toolu_same' });
    const a = await posted(1);
    api.sessions.decideApproval(TOKEN, a.id, 'approve');
    await one;
    const two = approve(c, { input: REAL, tool_use_id: 'toolu_same' });
    expect(await soon(two)).toBe('waiting');
    const b = await posted(2);
    expect(b.id).not.toBe(a.id);
    api.sessions.decideApproval(TOKEN, b.id, 'deny');
    expect(textOf(await two)).toContain('"behavior":"deny"');
  });

  it('a remembered verdict is given only for the same tool and input', () => {
    const waiters = new CardWaiters();
    waiters.rememberApproval('m1', {
      status: 'approved',
      text: permissionAllow(),
      toolName: 'Bash',
      hash: 'h1',
    });
    expect(waiters.approvalOf('m1', 'Bash', 'h1')?.text).toBe(permissionAllow());
    expect(waiters.approvalOf('m1', 'Bash', 'h2')).toBeUndefined();
    expect(waiters.approvalOf('m1', 'Write', 'h1')).toBeUndefined();
  });

  it('passes when the server says the id belongs to another call (idempotency_conflict)', async () => {
    const c = await started();
    api.sessions.approvalRefusals.push({
      code: 'idempotency_conflict',
      details: { idempotency_key: 'toolu_conflict' },
    });
    const r = await approve(c, { input: REAL, tool_use_id: 'toolu_conflict' });
    expect(textOf(r)).toBe('{}');
    expect(r.structuredContent).toMatchObject({ status: 'passed', reason: 'post_failed' });
  });
});

describe('"Allow for this session" grants only the rule the owner was shown', () => {
  it('grants the rule when the server stored the same rule', async () => {
    const c = await started();
    const p = approve(c, { input: { command: 'npm test' }, suggestions: [RULE] });
    const a = await posted();
    api.sessions.decideApproval(TOKEN, a.id, 'approve_session');
    expect(textOf(await p)).toBe(permissionAllow(RULE as never));
  });

  it('allows this one call only when the stored rule differs, and says so in the log', async () => {
    const c = await started();
    const p = approve(c, { input: { command: 'npm test' }, suggestions: [RULE] });
    const a = await posted();
    api.sessions.decideApproval(TOKEN, a.id, 'approve_session', {
      storedRule: { ...RULE, rules: [{ toolName: 'Bash', ruleContent: 'npm:*' }] },
    });
    const r = await p;
    expect(textOf(r)).toBe(permissionAllow());
    expect(r.structuredContent).toMatchObject({ status: 'approved', reason: 'rule_mismatch' });
    expect(c.logs.join('\n')).toContain('rule_mismatch');
  });

  it('allows this one call only when the verdict came without the stored rule (read by GET)', async () => {
    const c = await started();
    const p = approve(c, { input: { command: 'npm test' }, suggestions: [RULE] });
    const a = await posted();
    api.sessions.decideApproval(TOKEN, a.id, 'approve_session', { withEvent: false });
    const r = await p;
    expect(textOf(r)).toBe(permissionAllow());
    expect(r.structuredContent).toMatchObject({ reason: 'rule_mismatch' });
  });

  it('never offers a rule for another tool than the one asking', async () => {
    const c = await started();
    const p = approve(c, {
      tool_name: 'PowerShell',
      input: { command: 'ls' },
      suggestions: [RULE],
    });
    const a = await posted();
    expect(a.posted.suggestion).toBeUndefined();
    api.sessions.decideApproval(TOKEN, a.id, 'approve');
    expect(textOf(await p)).toBe(permissionAllow());
  });
});

describe('fallback ids', () => {
  it("can't be computed without this server's nonce, and differ between servers", async () => {
    const c = await started();
    const one = approve(c, { input: REAL });
    const a = await posted(1);
    const guess = uuidV5(
      ['claude-session-1', '', 'Bash', inputHash(REAL), 'prompt-1', '1'].join('\n'),
      APPROVE_NAMESPACE,
    );
    expect(a.id).not.toBe(guess);
    api.sessions.decideApproval(TOKEN, a.id, 'approve');
    await one;
    await Promise.all(stops.splice(0).map((stop) => stop()));
    const c2 = await start();
    await waitFor(() => session().heartbeats.filter((h) => h === 'online').length >= 2);
    const two = approve(c2, { input: REAL });
    const b = await posted(2);
    expect(b.id).not.toBe(a.id);
    api.sessions.decideApproval(TOKEN, b.id, 'approve');
    await two;
  });
});

describe('a post that may have been stored', () => {
  it('is closed as interrupted, and the terminal decides', async () => {
    const c = await started({ journal: true });
    api.sessions.approvalStoreThenFail = 1;
    const r = await approve(c, { input: REAL, tool_use_id: 'toolu_lost' });
    expect(textOf(r)).toBe('{}');
    await waitFor(() => approvals()[0]?.closes.includes('interrupted') === true);
    expect(approvals()[0]?.status).toBe('closed');
    await waitFor(() => journalIds().length === 0);
  });

  it('stays in the journal while its close fails, and the next server closes it', async () => {
    const c = await started({ journal: true });
    api.sessions.approvalStoreThenFail = 1;
    api.sessions.approvalCloseFailures = 1;
    await approve(c, { input: REAL, tool_use_id: 'toolu_lost2' });
    const id = approvalIdForToolUse('toolu_lost2', '', 'Bash', inputHash(REAL));
    await waitFor(() => api.sessions.approvalCloseFailures === 0);
    expect(journalIds()).toEqual([id]);
    expect(approvals()[0]?.status).toBe('open');
    await Promise.all(stops.splice(0).map((stop) => stop()));
    await start({ journal: true });
    await waitFor(() => approvals()[0]?.status === 'closed');
    expect(approvals()[0]?.closes).toEqual(['interrupted']);
    await waitFor(() => journalIds().length === 0);
  });
});

describe('the wait', () => {
  it('counts from the start of the call, so a slow post leaves less of it', async () => {
    api.sessions.open(TOKEN);
    // 60 s at 10 ms a second: 600 ms in all; the post alone takes 500.
    const slow = await startChannel(api, stops, {
      config: channelConfig(api, { BUILDIT_APPROVAL_TIMEOUT_MINUTES: '1' }),
      stdio: { approve: { msPerSecond: 10 }, typing: { everyMs: 60_000 } },
    });
    await waitFor(() => session().heartbeats.includes('online'));
    const id = approvalIdForToolUse('toolu_slow', '', 'Bash', inputHash(REAL));
    const now = new Date().toISOString();
    api.enqueue('/v1/session/approvals', {
      status: 201,
      delayMs: 500,
      body: {
        created: true,
        message: {
          id,
          conversation_id: '00000000-0000-4000-8000-000000007003',
          thread_id: null,
          reply_to_id: null,
          text: 'Claude wants to use `Bash`',
          created_at: now,
          session: { id: session().id, label: session().label },
        },
        approval: {
          id,
          status: 'open',
          tool_name: 'Bash',
          thread_id: null,
          created_at: now,
          closes_at: now,
        },
      },
    });
    const t0 = Date.now();
    const r = await approve(slow, { input: REAL, tool_use_id: 'toolu_slow' });
    const took = Date.now() - t0;
    expect(textOf(r)).toBe(permissionDeny(denyText('expired', '', 1)));
    // From the start of the call: about 600 ms, not 500 + 600.
    expect(took).toBeLessThan(950);
  });
});

describe('the journal', () => {
  it('keeps what another server wrote meanwhile, and leaves no temporary file', async () => {
    const c = await started({ journal: true });
    const other = '00000000-0000-4000-8000-00000000abcd';
    writeFileSync(
      journalPath(),
      JSON.stringify({ v: 1, open: [{ id: other, posted_at: '2026-10-29T10:00:00.000Z' }] }),
    );
    const p = approve(c, { input: REAL, tool_use_id: 'toolu_merge' });
    const a = await posted();
    expect(journalIds()).toEqual([other, a.id]);
    api.sessions.decideApproval(TOKEN, a.id, 'approve');
    await p;
    expect(journalIds()).toEqual([other]);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(existsSync(journalPath())).toBe(true);
  });
});

describe('a command too long to check in the app', () => {
  it("is posted cut; the owner's Deny tells Claude to split it or ask in the terminal", async () => {
    const c = await started();
    const command = j('npm run build && ', R('echo step && ', 400), 'echo done');
    const p = approve(c, { input: { command }, tool_use_id: 'toolu_long' });
    const a = await posted();
    const field = (a.posted.fields as { key: string; cut?: number }[])[0];
    expect(field?.cut).toBeGreaterThan(0);
    // The server gives such a card no approve buttons; Deny is the owner's answer there.
    api.sessions.decideApproval(TOKEN, a.id, 'deny');
    const r = await p;
    expect(textOf(r)).toBe(permissionDeny(denyText('too_long', session().ownerName, 59)));
    expect(r.structuredContent).toMatchObject({ status: 'denied', reason: 'too_long' });
    expect(denyText('too_long', 'Test User', 1)).toBe(
      'This command was too long to show in full in buildIt.Social, so Test User could not approve it there. Split it into shorter commands, or ask Test User to approve it in the terminal.',
    );
  });

  it('is only Bash or PowerShell: a long Write is denied as usual', async () => {
    const c = await started();
    const p = approve(c, {
      tool_name: 'Write',
      input: { file_path: 'a.md', content: R('x', 5000) },
      tool_use_id: 'toolu_write',
    });
    const a = await posted();
    api.sessions.decideApproval(TOKEN, a.id, 'deny');
    expect(textOf(await p)).toBe(permissionDeny(denyText('denied', session().ownerName, 59)));
  });
});

describe('switched off while it waits', () => {
  it('tells Claude approvals were switched off', async () => {
    const c = await started();
    const p = approve(c, { input: REAL, tool_use_id: 'toolu_off' });
    const a = await posted();
    api.sessions.endApproval(TOKEN, a.id, 'switched_off');
    const r = await p;
    expect(textOf(r)).toBe(
      permissionDeny(
        'Tool approvals in buildIt.Social were switched off before anyone answered, so this was not run.',
      ),
    );
    expect(r.structuredContent).toMatchObject({ status: 'closed', reason: 'switched_off' });
  });
});

describe('who asks', () => {
  let folder: string;
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'buildit-mcp-who-'));
  });
  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  it("is an item worker only by its exact name, never another plugin's agent of that name", async () => {
    const { demoItem } = await import('./support/fake-sessions.js');
    const item = demoItem(31);
    mkdirSync(join(folder, '.claude'), { recursive: true });
    writeFileSync(
      join(folder, '.claude', 'buildit-workers.json'),
      JSON.stringify({ workers: [{ agent_id: 'agent-w', item: item.key, thread_id: item.id }] }),
    );
    const c = await started({ env: { BUILDIT_FOLDER: folder } });
    api.sessions.assignItem(TOKEN, item);
    await waitFor(() => channelNotes(c.notes).length === 2);
    for (const [n, agentType, inItem] of [
      [1, 'buildit-item-worker', true],
      [2, 'buildit:buildit-item-worker', true],
      [3, 'other:buildit-item-worker', false],
      [4, 'buildit-item-worker-2', false],
    ] as const) {
      const p = call(c, 'approve', {
        tool_name: 'Bash',
        tool_input: JSON.stringify(REAL),
        tool_use_id: `toolu_who${n}`,
        agent_id: 'agent-w',
        agent_type: agentType,
      });
      const a = await posted(n);
      expect(a.posted.thread_id === item.id, agentType).toBe(inItem);
      api.sessions.decideApproval(TOKEN, a.id, 'approve');
      await p;
    }
  });

  it('sends the agent type only when it is a plain name of at most 64 characters', async () => {
    const c = await started();
    for (const [n, agentType, sent] of [
      [1, 'Explore', true],
      [2, 'my-plugin:reviewer_2.1', true],
      [3, 'Explore agent', false],
      [4, R('a', 65), false],
      [5, '-leading', false],
    ] as const) {
      const p = call(c, 'approve', {
        tool_name: 'Bash',
        tool_input: JSON.stringify(REAL),
        tool_use_id: `toolu_type${n}`,
        agent_id: 'agent-x',
        agent_type: agentType,
      });
      const a = await posted(n);
      expect(a.posted.agent, agentType).toEqual(
        sent ? { ref: 'agent-x', type: agentType } : { ref: 'agent-x' },
      );
      api.sessions.decideApproval(TOKEN, a.id, 'approve');
      await p;
    }
  });
});

describe('the hooks under --read-only', () => {
  it('lists the hooks that end approvals (no-ops there), not approve; their annotations say what they do', async () => {
    api.sessions.open(TOKEN);
    const c = await start({ env: { BUILDIT_READ_ONLY: 'true' } });
    const { tools } = await c.client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.has('approve')).toBe(false);
    for (const name of ['tool_seen', 'tool_done', 'agent_done', 'prompt_typed', 'turn_ended']) {
      expect(byName.has(name), name).toBe(true);
    }
    expect(byName.get('tool_seen')?.annotations?.readOnlyHint).toBe(true);
    for (const name of ['tool_done', 'agent_done', 'prompt_typed']) {
      expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(false);
    }
    expect(textOf(await call(c, 'tool_done', { tool_use_id: 'toolu_x' }))).toBe('{}');
  });
});

describe('an event that names another approval', () => {
  it('is not a verdict: the state is read instead', async () => {
    const c = await started();
    const p = approve(c, { input: REAL, tool_use_id: 'toolu_evt' });
    const a = await posted();
    const before = api.requests.length;
    api.sessions.decideApproval(TOKEN, a.id, 'deny', {
      eventApprovalId: '00000000-0000-4000-8000-00000000beef',
    });
    expect(textOf(await p)).toContain('"behavior":"deny"');
    // The verdict came from GET, not from the event.
    expect(
      api.requests
        .slice(before)
        .some((r) => r.method === 'GET' && r.path === `/v1/session/approvals/${a.id}`),
    ).toBe(true);
  });
});
