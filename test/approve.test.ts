/**
 * Tool approvals, end to end in process: the plugin's PermissionRequest
 * hook (`approve`) against the fake API's sessions playing the owner. Each
 * hook answer is checked byte for byte; then the cases where the hook
 * passes, a repeated call, the owner's tap racing the deadline, the
 * deadline, a cancelled call, the session's end, the item taken away, the
 * state read when an event was missed, "is writing", and where the card
 * goes (the main agent, an item worker, another subagent).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { CallToolResult } from '@modelcontextprotocol/client';

import {
  approvalIdForToolUse,
  denyText,
  HOOK_PASS,
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
import { parseCli } from '../src/config.js';
import { hookWaitSeconds } from '../src/transports/stdio.js';
import { FakeApi } from './support/fake-api.js';
import { demoItem, SESSION_TOKENS } from './support/fake-sessions.js';

const TOKEN = SESSION_TOKENS.first;
const j = (...p: string[]): string => p.join('');

let api: FakeApi;
const stops: (() => Promise<void>)[] = [];

beforeAll(async () => {
  api = await new FakeApi().start();
});
afterAll(async () => {
  await api.close();
});
beforeEach(() => {
  api.reset();
});
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
  expect(api.violations).toEqual([]);
});

const session = () => api.sessions.session(TOKEN);
const approvals = () => api.sessions.approvals(TOKEN);
const textOf = (r: CallToolResult): string =>
  (r.content as { type: string; text: string }[]).map((c) => c.text).join('\n');
const structuredOf = (r: CallToolResult) =>
  r.structuredContent as { status: string; reason?: string; message_id: string | null };

/** A channel server; approve waits `msPerSecond` ms per second of its wait. */
async function start(
  options: { env?: Record<string, string>; msPerSecond?: number; owner?: boolean } = {},
): Promise<ChannelClient> {
  return startChannel(api, stops, {
    config: channelConfig(api, options.env),
    stdio: {
      approve: { msPerSecond: options.msPerSecond ?? 2 },
      ...(options.owner === undefined ? {} : { channelOwner: options.owner }),
      typing: { everyMs: 60_000 },
    },
  });
}

/** Waits until the nth server has said the session is online (the session is known). */
async function ready(n = 1): Promise<void> {
  await waitFor(() => session().heartbeats.filter((h) => h === 'online').length >= n);
}

/** A session with the owner's first message delivered: the main agent works in its thread. */
async function started(
  options: Parameters<typeof start>[0] = {},
): Promise<{ c: ChannelClient; root: string }> {
  api.sessions.open(TOKEN);
  const c = await start(options);
  await ready();
  const root = api.sessions.postFrom(TOKEN, 'Run the tests, please.');
  await waitFor(() => channelNotes(c.notes).length === 1);
  return { c, root };
}

const BASH = { command: 'npm test', description: 'Run the tests' };

/** Calls approve as the hook does: tool_input as JSON text, the fields Claude Code fills in. */
function hookApprove(
  c: ChannelClient,
  init: {
    tool_name?: string;
    tool_input?: unknown;
    tool_use_id?: string;
    agent_id?: string;
    agent_type?: string;
    suggestions?: unknown;
    prompt_id?: string;
  } = {},
  signal?: AbortSignal,
) {
  return c.client.callTool(
    {
      name: 'approve',
      arguments: {
        tool_name: init.tool_name ?? 'Bash',
        tool_input:
          typeof init.tool_input === 'string'
            ? init.tool_input
            : JSON.stringify(init.tool_input ?? BASH),
        tool_use_id: init.tool_use_id ?? 'toolu_01A',
        agent_id: init.agent_id ?? '',
        agent_type: init.agent_type ?? '',
        session_id: 'claude-session-1',
        prompt_id: init.prompt_id ?? 'prompt-1',
        suggestions:
          typeof init.suggestions === 'string'
            ? init.suggestions
            : JSON.stringify(init.suggestions ?? []),
        mode: 'default',
      },
    },
    signal === undefined ? undefined : { signal },
  );
}

