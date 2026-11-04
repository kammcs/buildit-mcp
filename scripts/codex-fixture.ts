/**
 * Turns a smoke run's JSON-RPC transcript (scripts/codex-smoke.ts writes
 * one) into a test fixture: test/fixtures/codex/smoke-<version>.jsonl,
 * which test/codex-replay.test.ts plays back to the bridge.
 *
 *   npx tsx scripts/codex-fixture.ts <transcript.jsonl> [--out <file>]
 *
 * Kept: every message between the bridge and the app-server about the
 * session's threads and turns, in order, with the time since the first.
 * Left out: notifications about the Codex account and this computer
 * (account/*, remoteControl/*, moderation metadata), and the thread
 * settings notices (Codex's own mode instructions). Rewritten: the
 * working folder and Codex's home (to /tmp paths), the plugin's skills
 * folder (to a placeholder the replay maps back), the user agent's
 * platform, the hosted tools' URL (its port and per-thread token), the
 * tools' random idempotency keys (fixed ones), and
 * config/read's answer, cut to the two approval settings the bridge reads
 * (the rest is the person's whole Codex config: their MCP servers, their
 * paths). It fails when any string still looks like a local user path,
 * so nothing from the computer or the account reaches the repository; the
 * texts kept are the smoke's own test prompts and the model's answers.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// thread/settings/updated carries Codex's own mode instructions (its prompt text), not the bridge's.
const DROPPED = [
  /^account\//,
  /^remoteControl\//,
  /^turn\/moderationMetadata$/,
  /^thread\/settings\/updated$/,
];
const WORK = '/tmp/codex-smoke-work';
const HOME = '/tmp/codex-home';
/** The plugin's skills folder, as the fixture writes it (the replay puts this checkout's back). */
export const SKILLS = '/buildit-mcp/plugin/skills';
/** The hosted tools' per-run URL, as the fixture writes it. */
const TOOLS_URL = 'http://127.0.0.1:0/mcp/thread-token';

/** config/read's answer, cut to what the bridge reads. */
function configAnswer(result: unknown): Record<string, unknown> {
  const config = ((result ?? {}) as { config?: Record<string, unknown> }).config ?? {};
  return {
    config: {
      approval_policy: config.approval_policy ?? null,
      approvals_reviewer: config.approvals_reviewer ?? null,
    },
    origins: {},
    layers: null,
  };
}

export interface FixtureRecord {
  dir: 'in' | 'out';
  /** Milliseconds since the transcript's first message. */
  ms: number;
  msg: Record<string, unknown>;
}

