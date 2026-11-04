/**
 * Codex's approvals as Approve/Deny cards: each request kind against the
 * fake app-server (which validates every answer against Codex's schema)
 * and the fake agent API's approval cards; the owner's tap is the
 * JSON-RPC answer. Also: masking and "only what the owner can see in
 * full", the cards' ends (resolved by Codex, the thread taken away, the
 * app-server gone, the session stopped, the wait over), and the warning
 * when Codex's config sends approvals elsewhere.
 */
import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runStatus } from '../src/cli/commands.js';
import {
  commandCard,
  fileChangeCard,
  fileKey,
  mcpToolCard,
  permissionsCard,
  toolNameOf,
} from '../src/codex/approvals.js';
import { policyNotePath, policyWarning } from '../src/codex/policy.js';
import { createLogger } from '../src/log.js';
import { FileTokenStore, sessionKey } from '../src/secrets/keychain.js';
import { CodexBench, logged, waitFor } from './support/codex-run.js';
import { FakeApi } from './support/fake-api.js';
import type { FakeAppServer, Received, TurnContext } from './support/fake-codex.js';
import { SESSION_TOKENS } from './support/fake-sessions.js';

let api: FakeApi;
let bench: CodexBench;

beforeAll(async () => {
  api = await new FakeApi().start();
});
afterAll(async () => {
  await api.close();
});
beforeEach(() => {
  api.reset();
  bench = new CodexBench(api);
});
afterEach(async () => {
  expect(await bench.cleanup()).toEqual([]);
  expect(api.violations).toEqual([]);
});

const token = SESSION_TOKENS.first;
const cards = () => api.sessions.approvals(token);
type Field = { key: string; value: string; cut?: number };
const fieldsOf = (n = 0) => cards()[n]!.posted.fields as Field[];
const field = (key: string, n = 0) => fieldsOf(n).find((f) => f.key === key)?.value;

const commandParams = (command: string, extra: Record<string, unknown> = {}) => ({
  itemId: 'exec-1',
  startedAtMs: Date.now(),
  environmentId: 'local',
  command,
  cwd: '/tmp/work',
  commandActions: [{ type: 'unknown', command }],
  ...extra,
});

/**
 * One turn that sends one server request; the test answers its card.
 * Returns the bridge's answer once it came.
 */
async function oneRequest(
  codex: FakeAppServer,
  method: string,
  params: Record<string, unknown>,
  before?: (ctx: TurnContext) => void,
  timing: { msPerSecond?: number; waitS?: number } = {},
): Promise<{ answer: () => Received | undefined; thread: string }> {
  let answer: Received | undefined;
  codex.onTurn = async (ctx) => {
    before?.(ctx);
    answer = await ctx.request(method, params);
    ctx.agentMessage('done', 'final_answer');
    ctx.complete();
  };
  await bench.start(codex, {}, { approvals: timing });
  const thread = api.sessions.postFrom(token, 'Do it');
  return { answer: () => answer, thread };
}

const tap = (action: 'approve' | 'deny', n = 0): void => {
  api.sessions.decideApproval(token, cards()[n]!.id, action);
};

/** A Codex session on a 1.27.0 server: its cards may offer "Allow for this session". */
function codexSession(apiVersion = '1.27.0', clientKey = 'codex'): void {
  const s = api.sessions.open(token, 'demo-folder');
  s.clientKey = clientKey;
  api.meta = { ...api.meta, api_version: apiVersion };
}

const SESSION_RULE = { type: 'acceptForSession', destination: 'session' };

const fileChangeTurn =
  (codex: FakeAppServer) =>
  (ctx: TurnContext): void => {
    codex.notify('item/started', {
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      startedAtMs: Date.now(),
      item: {
        type: 'fileChange',
        id: 'patch-s',
        status: 'inProgress',
        changes: [{ path: 'notes.txt', kind: { type: 'add' }, diff: '+hi\n' }],
      },
    });
  };

