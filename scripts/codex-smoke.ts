/**
 * The Codex bridge's smoke test against the REAL `codex app-server`: it
 * runs model turns on the person's Codex plan, so a maintainer runs it by
 * hand, only with the plan owner's yes. buildIt.Social's side is the
 * in-process fake API (nothing reaches a real buildIt.Social server).
 *
 *   npx tsx scripts/codex-smoke.ts --approved --model <id> --cwd <empty folder>
 *   npx tsx scripts/codex-smoke.ts --preflight-only --model <id> --cwd <empty folder>
 *                                   (the free checks below, then stop: no turn)
 *   npx tsx scripts/codex-smoke.ts --dry-run --model x --cwd <empty folder>
 *                                   (everything against the fake app-server: no Codex, no turn)
 *   npx tsx scripts/codex-smoke.ts --approved --only steer --model <id> --cwd <empty folder>
 *                                   (step 2 alone: 1 turn, at most 2)
 *   npx tsx scripts/codex-smoke.ts --approved --only parity --model <id> --cwd <empty folder>
 *                                   (the hosted tools, approvals and files: 4 turns, at most 5;
 *                                   see "Parity" below)
 *   npx tsx scripts/codex-smoke.ts --approved --only threads --model <id> --cwd <empty folder>
 *                                   (work items in their own threads and worktrees: 3 turns, at
 *                                   most 4; see "Threads" below)
 *   npx tsx scripts/codex-smoke.ts --approved --only questions --model <id> --cwd <empty folder>
 *                                   (ask, and plan mode: 3 turns, 4 when Codex asks without
 *                                   waiting, at most 5)
 *   npx tsx scripts/codex-smoke.ts --approved --only requests --model <id> --cwd <empty folder>
 *                                   (a catch-up and a thread to items: 2 turns, at most 3)
 *   npx tsx scripts/codex-smoke.ts --approved --only unassign --model <id> --cwd <empty folder>
 *                                   (threads' step B alone: 1 turn, at most 2)
 *   npx tsx scripts/codex-smoke.ts --approved --only plan --model <id> --cwd <empty folder>
 *                                   (questions' plan step alone, asking nothing: 2 turns, at
 *                                   most 4: a question Codex asks anyway takes one more)
 *   npx tsx scripts/codex-smoke.ts --approved --only allowsession --model <id> --cwd <empty folder>
 *                                   ("Allow for this session": 2 turns, 3 when Codex doesn't
 *                                   offer it for the command, at most 4; see below)
 *   --fake-no-session               (with --dry-run --only allowsession: the fake leaves
 *                                   acceptForSession out of the command's decisions, as Codex
 *                                   0.166 did for an escalated command, so the file-change
 *                                   steps run)
 *   (threads, unassign, questions, plan and requests first make the empty folder a git
 *   repository with one empty commit.)
 *
 * Four turns, at most five (the script stops before a sixth):
 *   1. reply      "Reply with the single word pong."  -> a post
 *   2. steer      a slow count and "reply steered", posted at once: the second is
 *                 steered into the turn the first started -> one post, "steered"
 *   3. interrupt  a slow count, interrupted -> no post
 *   4. resume     the bridge restarts (a new app-server); a question about turn 1 ->
 *                 thread/resume {excludeTurns: true}, then a post
 *
 * Lean threads: `-c model=<id>`, `model_reasoning_effort="low"`,
 * `model_reasoning_summary="none"`, `features.plugins=false`,
 * `features.apps=false`, and `mcp_servers.<name>.enabled=false` for each
 * MCP server still configured. Before any turn it checks, for free
 * (initialize, model/list, an ephemeral thread/start, mcpServerStatus/list
 * and skills/list), that the model exists and no MCP tool is left; it
 * stops otherwise. Each step checks what the wire shows (the steer named
 * the running turn, the interrupted status, the resume) and the report says
 * OK or FAIL (exit 1 on a failure). The folder must be
 * empty and stay so (the turns ask for nothing that writes). The JSON-RPC
 * transcript and a report go to --out (default <tmp>/codex-smoke), never
 * into the repository.
 *
 * Parity (--only parity): four turns, at most five, with Codex asking
 * before anything that writes (`approval_policy="on-request"`,
 * `approvals_reviewer="user"`, `sandbox_mode="read-only"`: a write needs
 * the sandbox lifted, which Codex asks for; Codex 0.166 refuses to start
 * with the old `untrusted` policy). The in-process owner answers every
 * approval card itself (no one taps):
 *   A. tools + image  an image attached; "call whoami, then post with reply" ->
 *                     a localImage input, whoami and reply over the hosted tools,
 *                     the reply in the message's own thread, no second post
 *   B. approve + file a shell command that writes out.txt, approved on its card ->
 *                     out.txt written, then shared with reply's files
 *   C. deny           a command, denied on its card -> declined, nothing written
 *   D. file change    a file made with Codex's edit tool -> a file_change card
 *                     with its diff, approved -> the file written
 * This one writes in the folder (out.txt, hello.txt): give it a throwaway one.
 *
 * Threads (--only threads): three turns, at most four, on two work items
 * (the fake API's DEMO-44 and DEMO-45). The empty folder becomes a git
 * repository with one empty commit, so each item gets its own worktree in
 * `.buildit/worktrees/`; the in-process owner denies any card:
 *   A. two at once  a mention in each item's thread, posted together ("reply with
 *                   the single word one", "... two") -> two Codex threads, each in its
 *                   own worktree on a branch named for its item, the person's plugins
 *                   off; the turns overlap; each word in its own item's thread
 *   B. unassign     a slow count in DEMO-44's thread, then the item is unassigned ->
 *                   turn/interrupt, thread/unsubscribe, nothing more in its thread
 *
 * Questions (--only questions): three turns (four when Codex asks without
 * waiting), at most five. The in-process
 * owner answers each question card with its first option and approves the
 * plan's card; work items plan first (--plan-items):
 *   A. ask          "call the buildit ask tool once" in the direct message -> a question
 *                   card, answered "red" -> the answer posted
 *   B. plan mode    a mention in DEMO-44's thread: plan a one-word reply, asking first
 *                   with request_user_input -> Codex's question on the card ("yes"; Codex
 *                   0.166 asked it as an async message, which takes one more turn), the
 *                   plan's Approve/Deny card, approved -> the next turn in default mode
 *                   carries it out ("yes" posted)
 *
 * Allow for this session (--only allowsession): two turns (three when Codex
 * doesn't offer acceptForSession for the command), at most four, with
 * parity's approval settings; the fake API is a 1.27.0 server and the
 * session a Codex one. The in-process owner taps "Allow for this session"
 * on every card that offers it and denies any other:
 *   A. command      a shell command (it appends to allow.txt) with escalated
 *                   permissions -> a command card with the session rule, Allow for
 *                   this session -> the bridge answers Codex's acceptForSession, the
 *                   command ran
 *   B. again        the same command once more in the same Codex thread -> no second
 *                   card (Codex's session cache), the command ran again
 *   When Codex lists no acceptForSession for A's command (0.166 offers an exec
 *   policy amendment instead, which the bridge never sends), A is denied and
 *   reported, and the same two steps run with a file change:
 *   C. file change  allow-file.txt made with apply_patch -> a file_change card with the
 *                   rule, Allow for this session -> acceptForSession, the file written
 *   D. again        the same file changed -> no second card, the file changed
 * This one writes in the folder (allow.txt, allow-file.txt): give it a throwaway one.
 *
 * Requests (--only requests): two turns, at most three, on the fake API's
 * tiny #general (three messages):
 *   A. catch-up         its own thread (ephemeral, read-only, no shell, plugins off)
 *                       with two skill inputs -> its result in the direct message only;
 *                       the thread unsubscribed after
 *   B. thread to items  the same for a thread -> its result (the card or a note) in
 *                       that thread only
 */
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

import { ApiClient } from '../src/api/client.js';
import { getSession } from '../src/channel/api.js';
import { ChannelState } from '../src/channel/loop.js';
import { runCodex } from '../src/cli/codex.js';
import type { CommandIO } from '../src/cli/commands.js';
import { findCodex } from '../src/codex/binary.js';
import type { CodexBridge } from '../src/codex/bridge.js';
import { PLUGINS_OFF, REQUEST_THREAD_CONFIG } from '../src/codex/bridge.js';
import { PLAN_APPROVED } from '../src/codex/plans.js';
import { BRIDGE_SKILLS, listedSkills, SKILLS_ROOT } from '../src/codex/skills.js';
import { spawnAppServer, type SpawnAppServer } from '../src/codex/process.js';
import { AppServerConnection } from '../src/codex/rpc.js';
import { BRIDGE_MCP_SERVER, BridgeToolServer } from '../src/codex/tool-server.js';
import { createLogger } from '../src/log.js';
import { FileTokenStore, sessionKey } from '../src/secrets/keychain.js';
import { CHANNELS, FakeApi, MESSAGES } from '../test/support/fake-api.js';
import { CodexHome, FakeAppServer } from '../test/support/fake-codex.js';
import { SESSION_TOKENS } from '../test/support/fake-sessions.js';

