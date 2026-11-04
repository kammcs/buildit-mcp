/**
 * Work items on Codex: a Codex thread per item, in a git worktree the
 * bridge makes on a branch named for the item, with the item worker's
 * instructions; at most N at once, with the queued line; every item event
 * routed in code (children to the epic's thread, a handed subtask to its
 * own); unassigning interrupts the item, closes its cards and unsubscribes;
 * Codex's own subagents' approvals go to the parent's thread, naming the
 * subagent; the person's plugins off by default; and a restart resumes the
 * items' threads and worktrees. Against the fake agent API and the fake
 * app-server, with real git in a throwaway repository.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { itemWorkerText, requestWorkerText } from '../src/agent-text.js';
import {
  ITEM_DEVELOPER_INSTRUCTIONS,
  PLUGINS_OFF,
  queuedLine,
  RESUMED_NOTE,
} from '../src/codex/bridge.js';
import { itemPlace, SessionRouter } from '../src/codex/router.js';
import { branchName, WORKTREES_DIR } from '../src/codex/worktrees.js';
import { staleAgentFiles } from '../scripts/agent-text.js';
import { CodexBench, logged, waitFor } from './support/codex-run.js';
import { FakeApi } from './support/fake-api.js';
import { CodexHome, type FakeAppServer, type TurnContext } from './support/fake-codex.js';
import { demoItem, SESSION_TOKENS } from './support/fake-sessions.js';

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
const session = () => api.sessions.session(token);
const posts = () => session().messages;
const cardIds = () => new Set(api.sessions.approvals(token).map((c) => c.id));
const postsIn = (thread: string) =>
  posts().filter((m) => m.thread_id === thread && !cardIds().has(m.id));
type Json = Record<string, unknown>;
const texts = (input: unknown): string[] =>
  (input as Json[]).filter((i) => i.type === 'text').map((i) => String(i.text));

/** The bench folder as a git repository with one commit, so items get worktrees. */
function gitRepo(folder: string): void {
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=Test User', '-c', 'user.email=test@example.com', ...args],
      {
        cwd: folder,
        stdio: 'ignore',
      },
    );
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'init');
}

/** Turns that wait to be let go, each by its thread; every turn answers "done <n>". */
class Turns {
  private readonly gates = new Map<string, () => void>();
  readonly started: TurnContext[] = [];
  play(codex: FakeAppServer, during?: (ctx: TurnContext) => Promise<void>): void {
    codex.onTurn = async (ctx) => {
      this.started.push(ctx);
      await new Promise<void>((resolve) => {
        this.gates.set(ctx.threadId, resolve);
        ctx.signal.addEventListener(
          'abort',
          () => {
            resolve();
          },
          { once: true },
        );
      });
      if (ctx.signal.aborted) return;
      await during?.(ctx);
      ctx.agentMessage(`done ${this.started.indexOf(ctx) + 1}`, 'final_answer');
      ctx.complete();
    };
  }
  /** Lets the turn of a thread finish. */
  release(threadId: string): void {
    const gate = this.gates.get(threadId);
    this.gates.delete(threadId);
    gate?.();
  }
  running(threadId: string): boolean {
    return this.gates.has(threadId);
  }
}