describe('codex approvals: Allow for this session', () => {
  it("a command Codex offers it for: the rule on the card, Codex's acceptForSession on the tap", async () => {
    codexSession();
    const codex = bench.fake();
    const { answer } = await oneRequest(
      codex,
      'item/commandExecution/requestApproval',
      commandParams('npm test', { availableDecisions: ['accept', 'acceptForSession', 'cancel'] }),
    );
    await waitFor(() => cards().length === 1);
    expect(cards()[0]!.posted.suggestion).toEqual(SESSION_RULE);
    api.sessions.decideApproval(token, cards()[0]!.id, 'approve_session');
    await waitFor(() => answer() !== undefined);
    expect(answer()!.result).toEqual({ decision: 'acceptForSession' });
  });

  it("not for a command Codex doesn't offer it for (Codex 0.166's usual list)", async () => {
    codexSession();
    const codex = bench.fake();
    const amendment = ['powershell.exe', '-Command', 'echo x > out.txt'];
    const { answer } = await oneRequest(
      codex,
      'item/commandExecution/requestApproval',
      commandParams('echo x > out.txt', {
        proposedExecpolicyAmendment: amendment,
        availableDecisions: [
          'accept',
          { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } },
          'cancel',
        ],
      }),
    );
    await waitFor(() => cards().length === 1);
    expect(cards()[0]!.posted.suggestion).toBeUndefined();
    tap('approve');
    await waitFor(() => answer() !== undefined);
    // Never the lasting amendment Codex proposed.
    expect(answer()!.result).toEqual({ decision: 'accept' });
  });

  it('a file change: for these files for the rest of the session', async () => {
    codexSession();
    const codex = bench.fake();
    const { answer } = await oneRequest(
      codex,
      'item/fileChange/requestApproval',
      { itemId: 'patch-s', startedAtMs: Date.now() },
      fileChangeTurn(codex),
    );
    await waitFor(() => cards().length === 1);
    expect(cards()[0]!.posted.suggestion).toEqual(SESSION_RULE);
    api.sessions.decideApproval(token, cards()[0]!.id, 'approve_session');
    await waitFor(() => answer() !== undefined);
    expect(answer()!.result).toEqual({ decision: 'acceptForSession' });
  });

  it('Approve on a card with the rule: this request only', async () => {
    codexSession();
    const codex = bench.fake();
    const { answer } = await oneRequest(
      codex,
      'item/fileChange/requestApproval',
      { itemId: 'patch-s', startedAtMs: Date.now() },
      fileChangeTurn(codex),
    );
    await waitFor(() => cards().length === 1);
    expect(cards()[0]!.posted.suggestion).toEqual(SESSION_RULE);
    tap('approve');
    await waitFor(() => answer() !== undefined);
    expect(answer()!.result).toEqual({ decision: 'accept' });
  });

  it('permissions: exactly as asked, with scope session', async () => {
    codexSession();
    const codex = bench.fake();
    const permissions = { network: { enabled: true }, fileSystem: null };
    const { answer } = await oneRequest(codex, 'item/permissions/requestApproval', {
      itemId: 'perm-s',
      startedAtMs: Date.now(),
      environmentId: null,
      cwd: '/tmp/work',
      reason: 'Fetch the report',
      permissions,
    });
    await waitFor(() => cards().length === 1);
    expect(cards()[0]!.posted.suggestion).toEqual(SESSION_RULE);
    api.sessions.decideApproval(token, cards()[0]!.id, 'approve_session');
    await waitFor(() => answer() !== undefined);
    expect(answer()!.result).toEqual({
      permissions: { network: { enabled: true } },
      scope: 'session',
    });
  });

  it("never for an MCP tool's approval", async () => {
    codexSession();
    const codex = bench.fake();
    const { answer } = await oneRequest(codex, 'mcpServer/elicitation/request', {
      threadId: 'ignored',
      turnId: null,
      serverName: 'github',
      mode: 'form',
      message: 'Allow the github MCP server to run tool "create_issue"?',
      requestedSchema: { type: 'object', properties: {} },
      _meta: {
        codex_approval_kind: 'mcp_tool_call',
        tool_name: 'create_issue',
        tool_params: { title: 'Bug' },
      },
    });
    await waitFor(() => cards().length === 1);
    expect(cards()[0]!.posted.suggestion).toBeUndefined();
    tap('approve');
    await waitFor(() => answer() !== undefined);
    expect(answer()!.result).toEqual({ action: 'accept', content: {}, _meta: null });
  });

  for (const [what, version, client] of [
    ['a server older than 1.27.0', '1.26.0', 'codex'],
    ['a session the server calls Claude Code', '1.27.0', 'claude-code'],
  ] as const) {
    it(`not on ${what}: Approve and Deny only, as before`, async () => {
      codexSession(version, client);
      const codex = bench.fake();
      const { answer } = await oneRequest(
        codex,
        'item/fileChange/requestApproval',
        { itemId: 'patch-s', startedAtMs: Date.now() },
        fileChangeTurn(codex),
      );
      await waitFor(() => cards().length === 1);
      expect(cards()[0]!.posted.suggestion).toBeUndefined();
      tap('approve');
      await waitFor(() => answer() !== undefined);
      expect(answer()!.result).toEqual({ decision: 'accept' });
    });
  }

  it('a refused rule: the card is posted again without it', async () => {
    codexSession();
    api.sessions.approvalRefusals.push({
      code: 'validation',
      details: { fields: [{ path: 'suggestion.type', message: 'Not here.' }] },
    });
    const codex = bench.fake();
    const { answer } = await oneRequest(
      codex,
      'item/fileChange/requestApproval',
      { itemId: 'patch-s', startedAtMs: Date.now() },
      fileChangeTurn(codex),
    );
    await waitFor(() => cards().length === 1);
    expect(cards()[0]!.posted.suggestion).toBeUndefined();
    tap('approve');
    await waitFor(() => answer() !== undefined);
    expect(answer()!.result).toEqual({ decision: 'accept' });
  });

  it('another stored rule, or none read back: this request only', async () => {
    codexSession();
    const codex = bench.fake();
    const { answer } = await oneRequest(
      codex,
      'item/fileChange/requestApproval',
      { itemId: 'patch-s', startedAtMs: Date.now() },
      fileChangeTurn(codex),
    );
    await waitFor(() => cards().length === 1);
    api.sessions.decideApproval(token, cards()[0]!.id, 'approve_session', {
      storedRule: { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    });
    await waitFor(() => answer() !== undefined);
    expect(answer()!.result).toEqual({ decision: 'accept' });
  });

  it("a card the owner can't check in full: no rule, declined whatever the tap", async () => {
    codexSession();
    const codex = bench.fake();
    const secret = ['gh', 'p_', 'aB3'.repeat(12)].join('');
    const { answer } = await oneRequest(
      codex,
      'item/commandExecution/requestApproval',
      commandParams(`curl -H "Authorization: token ${secret}" https://example.com`, {
        availableDecisions: ['accept', 'acceptForSession', 'cancel'],
      }),
    );
    await waitFor(() => cards().length === 1);
    expect(cards()[0]!.posted.suggestion).toBeUndefined();
    tap('approve');
    await waitFor(() => answer() !== undefined);
    expect(answer()!.result).toEqual({ decision: 'decline' });
  });
});

