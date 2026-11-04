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
 * (account/*, remoteControl/*, moderation metadata). Rewritten: the
 * working folder and Codex's home (to /tmp paths) and the user agent's
 * platform. It fails when any string still looks like a local user path,
 * so nothing from the computer or the account reaches the repository; the
 * texts kept are the smoke's own test prompts and the model's answers.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const DROPPED = [/^account\//, /^remoteControl\//, /^turn\/moderationMetadata$/];
const WORK = '/tmp/codex-smoke-work';
const HOME = '/tmp/codex-home';

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
  // The folders to rewrite, from the bridge's thread/start and the handshake's answer.
  for (const e of parsed) {
    const m = JSON.parse(e.line) as Record<string, unknown>;
    const params = m.params as Record<string, unknown> | undefined;
    if (m.method === 'thread/start' && typeof params?.cwd === 'string') work ??= params.cwd;
    const result = m.result as Record<string, unknown> | undefined;
    if (typeof result?.codexHome === 'string') home ??= result.codexHome;
  }
  const scrub = (v: unknown): unknown => {
    if (typeof v === 'string') {
      let s = v;
      if (work !== undefined) s = s.split(work).join(WORK);
      if (home !== undefined) s = s.split(home).join(HOME);
      s = s.replace(/^\\\\\?\\/, '');
      if (/^[^/\s]+\/\d+\.\d+\.\d+ \(/.test(s)) {
        s = s.replace(/\(([^)]*)\)/, '(Test OS; x86_64)').replace(/\) \S+ \(/, ') test (');
      }
      if (/[A-Za-z]:\\+Users\\+|\/(Users|home)\/[A-Za-z]/.test(s)) {
        throw new Error('a local user path is left in the transcript');
      }
      return s;
    }
    if (Array.isArray(v)) return v.map(scrub);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]));
    }
    return v;
  };
  for (const e of parsed) {
    const m = JSON.parse(e.line) as Record<string, unknown>;
    if (typeof m.method === 'string' && DROPPED.some((r) => r.test(m.method as string))) continue;
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