const { values } = parseArgs({
  options: {
    approved: { type: 'boolean' },
    model: { type: 'string' },
    cwd: { type: 'string' },
    out: { type: 'string' },
    'codex-path': { type: 'string' },
    'preflight-only': { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    'fake-no-session': { type: 'boolean' },
    only: { type: 'string' },
  },
});

const preflightOnly = values['preflight-only'] === true;
const ONLY = [
  'steer',
  'parity',
  'threads',
  'unassign',
  'questions',
  'plan',
  'requests',
  'allowsession',
] as const;
if (values.only !== undefined && !(ONLY as readonly string[]).includes(values.only)) {
  console.error(
    '--only takes "steer" (the steer step alone: 1 turn), "parity" (tools, approvals, files: 4 turns), "threads" (work items: 3 turns), "unassign" (its step B alone: 1 turn), "questions" (ask and plan mode: 3 turns), "plan" (its plan step alone: 2 turns), "requests" (a catch-up and a thread to items: 2 turns) or "allowsession" (Allow for this session: 2 turns, 3 when Codex doesn\'t offer it for the command).',
  );
  process.exit(2);
}
const only = values.only === 'steer';
const parity = values.only === 'parity';
/** --only unassign and --only plan run one step of threads and of questions. */
const unassignStep = values.only === 'unassign';
const planStep = values.only === 'plan';
const threadsStep = values.only === 'threads' || unassignStep;
const questionsStep = values.only === 'questions' || planStep;
const requestsStep = values.only === 'requests';
/** --only allowsession: "Allow for this session" on a command (or, failing that, a file change). */
const allowSession = values.only === 'allowsession';
/** The runs with Codex asking before anything that writes (the owner answers the cards). */
const approvalsRun = parity || allowSession;
/** Turns allowed: each run's turns plus one spare. */
// questions and plan: one turn more when Codex asks without waiting (the answer is a turn).
const maxTurns =
  only || unassignStep ? 2 : requestsStep ? 3 : planStep || threadsStep || allowSession ? 4 : 5;
if (
  (values.approved !== true && !preflightOnly && values['dry-run'] !== true) ||
  values.model === undefined ||
  values.cwd === undefined
) {
  console.error(
    "This runs real Codex model turns (4, at most 5) on your plan. Run it only with the plan owner's yes:\n  npx tsx scripts/codex-smoke.ts --approved --model <id from model/list> --cwd <empty folder>",
  );
  process.exit(2);
}
const work = resolve(values.cwd);
if (readdirSync(work).length > 0) {
  console.error(`${work} is not empty; give an empty throwaway folder.`);
  process.exit(2);
}
/** The runs whose items need worktrees: the folder becomes a repository with one empty commit. */
const needsRepo = threadsStep || questionsStep || requestsStep;
if (needsRepo) {
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=codex smoke', '-c', 'user.email=smoke@example.com', ...args],
      { cwd: work, stdio: 'ignore' },
    );
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'smoke');
}
/** What the folder holds besides the repository and its worktrees. */
const contents = (): string[] => readdirSync(work).filter((n) => n !== '.git' && n !== '.buildit');
const out = resolve(values.out ?? join(tmpdir(), 'codex-smoke'));
mkdirSync(out, { recursive: true });
const transcript = join(out, `transcript-${Date.now()}.jsonl`);
/**
 * --dry-run: the whole script against the scripted fake app-server, with
 * no Codex at all (no turn): it checks the script's own steps and checks.
 */
const dryRun = values['dry-run'] === true;
const binary = dryRun
  ? { path: 'codex', via: 'option' as const, env: {} }
  : findCodex(values['codex-path']);
const fakeHome = new CodexHome();
const fakeSpawn: SpawnAppServer = (args, env) => {
  const fake = new FakeAppServer(fakeHome);
  fake.onTurn = async (ctx) => {
    const said = (ctx.inputs[0]?.[0] as { text?: unknown } | undefined)?.text;
    const first = typeof said === 'string' ? said : '';
    if (await fakeParityTurn(fake, ctx, first)) return;
    if (await fakeAllowSessionTurn(fake, ctx, first)) return;
    if (first.includes(THREADS.one) || first.includes(THREADS.two)) {
      ctx.agentMessage(first.includes(THREADS.one) ? 'one' : 'two', 'final_answer');
      // Both run a while (longer than the second worktree takes to make), so they overlap as the real ones do.
      await sleep(3000);
      ctx.complete();
      return;
    }
    if (first.includes(THREADS.count)) {
      await ctx.interrupted();
      return;
    }
    if (await fakeQuestionsTurn(fake, ctx, first)) return;
    if (await fakeRequestTurn(fake, ctx, first)) return;
    if (first.startsWith('Count slowly from 1 to 30')) {
      await ctx.inputsReach(2);
      ctx.agentMessage('steered', 'final_answer');
    } else if (first.startsWith('Count slowly from 1 to 200')) {
      await ctx.interrupted();
      return;
    } else {
      ctx.agentMessage('pong', 'final_answer');
    }
    ctx.complete();
  };
  return fake.spawn(args, env);
};

/** The threads run's prompts, each the owner's mention in an item's thread. */
const THREADS = {
  one: 'Reply with the single word one, and do nothing else.',
  two: 'Reply with the single word two, and do nothing else.',
  count: 'Count slowly from 1 to 200, one number per line, and do nothing else.',
} as const;

/** The questions run's prompts: a question through the hosted ask, then a plan with a question. */
const QUESTIONS = {
  ask: 'Call the buildit ask tool once, with one question: "Pick a colour", header "Colour", options "red" and "blue". Then reply with the chosen colour only, and do nothing else.',
  plan: 'Plan how to reply in this thread with one word. Before you plan, ask me which word with your request_user_input tool: one question, header "Word", options "yes" and "no". Then propose a one-step plan: reply with that word. Do nothing else.',
  // The first real run replied "yes" at once instead (luna, plan mode on): planning, not doing, is said plainly.
  planOnly:
    "Plan this, don't do it yet: the work is to reply in this thread with the single word yes. Don't ask me anything. Give the one-step plan in a <proposed_plan> block, and reply only after I approve it.",
} as const;

/** The dry run's stand-in for Codex in the questions run; false: not one of its prompts. */
async function fakeQuestionsTurn(
  fake: FakeAppServer,
  ctx: Parameters<FakeAppServer['onTurn']>[0],
  first: string,
): Promise<boolean> {
  if (first.startsWith(QUESTIONS.ask)) {
    const client = await fake.mcp(ctx.threadId);
    const r = await client.callTool({
      name: 'ask',
      arguments: {
        questions: [
          {
            question: 'Pick a colour',
            header: 'Colour',
            options: [{ label: 'red' }, { label: 'blue' }],
          },
        ],
      },
    });
    ctx.agentMessage(JSON.stringify(r).includes('red') ? 'red' : 'none', 'final_answer');
  } else if (first.includes(QUESTIONS.plan)) {
    const r = await ctx.request('item/tool/requestUserInput', {
      itemId: 'question-1',
      questions: [
        {
          id: 'word',
          header: 'Word',
          question: 'Which word?',
          isOther: true,
          isSecret: false,
          options: [
            { label: 'yes', description: 'Say yes' },
            { label: 'no', description: 'Say no' },
          ],
        },
      ],
      isBlocking: true,
      autoResolutionMs: null,
    });
    const word = JSON.stringify(r.result).includes('"yes"') ? 'yes' : 'no';
    ctx.agentMessage('Here is the plan.', 'final_answer');
    ctx.plan(`1. Reply with the word ${word}.`);
  } else if (first.includes(QUESTIONS.planOnly)) {
    ctx.agentMessage('Here is the plan.', 'final_answer');
    ctx.plan('1. Reply with the word yes.');
  } else if (first.startsWith(PLAN_APPROVED)) {
    ctx.agentMessage('yes', 'final_answer');
  } else {
    return false;
  }
  ctx.complete();
  return true;
}