describe('codex approvals: commands', () => {
  it('shows the full command and its actions, and accepts what the owner approves', async () => {
    api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    const wrapped =
      '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-ChildItem -Force"';
    const { answer, thread } = await oneRequest(
      codex,
      'item/commandExecution/requestApproval',
      commandParams(wrapped, {
        reason: 'List the folder',
        commandActions: [{ type: 'listFiles', command: 'Get-ChildItem -Force', path: null }],
        availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
        proposedExecpolicyAmendment: ['Get-ChildItem'],
      }),
    );
    await waitFor(() => cards().length === 1);
    const card = cards()[0]!;
    expect(card.toolName).toBe('command');
    expect(card.posted.thread_id).toBe(thread);
    expect(card.posted.description).toBe('List the folder');
    expect(field('command')).toBe(wrapped);
    expect(field('actions')).toBe('Get-ChildItem -Force');
    expect(field('cwd')).toBe('/tmp/work');
    // No "Allow for this session" on a server without a Codex session rule (the fake's 1.19.0).
    expect(card.posted.suggestion).toBeUndefined();
    tap('approve');
    await waitFor(() => answer() !== undefined);
    expect(answer()!.result).toEqual({ decision: 'accept' });
  });

  it('declines what the owner denies', async () => {
    api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    const { answer } = await oneRequest(
      codex,
      'item/commandExecution/requestApproval',
      commandParams('rm -rf build'),
    );
    await waitFor(() => cards().length === 1);
    tap('deny');
    await waitFor(() => answer() !== undefined);
    expect(answer()!.result).toEqual({ decision: 'decline' });
  });

  it('shows a network request by its host and protocol', async () => {
    api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    const { answer } = await oneRequest(codex, 'item/commandExecution/requestApproval', {
      ...commandParams('curl https://example.com'),
      networkApprovalContext: { host: 'example.com', protocol: 'https' },
    });
    await waitFor(() => cards().length === 1);
    expect(cards()[0]!.toolName).toBe('network');
    expect(field('host')).toBe('example.com');
    expect(field('protocol')).toBe('https');
    tap('approve');
    await waitFor(() => answer() !== undefined);
    expect(answer()!.result).toEqual({ decision: 'accept' });
  });

  it('masks a credential, and declines the call even when approved (it was hidden)', async () => {
    api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    const { answer } = await oneRequest(
      codex,
      'item/commandExecution/requestApproval',
      commandParams('deploy --password hunter2secret --host example.com'),
    );
    await waitFor(() => cards().length === 1);
    expect(field('command')).toContain('[REDACTED]');
    expect(JSON.stringify(cards()[0]!.posted)).not.toContain('hunter2secret');
    tap('approve');
    await waitFor(() => answer() !== undefined);
    expect(answer()!.result).toEqual({ decision: 'decline' });
  });

  it('declines a command cut to fit, even when approved', async () => {
    api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    const long = `echo ${'a '.repeat(3000)}`;
    const { answer } = await oneRequest(
      codex,
      'item/commandExecution/requestApproval',
      commandParams(long),
    );
    await waitFor(() => cards().length === 1);
    expect(fieldsOf().find((f) => f.key === 'command')?.cut).toBeGreaterThan(0);
    tap('approve');
    await waitFor(() => answer() !== undefined);
    expect(answer()!.result).toEqual({ decision: 'decline' });
  });
});

