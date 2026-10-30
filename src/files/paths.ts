/**
 * Where a file a session shares may come from: inside the session's
 * working folder or the OS temp folder (by its real path, symlinks
 * resolved), and never from a well-known secret folder, whatever the roots.
 */
import { realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { defaultTokenFile } from '../secrets/keychain.js';

/** Whether paths on this platform compare without case (Windows and macOS). */
const FOLD = process.platform === 'win32' || process.platform === 'darwin';

const norm = (p: string): string => (FOLD ? p.toLowerCase() : p);

/** Whether `child` is `parent` or inside it (both resolved). */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(sep + sep));
}

/** The real path of a folder, or the folder itself when it can't be resolved. */
async function real(folder: string): Promise<string> {
  return realpath(folder).catch(() => resolve(folder));
}

/**
 * The secret folders and files a session never shares from, under the home
 * folder: SSH, cloud and cluster credentials, GnuPG, the Docker login,
 * buildit-mcp's own token file, and the browsers' profiles (passwords and
 * cookies).
 */
export function secretLocations(home: string = homedir()): string[] {
  const h = (...parts: string[]): string => join(home, ...parts);
  return [
    h('.ssh'),
    h('.aws'),
    h('.azure'),
    h('.gnupg'),
    h('.config', 'gcloud'),
    h('.kube'),
    h('.docker', 'config.json'),
    h('.git-credentials'),
    dirname(defaultTokenFile()),
    // Browser profiles.
    h('AppData', 'Local', 'Google', 'Chrome', 'User Data'),
    h('AppData', 'Local', 'Microsoft', 'Edge', 'User Data'),
    h('AppData', 'Local', 'BraveSoftware'),
    h('AppData', 'Roaming', 'Mozilla', 'Firefox'),
    h('AppData', 'Roaming', 'Opera Software'),
    h('Library', 'Application Support', 'Google', 'Chrome'),
    h('Library', 'Application Support', 'Microsoft Edge'),
    h('Library', 'Application Support', 'Firefox'),
    h('Library', 'Application Support', 'BraveSoftware'),
    h('Library', 'Safari'),
    h('Library', 'Cookies'),
    h('Library', 'Keychains'),
    h('.mozilla'),
    h('.config', 'google-chrome'),
    h('.config', 'chromium'),
    h('.config', 'BraveSoftware'),
    h('.local', 'share', 'keyrings'),
  ];
}

/** Why a resolved path may not be shared from where it is, or undefined. */
export async function locationProblem(
  path: string,
  roots: { folder: string; home?: string },
): Promise<'secret_folder' | 'outside_roots' | undefined> {
  const home = roots.home ?? homedir();
  for (const secret of secretLocations(home)) {
    if (isInside(await real(secret), path) || isInside(secret, path)) return 'secret_folder';
  }
  const allowed = [await real(roots.folder), await real(tmpdir())];
  return allowed.some((root) => isInside(root, path)) ? undefined : 'outside_roots';
}