describe('codex items: a thread per item, in its own worktree', () => {
  it('runs two items at once, each in its own worktree, with the item worker and the work-updates skill', async () => {
    gitRepo(bench.folder);
    const s = api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    const turns = new Turns();
    turns.play(codex);
    await bench.start(codex);
    await waitFor(() => s.heartbeats.includes('online'));
    const one = demoItem(1, { title: 'Fix the login redirect' });
    const two = demoItem(2, { title: 'Ünïcode & spaces: tray' });
    api.sessions.assignItem(token, one);
    api.sessions.assignItem(token, two);
    await waitFor(() => turns.started.length === 2);
    await waitFor(() => s.acked === 2);

    const starts = codex.requests('thread/start');
    expect(starts).toHaveLength(2);
    const cwds = starts.map((p) => String(p.cwd));
    const wt1 = join(bench.folder, WORKTREES_DIR, 'demo-1-fix-the-login-redirect');
    const wt2 = join(bench.folder, WORKTREES_DIR, 'demo-2-unicode-spaces-tray');
    expect(cwds).toEqual([wt1, wt2]);
    for (const wt of [wt1, wt2]) expect(existsSync(join(wt, '.git'))).toBe(true);
    const list = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: bench.folder,
      encoding: 'utf8',
    });
    expect(list).toContain('branch refs/heads/demo-1-fix-the-login-redirect');
    expect(list).toContain('branch refs/heads/demo-2-unicode-spaces-tray');
    // The worktrees stay out of the folder's own status.
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: bench.folder,
      encoding: 'utf8',
    });
    expect(status).toBe('');
    for (const p of starts) {
      expect(p.developerInstructions).toBe(ITEM_DEVELOPER_INSTRUCTIONS);
      expect(p.config).toMatchObject(PLUGINS_OFF);
      expect(p.config).toHaveProperty(['mcp_servers.buildit']);
    }
    // Each item's own hosted-tools URL.
    const urls = starts.map((p) => (p.config as Json)['mcp_servers.buildit'] as Json);
    expect(urls[0]!.url).not.toBe(urls[1]!.url);

    const first = codex.requests('turn/start')[0]!;
    const input = first.input as Json[];
    expect(texts(input)[0]).toContain('DEMO-1');
    expect(texts(input).join('\n')).toContain('on branch demo-1-fix-the-login-redirect');
    expect(input).toContainEqual(
      expect.objectContaining({ type: 'skill', name: 'buildit:buildit-work-updates' }),
    );
    // Both run at once.
    expect(turns.running(turns.started[0]!.threadId)).toBe(true);
    expect(turns.running(turns.started[1]!.threadId)).toBe(true);

    // Each answer goes in its own item's thread.
    turns.release(turns.started[1]!.threadId);
    turns.release(turns.started[0]!.threadId);
    await waitFor(() => postsIn(one.id).length === 1 && postsIn(two.id).length === 1);
    expect(postsIn(one.id)[0]!.text).toBe('done 1');
    expect(postsIn(two.id)[0]!.text).toBe('done 2');

    // A later message in the item's thread is the same conversation: no new thread, no skill.
    api.sessions.itemMessage(token, one, 'Also check the logout');
    await waitFor(() => turns.started.length === 3);
    expect(codex.requests('thread/start')).toHaveLength(2);
    const later = codex.requests('turn/start')[2]!;
    expect(later.threadId).toBe(turns.started[0]!.threadId);
    expect((later.input as Json[]).some((i) => i.type === 'skill')).toBe(false);
    turns.release(turns.started[2]!.threadId);
    await waitFor(() => postsIn(one.id).length === 2);
  });

  it("keeps the person's plugins with the setting, and works in the folder when it is no repository", async () => {
    const s = api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    const r = await bench.start(codex, { keepPlugins: true });
    await waitFor(() => s.heartbeats.includes('online'));
    api.sessions.assignItem(token, demoItem(3));
    await waitFor(() => postsIn(demoItem(3).id).length === 1);
    const p = codex.requests('thread/start')[0]!;
    expect(p.cwd).toBe(bench.folder);
    expect(p.config).not.toHaveProperty(['features.plugins']);
    expect(texts(codex.requests('turn/start')[0]!.input).join('\n')).toContain(
      'could not make a git worktree',
    );
    expect(logged(r, 'not in a git repository')).toBe(true);
  });
});