describe('codex approvals: file changes, permissions and MCP tools', () => {
  it('shows the diff from the fileChange item, matched by itemId, and accepts it', async () => {
    api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    const diff = '@@ -1 +1 @@\n-old line\n+new line\n';
    const { answer } = await oneRequest(
      codex,
      'item/fileChange/requestApproval',
      { itemId: 'patch-1', startedAtMs: Date.now(), reason: 'Fix the greeting' },
      (ctx) => {
        codex.notify('item/started', {
          threadId: ctx.threadId,
          turnId: ctx.turnId,
          startedAtMs: Date.now(),
          item: {
            type: 'fileChange',
            id: 'patch-1',
            status: 'inProgress',
            changes: [
              { path: 'src/hello.ts', kind: { type: 'update', move_path: null }, diff },
              { path: 'src/new.ts', kind: { type: 'add' }, diff: '+export {};\n' },
            ],
          },
        });
      },
    );
    await waitFor(() => cards().length === 1);
    expect(cards()[0]!.toolName).toBe('file_change');
    expect(field('src/hello.ts')).toBe(`update: src/hello.ts\n${diff}`);
    expect(field('src/new.ts')).toBe('add: src/new.ts\n+export {};\n');
    tap('approve');
    await waitFor(() => answer() !== undefined);
    expect(answer()!.result).toEqual({ decision: 'accept' });
  });

  it("declines a file change whose diff Codex didn't show, even when approved", async () => {
    api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    const { answer } = await oneRequest(codex, 'item/fileChange/requestApproval', {
      itemId: 'patch-unseen',
      startedAtMs: Date.now(),
    });
    await waitFor(() => cards().length === 1);
    expect(field('changes')).toContain("didn't show");
    tap('approve');
    await waitFor(() => answer() !== undefined);
    expect(answer()!.result).toEqual({ decision: 'decline' });
  });

  it('grants the permissions asked for, for this turn only', async () => {
    api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    const permissions = {
      network: { enabled: true },
      fileSystem: { read: null, write: ['/tmp/out'] },
    };
    const { answer } = await oneRequest(codex, 'item/permissions/requestApproval', {
      itemId: 'perm-1',
      startedAtMs: Date.now(),
      environmentId: null,
      cwd: '/tmp/work',
      reason: 'Fetch and write the report',
      permissions,
    });
    await waitFor(() => cards().length === 1);
    expect(cards()[0]!.toolName).toBe('permissions');
    expect(field('network')).toBe('enabled');
    expect(field('write')).toBe('/tmp/out');
    tap('approve');
    await waitFor(() => answer() !== undefined);
    expect(answer()!.result).toEqual({ permissions, scope: 'turn' });
  });

  it('grants nothing when the owner denies permissions', async () => {
    api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    const { answer } = await oneRequest(codex, 'item/permissions/requestApproval', {
      itemId: 'perm-2',
      startedAtMs: Date.now(),
      environmentId: null,
      cwd: '/tmp/work',
      reason: null,
      permissions: { network: { enabled: true }, fileSystem: null },
    });
    await waitFor(() => cards().length === 1);
    tap('deny');
    await waitFor(() => answer() !== undefined);
    expect(answer()!.result).toEqual({ permissions: {}, scope: 'turn' });
  });

  it("shows an MCP tool call's server, tool and arguments, and accepts it", async () => {
    api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    const { answer } = await oneRequest(codex, 'mcpServer/elicitation/request', {
      serverName: 'docs',
      mode: 'form',
      message: 'Allow the docs server to run search?',
      requestedSchema: { type: 'object', properties: {} },
      _meta: {
        codex_approval_kind: 'mcp_tool_call',
        tool_name: 'search',
        tool_params: { query: 'release notes' },
        persist: ['session', 'always'],
      },
    });
    await waitFor(() => cards().length === 1);
    expect(cards()[0]!.toolName).toBe('mcp__docs__search');
    expect(field('server')).toBe('docs');
    expect(field('tool')).toBe('search');
    expect(JSON.parse(field('arguments')!)).toEqual({ query: 'release notes' });
    tap('approve');
    await waitFor(() => answer() !== undefined);
    // Never a lasting choice (no persist in _meta).
    expect(answer()!.result).toEqual({ action: 'accept', content: {}, _meta: null });
  });

  it('declines another kind of elicitation at once, without a card', async () => {
    api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    const { answer } = await oneRequest(codex, 'mcpServer/elicitation/request', {
      serverName: 'docs',
      mode: 'form',
      message: 'Your API key?',
      requestedSchema: { type: 'object', properties: {} },
      _meta: null,
    });
    await waitFor(() => answer() !== undefined);
    expect(answer()!.result).toMatchObject({ action: 'decline' });
    expect(cards()).toHaveLength(0);
  });
});