/** Waits for the nth approval post and returns it. */
async function posted(n = 1) {
  await waitFor(() => approvals().length >= n);
  return approvals()[n - 1]!;
}

const RULE = {
  type: 'addRules',
  rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
  behavior: 'allow',
  destination: 'session',
};

describe('the settings', () => {
  it('reads BUILDIT_APPROVALS_IN_APP and BUILDIT_APPROVAL_TIMEOUT_MINUTES, keeping the defaults on bad values', () => {
    const config = (env: Record<string, string>) => {
      const action = parseCli(['--channel'], { BUILDIT_TOKEN: TOKEN, ...env });
      if (action.kind !== 'run') throw new Error('expected a run action');
      return action.config;
    };
    expect(config({}).approvals).toEqual({ inApp: true, timeoutMinutes: 60 });
    expect(
      config({ BUILDIT_APPROVALS_IN_APP: 'false', BUILDIT_APPROVAL_TIMEOUT_MINUTES: '5' })
        .approvals,
    ).toEqual({ inApp: false, timeoutMinutes: 5 });
    const bad = config({
      BUILDIT_APPROVALS_IN_APP: 'maybe',
      BUILDIT_APPROVAL_TIMEOUT_MINUTES: '90',
    });
    expect(bad.approvals).toEqual({ inApp: true, timeoutMinutes: 60 });
    expect(bad.warnings).toHaveLength(2);
    // The wait sent: the minutes, at most a minute under the hook's 3,600 s.
    expect(hookWaitSeconds(60)).toBe(3540);
    expect(hookWaitSeconds(1)).toBe(60);
  });
});

describe('the hook answers (byte for byte)', () => {
  it('approved', () => {
    expect(permissionAllow()).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}',
    );
  });

  it('approved for the session: the rule, a rule without content leaves the key out, and accept edits', () => {
    expect(permissionAllow(RULE as never)).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedPermissions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"npm test:*"}],"behavior":"allow","destination":"session"}]}}}',
    );
    expect(permissionAllow({ ...RULE, rules: [{ toolName: 'Read' }] } as never)).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedPermissions":[{"type":"addRules","rules":[{"toolName":"Read"}],"behavior":"allow","destination":"session"}]}}}',
    );
    expect(permissionAllow({ type: 'setMode', mode: 'acceptEdits', destination: 'session' })).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedPermissions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}]}}}',
    );
  });

  it('denied, expired, the session ended, unassigned, closed', () => {
    const deny = (message: string): string =>
      `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":${JSON.stringify(message)}}}}`;
    expect(permissionDeny(denyText('denied', 'Test User', 60))).toBe(
      deny("Test User denied this in buildIt.Social. Don't retry it; ask them what to do instead."),
    );
    expect(permissionDeny(denyText('expired', 'Test User', 60))).toBe(
      deny(
        "Nobody approved this in buildIt.Social within 60 minutes, so it was not run. Don't retry it now: stop and tell the person what you need, or do the task another way.",
      ),
    );
    expect(denyText('expired', 'Test User', 1)).toContain('within 1 minute, so');
    expect(permissionDeny(denyText('session_ended', 'Test User', 60))).toBe(
      deny(
        'The buildIt.Social session ended before anyone approved this, so it was not run. Stop and tell the person in this terminal what you need.',
      ),
    );
    expect(permissionDeny(denyText('unassigned', 'Test User', 60))).toBe(
      deny(
        'You were taken off this work item in buildIt.Social, so this was not run. Stop work on it.',
      ),
    );
    expect(permissionDeny(denyText('closed', 'Test User', 60))).toBe(
      deny(
        'The approval card was closed in buildIt.Social before anyone answered, so this was not run. Ask the person what to do.',
      ),
    );
    expect(HOOK_PASS).toBe('{}');
  });
});