/** The dry run's stand-in for Codex in a request's turn: the result through reply, with the request. */
async function fakeRequestTurn(
  fake: FakeAppServer,
  ctx: Parameters<FakeAppServer['onTurn']>[0],
  first: string,
): Promise<boolean> {
  const kind = /Use the (buildit-[a-z-]+) skill\./.exec(first)?.[1];
  const request = /request="([0-9a-f-]{36})"/.exec(first)?.[1];
  if (kind === undefined || request === undefined) return false;
  const client = await fake.mcp(ctx.threadId);
  await client.callTool({
    name: 'reply',
    arguments: {
      text:
        kind === 'buildit-catch-up' ? 'A quiet day: a release on Friday.' : 'No items to draft.',
      request,
    },
  });
  ctx.agentMessage('Posted.', 'final_answer');
  ctx.complete();
  return true;
}

/** The parity prompts (the dry run's fake plays a turn for each). */
const PARITY = {
  a: 'Call the buildit whoami tool. Then post one short message with the buildit reply tool, without thread_id or item: the word pong, and in three words or fewer what the attached image shows. Do nothing else; your final answer can be empty.',
  b: 'Your sandbox here is read-only, so run exactly this shell command once, in this folder, with escalated permissions (ask for approval to run it outside the sandbox): echo smoke > out.txt . Then share out.txt with the buildit reply tool (its files parameter), with the text "out.txt". Do nothing else.',
  c: 'Your sandbox here is read-only, so run exactly this shell command once, in this folder, with escalated permissions (ask for approval to run it outside the sandbox): echo declined > denied.txt . If it is not allowed, reply only with the word declined. Do nothing else.',
  d: 'Create a file named hello.txt in this folder, containing the single line hi, with your file editing tool (apply_patch), not a shell command. Then reply only with the word done.',
} as const;

/** The dry run's stand-in for Codex in the parity turns; false: not a parity prompt. */
async function fakeParityTurn(
  fake: FakeAppServer,
  ctx: Parameters<FakeAppServer['onTurn']>[0],
  first: string,
): Promise<boolean> {
  const approval = (command: string) =>
    ctx.request('item/commandExecution/requestApproval', {
      itemId: `exec-${Date.now()}`,
      startedAtMs: Date.now(),
      environmentId: 'local',
      command,
      cwd: work,
      commandActions: [{ type: 'unknown', command }],
    });
  const accepted = (r: { result?: unknown }): boolean =>
    JSON.stringify(r.result).includes('"accept"');
  if (first.startsWith(PARITY.a)) {
    const client = await fake.mcp(ctx.threadId);
    await client.callTool({ name: 'whoami', arguments: {} });
    await client.callTool({ name: 'reply', arguments: { text: 'pong, a picture' } });
    ctx.agentMessage('', 'final_answer');
  } else if (first === PARITY.b) {
    if (accepted(await approval('echo smoke > out.txt'))) {
      writeFileSync(join(work, 'out.txt'), 'smoke\n');
      const client = await fake.mcp(ctx.threadId);
      await client.callTool({ name: 'reply', arguments: { text: 'out.txt', files: ['out.txt'] } });
    }
    ctx.agentMessage('', 'final_answer');
  } else if (first === PARITY.c) {
    const r = await approval('echo declined > denied.txt');
    ctx.agentMessage(accepted(r) ? 'ran it' : 'declined', 'final_answer');
  } else if (first === PARITY.d) {
    fake.notify('item/started', {
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      startedAtMs: Date.now(),
      item: {
        type: 'fileChange',
        id: 'patch-hello',
        status: 'inProgress',
        changes: [{ path: join(work, 'hello.txt'), kind: { type: 'add' }, diff: '+hi\n' }],
      },
    });
    const r = await ctx.request('item/fileChange/requestApproval', {
      itemId: 'patch-hello',
      startedAtMs: Date.now(),
    });
    if (accepted(r)) writeFileSync(join(work, 'hello.txt'), 'hi\n');
    ctx.agentMessage('done', 'final_answer');
  } else {
    return false;
  }
  ctx.complete();
  return true;
}
/** The allowsession prompts (the dry run's fake plays a turn for each). */
const ALLOW = {
  a: 'Your sandbox here is read-only, so run exactly this shell command once, in this folder, with escalated permissions (ask for approval to run it outside the sandbox): echo allow >> allow.txt . Then reply only with the word ran. Do nothing else.',
  b: 'Run exactly the same shell command once more, in this folder, with escalated permissions as before: echo allow >> allow.txt . Then reply only with the word again. Do nothing else.',
  c: 'Create a file named allow-file.txt in this folder, containing the single line one, with your file editing tool (apply_patch), not a shell command. Then reply only with the word done.',
  d: 'Change allow-file.txt in this folder so that its single line is two, with your file editing tool (apply_patch), not a shell command. Then reply only with the word changed.',
} as const;

/**
 * The dry run's stand-in for Codex's session-scoped approval cache: what
 * an acceptForSession let through, per thread (a command by its text, a
 * file change by its file), so a second identical request isn't asked.
 */
const fakeSessionCache = new Set<string>();

/** The dry run's stand-in for Codex in the allowsession turns; false: not one of its prompts. */
async function fakeAllowSessionTurn(
  fake: FakeAppServer,
  ctx: Parameters<FakeAppServer['onTurn']>[0],
  first: string,
): Promise<boolean> {
  const decision = (r: { result?: unknown }): unknown =>
    (r.result as { decision?: unknown } | undefined)?.decision;
  if (first === ALLOW.a || first === ALLOW.b) {
    const command = 'echo allow >> allow.txt';
    const key = `${ctx.threadId}:command:${command}`;
    let run = fakeSessionCache.has(key);
    if (!run) {
      const amendment = ['powershell.exe', '-Command', command];
      const r = await ctx.request('item/commandExecution/requestApproval', {
        itemId: `exec-${Date.now()}`,
        startedAtMs: Date.now(),
        environmentId: 'local',
        command,
        cwd: work,
        commandActions: [{ type: 'unknown', command }],
        proposedExecpolicyAmendment: amendment,
        availableDecisions:
          values['fake-no-session'] === true
            ? [
                'accept',
                { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } },
                'cancel',
              ]
            : ['accept', 'acceptForSession', 'cancel'],
      });
      if (decision(r) === 'acceptForSession') fakeSessionCache.add(key);
      run = decision(r) === 'accept' || decision(r) === 'acceptForSession';
    }
    if (run) appendFileSync(join(work, 'allow.txt'), 'allow\n');
    ctx.agentMessage(run ? (first === ALLOW.a ? 'ran' : 'again') : 'declined', 'final_answer');
  } else if (first === ALLOW.c || first === ALLOW.d) {
    const path = join(work, 'allow-file.txt');
    const key = `${ctx.threadId}:file:${path}`;
    const line = first === ALLOW.c ? 'one' : 'two';
    let write = fakeSessionCache.has(key);
    if (!write) {
      const itemId = `patch-${Date.now()}`;
      fake.notify('item/started', {
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        startedAtMs: Date.now(),
        item: {
          type: 'fileChange',
          id: itemId,
          status: 'inProgress',
          changes: [
            {
              path,
              kind: first === ALLOW.c ? { type: 'add' } : { type: 'update', move_path: null },
              diff: first === ALLOW.c ? '+one\n' : '-one\n+two\n',
            },
          ],
        },
      });
      const r = await ctx.request('item/fileChange/requestApproval', {
        itemId,
        startedAtMs: Date.now(),
      });
      if (decision(r) === 'acceptForSession') fakeSessionCache.add(key);
      write = decision(r) === 'accept' || decision(r) === 'acceptForSession';
    }
    if (write) writeFileSync(path, `${line}\n`);
    ctx.agentMessage(write ? (first === ALLOW.c ? 'done' : 'changed') : 'declined', 'final_answer');
  } else {
    return false;
  }
  ctx.complete();
  return true;
}

