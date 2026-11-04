/**
 * The buildit skills for Codex threads, from the one source the Claude Code
 * plugin uses: `plugin/skills/<name>/SKILL.md` (Codex reads the same
 * format), shipped in the npm package beside `dist/`.
 *
 * At startup the bridge adds that folder to the app-server's skill roots
 * (`skills/extraRoots/set`, no turn) and reads back what Codex found
 * (`skills/list`): each skill's name as Codex lists it (it may add a
 * namespace) and its path. A turn that needs one (an item's first turn:
 * `buildit-work-updates`; a request: `buildit-requests` and its kind's) then
 * names it as a `{type: "skill", name, path}` input item. A Codex that
 * doesn't list them (an older line, a refused root) gets the skill's text
 * as a text input instead, so the turn still has it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Logger } from '../log.js';
import type { UserInput } from './protocol.js';
import { RpcClosedError, RpcError, type AppServerConnection } from './rpc.js';

/** The plugin's skills folder: `plugin/skills` next to `src/` (or `dist/`). */
export const SKILLS_ROOT = fileURLToPath(new URL('../../plugin/skills', import.meta.url));

/** The skills a bridge thread may be given. */
export const BRIDGE_SKILLS = [
  'buildit-work-updates',
  'buildit-requests',
  'buildit-catch-up',
  'buildit-thread-to-items',
  'buildit-triage',
  'buildit-item-helper',
  'buildit-meeting-notes',
] as const;

export type BridgeSkill = (typeof BRIDGE_SKILLS)[number];

const isBridgeSkill = (name: string): name is BridgeSkill =>
  (BRIDGE_SKILLS as readonly string[]).includes(name);

/** A skill's SKILL.md under a root, when it is there. */
export function skillFile(name: string, root: string = SKILLS_ROOT): string | undefined {
  const path = join(root, name, 'SKILL.md');
  return existsSync(path) ? path : undefined;
}

/** The skills Codex lists, by their plain name: Codex's own name and path for each. */
export type ListedSkills = Map<BridgeSkill, { name: string; path: string }>;

const samePath = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

/** Reads skills/list's answer: the bridge's skills under `root` (tolerant). */
export function listedSkills(answer: unknown, root: string = SKILLS_ROOT): ListedSkills {
  const out: ListedSkills = new Map();
  const data = (answer as { data?: unknown } | null)?.data;
  for (const entry of Array.isArray(data) ? data : []) {
    const skills = (entry as { skills?: unknown } | null)?.skills;
    for (const s of Array.isArray(skills) ? skills : []) {
      const r = s as { name?: unknown; path?: unknown; enabled?: unknown };
      if (typeof r.name !== 'string' || typeof r.path !== 'string' || r.enabled === false) continue;
      // Matched by its file: a skill of that name from anywhere else is not ours.
      const plain = r.name.replace(/^.*:/, '');
      if (!isBridgeSkill(plain)) continue;
      const own = skillFile(plain, root);
      if (own === undefined || !samePath(own, r.path)) continue;
      out.set(plain, { name: r.name, path: r.path });
    }
  }
  return out;
}

export class BridgeSkills {
  private listed: ListedSkills = new Map();

  constructor(
    private readonly logger: Logger,
    private readonly root: string = SKILLS_ROOT,
  ) {}

  /** Whether the plugin's skills are on disk at all. */
  get available(): boolean {
    return skillFile('buildit-requests', this.root) !== undefined;
  }

  /**
   * Adds the root to the app-server's skills and reads back what it found.
   * A Codex that refuses or doesn't know these is only logged: the skills
   * then go as text.
   */
  async register(connection: AppServerConnection, cwd: string): Promise<void> {
    if (!this.available) {
      this.logger.warn("the buildit skills aren't next to this buildit-mcp; turns go without them");
      return;
    }
    try {
      await connection.request('skills/extraRoots/set', { extraRoots: [this.root] });
      const answer = await connection.request('skills/list', { cwds: [cwd], forceReload: true });
      this.listed = listedSkills(answer, this.root);
      this.logger.info('buildit skills registered with codex', { count: this.listed.size });
    } catch (err) {
      if (err instanceof RpcClosedError) throw err;
      this.logger.info("codex didn't take the buildit skills as skills; they go as text", {
        code: err instanceof RpcError ? err.code : 'error',
      });
    }
  }

  /** The input items that give a turn these skills. */
  inputs(names: readonly BridgeSkill[]): UserInput[] {
    const out: UserInput[] = [];
    for (const name of names) {
      const listed = this.listed.get(name);
      if (listed !== undefined) {
        out.push({ type: 'skill', name: listed.name, path: listed.path });
        continue;
      }
      const file = skillFile(name, this.root);
      if (file === undefined) continue;
      let body: string;
      try {
        body = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      out.push({
        type: 'text',
        text: `<skill name="${name}">\n${body.trim()}\n</skill>`,
        text_elements: [],
      });
    }
    return out;
  }
}