describe('approve', () => {
  it("posts the main agent's card in its direct-message thread, and allows the call on the owner's Approve", async () => {
    const { c, root } = await started();
    const pending = hookApprove(c, {
      tool_input: {
        command: j('GITHUB_TOK', 'EN=', 'q1'.repeat(10), ' npm test'),
        description: 'Run the tests',
      },
    });
    const a = await posted();
    expect(a.id).toBe(approvalIdForToolUse('toolu_01A'));
    expect(a.posted).toEqual({
      id: a.id,
      thread_id: root,
      tool_name: 'Bash',
      tool_use_id: 'toolu_01A',
      description: 'Run the tests',
      fields: [{ key: 'command', value: 'GITHUB_TOKEN=[REDACTED] npm test' }],
      wait_s: 3540,
    });
    // "is writing" stops while the card waits.
    await waitFor(() => session().typings.some((t) => t.thread_id === root && !t.typing));
    const before = session().typings.length;
    api.sessions.decideApproval(TOKEN, a.id, 'approve');
    const r = await pending;
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toBe(permissionAllow());
    expect(structuredOf(r)).toEqual({ status: 'approved', message_id: a.id });
    // It works again there; the card was never closed by the session.
    await waitFor(() =>
      session()
        .typings.slice(before)
        .some((t) => t.thread_id === root && t.typing),
    );
    expect(approvals()[0]?.closes).toEqual([]);
  });

  it('allows for the session with the rule it offered (cleaned), never the one an event names', async () => {
    const { c } = await started();
    const offered = [
      { type: 'addDirectories', directories: ['C:\\work'], destination: 'session' },
      {
        ...RULE,
        rules: [
          { toolName: 'Bash', ruleContent: j('npm', String.fromCharCode(0x200b), ' test:*') },
        ],
      },
    ];
    const pending = hookApprove(c, { suggestions: offered });
    const a = await posted();
    expect(a.posted.suggestion).toEqual(RULE);
    api.sessions.decideApproval(TOKEN, a.id, 'approve_session');
    const r = await pending;
    expect(textOf(r)).toBe(permissionAllow(RULE as never));
    expect(structuredOf(r).status).toBe('approved_session');
  });

  it("denies with the owner's name on Deny", async () => {
    const { c } = await started();
    const pending = hookApprove(c);
    const a = await posted();
    api.sessions.decideApproval(TOKEN, a.id, 'deny');
    const r = await pending;
    expect(textOf(r)).toBe(permissionDeny(denyText('denied', session().ownerName, 60)));
    expect(structuredOf(r).status).toBe('denied');
  });

  it('offers no rule when Claude Code suggests none that is session-scoped', async () => {
    const { c } = await started();
    const pending = hookApprove(c, {
      suggestions: [{ ...RULE, destination: 'localSettings' }],
    });
    const a = await posted();
    expect(a.posted.suggestion).toBeUndefined();
    api.sessions.decideApproval(TOKEN, a.id, 'approve');
    expect(textOf(await pending)).toBe(permissionAllow());
  });

  it('expires at its deadline: closes the card, and Claude is told no', async () => {
    const { c } = await started({
      env: { BUILDIT_APPROVAL_TIMEOUT_MINUTES: '1' },
      msPerSecond: 5,
    });
    const r = await hookApprove(c);
    const a = approvals()[0]!;
    expect(a.posted.wait_s).toBe(60);
    expect(a.closes).toEqual(['expired']);
    expect(textOf(r)).toBe(permissionDeny(denyText('expired', session().ownerName, 1)));
    expect(structuredOf(r)).toEqual({ status: 'expired', reason: 'client', message_id: a.id });
  });

  it("takes the owner's tap when it raced the deadline (the close answers the verdict)", async () => {
    const { c } = await started({
      env: { BUILDIT_APPROVAL_TIMEOUT_MINUTES: '1' },
      msPerSecond: 5,
    });
    const pending = hookApprove(c);
    const a = await posted();
    // Tapped, but the event hasn't arrived before the deadline.
    api.sessions.decideApproval(TOKEN, a.id, 'approve', { withEvent: false });
    const r = await pending;
    expect(textOf(r)).toBe(permissionAllow());
  });

  it('reads the state when an event was missed (every 120 s)', async () => {
    const { c } = await started({ msPerSecond: 1 });
    const pending = hookApprove(c);
    const a = await posted();
    api.sessions.decideApproval(TOKEN, a.id, 'deny', { withEvent: false });
    const r = await pending;
    expect(textOf(r)).toBe(permissionDeny(denyText('denied', session().ownerName, 60)));
  });

  it('closes the card as interrupted when the call is cancelled', async () => {
    const { c } = await started();
    const abort = new AbortController();
    const pending = hookApprove(c, {}, abort.signal).catch(() => 'cancelled');
    const a = await posted();
    abort.abort();
    expect(await pending).toBe('cancelled');
    await waitFor(() => approvals()[0]?.closes.length === 1);
    expect(approvals()[0]?.closes).toEqual(['interrupted']);
    expect(approvals()[0]?.status).toBe('closed');
    expect(a.id).toBe(approvals()[0]?.id);
  });

  it('denies when the server closes it: the session ended, the message deleted, expiry on the server', async () => {
    const { c } = await started();
    for (const [n, by, text, status] of [
      [1, 'session_ended', denyText('session_ended', '', 60), 'closed'],
      [2, 'deleted', denyText('closed', '', 60), 'closed'],
      // The card's wait is 3,540 s: Claude reads 59 minutes.
      [3, 'time', denyText('expired', '', 59), 'expired'],
    ] as const) {
      const pending = hookApprove(c, { tool_use_id: `toolu_end_${n}` });
      const a = await posted(n);
      api.sessions.endApproval(TOKEN, a.id, by);
      const r = await pending;
      expect(textOf(r), by).toBe(permissionDeny(text));
      expect(structuredOf(r).status, by).toBe(status);
    }
  });

  it('denies with the session ended when it ends for good while waiting', async () => {
    const { c } = await started();
    const pending = hookApprove(c);
    await posted();
    api.sessions.revoke(TOKEN);
    const r = await pending;
    expect(textOf(r)).toBe(permissionDeny(denyText('session_ended', '', 60)));
  });

  it('answers a repeated call for the same tool call with the same verdict, posting once', async () => {
    const { c } = await started();
    const first = hookApprove(c);
    const a = await posted();
    api.sessions.decideApproval(TOKEN, a.id, 'approve');
    expect(textOf(await first)).toBe(permissionAllow());
    const again = await hookApprove(c);
    expect(textOf(again)).toBe(permissionAllow());
    expect(approvals()).toHaveLength(1);
  });

  it('takes the verdict at once when the server already has one (a restart, a replayed post)', async () => {
    const { c } = await started();
    const first = hookApprove(c, { tool_use_id: 'toolu_old' });
    const a = await posted();
    api.sessions.decideApproval(TOKEN, a.id, 'deny');
    await first;
    // A new server for the same session: it doesn't remember, the replayed post answers.
    await Promise.all(stops.splice(0).map((stop) => stop()));
    const c2 = await start();
    await ready(2);
    const r = await hookApprove(c2, { tool_use_id: 'toolu_old' });
    expect(textOf(r)).toBe(permissionDeny(denyText('denied', session().ownerName, 60)));
    expect(approvals()).toHaveLength(1);
  });

  it('two hook calls for one tool call wait on one card, and both get the verdict', async () => {
    const { c } = await started();
    const one = hookApprove(c);
    const two = hookApprove(c);
    const a = await posted();
    await waitFor(() => c.logs.filter((l) => l.includes('tool approval posted')).length === 2);
    api.sessions.decideApproval(TOKEN, a.id, 'approve');
    expect(textOf(await one)).toBe(permissionAllow());
    expect(textOf(await two)).toBe(permissionAllow());
    expect(approvals()).toHaveLength(1);
  });

  it('reports progress on a long wait', async () => {
    const { c } = await started({ msPerSecond: 2 });
    const progress: string[] = [];
    const pending = c.client.callTool(
      {
        name: 'approve',
        arguments: { tool_name: 'Bash', tool_input: JSON.stringify(BASH), tool_use_id: 'toolu_p' },
      },
      {
        onprogress: (p) => {
          progress.push(String(p.message));
        },
      },
    );
    const a = await posted();
    await waitFor(() => progress.length >= 2);
    api.sessions.decideApproval(TOKEN, a.id, 'approve');
    await pending;
    expect(progress[0]).toContain("Waiting for the person's approval");
  });
});