describe('codex approvals: how cards end', () => {
  it('closes the card and sends nothing when Codex resolves the request itself', async () => {
    api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    const { answer } = await oneRequest(
      codex,
      'item/commandExecution/requestApproval',
      commandParams('make test'),
    );
    await waitFor(() => cards().length === 1);
    const pending = codex.pendingServerRequests();
    expect(pending).toHaveLength(1);
    codex.resolveElsewhere(pending[0]!.id);
    await waitFor(() => cards()[0]!.closes.includes('answered_elsewhere'));
    expect(answer()!.result).toBe('resolved elsewhere');
    // A late answer would be a violation (an answer to no server request): there is none.
    await new Promise((r) => setTimeout(r, 100));
  });

  it("declines when the card's thread is taken from the session", async () => {
    api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    let answer: Received | undefined;
    codex.onTurn = async (ctx) => {
      answer = await ctx.request(
        'item/commandExecution/requestApproval',
        commandParams('make deploy'),
      );
      ctx.agentMessage('done', 'final_answer');
      ctx.complete();
    };
    const r = await bench.start(codex);
    const thread = api.sessions.postFrom(token, 'Deploy');
    await waitFor(() => cards().length === 1);
    // What the loop does on item_unassigned: the server closed the thread's cards.
    expect(r.state().waiters.closeThread(thread)).toBe(1);
    await waitFor(() => answer !== undefined);
    expect(answer!.result).toEqual({ decision: 'decline' });
  });

  it('declines when nobody answers in time, and closes the card as expired', async () => {
    api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    const { answer } = await oneRequest(
      codex,
      'item/commandExecution/requestApproval',
      commandParams('sleep 1'),
      undefined,
      { msPerSecond: 5, waitS: 60 },
    );
    await waitFor(() => answer() !== undefined, 8000);
    expect(answer()!.result).toEqual({ decision: 'decline' });
    expect(cards()[0]!.closes).toContain('expired');
  });

  it('closes the open cards when the bridge stops', async () => {
    api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    codex.onTurn = async (ctx) => {
      await ctx.request('item/commandExecution/requestApproval', commandParams('make build'));
    };
    const r = await bench.start(codex);
    api.sessions.postFrom(token, 'Build');
    await waitFor(() => cards().length === 1);
    expect(await r.stop()).toBe(0);
    expect(cards()[0]!.closes).toContain('session_ended');
  });

  it('closes the open cards when the app-server exits', async () => {
    api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    codex.onTurn = async (ctx) => {
      await ctx.request('item/commandExecution/requestApproval', commandParams('make build'));
    };
    const r = await bench.start(codex);
    api.sessions.postFrom(token, 'Build');
    await waitFor(() => cards().length === 1);
    codex.exit(1);
    expect(await r.done).toBe(1);
    expect(cards()[0]!.closes.some((c) => c === 'interrupted' || c === 'session_ended')).toBe(true);
  });
});