/** The fixture records of a transcript's lines. */
export function fixtureOf(lines: readonly string[]): FixtureRecord[] {
  const out: FixtureRecord[] = [];
  let first: number | undefined;
  let work: string | undefined;
  let home: string | undefined;
  const parsed = lines
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { t: number; dir: 'in' | 'out'; line: string });
  // The folders to rewrite: the session's folder (config/read's, else the first thread's, outside
  // any worktree), Codex's home (the handshake's answer) and the plugin's skills (the bridge's
  // skill root, which names this checkout).
  let skills: string | undefined;
  for (const e of parsed) {
    const m = JSON.parse(e.line) as Record<string, unknown>;
    const params = m.params as Record<string, unknown> | undefined;
    if (m.method === 'config/read' && typeof params?.cwd === 'string') work ??= params.cwd;
    if (m.method === 'thread/start' && typeof params?.cwd === 'string') {
      work ??= params.cwd.replace(/[\\/]\.buildit[\\/]worktrees[\\/].*$/, '');
    }
    const roots = params?.extraRoots;
    if (m.method === 'skills/extraRoots/set' && Array.isArray(roots)) {
      skills ??= typeof roots[0] === 'string' ? roots[0] : undefined;
    }
    const result = m.result as Record<string, unknown> | undefined;
    if (typeof result?.codexHome === 'string') home ??= result.codexHome;
  }
  /** A path as it appears: as is, with doubled backslashes (in a command), with slashes. */
  const forms = (path: string): string[] => [
    path.replace(/\\/g, '\\\\'),
    path,
    path.replace(/\\/g, '/'),
  ];
  const keys = new Map<string, string>();
  const fixedKey = (key: string): string => {
    let fixed = keys.get(key);
    if (fixed === undefined) {
      fixed = `00000000-0000-4000-8000-${String(keys.size + 1).padStart(12, '0')}`;
      keys.set(key, fixed);
    }
    return fixed;
  };
  const scrub = (v: unknown): unknown => {
    if (typeof v === 'string') {
      let s = v;
      if (skills !== undefined) {
        for (const f of forms(skills)) s = s.split(f).join(SKILLS);
        // The rest of a skill's path after the root, in the slashes of the placeholder.
        s = s.replace(
          /\/buildit-mcp\/plugin\/skills((?:\\+[\w.-]+)+)/g,
          (_m, rest: string) => `${SKILLS}${rest.replace(/\\+/g, '/')}`,
        );
      }
      if (work !== undefined) for (const f of forms(work)) s = s.split(f).join(WORK);
      if (home !== undefined) for (const f of forms(home)) s = s.split(f).join(HOME);
      s = s.replace(/^\\\\\?\\/, '');
      s = s.replace(/http:\/\/127\.0\.0\.1:\d+\/mcp\/[A-Za-z0-9_-]+/g, TOOLS_URL);
      if (/^[^/\s]+\/\d+\.\d+\.\d+ \(/.test(s)) {
        s = s.replace(/\(([^)]*)\)/, '(Test OS; x86_64)').replace(/\) \S+ \(/, ') test (');
      }
      if (/[A-Za-z]:\\+Users\\+|\/(Users|home)\/[A-Za-z]/.test(s)) {
        throw new Error('a local user path is left in the transcript');
      }
      // Any other absolute Windows path is this computer's too (Windows' own folders aside).
      if (/(^|[\s"'(=])[A-Za-z]:\\+(?!\\|WINDOWS\\|Windows\\|Program Files)/.test(s)) {
        throw new Error('a local path is left in the transcript');
      }
      return s;
    }
    if (Array.isArray(v)) return v.map(scrub);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [
          k,
          // A tool's random idempotency keys: fixed ones (secret scanners read random ones as keys).
          k === 'idempotency_key' && typeof x === 'string' ? fixedKey(x) : scrub(x),
        ]),
      );
    }
    return v;
  };
  const configReads = new Set<unknown>();
  for (const e of parsed) {
    const m = JSON.parse(e.line) as Record<string, unknown>;
    if (typeof m.method === 'string' && DROPPED.some((r) => r.test(m.method as string))) continue;
    if (e.dir === 'out' && m.method === 'config/read') configReads.add(m.id);
    if (e.dir === 'in' && m.method === undefined && configReads.has(m.id) && 'result' in m) {
      m.result = configAnswer(m.result);
    }
    first ??= e.t;
    out.push({ dir: e.dir, ms: e.t - first, msg: scrub(m) as Record<string, unknown> });
  }
  return out;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { out: { type: 'string' } },
  });
  const source = positionals[0];
  if (source === undefined) {
    console.error('Usage: npx tsx scripts/codex-fixture.ts <transcript.jsonl> [--out <file>]');
    process.exit(2);
  }
  const records = fixtureOf(readFileSync(source, 'utf8').split('\n'));
  const init = records.find(
    (r) => r.msg.result !== undefined && 'userAgent' in (r.msg.result as object),
  );
  const said = (init?.msg.result as { userAgent?: unknown } | undefined)?.userAgent;
  const ua = typeof said === 'string' ? said : '';
  const version = /\/(\d+\.\d+\.\d+)/.exec(ua)?.[1] ?? 'unknown';
  const root = fileURLToPath(new URL('..', import.meta.url));
  const target = values.out ?? join(root, 'test', 'fixtures', 'codex', `smoke-${version}.jsonl`);
  writeFileSync(target, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`wrote ${records.length} messages to ${target}`);
}
