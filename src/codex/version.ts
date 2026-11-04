/**
 * Which Codex versions the bridge works with.
 *
 * The app-server protocol is experimental and changes about weekly, so the
 * bridge names the oldest version it supports and the release lines it was
 * tested on (README, "Codex (bridge mode)"). Older than the minimum: the
 * bridge refuses to start. Newer than the tested lines: it starts, and
 * warns once. `npm run codex:schema` compares an installed Codex's
 * protocol with the one the bridge was built on.
 */
import { compareVersions } from '../version.js';

/** The oldest Codex the bridge starts with. */
export const MIN_CODEX_VERSION = '0.166.0';

/** The release lines (major.minor) the bridge was tested on. */
export const TESTED_CODEX_LINES: readonly string[] = ['0.166'];

export type VersionVerdict =
  | { kind: 'tested'; version: string }
  | { kind: 'untested'; version: string }
  | { kind: 'too_old'; version: string }
  | { kind: 'unknown' };

/**
 * The Codex version in the app-server's user agent:
 * `<client name>/<version> (<platform>) ...`.
 */
export function versionFromUserAgent(userAgent: string): string | undefined {
  const m = /^[^/\s]+\/(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(userAgent);
  return m?.[1];
}

/** The verdict on a Codex version (undefined: it couldn't be read). */
export function checkCodexVersion(version: string | undefined): VersionVerdict {
  if (version === undefined) return { kind: 'unknown' };
  if (compareVersions(version, MIN_CODEX_VERSION) < 0) return { kind: 'too_old', version };
  const line = version.split('.').slice(0, 2).join('.');
  return TESTED_CODEX_LINES.includes(line)
    ? { kind: 'tested', version }
    : { kind: 'untested', version };
}