const logger = createLogger({ level: 'info' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The parity run is over (its steps reported): the main steps are skipped. */
class ParityDone extends Error {}

/** Lean threads: the cheap model at low effort, and none of the person's plugins, apps or MCP servers. */
const config = [
  `model="${values.model}"`,
  'model_reasoning_effort="low"',
  'model_reasoning_summary="none"',
  'features.plugins=false',
  'features.apps=false',
];

/** A TOML key for -c: bare when it can be, else quoted. */
const tomlKey = (name: string): string =>
  /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);

interface McpStatus {
  name: string;
  tools?: Record<string, unknown>;
}

/** A free app-server session (no turn): initialize, then `use`, then it ends. */
async function freeSession<T>(
  args: string[],
  use: (conn: AppServerConnection) => Promise<T>,
): Promise<T> {
  const proc = spawnAppServer(binary, { cwd: work, logger })(args.flatMap((c) => ['-c', c]));
  const conn = new AppServerConnection(proc.stdout, proc.stdin, { logger });
  try {
    await conn.request('initialize', {
      clientInfo: { name: 'buildit_mcp_smoke', title: null, version: '0.0.0' },
      capabilities: { experimentalApi: true },
    });
    conn.notify('initialized');
    return await use(conn);
  } finally {
    conn.close();
    await proc.stop();
  }
}

/** The MCP servers a thread would load, with their tools (an ephemeral thread: never saved). */
async function mcpServers(conn: AppServerConnection): Promise<McpStatus[]> {
  await conn.request('thread/start', { cwd: work, ephemeral: true });
  let servers: McpStatus[] = [];
  for (let i = 0; i < 10; i++) {
    await sleep(1000);
    servers = (await conn.request<{ data?: McpStatus[] }>('mcpServerStatus/list', {})).data ?? [];
    if (servers.every((m) => m.tools !== undefined)) break;
  }
  return servers;
}

const toolCount = (servers: McpStatus[]): number =>
  servers.reduce((n, m) => n + Object.keys(m.tools ?? {}).length, 0);

// Free (no turn): the model exists, and the person's own MCP servers are turned off too.
if (!dryRun) {
  const before = await freeSession([], async (conn) => {
    const list = await conn.request<{ data: { id: string }[] }>('model/list', {});
    if (!list.data.some((m) => m.id === values.model)) {
      console.error(`No model ${values.model}: ${list.data.map((m) => m.id).join(', ')}`);
      process.exit(2);
    }
    return mcpServers(conn);
  });
  const leftOn = await freeSession(config, mcpServers);
  for (const m of leftOn) config.push(`mcp_servers.${tomlKey(m.name)}.enabled=false`);
  const after = await freeSession(config, async (conn) => {
    const servers = await mcpServers(conn);
    const skills = await conn.request<{ data?: { skills?: unknown[] }[] }>('skills/list', {
      cwds: [work],
    });
    return {
      servers,
      skills: (skills.data ?? []).reduce((n, e) => n + (e.skills ?? []).length, 0),
    };
  });
  console.log(
    `Lean threads: MCP tools ${toolCount(before)} -> ${toolCount(after.servers)}, skills ${after.skills}; sending ${config.map((c) => `-c ${c}`).join(' ')}`,
  );
  if (toolCount(after.servers) > 0) {
    console.error('MCP tools are still loaded; not running any turn.');
    process.exit(2);
  }
}
/**
 * Free (no turn): the bridge's hosted tools reach a Codex thread. A tool
 * server on loopback (buildIt.Social's side is the in-process fake), an
 * app-server started with its secret, an ephemeral thread started with
 * the thread's config, then mcpServerStatus/list for that thread: the
 * buildit server must be connected, with its tools.
 */
async function hostedToolsCheck(): Promise<string> {
  const fake = await new FakeApi().start();
  fake.sessions.open(SESSION_TOKENS.first, 'codex-smoke-tools');
  const api = new ApiClient({ baseUrl: fake.url, token: SESSION_TOKENS.first, logger });
  await api.getMeta().catch(() => undefined);
  const state = new ChannelState();
  state.folder = work;
  state.session = await getSession(api);
  const tools = new BridgeToolServer({
    api,
    state,
    logger,
    ask: { questionsInApp: true, hookWaitS: 60 },
  });
  await tools.start();
  const proc = spawnAppServer(binary, { cwd: work, logger })(
    config.flatMap((c) => ['-c', c]),
    tools.env,
  );
  const conn = new AppServerConnection(proc.stdout, proc.stdin, { logger });
  try {
    await conn.request('initialize', {
      clientInfo: { name: 'buildit_mcp_smoke', title: null, version: '0.0.0' },
      capabilities: { experimentalApi: true },
    });
    conn.notify('initialized');
    const started = await conn.request<{ thread: { id: string } }>('thread/start', {
      cwd: work,
      ephemeral: true,
      config: tools.threadConfig('dm'),
    });
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      const list = await conn.request<{ data?: McpStatus[] }>('mcpServerStatus/list', {
        threadId: started.thread.id,
        serverName: BRIDGE_MCP_SERVER,
      });
      const entry = (list.data ?? []).find((m) => m.name === BRIDGE_MCP_SERVER);
      const names = Object.keys(entry?.tools ?? {});
      if (names.length > 0) {
        const want = ['reply', 'whoami', 'ask', 'get_attachment'];
        const missing = want.filter((n) => !names.includes(n));
        return missing.length === 0
          ? `OK, ${names.length} tools over loopback`
          : `FAIL, missing ${missing.join(', ')}`;
      }
    }
    return 'FAIL, the buildit server listed no tools';
  } finally {
    conn.close();
    await proc.stop();
    await tools.close();
    await fake.close();
  }
}

/** Codex asks before anything that writes, and the owner answers: the parity turns' settings. */
const PARITY_CONFIG = [
  'approval_policy="on-request"',
  'approvals_reviewer="user"',
  'sandbox_mode="read-only"',
];

if (!dryRun) console.log(`Hosted tools (no turn): ${await hostedToolsCheck()}`);

/**
 * Free (no turn): the plugin's skills reach Codex (skills/extraRoots/set,
 * then skills/list names them, at their own files), and a request's
 * thread starts as the bridge starts it (ephemeral, read-only, no shell).
 */
async function skillsAndRequestThreadCheck(): Promise<string> {
  return freeSession(config, async (conn) => {
    await conn.request('skills/extraRoots/set', { extraRoots: [SKILLS_ROOT] });
    const listed = listedSkills(
      await conn.request('skills/list', { cwds: [work], forceReload: true }),
    );
    const started = await conn.request<{ sandbox?: { type?: unknown } }>('thread/start', {
      cwd: work,
      ephemeral: true,
      sandbox: 'read-only',
      config: { ...PLUGINS_OFF, ...REQUEST_THREAD_CONFIG },
    });
    const ok = listed.size === BRIDGE_SKILLS.length && started.sandbox?.type === 'readOnly';
    return `${ok ? 'OK' : 'FAIL'}, ${listed.size} of ${BRIDGE_SKILLS.length} buildit skills listed (${[...listed.values()].map((s) => s.name).join(', ')}); a request's thread starts, sandbox ${String(started.sandbox?.type)}`;
  });
}
if (!dryRun && (threadsStep || questionsStep || requestsStep)) {
  const said = await skillsAndRequestThreadCheck();
  console.log(`Skills and a request's thread (no turn): ${said}`);
  if (!said.startsWith('OK')) process.exit(2);
}

// Free (no turn): the parity settings start, and a thread shows them (allowsession's too).
if (!dryRun && approvalsRun) {
  const shown = await freeSession([...config, ...PARITY_CONFIG], async (conn) => {
    const r = await conn.request<{
      approvalPolicy?: unknown;
      approvalsReviewer?: unknown;
      sandbox?: { type?: unknown };
    }>('thread/start', { cwd: work, ephemeral: true });
    return { policy: r.approvalPolicy, reviewer: r.approvalsReviewer, sandbox: r.sandbox?.type };
  }).catch((err: unknown) => {
    console.error(
      `The parity settings don't start: ${err instanceof Error ? err.message : String(err)}; not running any turn.`,
    );
    process.exit(2);
  });
  console.log(`Parity settings (no turn): ${JSON.stringify(shown)}`);
  if (shown.policy !== 'on-request' || shown.reviewer !== 'user' || shown.sandbox !== 'readOnly') {
    console.error('The parity settings did not apply; not running any turn.');
    process.exit(2);
  }
}
if (preflightOnly) process.exit(0);

