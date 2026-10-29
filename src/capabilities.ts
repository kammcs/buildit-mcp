/**
 * Capability tags: what this computer can do for work that has Needs
 * (macos, ios, flutter...), suggested to buildIt.Social at connect and when
 * a channel session starts. The owner confirms the tags that count, in the
 * app; a session only ever suggests.
 *
 * Detection is cheap and never fails: the operating system from
 * process.platform, and toolchains by looking for known programs on the
 * PATH, or for a known folder, without running anything. Every probe has a
 * time limit, and a probe that fails or runs out of time means "not found".
 * Only tag names from the fixed list below ever leave the machine: never a
 * path, a version or any other detail of what was found.
 */
import { constants } from 'node:fs';
import { access, readlink, stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

/** The suggested tags (the app keeps the same list). Tags stay free-form. */
export const SUGGESTED_CAPABILITIES = [
  'windows',
  'macos',
  'linux',
  'ios',
  'android',
  'xcode',
  'flutter',
  'docker',
  'rust',
  'web',
  'gpu',
] as const;

/** A tag once normalised: lower case, a letter or digit, then up to 31 of a-z 0-9 + . _ - */
export const CAPABILITY_RE = /^[a-z0-9][a-z0-9+._-]{0,31}$/;

/** The most tags a session suggests (the server's limit). */
export const MAX_SESSION_CAPABILITIES = 20;

/** The most Needs an item has (the server's limit). */
export const MAX_ITEM_NEEDS = 10;

/** How long one probe may take before it counts as "not found". */
export const PROBE_TIMEOUT_MS = 1500;

/**
 * Tags as the server stores them: trimmed, lower case, unique and sorted.
 * Throws with the bad ones named, so a person's --capabilities can be fixed.
 */
export function normalizeCapabilities(raw: readonly string[], max: number): string[] {
  const tags = [...new Set(raw.map((t) => t.trim().toLowerCase()).filter((t) => t !== ''))];
  const bad = tags.filter((t) => !CAPABILITY_RE.test(t));
  if (bad.length > 0) {
    throw new Error(
      `Not a capability tag: ${bad.map((b) => JSON.stringify(b.slice(0, 40))).join(', ')}. A tag is a lower-case letter or digit, then up to 31 lower-case letters, digits or + . _ - (for example macos, ios, flutter).`,
    );
  }
  if (tags.length > max) throw new Error(`At most ${max} capability tags.`);
  return tags.sort();
}

/** What detection reads, so tests can stand in for the machine. */
export interface DetectionHost {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  /** Whether a file exists and may be run (a program). */
  isExecutable(path: string): Promise<boolean>;
  /** Whether a folder exists. */
  isDirectory(path: string): Promise<boolean>;
  /** A symbolic link's target, or undefined. */
  readLink(path: string): Promise<string | undefined>;
  /** The time limit of each probe, in milliseconds. */
  timeoutMs?: number;
}

/** The real machine. */
export const NODE_HOST: DetectionHost = {
  platform: process.platform,
  env: process.env,
  async isExecutable(path) {
    try {
      const s = await stat(path);
      if (!s.isFile()) return false;
      if (process.platform === 'win32') return true;
      await access(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  async isDirectory(path) {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  },
  async readLink(path) {
    try {
      return await readlink(path);
    } catch {
      return undefined;
    }
  },
};

/** The program names to look for on the PATH, by tag (android: hasAndroid). */
const PROGRAMS: readonly { tag: string; programs: readonly string[] }[] = [
  { tag: 'flutter', programs: ['flutter'] },
  { tag: 'docker', programs: ['docker'] },
  { tag: 'rust', programs: ['cargo', 'rustc'] },
];

/** Resolves to false when `probe` fails or takes longer than the time limit. */
async function within(probe: () => Promise<boolean>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, ms);
  });
  try {
    return await Promise.race([probe().catch(() => false), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Whether one of `names` is a program in a folder of the PATH. */
async function onPath(host: DetectionHost, names: readonly string[]): Promise<boolean> {
  const win = host.platform === 'win32';
  const path = (win ? (host.env.Path ?? host.env.PATH) : host.env.PATH) ?? '';
  const paths = win ? win32 : posix;
  const dirs = path
    .split(win ? ';' : ':')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d !== '');
  const extensions = win
    ? (host.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e !== '')
    : [''];
  const candidates = dirs.flatMap((dir) =>
    names.flatMap((name) => extensions.map((ext) => paths.join(dir, name + ext))),
  );
  const found = await Promise.all(candidates.map((c) => host.isExecutable(c)));
  return found.some(Boolean);
}

/** The Android SDK: ANDROID_HOME or ANDROID_SDK_ROOT names a folder, or adb is on the PATH. */
async function hasAndroid(host: DetectionHost): Promise<boolean> {
  for (const name of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
    const dir = host.env[name]?.trim();
    if (dir !== undefined && dir !== '' && (await host.isDirectory(dir))) return true;
  }
  return onPath(host, ['adb']);
}

/**
 * The developer folder of Xcode (macOS), when it is the full app and not
 * only the command line tools: DEVELOPER_DIR, else the folder xcode-select
 * chose (the link it keeps), else the app in /Applications. Read from the
 * file system; nothing is run.
 */
async function xcodeDeveloperDir(host: DetectionHost): Promise<string | undefined> {
  const isApp = (dir: string): boolean => /\.app\/Contents\/Developer\/?$/.test(dir);
  const fromEnv = host.env.DEVELOPER_DIR?.trim();
  if (fromEnv !== undefined && fromEnv !== '') {
    return isApp(fromEnv) && (await host.isDirectory(fromEnv)) ? fromEnv : undefined;
  }
  const selected = await host.readLink('/var/db/xcode_select_link');
  if (selected !== undefined) {
    return isApp(selected) && (await host.isDirectory(selected)) ? selected : undefined;
  }
  const standard = '/Applications/Xcode.app/Contents/Developer';
  return (await host.isDirectory(standard)) ? standard : undefined;
}

/** The operating system's tag, or undefined for one outside the list. */
export function osCapability(platform: NodeJS.Platform): string | undefined {
  switch (platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'macos';
    case 'linux':
      return 'linux';
    default:
      return undefined;
  }
}

/**
 * The tags this machine suggests. Never throws: a probe that fails, or runs
 * out of time, leaves its tag out. `web` and `gpu` are never detected (the
 * owner adds them in the app).
 */
export async function detectCapabilities(host: DetectionHost = NODE_HOST): Promise<string[]> {
  const ms = host.timeoutMs ?? PROBE_TIMEOUT_MS;
  const tags = new Set<string>();
  try {
    const os = osCapability(host.platform);
    if (os !== undefined) tags.add(os);
    const probes: Promise<void>[] = PROGRAMS.map(async ({ tag, programs }) => {
      if (await within(() => onPath(host, programs), ms)) tags.add(tag);
    });
    probes.push(
      (async () => {
        if (await within(() => hasAndroid(host), ms)) tags.add('android');
      })(),
    );
    if (host.platform === 'darwin') {
      probes.push(
        (async () => {
          let dir: string | undefined;
          const found = await within(async () => {
            dir = await xcodeDeveloperDir(host);
            return dir !== undefined;
          }, ms);
          if (!found || dir === undefined) return;
          tags.add('xcode');
          const sdk = posix.join(dir, 'Platforms', 'iPhoneOS.platform');
          if (await within(() => host.isDirectory(sdk), ms)) tags.add('ios');
        })(),
      );
    }
    await Promise.all(probes);
  } catch {
    // Detection never fails connect: what was found so far is suggested.
  }
  // Only tags of the fixed list leave the machine.
  return [...tags].filter((t) => (SUGGESTED_CAPABILITIES as readonly string[]).includes(t)).sort();
}

/**
 * The tags to suggest: `override` (--capabilities, or BUILDIT_CAPABILITIES)
 * replaces detection; "none" suggests none.
 */
export async function suggestedCapabilities(
  override: readonly string[] | undefined,
  host: DetectionHost = NODE_HOST,
): Promise<string[]> {
  if (override !== undefined) return [...override];
  return detectCapabilities(host);
}

/**
 * --capabilities or BUILDIT_CAPABILITIES: tags separated by commas or
 * spaces, or "none". Throws with what is wrong.
 */
export function parseCapabilitiesOption(raw: string): string[] {
  const parts = raw
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t !== '');
  if (parts.length === 1 && parts[0]?.toLowerCase() === 'none') return [];
  if (parts.length === 0) {
    throw new Error('Give capability tags separated by commas (for example macos,ios), or none.');
  }
  return normalizeCapabilities(parts, MAX_SESSION_CAPABILITIES);
}