describe("codex approvals: when Codex's config sends them elsewhere", () => {
  const status = async (): Promise<string> => {
    let out = '';
    await runStatus(
      { apiUrl: api.url, folder: bench.folder, apiUrlFlag: true },
      {
        out: (t) => (out += t),
        err: () => undefined,
        store: new FileTokenStore(`${bench.dir}/status-sessions.json`),
        logger: createLogger({ sink: () => undefined }),
        lockDir: bench.lockDir,
      },
    );
    return out;
  };

  it('warns at startup and in status when the policy is "never"', async () => {
    const s = api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    codex.userConfig = { approval_policy: 'never', approvals_reviewer: 'user' };
    const r = await bench.start(codex);
    await waitFor(() => s.heartbeats.includes('online'));
    expect(logged(r, "approvals won't reach buildIt.Social as cards")).toBe(true);
    const note = policyNotePath(bench.lockDir, sessionKey(bench.folder, api.url));
    expect(existsSync(note)).toBe(true);
    expect(await status()).toContain(
      'Codex:    approvals won\'t reach buildIt.Social as cards: approval_policy is "never"',
    );
  });

  it('warns for the automatic reviewer, and says nothing is wrong otherwise', async () => {
    const s = api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    codex.userConfig = { approval_policy: 'on-request', approvals_reviewer: 'auto_review' };
    const r = await bench.start(codex);
    await waitFor(() => s.heartbeats.includes('online'));
    expect(logged(r, 'approvals_reviewer is \\"auto_review\\"')).toBe(true);
    await r.stop();
    const fine = bench.fake();
    const r2 = await bench.start(fine);
    await waitFor(() => logged(r2, "codex's approvals come to buildIt.Social as cards"));
    expect(await status()).toContain('Codex:    approvals come to buildIt.Social as cards');
  });

  it('names granular switches that keep approvals away', () => {
    expect(
      policyWarning({
        approvalPolicy: {
          granular: {
            sandbox_approval: true,
            rules: true,
            skill_approval: true,
            request_permissions: false,
            mcp_elicitations: false,
          },
        },
        approvalsReviewer: null,
      }),
    ).toContain('request_permissions, mcp_elicitations');
    expect(policyWarning({ approvalPolicy: null, approvalsReviewer: null })).toBeUndefined();
    expect(
      policyWarning({ approvalPolicy: 'on-request', approvalsReviewer: 'user' }),
    ).toBeUndefined();
  });
});

describe('codex approvals: the cards, built', () => {
  it('never offers a lasting rule, whatever Codex offers', () => {
    const specs = [
      commandCard(commandParams('ls', { availableDecisions: ['acceptForSession'] })),
      fileChangeCard({}, undefined),
      permissionsCard({ permissions: { network: { enabled: true } } }),
      mcpToolCard({ serverName: 's', _meta: { tool_name: 't', tool_params: {} } }),
    ];
    for (const spec of specs) {
      const text = JSON.stringify([spec.accept, spec.decline]);
      expect(text).not.toMatch(/ForSession|Amendment|"session"|persist/);
    }
    // A command whose decisions leave out accept can't be approved.
    expect(specs[0]!.unchecked).toBe('not_offered');
  });

  it("names a file relative to the folder, keeps a long name's end, and shows the whole path", () => {
    const folder = join(sep, 'work', 'repo');
    expect(fileKey(join(folder, 'src', 'a.ts'), folder)).toBe(join('src', 'a.ts'));
    expect(fileKey(join(sep, 'elsewhere', 'b.ts'), folder)).toBe(join(sep, 'elsewhere', 'b.ts'));
    const deep = join(folder, ...Array.from({ length: 30 }, () => 'nested'), 'hello.txt');
    const key = fileKey(deep, undefined);
    expect(Array.from(key)).toHaveLength(100);
    expect(key.startsWith('…')).toBe(true);
    expect(key.endsWith('hello.txt')).toBe(true);
    const spec = fileChangeCard({}, [
      { path: deep, kind: 'add', movePath: undefined, diff: '+hi' },
    ]);
    expect(Object.values(spec.input)[0]).toBe(`add: ${deep}` + String.fromCharCode(10) + '+hi');
  });

  it('keeps tool names to the API pattern', () => {
    expect(toolNameOf('mcp__my server__do it!', 'mcp_tool')).toBe('mcp__my_server__do_it_');
    expect(toolNameOf('', 'mcp_tool')).toBe('mcp_tool');
  });
});
