/**
 * The meeting's notes requests this session was sent, kept in a small file
 * next to the folder's lock files.
 *
 * A meeting's notes request reads its meeting's thread and its transcript
 * by itself (read_thread and get_attachment with `request`), and the tools
 * check what they read against the request before any call: that thread
 * and those two files, nothing else. A request reaches the server once (its
 * event is acknowledged), so a restarted server would forget it and could
 * no longer check. The journal keeps each such request's scope until it
 * expires, so a restarted server still checks it; a request it doesn't know
 * is refused.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** What the journal keeps of one request: its scope, never any text. */
export interface JournalEntry {
  id: string;
  kind: string;
  thread: string;
  /** The meeting's project key, or null when it has none. */
  project: string | null;
  transcript: { message_id: string; file_id: string }[];
  /** When the request expires (RFC 3339); dropped after that. */
  expires_at: string;
}

interface JournalFile {
  v: 1;
  requests: JournalEntry[];
}

/** The most requests the journal keeps (the newest). */
export const JOURNAL_MAX = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT_KEY = /^[A-Z][A-Z0-9]{0,19}$/;

function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID.test(v);
}

function entryOf(v: unknown, now: number): JournalEntry | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const e = v as Record<string, unknown>;
  if (!isUuid(e.id) || e.kind !== 'meeting_notes' || !isUuid(e.thread)) return undefined;
  if (e.project !== null && !(typeof e.project === 'string' && PROJECT_KEY.test(e.project))) {
    return undefined;
  }
  if (!Array.isArray(e.transcript) || e.transcript.length === 0 || e.transcript.length > 2) {
    return undefined;
  }
  const transcript: { message_id: string; file_id: string }[] = [];
  for (const t of e.transcript as unknown[]) {
    const f = t as Record<string, unknown> | null;
    if (f === null || typeof f !== 'object' || !isUuid(f.message_id) || !isUuid(f.file_id)) {
      return undefined;
    }
    transcript.push({ message_id: f.message_id, file_id: f.file_id });
  }
  const expires = typeof e.expires_at === 'string' ? Date.parse(e.expires_at) : NaN;
  if (!Number.isFinite(expires) || expires <= now) return undefined;
  return {
    id: e.id.toLowerCase(),
    kind: e.kind,
    thread: e.thread,
    project: e.project,
    transcript,
    expires_at: e.expires_at as string,
  };
}

/** The journal's unexpired, well-formed entries (none when it's missing or unreadable). */
export function readRequestJournal(path: string, now = Date.now()): JournalEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<JournalFile>;
    if (parsed.v !== 1 || !Array.isArray(parsed.requests)) return [];
    return parsed.requests
      .map((e) => entryOf(e, now))
      .filter((e): e is JournalEntry => e !== undefined)
      .slice(-JOURNAL_MAX);
  } catch {
    return [];
  }
}

/**
 * Writes the journal (the newest JOURNAL_MAX unexpired entries): to a
 * temporary file, then renamed over it. Best effort: false when it couldn't
 * be written (the requests are then known to this process only).
 */
export function writeRequestJournal(
  path: string,
  entries: readonly JournalEntry[],
  now = Date.now(),
): boolean {
  const file: JournalFile = {
    v: 1,
    requests: entries.filter((e) => entryOf(e, now) !== undefined).slice(-JOURNAL_MAX),
  };
  const temp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temp, JSON.stringify(file), { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
    return true;
  } catch {
    try {
      rmSync(temp, { force: true });
    } catch {
      // Nothing to clean up.
    }
    return false;
  }
}