describe('when approve passes ({}: the terminal decides)', () => {
  it('passes with approvals in the app off, for AskUserQuestion, a bad tool name or input', async () => {
    const { c } = await started({ env: { BUILDIT_APPROVALS_IN_APP: 'false' } });
    const off = await hookApprove(c);
    expect(textOf(off)).toBe('{}');
    expect(structuredOf(off)).toEqual({
      status: 'passed',
      reason: 'approvals_in_app_off',
      message_id: null,
    });
    await Promise.all(stops.splice(0).map((stop) => stop()));
    const c2 = await start();
    await ready(2);
    for (const [init, reason] of [
      [{ tool_name: 'AskUserQuestion' }, 'ask_user_question'],
      [{ tool_name: 'bad name' }, 'tool_name'],
      [{ tool_name: '${tool_name}' }, 'tool_name'],
      [{ tool_input: 'not json' }, 'tool_input'],
      [{ tool_input: '[1, 2]' }, 'tool_input'],
    ] as const) {
      const r = await hookApprove(c2, init);
      expect(textOf(r), reason).toBe('{}');
      expect(structuredOf(r).reason, reason).toBe(reason);
    }
    expect(approvals()).toEqual([]);
  });

  it("passes in a server that isn't the folder's channel", async () => {
    api.sessions.open(TOKEN);
    const c = await start({ owner: false });
    const r = await hookApprove(c);
    expect(structuredOf(r).reason).toBe('not_the_channel');
  });

  it('passes before the session is known, and after it ended', async () => {
    const c = await start();
    expect(structuredOf(await hookApprove(c)).reason).toBe('no_session');
    await Promise.all(stops.splice(0).map((stop) => stop()));
    api.sessions.open(TOKEN);
    const c2 = await start();
    await ready();
    api.sessions.revoke(TOKEN);
    await waitFor(() => c2.logs.join('\n').includes('polling stopped'));
    expect(structuredOf(await hookApprove(c2)).reason).toBe('no_session');
  });

  it('passes when the post is refused (switched off, too many open, the platform switch)', async () => {
    const { c } = await started();
    api.sessions.approvalRefusals.push(
      { code: 'approvals_off', details: { by: 'agent' } },
      { code: 'approvals_off', details: { by: 'platform' } },
      { code: 'too_many_open', details: { open: 10 } },
    );
    for (const n of [1, 2, 3]) {
      const r = await hookApprove(c, { tool_use_id: `toolu_r${n}` });
      expect(textOf(r)).toBe('{}');
      expect(structuredOf(r).reason).toBe('post_failed');
    }
    // Nothing waits, nothing is open.
    const r = hookApprove(c, { tool_use_id: 'toolu_ok' });
    const a = await posted();
    api.sessions.decideApproval(TOKEN, a.id, 'approve');
    expect(textOf(await r)).toBe(permissionAllow());
  });
});