describe('codex items: at most N at once', () => {
  it('queues the next item with the queued line, and starts it when a slot frees', async () => {
    gitRepo(bench.folder);
    const s = api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    const turns = new Turns();
    turns.play(codex);
    await bench.start(codex, {
      ask: { questionsInApp: true, timeoutMinutes: 60, maxParallelItems: 1 },
    });
    await waitFor(() => s.heartbeats.includes('online'));
    const one = demoItem(1);
    const two = demoItem(2);
    api.sessions.assignItem(token, one);
    await waitFor(() => turns.started.length === 1);
    api.sessions.assignItem(token, two);
    // Taken (acknowledged) while it waits, and told once in its own thread.
    await waitFor(() => s.acked === 2);
    await waitFor(() => postsIn(two.id).length === 1);
    expect(postsIn(two.id)[0]!.text).toBe(queuedLine(['DEMO-1']));
    expect(postsIn(two.id)[0]!.text).toBe("Queued — I'll start this after DEMO-1.");
    // Another message for the waiting item waits with it, without a second line.
    api.sessions.itemMessage(token, two, 'More detail');
    await waitFor(() => s.acked === 3);
    expect(codex.requests('turn/start')).toHaveLength(1);
    // Its thread was opened already (free), but no turn.
    expect(codex.requests('thread/start')).toHaveLength(2);
    // The direct message never waits.
    const dm = api.sessions.postFrom(token, 'A quick question');
    await waitFor(() => turns.started.length === 2);
    turns.release(turns.started[1]!.threadId);
    await waitFor(() => postsIn(dm).length === 1);

    turns.release(turns.started[0]!.threadId);
    await waitFor(() => turns.started.length === 3);
    // The waiting item starts with both its messages: the first starts the turn, the second joins it.
    const second = codex.requests('turn/start').at(-1)!;
    expect(texts(second.input)[0]).toContain('DEMO-2');
    await waitFor(() => turns.started[2]!.inputs.length === 2);
    turns.release(turns.started[2]!.threadId);
    await waitFor(() => postsIn(two.id).length === 2);
    expect(postsIn(two.id).filter((m) => m.text.startsWith('Queued'))).toHaveLength(1);
  });
});

describe('codex items: unassigned', () => {
  it('interrupts that item only, closes its cards and unsubscribes, posting nothing of it', async () => {
    gitRepo(bench.folder);
    const s = api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    const turns = new Turns();
    let answered: unknown;
    codex.onTurn = async (ctx) => {
      turns.started.push(ctx);
      if (turns.started.length === 1) {
        // The first item waits on an approval when it is taken away.
        const r = await ctx.request('item/commandExecution/requestApproval', {
          itemId: 'exec-1',
          startedAtMs: Date.now(),
          environmentId: 'local',
          command: 'npm test',
          cwd: '/tmp/work',
          commandActions: [{ type: 'unknown', command: 'npm test' }],
        });
        answered = r.result;
        await ctx.interrupted();
        return;
      }
      await new Promise((r) => setTimeout(r, 300));
      ctx.agentMessage('two is done', 'final_answer');
      ctx.complete();
    };
    await bench.start(codex);
    await waitFor(() => s.heartbeats.includes('online'));
    const one = demoItem(1);
    const two = demoItem(2);
    api.sessions.assignItem(token, one);
    await waitFor(() => api.sessions.approvals(token).length === 1);
    api.sessions.assignItem(token, two);
    await waitFor(() => turns.started.length === 2);
    const threadOne = turns.started[0]!.threadId;
    api.sessions.unassignItem(token, one);
    await waitFor(() => codex.unsubscribed(threadOne));
    expect(codex.requests('turn/interrupt').map((p) => p.threadId)).toEqual([threadOne]);
    await waitFor(() => answered !== undefined);
    expect(answered).toEqual({ decision: 'decline' });
    // The other item goes on and answers; nothing is posted in the unassigned one's thread.
    await waitFor(() => postsIn(two.id).length === 1);
    expect(postsIn(one.id)).toHaveLength(0);
    expect(bench.fakes[0]!.unsubscribed(turns.started[1]!.threadId)).toBe(false);
  });
});