// What the wire shows: new turns, their ends, the steers, the resumes, and the token usage.
const wire = {
  turns: 0,
  started: [] as string[],
  completed: new Map<string, string>(),
  steers: [] as { expected: string; turnId: string | undefined }[],
  steersRefused: 0,
  resumes: 0,
  usage: [] as unknown[],
  /** Each turn/start's input item types, and the server requests with the bridge's answers. */
  inputs: [] as string[][],
  serverRequests: new Map<
    unknown,
    { method: string; answer: string | undefined; params?: Record<string, unknown> }
  >(),
  /** The MCP tool calls Codex made (server/tool), from the items. */
  toolCalls: [] as string[],
  /** thread/start's params; turn/interrupt's and thread/unsubscribe's threads; each turn's thread. */
  threadStarts: [] as Record<string, unknown>[],
  interrupts: [] as string[],
  unsubscribes: [] as string[],
  turnThread: new Map<string, string>(),
  /** When each turn started and ended (ms), by turn id. */
  turnTimes: new Map<string, { start: number; end?: number }>(),
  /** Each turn/start's collaboration mode (none: not sent). */
  modes: [] as string[],
};
const tapped =
  (inner: SpawnAppServer): SpawnAppServer =>
  (args, env) => {
    const proc = inner(args, env);
    const fromServer = new PassThrough();
    const toServer = new PassThrough();
    const sent = new Map<unknown, { method: string; params: Record<string, unknown> }>();
    createInterface({ input: proc.stdout }).on('line', (line) => {
      appendFileSync(transcript, JSON.stringify({ t: Date.now(), dir: 'in', line }) + '\n');
      try {
        const m = JSON.parse(line) as {
          id?: unknown;
          method?: string;
          result?: { turn?: { id?: string }; turnId?: string };
          error?: unknown;
          params?: { tokenUsage?: unknown; turn?: { id?: string; status?: string } };
        };
        if (m.method === 'turn/started') {
          wire.turns++;
          const id = m.params?.turn?.id;
          const thread = (m.params as { threadId?: unknown } | undefined)?.threadId;
          if (id !== undefined) {
            wire.turnTimes.set(id, { start: Date.now() });
            if (typeof thread === 'string') wire.turnThread.set(id, thread);
          }
        }
        if (m.method === 'turn/completed' && m.params?.turn?.id !== undefined) {
          wire.completed.set(m.params.turn.id, m.params.turn.status ?? 'unknown');
          const t = wire.turnTimes.get(m.params.turn.id);
          if (t !== undefined) t.end = Date.now();
        }
        if (m.method === 'thread/tokenUsage/updated') wire.usage.push(m.params?.tokenUsage);
        if (m.method !== undefined && m.id !== undefined) {
          wire.serverRequests.set(m.id, {
            method: m.method,
            answer: undefined,
            params: m.params ?? {},
          });
        }
        const item = (
          m.params as { item?: { type?: string; server?: string; tool?: string } } | undefined
        )?.item;
        if (m.method === 'item/completed' && item?.type === 'mcpToolCall') {
          wire.toolCalls.push(`${String(item.server)}/${String(item.tool)}`);
        }
        const request = m.method === undefined ? sent.get(m.id) : undefined;
        if (request?.method === 'turn/start' && m.result?.turn?.id !== undefined) {
          if (!wire.started.includes(m.result.turn.id)) wire.started.push(m.result.turn.id);
        }
        if (request?.method === 'turn/steer') {
          if (m.error === undefined) {
            wire.steers.push({
              expected: String(request.params.expectedTurnId),
              turnId: m.result?.turnId,
            });
          } else {
            wire.steersRefused++;
          }
        }
        if (request?.method === 'thread/resume' && m.error === undefined) wire.resumes++;
      } catch {
        // Not JSON: the bridge logs it.
      }
      fromServer.write(line + '\n');
    });
    proc.stdout.on('end', () => fromServer.end());
    createInterface({ input: toServer }).on('line', (line) => {
      appendFileSync(transcript, JSON.stringify({ t: Date.now(), dir: 'out', line }) + '\n');
      const m = JSON.parse(line) as {
        id?: unknown;
        method?: string;
        params?: Record<string, unknown>;
      };
      if (m.method !== undefined && m.id !== undefined) {
        sent.set(m.id, { method: m.method, params: m.params ?? {} });
      }
      if (m.method === 'turn/start') {
        const input = (m.params?.input ?? []) as { type?: string }[];
        wire.inputs.push(input.map((i) => String(i.type)));
      }
      if (m.method === 'thread/start') wire.threadStarts.push(m.params ?? {});
      if (m.method === 'turn/start') {
        const mode = (m.params?.collaborationMode as { mode?: unknown } | undefined)?.mode;
        wire.modes.push(typeof mode === 'string' ? mode : 'none');
      }
      if (m.method === 'turn/interrupt') wire.interrupts.push(String(m.params?.threadId));
      if (m.method === 'thread/unsubscribe') wire.unsubscribes.push(String(m.params?.threadId));
      const asked = m.method === undefined ? wire.serverRequests.get(m.id) : undefined;
      if (asked !== undefined) {
        const r = (m as { result?: unknown }).result;
        asked.answer = JSON.stringify(r ?? null);
      }
      if (wire.turns >= maxTurns && m.method === 'turn/start') {
        console.error('Turn cap reached; stopping.');
        process.exit(3);
      }
      proc.stdin.write(line + '\n');
    });
    toServer.on('end', () => proc.stdin.end());
    return { ...proc, stdout: fromServer, stdin: toServer };
  };

const api = await new FakeApi().start();
const state = mkdtempSync(join(tmpdir(), 'codex-smoke-state-'));
const store = new FileTokenStore(join(state, 'sessions.json'));
await store.set(sessionKey(work, api.url), SESSION_TOKENS.first);
const s = api.sessions.open(SESSION_TOKENS.first, 'codex-smoke');
const io: CommandIO = {
  out: (t) => process.stdout.write(t),
  err: (t) => process.stderr.write(t),
  store,
  logger,
};
async function until(check: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(100);
  }
}

async function bridgeRun(): Promise<{ bridge: CodexBridge; stop: () => Promise<number> }> {
  let release!: () => void;
  const stop = new Promise<void>((r) => (release = r));
  let bridge: CodexBridge | undefined;
  const done = runCodex(
    {
      apiUrl: api.url,
      apiUrlFlag: true,
      folder: work,
      projects: [],
      label: 'codex-smoke',
      yes: false,
      capabilities: [],
      codexConfig: approvalsRun ? [...config, ...PARITY_CONFIG] : config,
      // Parity: debug, for the `_meta` keys of Codex's tool calls (names only; the report lists them).
      logLevel: parity ? 'debug' : 'info',
      // The questions run: work items plan first.
      ...(questionsStep ? { planItems: true } : {}),
    },
    io,
    {
      stop,
      spawn: tapped(dryRun ? fakeSpawn : spawnAppServer(binary, { cwd: work, logger })),
      lockDir: join(state, 'locks'),
      // Polls the in-process fake often, so a message reaches Codex quickly.
      intervalMs: 250,
      ...(parity
        ? {
            logSink: (line: string) => {
              if (line.includes('bridge tools: tools/call')) {
                const keys = (JSON.parse(line) as { meta_keys?: unknown }).meta_keys;
                metaKeys.add(JSON.stringify(keys ?? []));
              }
              process.stderr.write(`${line}\n`);
            },
          }
        : {}),
      onReady: (b) => (bridge = b),
    },
  );
  await until(() => bridge !== undefined, 60_000, 'the bridge');
  return {
    bridge: bridge!,
    stop: () => {
      release();
      return done;
    },
  };
}

/** The `_meta` keys Codex's tool calls carried (parity), as the bridge logged them. */
const metaKeys = new Set<string>();

const report: string[] = [];
const say = (text: string): void => {
  api.sessions.postFrom(SESSION_TOKENS.first, text);
};
const posts = () => s.messages.map((m) => m.text);
const check = (step: string, ok: boolean, detail: string): void => {
  report.push(`${step}: ${ok ? 'OK' : 'FAIL'} ${detail}`);
  if (!ok) process.exitCode = 1;
};
/** No turn runs: every turn started has completed, and the bridge follows none. */
const idle = (run: { bridge: CodexBridge }) => (): boolean =>
  run.bridge.runningTurn() === undefined && wire.started.every((id) => wire.completed.has(id));

/**
 * The parity turns: the in-process owner answers each approval card as the
 * step says (by the card's tool name; anything else is denied).
 */