describe('where the card goes', () => {
  let folder: string;
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'buildit-mcp-approve-'));
  });
  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  function table(workers: Record<string, string>[]): void {
    mkdirSync(join(folder, '.claude'), { recursive: true });
    writeFileSync(join(folder, '.claude', 'buildit-workers.json'), JSON.stringify({ workers }));
  }

  it("an item worker in the lead's table asks in its item's thread", async () => {
    const item = demoItem(12);
    table([{ agent_id: 'agent-w1', item: item.key, thread_id: item.id }]);
    const { c } = await started({ env: { BUILDIT_FOLDER: folder } });
    api.sessions.assignItem(TOKEN, item);
    await waitFor(() => channelNotes(c.notes).length === 2);
    const pending = hookApprove(c, {
      agent_id: 'agent-w1',
      agent_type: 'buildit:buildit-item-worker',
      tool_name: 'Write',
      tool_input: { file_path: 'a.md', content: 'x' },
    });
    const a = await posted();
    expect(a.posted.thread_id).toBe(item.id);
    expect(a.posted.agent).toEqual({ ref: 'agent-w1', type: 'buildit:buildit-item-worker' });
    api.sessions.decideApproval(TOKEN, a.id, 'approve');
    expect(textOf(await pending)).toBe(permissionAllow());
  });

  it("is denied as unassigned when the worker's item is taken away while it waits", async () => {
    const item = demoItem(13);
    table([{ agent_id: 'agent-w2', item: item.key, thread_id: item.id }]);
    const { c } = await started({ env: { BUILDIT_FOLDER: folder } });
    api.sessions.assignItem(TOKEN, item);
    await waitFor(() => channelNotes(c.notes).length === 2);
    const pending = hookApprove(c, {
      agent_id: 'agent-w2',
      agent_type: 'buildit:buildit-item-worker',
    });
    await posted();
    api.sessions.unassignItem(TOKEN, item);
    const r = await pending;
    expect(textOf(r)).toBe(permissionDeny(denyText('unassigned', '', 60)));
    expect(structuredOf(r)).toMatchObject({ status: 'closed', reason: 'unassigned' });
  });

  it("asks in the direct message, labelled, when the item's thread refuses it", async () => {
    const item = demoItem(14);
    // In the table, but the session doesn't work in the item's thread (not bound).
    table([{ agent_id: 'agent-w3', item: item.key, thread_id: item.id }]);
    const { c, root } = await started({ env: { BUILDIT_FOLDER: folder } });
    api.sessions.assignItem(TOKEN, item);
    await waitFor(() => channelNotes(c.notes).length === 2);
    api.sessions.unassignItem(TOKEN, item);
    await waitFor(() => channelNotes(c.notes).length === 3);
    const pending = hookApprove(c, {
      agent_id: 'agent-w3',
      agent_type: 'buildit:buildit-item-worker',
    });
    const a = await posted();
    expect(a.posted.thread_id).toBe(root);
    expect(a.posted.agent).toEqual({ ref: 'agent-w3', type: 'buildit:buildit-item-worker' });
    expect(c.logs.join('\n')).toContain('tool approval moved to the direct message');
    api.sessions.decideApproval(TOKEN, a.id, 'approve');
    expect(textOf(await pending)).toBe(permissionAllow());
  });

  it("asks in the direct message for a worker the table doesn't name, and for another subagent", async () => {
    table([]);
    const { c, root } = await started({ env: { BUILDIT_FOLDER: folder } });
    for (const [n, agent_type] of [
      [1, 'buildit:buildit-item-worker'],
      [2, 'Explore'],
    ] as const) {
      const pending = hookApprove(c, {
        agent_id: `agent-s${n}`,
        agent_type,
        tool_use_id: `toolu_s${n}`,
      });
      const a = await posted(n);
      expect(a.posted.thread_id).toBe(root);
      expect(a.posted.agent).toEqual({ ref: `agent-s${n}`, type: agent_type });
      api.sessions.decideApproval(TOKEN, a.id, 'approve');
      expect(textOf(await pending)).toBe(permissionAllow());
    }
  });

  it('asks the main agent at the top of the direct message before the owner wrote', async () => {
    api.sessions.open(TOKEN);
    const c = await start();
    await ready();
    const pending = hookApprove(c);
    const a = await posted();
    expect(a.posted.thread_id).toBeUndefined();
    expect(a.posted.agent).toBeUndefined();
    api.sessions.decideApproval(TOKEN, a.id, 'approve');
    expect(textOf(await pending)).toBe(permissionAllow());
  });
});
