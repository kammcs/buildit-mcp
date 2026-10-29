/**
 * The recent tool calls Claude Code announced (the plugin's PreToolUse hook,
 * `tool_seen`), so a tool approval can name the call it is for.
 *
 * Claude Code's PermissionRequest hook gets no `tool_use_id`, but PreToolUse
 * fires for the same call just before it, with the same input and agent id,
 * and with the id. So `tool_seen` records each call (its agent, tool, a hash
 * of its input and its id), and `approve` claims the oldest unclaimed entry
 * that matches. An answer in the terminal then shows as such in the app: the
 * call's PostToolUse names that id (`tool_done`).
 *
 * Only these four values are kept, for 10 seconds, at most 256 entries; the
 * input itself never is.
 */
import { createHash } from 'node:crypto';

/** How many calls are remembered. */
export const RING_SIZE = 256;
/** How long a call is remembered. */
export const RING_TTL_MS = 10_000;
/** How old a call may be for an approval to claim it. */
export const CLAIM_MAX_AGE_MS = 5_000;

/** JSON with every object's keys sorted, at every level, and no spaces. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The hex SHA-256 of a tool input's canonical JSON. */
export function inputHash(input: unknown): string {
  return createHash('sha256').update(canonicalJson(input), 'utf8').digest('hex');
}

/**
 * A tool input as the hooks pass it (`${tool_input}` is JSON text; an object
 * works too): the object, or undefined when it isn't one.
 */
export function parseToolInput(value: unknown): Record<string, unknown> | undefined {
  let raw = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  }
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
}

interface Seen {
  agentId: string;
  toolName: string;
  hash: string;
  toolUseId: string;
  at: number;
  claimed: boolean;
}

export class ToolRing {
  private readonly entries: Seen[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly now: () => number = Date.now) {}

  /** How many calls are remembered (tests). */
  get size(): number {
    this.prune();
    return this.entries.length;
  }

  /** A call Claude Code is about to make (PreToolUse). */
  record(init: { agentId: string; toolName: string; hash: string; toolUseId: string }): void {
    this.prune();
    this.entries.push({ ...init, at: this.now(), claimed: false });
    while (this.entries.length > RING_SIZE) this.entries.shift();
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * The oldest unclaimed call that matches, at most 5 seconds old: its id,
   * now claimed. Claude Code asks for permission in the order it announced
   * the calls, so the oldest is the one asking.
   */
  claim(agentId: string, toolName: string, hash: string): string | undefined {
    const oldest = this.now() - CLAIM_MAX_AGE_MS;
    for (const e of this.entries) {
      if (e.at < oldest) continue;
      if (e.claimed || e.agentId !== agentId || e.toolName !== toolName || e.hash !== hash) {
        continue;
      }
      e.claimed = true;
      return e.toolUseId;
    }
    return undefined;
  }

  /** claim, waiting up to `waitMs` for the call to be recorded. */
  async claimSoon(
    agentId: string,
    toolName: string,
    hash: string,
    waitMs: number,
  ): Promise<string | undefined> {
    const found = this.claim(agentId, toolName, hash);
    if (found !== undefined || waitMs <= 0) return found;
    return new Promise((resolve) => {
      const listener = (): void => {
        const id = this.claim(agentId, toolName, hash);
        if (id !== undefined) finish(id);
      };
      const timer = setTimeout(() => {
        finish(this.claim(agentId, toolName, hash));
      }, waitMs);
      const finish = (id: string | undefined): void => {
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(id);
      };
      this.listeners.add(listener);
    });
  }

  private prune(): void {
    const oldest = this.now() - RING_TTL_MS;
    while (this.entries.length > 0 && (this.entries[0]?.at ?? 0) < oldest) this.entries.shift();
  }
}