describe('codex items: routing in code', () => {
  const stored = (n: number) => {
    const i = api.store.items.find((x) => x.project === 'DEMO' && x.number === n)!;
    return { id: i.id, key: `DEMO-${n}`, title: i.title };
  };

  it("sends a child's events to the epic's thread, and gives a handed subtask its own", async () => {
    gitRepo(bench.folder);
    const s = api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    const turns = new Turns();
    turns.play(codex);
    await bench.start(codex);
    await waitFor(() => s.heartbeats.includes('online'));
    const epic = stored(12);
    const story = stored(42);
    const subtask = stored(46);
    api.sessions.assignItem(token, epic);
    await waitFor(() => turns.started.length === 1);
    const epicThread = turns.started[0]!.threadId;
    turns.release(epicThread);
    await waitFor(() => postsIn(epic.id).length === 1);

    // A mention in the story's thread (a child of the epic): the epic's conversation.
    api.sessions.itemMessage(token, story, 'How is the story going?', { mention: true });
    await waitFor(() => turns.started.length === 2);
    expect(turns.started[1]!.threadId).toBe(epicThread);
    turns.release(epicThread);
    // Its answer goes in the story's own thread.
    await waitFor(() => postsIn(story.id).length === 1);
    // A subtask two levels down: the epic's too.
    api.sessions.itemMessage(token, subtask, 'And this one?');
    await waitFor(() => turns.started.length === 3);
    expect(turns.started[2]!.threadId).toBe(epicThread);
    turns.release(epicThread);
    await waitFor(() => postsIn(subtask.id).length === 1);
    // child_done about the epic: its conversation.
    api.sessions.childDone(token, epic, { ...subtask, title: 'x' }, 'done', {
      result: { text: 'built it' },
    });
    await waitFor(() => turns.started.length === 4);
    expect(turns.started[3]!.threadId).toBe(epicThread);
    turns.release(epicThread);
    expect(codex.requests('thread/start')).toHaveLength(1);

    // A subtask handed to this session gets its own thread, even under the epic.
    api.sessions.handOver(token, subtask, { parent: { id: story.id, key: story.key } });
    await waitFor(() => turns.started.length === 5);
    expect(codex.requests('thread/start')).toHaveLength(2);
    expect(turns.started[4]!.threadId).not.toBe(epicThread);
    turns.release(turns.started[4]!.threadId);
    // The parents were read once each.
    const reads = api.requests.filter((r) => r.headers['x-buildit-tool'] === 'get_item');
    expect(reads.length).toBeLessThanOrEqual(3);
  });

  it('routes card outcomes to the item whose thread the card is in, else the direct message', async () => {
    const router = new SessionRouter({
      has: (key) => key === itemPlace('E') || key === 'dm',
      parentOf: (id) => Promise.resolve(id === 'S' ? { id: 'E', key: 'DEMO-1' } : null),
      isItemThread: (t) => t === 'E' || t === 'S' || t === 'X',
      isRequestThread: (t) => t === 'X' || t === 'R',
    });
    const route = (meta: Record<string, string>) => router.route({ content: '', meta });
    expect(await route({ event: 'assignment_resolved', thread_id: 'S' })).toMatchObject({
      key: itemPlace('E'),
      threadId: 'S',
    });
    expect(await route({ event: 'assigned_item_done', thread_id: 'D' })).toMatchObject({
      key: 'dm',
      threadId: 'D',
    });
    expect(
      await route({ event: 'plan_resolved', thread_id: 'E', outcome: 'applied' }),
    ).toMatchObject({ key: itemPlace('E') });
    expect(
      await route({ event: 'plan_resolved', thread_id: 'D', outcome: 'applied' }),
    ).toMatchObject({ key: 'dm', threadId: 'D' });
    // A request's card (in an item's thread, or a channel thread): only trouble is told.
    expect(await route({ event: 'plan_resolved', thread_id: 'R', outcome: 'applied' })).toEqual({
      dropped: 'plan_resolved_no_conversation',
    });
    expect(await route({ event: 'plan_resolved', thread_id: 'X', outcome: 'applied' })).toEqual({
      dropped: 'plan_resolved_no_conversation',
    });
    expect(
      await route({ event: 'plan_resolved', thread_id: 'X', outcome: 'failed' }),
    ).toMatchObject({ key: 'dm', threadId: undefined });
    expect(
      await route({ event: 'handoff_resolved', thread_id: 'E', parent: 'DEMO-1', item: 'DEMO-2' }),
    ).toMatchObject({ key: itemPlace('E') });
    // The parent unknown: the card's thread (the subtask's) finds it.
    expect(
      await route({ event: 'handoff_resolved', thread_id: 'S', item: 'DEMO-2' }),
    ).toMatchObject({ key: itemPlace('E') });
    expect(await route({ event: 'item_unassigned', thread_id: 'S', item: 'DEMO-2' })).toMatchObject(
      { stop: { key: 'DEMO-2', id: 'S' }, own: undefined, tell: { key: itemPlace('E') } },
    );
    expect(await route({ event: 'item_unassigned', thread_id: 'E', item: 'DEMO-1' })).toMatchObject(
      { own: itemPlace('E') },
    );
  });
});