async function parityRun(): Promise<void> {
  const token = SESSION_TOKENS.first;
  const run = await bridgeRun();
  await until(() => s.heartbeats.includes('online'), 30_000, 'online');
  let answers: Record<string, 'approve' | 'deny'> = {};
  const decided = new Set<string>();
  const owner = setInterval(() => {
    for (const card of api.sessions.approvals(token)) {
      if (card.status !== 'open' || decided.has(card.id)) continue;
      decided.add(card.id);
      api.sessions.decideApproval(token, card.id, answers[card.toolName] ?? 'deny');
    }
  }, 100);
  // The reply tool posts with a random (v4) id; the bridge's own posts with a v5 id made
  // from the turn, so a v4 post in a thread came through the hosted tool.
  const viaTool = () =>
    s.messages.filter((m) => /^[0-9a-f]{8}-[0-9a-f]{4}-4/i.test(m.id) && (m.card ?? null) === null);
  const cardsSince = (n: number) => api.sessions.approvals(token).slice(n);
  const turn = async (n: number, what: string): Promise<void> => {
    await until(() => wire.started.length >= n && idle(run)(), 180_000, what);
    await run.bridge.idle();
  };
  try {
    // A. the hosted tools and an image
    answers = {};
    const png = readFileSync(new URL('../test/fixtures/location/plain.png', import.meta.url));
    const threadA = api.sessions.postFrom(token, PARITY.a, {
      files: [{ name: 'plain.png', type: 'image/png', bytes: png, kind: 'image' }],
    });
    await turn(1, 'turn A');
    const whoami = api.requests.some((r) => r.headers['x-buildit-tool'] === 'whoami');
    const replies = viaTool();
    const inA = s.messages.filter((m) => m.thread_id === threadA);
    check(
      'A tools + image',
      (wire.inputs[0] ?? []).includes('localImage') &&
        whoami &&
        replies.length >= 1 &&
        inA.length === 1,
      `inputs ${JSON.stringify(wire.inputs[0])}, whoami ${String(whoami)}, replies via the tool ${replies.length}, posts in the thread ${inA.length} ${JSON.stringify(inA.map((m) => m.text))}, tool calls ${JSON.stringify(wire.toolCalls)}, their _meta keys ${[...metaKeys].join(' ')}`,
    );

    // B. an approved command, then a file shared
    answers = { command: 'approve' };
    const beforeB = api.sessions.approvals(token).length;
    say(PARITY.b);
    await turn(2, 'turn B');
    const cardsB = cardsSince(beforeB);
    check(
      'B approve + file',
      cardsB.some((c) => c.toolName === 'command' && c.status === 'approved') &&
        existsSync(join(work, 'out.txt')) &&
        api.sessions.filePosts.length >= 1,
      `cards ${JSON.stringify(cardsB.map((c) => `${c.toolName}:${c.status}`))}, out.txt ${String(existsSync(join(work, 'out.txt')))}, file posts ${api.sessions.filePosts.length}`,
    );

    // C. a denied command
    answers = {};
    const beforeC = api.sessions.approvals(token).length;
    say(PARITY.c);
    await turn(3, 'turn C');
    const cardsC = cardsSince(beforeC);
    const declined = [...wire.serverRequests.values()].some((r) =>
      (r.answer ?? '').includes('"decline"'),
    );
    check(
      'C deny',
      cardsC.length >= 1 &&
        cardsC.every((c) => c.status === 'denied') &&
        declined &&
        !existsSync(join(work, 'denied.txt')),
      `cards ${JSON.stringify(cardsC.map((c) => `${c.toolName}:${c.status}`))}, denied.txt ${String(existsSync(join(work, 'denied.txt')))}`,
    );

    // D. a file change, shown with its diff, approved
    answers = { file_change: 'approve' };
    const beforeD = api.sessions.approvals(token).length;
    say(PARITY.d);
    await turn(4, 'turn D');
    const cardsD = cardsSince(beforeD);
    const change = cardsD.find((c) => c.toolName === 'file_change');
    const fields = (change?.posted.fields ?? []) as { key: string; value: string }[];
    const shown = fields.some(
      (f) => f.key.endsWith('hello.txt') && f.value.includes('hello.txt') && f.value.includes('hi'),
    );
    check(
      'D file change',
      change?.status === 'approved' && shown && existsSync(join(work, 'hello.txt')),
      `cards ${JSON.stringify(cardsD.map((c) => `${c.toolName}:${c.status}`))}, diff shown ${String(shown)}, hello.txt ${String(existsSync(join(work, 'hello.txt')))}`,
    );
  } finally {
    clearInterval(owner);
    await run.stop();
  }
}

/** A fake API item by its number (the made-up DEMO project), as item events name it. */
function storeItem(n: number): { id: string; key: string; title: string } {
  const i = api.store.items.find((x) => x.project === 'DEMO' && x.number === n);
  if (i === undefined) throw new Error(`no DEMO-${n} in the fake API`);
  return { id: i.id, key: `DEMO-${n}`, title: i.title };
}

/** The owner denies every approval card while a run lasts (unless `answers` says otherwise). */
function owner(answers: () => Record<string, 'approve' | 'deny'> = () => ({})): () => void {
  const decided = new Set<string>();
  const timer = setInterval(() => {
    for (const card of api.sessions.approvals(SESSION_TOKENS.first)) {
      if (card.status !== 'open' || decided.has(card.id)) continue;
      decided.add(card.id);
      api.sessions.decideApproval(
        SESSION_TOKENS.first,
        card.id,
        answers()[card.toolName] ?? 'deny',
      );
    }
  }, 100);
  return () => {
    clearInterval(timer);
  };
}

/** The text posts in a thread (not the approval cards). */
function textPostsIn(thread: string | null): string[] {
  const cards = new Set(api.sessions.approvals(SESSION_TOKENS.first).map((c) => c.id));
  return s.messages.filter((m) => m.thread_id === thread && !cards.has(m.id)).map((m) => m.text);
}

/** Work items in their own threads and worktrees, then an unassign that interrupts one. */
async function threadsRun(): Promise<void> {
  const token = SESSION_TOKENS.first;
  const run = await bridgeRun();
  await until(() => s.heartbeats.includes('online'), 30_000, 'online');
  const stopOwner = owner();
  const one = storeItem(44);
  const two = storeItem(45);
  try {
    if (!unassignStep) await twoAtOnce(run, one, two);

    // B. an unassign interrupts one item
    const before = textPostsIn(one.id).length;
    const place = `item:${one.id}`;
    api.sessions.itemMessage(token, one, THREADS.count, { mention: true });
    await until(() => run.bridge.runningTurn(place) !== undefined, 60_000, 'turn B running');
    const turnB = run.bridge.runningTurn(place) ?? '';
    await sleep(1500);
    api.sessions.unassignItem(token, one);
    await until(() => wire.unsubscribes.length >= 1, 60_000, 'unsubscribe');
    await until(() => wire.completed.has(turnB), 60_000, 'turn B ended');
    await sleep(1000);
    // Read once the turn is over: its turn/started may come after turn/start's answer.
    const threadOne = wire.turnThread.get(turnB) ?? '';
    check(
      'B unassign',
      threadOne !== '' &&
        wire.interrupts.includes(threadOne) &&
        wire.unsubscribes.includes(threadOne) &&
        wire.completed.get(turnB) === 'interrupted' &&
        textPostsIn(one.id).length === before,
      `thread ${threadOne}, interrupt ${JSON.stringify(wire.interrupts)}, unsubscribe ${JSON.stringify(wire.unsubscribes)}, status ${String(wire.completed.get(turnB))}, posts after ${textPostsIn(one.id).length} (expected ${before})`,
    );
  } finally {
    stopOwner();
    await run.stop();
  }
}

/** Step A of the threads run: two items' mentions at once. */
async function twoAtOnce(
  run: { bridge: CodexBridge },
  one: { id: string; key: string; title: string },
  two: { id: string; key: string; title: string },
): Promise<void> {
  const token = SESSION_TOKENS.first;
  {
    api.sessions.itemMessage(token, one, THREADS.one, { mention: true });
    api.sessions.itemMessage(token, two, THREADS.two, { mention: true });
    await until(
      () =>
        wire.started.length >= 2 &&
        idle(run)() &&
        textPostsIn(one.id).length >= 1 &&
        textPostsIn(two.id).length >= 1,
      180_000,
      'turns A',
    );
    await run.bridge.idle();
    const cwds = wire.threadStarts.map((p) => String(p.cwd));
    const inWorktrees =
      cwds.length === 2 &&
      cwds.every((c) => c.includes(join('.buildit', 'worktrees'))) &&
      cwds[0] !== cwds[1];
    const pluginsOff = wire.threadStarts.every(
      (p) => (p.config as Record<string, unknown> | undefined)?.['features.plugins'] === false,
    );
    const times = [...wire.turnTimes.values()].slice(0, 2);
    const [t1, t2] = times;
    const overlap =
      t1?.end !== undefined && t2?.end !== undefined && t1.start < t2.end && t2.start < t1.end;
    const branches = execFileSync('git', ['branch', '--list'], { cwd: work, encoding: 'utf8' })
      .split('\n')
      .map((b) => b.replace(/^[*+]?\s*/, '').trim())
      .filter((b) => b !== '');
    check(
      'A two at once',
      inWorktrees &&
        pluginsOff &&
        overlap &&
        /one/i.test(textPostsIn(one.id).join(' ')) &&
        /two/i.test(textPostsIn(two.id).join(' ')) &&
        branches.some((b) => b.startsWith('demo-44')) &&
        branches.some((b) => b.startsWith('demo-45')),
      `cwds ${JSON.stringify(cwds.map((c) => c.slice(work.length)))}, plugins off ${String(pluginsOff)}, turns overlapped ${String(overlap)}, posts ${JSON.stringify([textPostsIn(one.id), textPostsIn(two.id)])}, branches ${JSON.stringify(branches)}`,
    );
  }
}

