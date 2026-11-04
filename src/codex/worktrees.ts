/**
 * Each work item's git worktree, made by the Codex bridge.
 *
 * An item's Codex thread works in its own worktree, on a branch named for
 * the item (its key, then words of its title: `demo-12-fix-login-redirect`),
 * so items run side by side without touching each other's files, and the
 * branch and its commits link to the item. The worktrees sit in the
 * folder's `.buildit/worktrees/` (a `.gitignore` of `*` keeps them out of
 * the folder's own status), as Claude Code's sit in `.claude/worktrees/`.
 *
 * - **Made once, then kept:** the thread map remembers each item's path and
 *   branch; a restart reuses them, and a worktree that is gone is made
 *   again on the same branch. Nothing is ever removed here: the work in a
 *   worktree is the person's, done or not.
 * - **Never someone else's branch:** a branch of that name checked out
 *   anywhere else (the folder itself, another worktree) gets a new name
 *   (`-2`, `-3`...); a free branch of that name is checked out as it is.
 * - **No worktree:** a folder that isn't in a git repository, or a
 *   repository without a commit yet, can't have one: the item then works in
 *   the folder itself (logged), as the direct message does.
 * - **A folder inside a repository:** the worktree holds the whole
 *   repository, and the thread works in the same subfolder of it.
 *
 * Only git's exit codes and the paths it was given are logged, never its
 * output.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import type { Logger } from '../log.js';

/** Where an item works. */
export interface Worktree {
  /** The worktree's folder. */
  path: string;
  /** Its branch. */
  branch: string;
  /** The folder the thread works in (the worktree, or the same subfolder in it). */
  cwd: string;
}

/** Runs git (tests give their own); rejects with the exit code when it fails. */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<string>;

/** git on the PATH, with a minute at most and no prompts. */
export const runGit: GitRunner = (args, cwd) =>
  new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      [...args],
      {
        cwd,
        timeout: 60_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (err, stdout) => {
        if (err) reject(err instanceof Error ? err : new Error('git failed'));
        else resolvePromise(stdout);
      },
    );
  });

/** The worktrees' folder, relative to the project folder. */
export const WORKTREES_DIR = join('.buildit', 'worktrees');

/** How many characters of the title go into a branch name. */
const SLUG_MAX = 40;

/**
 * A branch name for an item: its key in lower case, then the title's words
 * (letters and digits only, lower case, joined with "-", at most 40
 * characters). The title is people-written: nothing else of it is kept.
 */
export function branchName(key: string, title?: string): string {
  const k =
    key
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'item';
  const words = (title ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w !== '');
  let slug = '';
  for (const w of words) {
    const next = slug === '' ? w : `${slug}-${w}`;
    if (next.length > SLUG_MAX) break;
    slug = next;
  }
  return slug === '' ? k : `${k}-${slug}`;
}

/** The branches checked out in some worktree, by `git worktree list --porcelain`. */
function checkedOut(porcelain: string): Map<string, string> {
  const out = new Map<string, string>();
  let path: string | undefined;
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
    else if (line.startsWith('branch refs/heads/') && path !== undefined) {
      out.set(line.slice('branch refs/heads/'.length), path);
    }
  }
  return out;
}

const samePath = (a: string, b: string): boolean => {
  const norm = (p: string) => resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32'
    ? norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b);
};

export interface WorktreesOptions {
  /** The project folder. */
  folder: string;
  logger: Logger;
  git?: GitRunner;
}

export class Worktrees {
  private readonly git: GitRunner;
  /** Items being set up now, so two events for one item make one worktree. */
  private readonly making = new Map<string, Promise<Worktree | undefined>>();

  constructor(private readonly options: WorktreesOptions) {
    this.git = options.git ?? runGit;
  }

  /**
   * The item's worktree: the saved one when it is still there, else one
   * made (on the saved branch, when there is one). Undefined when the
   * folder can't have one (no repository, no commit, git missing).
   */
  ensure(
    item: { key: string; id: string; title?: string | undefined },
    saved?: { path: string; branch: string }  ,
  ): Promise<Worktree | undefined> {
    const id = item.id.toLowerCase();
    let made = this.making.get(id);
    if (made === undefined) {
      made = this.make(item, saved).finally(() => this.making.delete(id));
      this.making.set(id, made);
    }
    return made;
  }

  private async make(
    item: { key: string; title?: string | undefined },
    saved: { path: string; branch: string } | undefined,
  ): Promise<Worktree | undefined> {
    const { folder, logger } = this.options;
    let top: string;
    try {
      top = (await this.git(['rev-parse', '--show-toplevel'], folder)).trim();
    } catch {
      logger.warn('the folder is not in a git repository: the item works in the folder itself', {
        item: item.key,
      });
      return undefined;
    }
    try {
      await this.git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], folder);
    } catch {
      logger.warn(
        "the folder's git repository has no commit yet: the item works in the folder itself",
        { item: item.key },
      );
      return undefined;
    }
    // The folder's place in the repository: the thread works in the same subfolder.
    const inside = relative(resolve(top), resolve(folder));
    const sub = inside === '' || inside.startsWith('..') || isAbsolute(inside) ? '' : inside;
    const cwdIn = (path: string): string => (sub === '' ? path : join(path, sub));

    let list: Map<string, string>;
    try {
      list = checkedOut(await this.git(['worktree', 'list', '--porcelain'], folder));
    } catch (err) {
      logger.warn('git worktree list failed: the item works in the folder itself', {
        item: item.key,
        code: (err as { code?: unknown }).code,
      });
      return undefined;
    }
    if (saved !== undefined) {
      const at = list.get(saved.branch);
      if (at !== undefined && samePath(at, saved.path) && existsSync(saved.path)) {
        return { path: saved.path, branch: saved.branch, cwd: cwdIn(saved.path) };
      }
    }

    const base = join(folder, WORKTREES_DIR);
    try {
      mkdirSync(base, { recursive: true });
      const ignore = join(base, '.gitignore');
      if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
    } catch (err) {
      logger.warn('the worktrees folder could not be made: the item works in the folder itself', {
        code: (err as NodeJS.ErrnoException).code ?? 'error',
      });
      return undefined;
    }
    // A worktree whose folder was deleted is still registered: prune it first.
    await this.git(['worktree', 'prune'], folder).catch(() => undefined);
    list = checkedOut(await this.git(['worktree', 'list', '--porcelain'], folder).catch(() => ''));

    const wanted = saved?.branch ?? branchName(item.key, item.title);
    for (let n = 1; n <= 20; n++) {
      const branch = n === 1 ? wanted : `${wanted}-${n}`;
      const path = join(base, branch.replace(/[\\/]+/g, '-'));
      if (list.has(branch)) continue;
      if (existsSync(path)) continue;
      const exists = await this.git(
        ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
        folder,
      ).then(
        () => true,
        () => false,
      );
      try {
        await this.git(
          exists
            ? ['worktree', 'add', path, branch]
            : ['worktree', 'add', '-b', branch, path, 'HEAD'],
          folder,
        );
      } catch (err) {
        logger.warn('git worktree add failed', {
          item: item.key,
          code: (err as { code?: unknown }).code,
        });
        continue;
      }
      logger.info('worktree made for the item', {
        item: item.key,
        branch,
        reused_branch: exists,
      });
      return { path, branch, cwd: cwdIn(path) };
    }
    logger.warn('no worktree could be made: the item works in the folder itself', {
      item: item.key,
    });
    return undefined;
  }
}