describe("codex items: Codex's own subagents", () => {
  it("routes a subagent's approval to the parent's thread, naming the subagent", async () => {
    const s = api.sessions.open(token, 'demo-folder');
    const codex = bench.fake();
    let answered: unknown;
    codex.onTurn = async (ctx) => {
      const sub = codex.spawnSubagent(ctx.threadId, 'Ada');
      const r = await sub.request('item/commandExecution/requestApproval', {
        itemId: 'exec-sub',
        startedAtMs: Date.now(),
        environmentId: 'local',
        command: 'npm test',
        cwd: '/tmp/work',
        commandActions: [{ type: 'unknown', command: 'npm test' }],
      });
      answered = r.result;
      ctx.agentMessage('tested', 'final_answer');
      ctx.complete();
    };
    const r = await bench.start(codex);
    await waitFor(() => s.heartbeats.includes('online'));
    const one = demoItem(1);
    api.sessions.assignItem(token, one);
    await waitFor(() => api.sessions.approvals(token).length === 1);
    expect(logged(r, 'codex subagent followed for its approvals')).toBe(true);
    const card = api.sessions.approvals(token)[0]!;
    expect(card.posted.thread_id).toBe(one.id);
    const fields = card.posted.fields as { key: string; value: string }[];
    expect(fields[0]).toEqual({ key: 'subagent', value: 'Ada' });
    api.sessions.decideApproval(token, card.id, 'approve');
    await waitFor(() => answered !== undefined);
    expect(answered).toEqual({ decision: 'accept' });
    await waitFor(() => postsIn(one.id).length === 1);
    // Nothing the subagent said is posted.
    expect(posts().filter((m) => !cardIds().has(m.id))).toHaveLength(1);
  });
});

describe('codex items: restarts', () => {
  it("resumes an item's thread in its worktree after a restart, and carries its work on", async () => {
    gitRepo(bench.folder);
    const home = new CodexHome();
    const s = api.sessions.open(token, 'demo-folder');
    const first = bench.fake({}, home);
    const turns = new Turns();
    turns.play(first);
    const r1 = await bench.start(first);
    await waitFor(() => s.heartbeats.includes('online'));
    const one = demoItem(1, { title: 'Keep going' });
    api.sessions.assignItem(token, one);
    await waitFor(() => turns.started.length === 1 && s.acked === 1);
    const thread = turns.started[0]!.threadId;
    const wt = String(first.requests('thread/start')[0]!.cwd);
    await r1.stop();

    const second = bench.fake({}, home);
    const again = new Turns();
    again.play(second);
    await bench.start(second);
    await waitFor(() => again.started.length === 1);
    const resume = second.requests('thread/resume')[0]!;
    expect(resume).toMatchObject({ threadId: thread, excludeTurns: true, cwd: wt });
    expect(second.requests('thread/start')).toHaveLength(0);
    expect(texts(second.requests('turn/start')[0]!.input)[0]).toBe(RESUMED_NOTE);
    again.release(thread);
    await waitFor(() => postsIn(one.id).length === 1);
    // The worktree was reused, not made again.
    const list = execFileSync('git', ['worktree', 'list'], { cwd: bench.folder, encoding: 'utf8' });
    expect(list.split('\n').filter((l) => l.includes('demo-1-keep-going'))).toHaveLength(1);
  });
});

describe('codex items: the parts', () => {
  it('names branches for the item, from letters and digits of its title only', () => {
    expect(branchName('DEMO-12', 'Fix login redirect')).toBe('demo-12-fix-login-redirect');
    expect(branchName('DEMO-3', '../../etc; rm -rf / `x`')).toBe('demo-3-etc-rm-rf-x');
    expect(branchName('DEMO-4', '')).toBe('demo-4');
    expect(branchName('DEMO-5', 'a'.repeat(60))).toBe('demo-5');
    expect(branchName('DEMO-6', 'one two three four five six seven eight nine ten')).toBe(
      'demo-6-one-two-three-four-five-six-seven-eight',
    );
  });

  it('keeps the plugin agents in step with their one source, and the Codex text Codex-shaped', () => {
    expect(staleAgentFiles()).toEqual([]);
    for (const text of [itemWorkerText('codex'), requestWorkerText('codex')]) {
      expect(text).not.toMatch(/AskUserQuestion|the lead (gave|tells|may|says)|in the terminal/);
    }
    expect(itemWorkerText('codex')).toContain('buildit-mcp made it for this item');
    expect(itemWorkerText('claude')).toContain('this agent runs in one');
  });
});