/** The question cards in a thread (the stacked card), oldest first. */
function questionCardsIn(thread: string | null): typeof s.messages {
  return s.messages.filter((m) => m.thread_id === thread && (m.card ?? null) !== null);
}

/** A question through the hosted ask, then a plan-mode question and the plan's card. */
async function questionsRun(): Promise<void> {
  const token = SESSION_TOKENS.first;
  const run = await bridgeRun();
  await until(() => s.heartbeats.includes('online'), 30_000, 'online');
  // The owner approves the plan's card and denies any other; each question card gets its first option.
  const stopOwner = owner(() => ({ plan: 'approve' }));
  const answered = new Set<string>();
  const answerer = setInterval(() => {
    for (const m of s.messages) {
      if ((m.card ?? null) === null || answered.has(m.id) || cardIdsOf().has(m.id)) continue;
      answered.add(m.id);
      api.sessions.answerCard(token, m.id, { inputs: { q1: 'o1' } });
    }
  }, 100);
  const item = storeItem(44);
  try {
    if (!planStep) await askStep(run);

    // B. plan mode: (a question, on a card,) the plan's card, approved, then carried out
    const turnsBefore = wire.started.length;
    api.sessions.itemMessage(token, item, planStep ? QUESTIONS.planOnly : QUESTIONS.plan, {
      mention: true,
    });
    await until(
      () => api.sessions.approvals(token).some((c) => c.toolName === 'plan'),
      240_000,
      'the plan card',
    );
    await until(
      () => wire.modes.at(-1) === 'default' && idle(run)(),
      180_000,
      'the plan carried out',
    );
    await run.bridge.idle();
    const modes = wire.modes.slice(-(wire.started.length - turnsBefore));
    const planCardOf = api.sessions.approvals(token).find((c) => c.toolName === 'plan');
    const native = [...wire.serverRequests.values()].some(
      (r) => r.method === 'item/tool/requestUserInput' && (r.answer ?? '').includes('"yes"'),
    );
    const cards = questionCardsIn(item.id).filter((m) => !cardIdsOf().has(m.id)).length;
    check(
      'B plan',
      (planStep || cards >= 1) &&
        planCardOf?.status === 'approved' &&
        modes[0] === 'plan' &&
        modes.at(-1) === 'default' &&
        /yes/i.test(textPostsIn(item.id).join(' ')),
      `question cards ${cards} (requestUserInput answered yes: ${String(native)}; else an async question), plan card ${String(planCardOf?.status)}, modes ${JSON.stringify(modes)}, posts ${JSON.stringify(textPostsIn(item.id))}`,
    );
  } finally {
    clearInterval(answerer);
    stopOwner();
    await run.stop();
  }
}

/** Step A of the questions run: a question through the hosted ask. */
async function askStep(run: { bridge: CodexBridge }): Promise<void> {
  const token = SESSION_TOKENS.first;
  {
    const thread = api.sessions.postFrom(token, QUESTIONS.ask);
    await until(
      () => wire.started.length >= 1 && idle(run)() && textPostsIn(thread).length >= 1,
      180_000,
      'turn A',
    );
    await run.bridge.idle();
    check(
      'A ask',
      questionCardsIn(thread).length === 1 && /red/i.test(textPostsIn(thread).join(' ')),
      `question cards ${questionCardsIn(thread).length}, tool calls ${JSON.stringify(wire.toolCalls)}, posts ${JSON.stringify(textPostsIn(thread))}`,
    );
  }
}

/** A catch-up and a thread to items, each in its own read-only thread with its skills. */
async function requestsRun(): Promise<void> {
  const token = SESSION_TOKENS.first;
  const run = await bridgeRun();
  await until(() => s.heartbeats.includes('online'), 30_000, 'online');
  const stopOwner = owner();
  const general = { id: CHANNELS.general, name: 'general' };
  const postsOf = (request: string) =>
    api.sessions.requestPosts.filter((r) => r.request.toLowerCase() === request.toLowerCase());
  try {
    // A. a catch-up: its result in the direct message only
    const a = api.sessions.pushRequest(token, {
      kind: 'catch_up',
      project: null,
      context: {
        type: 'channel',
        channel: general,
        from: '2026-10-06T00:00:00.000Z',
        to: '2026-10-08T00:00:00.000Z',
      },
    });
    await until(
      () => wire.started.length >= 1 && idle(run)() && postsOf(a.requestId).length >= 1,
      180_000,
      'request A',
    );
    await run.bridge.idle();
    await until(() => wire.unsubscribes.length >= 1, 30_000, 'request A unsubscribed');
    const startA = wire.threadStarts[0] ?? {};
    const configA = (startA.config ?? {}) as Record<string, unknown>;
    const lean =
      startA.ephemeral === true &&
      startA.sandbox === 'read-only' &&
      configA['features.shell_tool'] === false &&
      configA['features.plugins'] === false;
    check(
      'A catch-up',
      lean &&
        (wire.inputs[0] ?? []).filter((t) => t === 'skill').length === 2 &&
        postsOf(a.requestId).every((r) => r.thread_id === null) &&
        textPostsIn(null).length >= 1,
      `thread ${JSON.stringify({ ephemeral: startA.ephemeral, sandbox: startA.sandbox, shell: configA['features.shell_tool'], plugins: configA['features.plugins'] })}, inputs ${JSON.stringify(wire.inputs[0])}, result posts ${JSON.stringify(postsOf(a.requestId).map((r) => r.thread_id))}, DM posts ${JSON.stringify(textPostsIn(null))}, tool calls ${JSON.stringify(wire.toolCalls)}`,
    );

    // B. a thread to items: its card (or note) in that thread only
    const b = api.sessions.pushRequest(token, {
      kind: 'thread_to_items',
      place: 'thread',
      context: { type: 'thread', channel: { ...general, dm: false }, thread_id: MESSAGES.root },
    });
    await until(
      () => wire.started.length >= 2 && idle(run)() && postsOf(b.requestId).length >= 1,
      180_000,
      'request B',
    );
    await run.bridge.idle();
    check(
      'B thread to items',
      postsOf(b.requestId).every(
        (r) => r.thread_id?.toLowerCase() === MESSAGES.root.toLowerCase(),
      ) && (wire.inputs[1] ?? []).filter((t) => t === 'skill').length === 2,
      `inputs ${JSON.stringify(wire.inputs[1])}, result posts ${JSON.stringify(postsOf(b.requestId).map((r) => r.thread_id))}, tool calls ${JSON.stringify(wire.toolCalls)}`,
    );
  } finally {
    stopOwner();
    await run.stop();
  }
}

/**
 * "Allow for this session": a command allowed for the session, then the
 * same command with no second card; when Codex doesn't offer it for the
 * command, the same with a file change. The fake API is a 1.27.0 server
 * and the session a Codex one, so the bridge offers the rule.
 */
