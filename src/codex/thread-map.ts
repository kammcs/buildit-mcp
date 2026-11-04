/**
 * Which Codex thread holds each buildIt.Social conversation, kept across
 * restarts.
 *
 * Codex keeps a thread's history and settings in its own home folder; the
 * bridge keeps only the thread id, per place (`dm` for the direct message
 * with the owner), in a small file next to the folder's lock files (0600,
 * written whole and renamed). The file names the session it belongs to: a
 * new session in the folder (after connect) starts new threads.
 *
 * A thread is saved by Codex only once a turn has started in it, so the
 * map records whether one has (`has_turn`): one without is started fresh
 * instead of resumed.
 *
 * A work item's place (`item:<id>`) also keeps the item's key, its
 * worktree (path, branch and the folder the thread works in), its mode
 * (`plan` until a plan is approved) and whether its work was under way or
 * queued (`running`, `queued`): a restarted bridge carries those on.
 * Ids, keys, paths and flags only: never what anyone wrote.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Logger } from '../log.js';

export interface ThreadEntry {
  /** The Codex thread's id. */
  codex_thread_id: string;
  /** Whether a turn has started in it (Codex has saved it). */
  has_turn: boolean;
  /** When the entry last changed (RFC 3339). */
  updated_at: string;
  /** A work item's: its key and id. */
  item?: { key: string; id: string } | undefined;
  /** A work item's worktree (none: it works in the folder). */
  worktree?: { path: string; branch: string; cwd: string } | undefined;
  /** A turn ran when this was written (a restart carries the work on). */
  running?: boolean | undefined;
  /** The item waited for a free slot (a restart starts it). */
  queued?: boolean | undefined;
  /** `plan` while the item's plan waits for the person (plan mode). */
  mode?: 'plan' | 'default' | undefined;
}

/** What an entry keeps besides its thread. */
export type EntryState = Pick<ThreadEntry, 'item' | 'worktree' | 'running' | 'queued' | 'mode'>;

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' && v.length <= 4096 ? v : undefined;

/** The extra fields of an entry read from the file (tolerant: a bad one is left out). */
function stateOf(e: Record<string, unknown>): EntryState {
  const out: EntryState = {};
  const item = e.item as Record<string, unknown> | null | undefined;
  const key = str(item?.key);
  const id = str(item?.id);
  if (key !== undefined && id !== undefined) out.item = { key, id };
  const wt = e.worktree as Record<string, unknown> | null | undefined;
  const path = str(wt?.path);
  const branch = str(wt?.branch);
  const cwd = str(wt?.cwd);
  if (path !== undefined && branch !== undefined && cwd !== undefined) {
    out.worktree = { path, branch, cwd };
  }
  if (e.running === true) out.running = true;
  if (e.queued === true) out.queued = true;
  if (e.mode === 'plan' || e.mode === 'default') out.mode = e.mode;
  return out;
}

interface MapFile {
  v: 1;
  session_id: string;
  threads: Record<string, ThreadEntry>;
}

/** How many places are remembered (the oldest dropped first). */
const MAX_ENTRIES = 200;

export class ThreadMap {
  private sessionId: string | undefined;
  private entries = new Map<string, ThreadEntry>();

