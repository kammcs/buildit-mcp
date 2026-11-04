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
        if (typeof e.codex_thread_id !== 'string' || e.codex_thread_id === '') continue;
        this.entries.set(key, {
          codex_thread_id: e.codex_thread_id,
          has_turn: e.has_turn === true,
          updated_at: typeof e.updated_at === 'string' ? e.updated_at : this.now().toISOString(),
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

  /** The place whose Codex thread this is. */
  keyOf(codexThreadId: string): string | undefined {
    for (const [key, e] of this.entries) if (e.codex_thread_id === codexThreadId) return key;
    return undefined;
  }

  /** Records a place's thread (a new one, or one that has now had a turn). */
  set(key: string, codexThreadId: string, hasTurn: boolean): void {
    const before = this.entries.get(key);
    if (before?.codex_thread_id === codexThreadId && before.has_turn === hasTurn) return;
    this.entries.delete(key);
    this.entries.set(key, {
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