async function allowSessionRun(): Promise<void> {
  const token = SESSION_TOKENS.first;
  s.clientKey = 'codex';
  api.meta = { ...api.meta, api_version: '1.27.0' };
  const run = await bridgeRun();
  await until(() => s.heartbeats.includes('online'), 30_000, 'online');
  // The owner: Allow for this session where the card offers it, Deny otherwise.
  const decided = new Set<string>();
  const ownerTimer = setInterval(() => {
    for (const card of api.sessions.approvals(token)) {
      if (card.status !== 'open' || decided.has(card.id)) continue;
      decided.add(card.id);
      api.sessions.decideApproval(
        token,
        card.id,
        card.posted.suggestion !== undefined ? 'approve_session' : 'deny',
      );
    }
  }, 100);
  const cardsSince = (n: number) => api.sessions.approvals(token).slice(n);
  const requestsSince = (n: number) => [...wire.serverRequests.values()].slice(n);
  const linesOf = (name: string): string[] =>
    existsSync(join(work, name))
      ? readFileSync(join(work, name), 'utf8')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l !== '')
      : [];
  const turn = async (n: number, what: string): Promise<void> => {
    await until(() => wire.started.length >= n && idle(run)(), 180_000, what);
    await run.bridge.idle();
  };
  const allowed = (cards: ReturnType<typeof cardsSince>, tool: string) =>
    cards.some((c) => c.toolName === tool && c.status === 'approved_session');
  const answeredForSession = (since: number, method: string) =>
    requestsSince(since).some(
      (r) => r.method === method && (r.answer ?? '').includes('"acceptForSession"'),
    );
  const lasting = () =>
    [...wire.serverRequests.values()].some((r) => /Amendment/.test(r.answer ?? ''));
  const pair = async (
    first: { prompt: string; step: string; tool: string; method: string; check: () => boolean },
    again: { prompt: string; step: string; check: () => boolean },
    turns: number,
  ): Promise<void> => {
    const beforeCards = api.sessions.approvals(token).length;
    const beforeRequests = wire.serverRequests.size;
    say(first.prompt);
    await turn(turns + 1, first.step);
    const cardsA = cardsSince(beforeCards);
    check(
      first.step,
      allowed(cardsA, first.tool) &&
        answeredForSession(beforeRequests, first.method) &&
        first.check(),
      `cards ${JSON.stringify(cardsA.map((c) => `${c.toolName}:${c.status}:${c.posted.suggestion === undefined ? 'no rule' : 'rule'}`))}, acceptForSession sent ${String(answeredForSession(beforeRequests, first.method))}`,
    );
    const beforeAgain = api.sessions.approvals(token).length;
    const requestsAgain = wire.serverRequests.size;
    say(again.prompt);
    await turn(turns + 2, again.step);
    const asked = requestsSince(requestsAgain).filter((r) => r.method === first.method);
    check(
      again.step,
      cardsSince(beforeAgain).length === 0 && asked.length === 0 && again.check(),
      `new cards ${cardsSince(beforeAgain).length}, Codex asked ${asked.length} time(s)`,
    );
  };
  try {
    // A. a command, allowed for the session (when Codex offers it for this command)
    const beforeRequests = wire.serverRequests.size;
    const beforeCards = api.sessions.approvals(token).length;
    say(ALLOW.a);
    await turn(1, 'turn A');
    const cardsA = cardsSince(beforeCards);
    const commandRequest = requestsSince(beforeRequests).find(
      (r) => r.method === 'item/commandExecution/requestApproval',
    );
    const offered = commandRequest?.params?.availableDecisions;
    const offersSession = Array.isArray(offered) && offered.includes('acceptForSession');
    if (offersSession) {
      check(
        'A command for the session',
        allowed(cardsA, 'command') &&
          answeredForSession(beforeRequests, 'item/commandExecution/requestApproval') &&
          linesOf('allow.txt').length === 1,
        `cards ${JSON.stringify(cardsA.map((c) => `${c.toolName}:${c.status}`))}, allow.txt lines ${linesOf('allow.txt').length}`,
      );
      // B. the same command again: no second card
      const beforeAgain = api.sessions.approvals(token).length;
      const requestsAgain = wire.serverRequests.size;
      say(ALLOW.b);
      await turn(2, 'turn B');
      const asked = requestsSince(requestsAgain).filter(
        (r) => r.method === 'item/commandExecution/requestApproval',
      );
      check(
        'B again, no card',
        cardsSince(beforeAgain).length === 0 &&
          asked.length === 0 &&
          linesOf('allow.txt').length === 2,
        `new cards ${cardsSince(beforeAgain).length}, Codex asked ${asked.length} time(s), allow.txt lines ${linesOf('allow.txt').length}`,
      );
    } else {
      // Codex didn't offer it for this command: its card had no rule, and was denied.
      check(
        'A command (not offered)',
        commandRequest !== undefined &&
          cardsA.every((c) => c.posted.suggestion === undefined && c.status === 'denied') &&
          !existsSync(join(work, 'allow.txt')),
        `Codex's decisions for the command: ${JSON.stringify(offered ?? null)}; cards ${JSON.stringify(cardsA.map((c) => `${c.toolName}:${c.status}`))}; the file-change steps instead`,
      );
      await pair(
        {
          prompt: ALLOW.c,
          step: 'C file change for the session',
          tool: 'file_change',
          method: 'item/fileChange/requestApproval',
          check: () => linesOf('allow-file.txt').join() === 'one',
        },
        {
          prompt: ALLOW.d,
          step: 'D again, no card',
          check: () => linesOf('allow-file.txt').join() === 'two',
        },
        1,
      );
    }
    check(
      'never a lasting rule',
      !lasting(),
      'no acceptWithExecpolicyAmendment or applyNetworkPolicyAmendment sent',
    );
  } finally {
    clearInterval(ownerTimer);
    await run.stop();
  }
}

/** The approval cards' message ids (not question cards). */
function cardIdsOf(): Set<string> {
  return new Set(api.sessions.approvals(SESSION_TOKENS.first).map((c) => c.id));
}

/** An extra run is over (its steps reported): the main steps are skipped. */
class RunDone extends Error {}

try {
  if (parity) {
    await parityRun();
    throw new ParityDone();
  }
  if (threadsStep) {
    await threadsRun();
    throw new RunDone();
  }
  if (questionsStep) {
    await questionsRun();
    throw new RunDone();
  }
  if (requestsStep) {
    await requestsRun();
    throw new RunDone();
  }
  if (allowSession) {
    await allowSessionRun();
    throw new RunDone();
  }
  let run = await bridgeRun();
  await until(() => s.heartbeats.includes('online'), 30_000, 'online');

  if (!only) {
    // 1. reply
    say('Reply with the single word pong.');
    await until(() => posts().length === 1 && idle(run)(), 180_000, 'turn 1 answer');
    check('1 reply', /pong/i.test(posts()[0] ?? ''), JSON.stringify(posts()[0]));
  }

  // 2. steer. Both messages are posted at once, so one poll brings them: the
  // first starts a turn, and the second is steered into it a few
  // milliseconds later, long before the model can answer (its first output
  // came after about a second in the first run). Waiting for the turn
  // before posting the second raced the model there: the count finished
  // before the next poll brought the steer.
  const before = posts().length;
  say('Count slowly from 1 to 30, one number per line, then stop.');
  say('Stop counting. Reply with the single word steered.');
  await until(() => wire.steers.length + wire.steersRefused >= 1, 60_000, 'turn 2 steer');
  const turn2 = wire.started.at(-1);
  await until(() => posts().length === before + 1 && idle(run)(), 180_000, 'turn 2 answer');
  const steer = wire.steers.at(-1);
  check(
    '2 steer',
    steer !== undefined &&
      steer.expected === turn2 &&
      steer.turnId === turn2 &&
      wire.completed.get(steer.expected) === 'completed' &&
      /steered/i.test(posts()[before] ?? ''),
    `${JSON.stringify(posts()[before])} (steered into the running turn: ${String(steer?.turnId === turn2)}; refused steers: ${wire.steersRefused})`,
  );

  if (!only) {
    // 3. interrupt
    const count = posts().length;
    say('Count slowly from 1 to 200, one number per line.');
    await until(() => run.bridge.runningTurn() !== undefined, 60_000, 'turn 3 running');
    const turn3 = run.bridge.runningTurn();
    await sleep(1500);
    await run.bridge.interrupt();
    await until(() => idle(run)(), 60_000, 'turn 3 interrupted');
    await sleep(1000);
    check(
      '3 interrupt',
      wire.completed.get(turn3 ?? '') === 'interrupted' && posts().length === count,
      `status ${String(wire.completed.get(turn3 ?? ''))}, posts after = ${posts().length} (expected ${count})`,
    );

    // 4. resume after a restart
    report.push(`restart: exit ${await run.stop()}`);
    run = await bridgeRun();
    say('What single word did you reply to my first message? Reply with that word only.');
    await until(() => posts().length === count + 1 && idle(run)(), 180_000, 'turn 4 answer');
    check(
      '4 resume',
      wire.resumes >= 1 && /pong/i.test(posts()[count] ?? ''),
      `${JSON.stringify(posts()[count])} (thread/resume: ${wire.resumes})`,
    );
  }
  await run.stop();
} catch (err) {
  if (!(err instanceof ParityDone) && !(err instanceof RunDone)) {
    report.push(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
} finally {
  report.push(
    `turns: ${wire.turns} (cap ${maxTurns})`,
    `token usage: ${JSON.stringify(wire.usage.at(-1) ?? null)}`,
  );
  report.push(
    approvalsRun
      ? `folder now holds: ${readdirSync(work).join(', ') || 'nothing'}`
      : `folder still empty (the repository and its worktrees aside): ${contents().length === 0}`,
    `transcript: ${transcript}`,
  );
  console.log(report.join('\n'));
  appendFileSync(join(out, 'report.txt'), report.join('\n') + '\n');
  await api.close();
  rmSync(state, { recursive: true, force: true });
}