  constructor(
    /** The file; none: kept in memory only. */
    private readonly path: string | undefined,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Reads the file for this session (another session's entries are dropped). */
  load(sessionId: string): number {
    this.sessionId = sessionId;
    this.entries = new Map();
    if (this.path === undefined) return 0;
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch {
      return 0;
    }
    try {
      // Read tolerantly: the file may be from another version, or edited.
      const parsed = JSON.parse(raw) as {
        v?: unknown;
        session_id?: unknown;
        threads?: Record<string, Partial<Record<keyof ThreadEntry, unknown>> | null>;
      };
      if (parsed.v !== 1 || parsed.session_id !== sessionId) return 0;
      for (const [key, e] of Object.entries(parsed.threads ?? {})) {
        if (e === null || typeof e !== 'object') continue;
        if (typeof e.codex_thread_id !== 'string') continue;
        if (
          e.codex_thread_id === '' &&
          Object.keys(stateOf(e)).length === 0
        ) {
          continue;
        }
        this.entries.set(key, {
          codex_thread_id: e.codex_thread_id,
          has_turn: e.has_turn === true,
          updated_at: typeof e.updated_at === 'string' ? e.updated_at : this.now().toISOString(),
          ...stateOf(e),
        });
      }
    } catch {
      this.logger.info('codex thread map unreadable; starting new threads');
    }
    return this.entries.size;
  }

  get(key: string): ThreadEntry | undefined {
    return this.entries.get(key);
  }

  /** Every entry, oldest first. */
  list(): [string, ThreadEntry][] {
    return [...this.entries];
  }

  /** The place whose Codex thread this is. */
  keyOf(codexThreadId: string): string | undefined {
    for (const [key, e] of this.entries) if (e.codex_thread_id === codexThreadId) return key;
    return undefined;
  }

  /** Records a place's thread (a new one, or one that has now had a turn); its other fields stay. */
  set(key: string, codexThreadId: string, hasTurn: boolean): void {
    const before = this.entries.get(key);
    if (before?.codex_thread_id === codexThreadId && before.has_turn === hasTurn) return;
    this.entries.delete(key);
    this.entries.set(key, {
      ...(before === undefined ? {} : stateOf(before as unknown as Record<string, unknown>)),
      codex_thread_id: codexThreadId,
      has_turn: hasTurn,
      updated_at: this.now().toISOString(),
    });
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.write();
  }

  /**
   * Changes a place's other fields (undefined removes one). A place with no
   * thread yet gets an entry without one (`codex_thread_id` empty), so a
   * queued item is remembered too.
   */
  note(key: string, patch: Partial<EntryState>): void {
    const before = this.entries.get(key);
    const next: ThreadEntry = {
      codex_thread_id: before?.codex_thread_id ?? '',
      has_turn: before?.has_turn ?? false,
      updated_at: this.now().toISOString(),
      ...(before === undefined ? {} : stateOf(before as unknown as Record<string, unknown>)),
    };
    const fields = next as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(patch) as [string, unknown][]) {
      if (v === undefined || v === false) Reflect.deleteProperty(fields, k);
      else fields[k] = v;
    }
    const same =
      before !== undefined &&
      JSON.stringify({ ...before, updated_at: '' }) === JSON.stringify({ ...next, updated_at: '' });
    if (same) return;
    this.entries.delete(key);
    this.entries.set(key, next);
    this.write();
  }

  /** Forgets a place's thread, keeping its other fields (its thread can't be resumed). */
  forgetThread(key: string): void {
    const before = this.entries.get(key);
    if (before === undefined) return;
    const rest = stateOf(before as unknown as Record<string, unknown>);
    if (Object.keys(rest).length === 0) {
      this.delete(key);
      return;
    }
    this.entries.set(key, {
      codex_thread_id: '',
      has_turn: false,
      updated_at: this.now().toISOString(),
      ...rest,
    });
    this.write();
  }

  /** Forgets a place (its thread can't be resumed). */
  delete(key: string): void {
    if (this.entries.delete(key)) this.write();
  }

  private write(): void {
    if (this.path === undefined || this.sessionId === undefined) return;
    const file: MapFile = {
      v: 1,
      session_id: this.sessionId,
      threads: Object.fromEntries(this.entries),
    };
    const temp = `${this.path}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      writeFileSync(temp, JSON.stringify(file), { mode: 0o600 });
      chmodSync(temp, 0o600);
      renameSync(temp, this.path);
    } catch (err) {
      this.logger.info('codex thread map not written', {
        code: (err as NodeJS.ErrnoException).code ?? 'error',
      });
      try {
        rmSync(temp, { force: true });
      } catch {
        // Nothing more to do.
      }
    }
  }
}
