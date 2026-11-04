/**
 * Where the native `codex` program is, and how to start its app-server.
 *
 * The npm package `@openai/codex` installs a Node shim (`bin/codex.js`)
 * that starts the native binary from a platform package. The bridge starts
 * the native binary itself: ending the shim can leave the native server
 * running (on Windows the shim is a separate process), while the native
 * app-server exits cleanly when its stdin closes. Nothing is run to find
 * it: the PATH and the package's folders are only looked at.
 *
 * Order: --codex-path (or BUILDIT_CODEX_PATH) as given; else the first
 * `codex` on the PATH: the npm shim is followed to its native binary, and
 * a native binary is used as is.
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';

/** The npm platform packages, by Node's platform and architecture (as the shim names them). */
const PLATFORM_PACKAGES: Record<string, { pkg: string; triple: string }> = {
  'linux-x64': { pkg: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl' },
  'linux-arm64': { pkg: '@openai/codex-linux-arm64', triple: 'aarch64-unknown-linux-musl' },
  'darwin-x64': { pkg: '@openai/codex-darwin-x64', triple: 'x86_64-apple-darwin' },
  'darwin-arm64': { pkg: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin' },
  'win32-x64': { pkg: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc' },
  'win32-arm64': { pkg: '@openai/codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' },
};

export interface CodexBinary {
  /** The native program. */
  path: string;
  /** How it was found. */
  via: 'option' | 'npm' | 'path';
  /** Environment the npm shim would set for it (the package root), when found through it. */
  env: Record<string, string>;
}

export interface BinaryHost {
  platform: NodeJS.Platform;
  arch: string;
  env: Readonly<Record<string, string | undefined>>;
  isFile(path: string): boolean;
  realpath(path: string): string;
}

export const NODE_BINARY_HOST: BinaryHost = {
  platform: process.platform,
  arch: process.arch,
  env: process.env,
  isFile: (path) => {
    try {
      return existsSync(path) && statSync(path).isFile();
    } catch {
      return false;
    }
  },
  realpath: (path) => realpathSync(path),
};

export class CodexNotFoundError extends Error {
  override name = 'CodexNotFoundError';
}

/** The native binary inside an `@openai/codex` package root, if its platform package is there. */
export function nativeInPackage(root: string, host: BinaryHost): string | undefined {
  const target = PLATFORM_PACKAGES[`${host.platform}-${host.arch}`];
  if (target === undefined) return undefined;
  const exe = host.platform === 'win32' ? 'codex.exe' : 'codex';
  const candidates = [
    // npm nests the optional platform package under the main one...
    join(root, 'node_modules', ...target.pkg.split('/'), 'vendor', target.triple, 'bin', exe),
    // ...or hoists it next to it.
    join(dirname(dirname(root)), ...target.pkg.split('/'), 'vendor', target.triple, 'bin', exe),
    // Older layouts carried the binary in the main package.
    join(root, 'vendor', target.triple, 'bin', exe),
    join(root, 'vendor', target.triple, 'codex', exe),
  ];
  return candidates.find((c) => host.isFile(c));
}

/** The package root of the `@openai/codex` npm shim found at `found`, if it is one. */
function shimPackageRoot(found: string, host: BinaryHost): string | undefined {
  // Windows (npm's global prefix): codex.cmd and node_modules side by side.
  const beside = join(dirname(found), 'node_modules', '@openai', 'codex');
  if (host.isFile(join(beside, 'bin', 'codex.js'))) return beside;
  // Unix: a symlink to <root>/bin/codex.js.
  let real: string;
  try {
    real = host.realpath(found);
  } catch {
    return undefined;
  }
  if (basename(real) === 'codex.js' && basename(dirname(real)) === 'bin') {
    return dirname(dirname(real));
  }
  return undefined;
}

/** The names a `codex` program may have in a PATH folder. */
function programNames(host: BinaryHost): string[] {
  if (host.platform !== 'win32') return ['codex'];
  const exts = (host.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e !== '');
  return [...exts.map((e) => `codex${e}`), 'codex'];
}

/** Finds the native codex binary; throws CodexNotFoundError with what to do. */
export function findCodex(
  explicit: string | undefined,
  host: BinaryHost = NODE_BINARY_HOST,
): CodexBinary {
  if (explicit !== undefined) {
    if (!host.isFile(explicit)) {
      throw new CodexNotFoundError(
        `No program at ${explicit} (--codex-path or BUILDIT_CODEX_PATH).`,
      );
    }
    const root = shimPackageRoot(explicit, host);
    if (root !== undefined) {
      const native = nativeInPackage(root, host);
      if (native !== undefined) return { path: native, via: 'npm', env: shimEnv(root) };
    }
    return { path: explicit, via: 'option', env: {} };
  }
  const pathVar =
    (host.platform === 'win32' ? (host.env.Path ?? host.env.PATH) : host.env.PATH) ?? '';
  for (const dir of pathVar.split(delimiter)) {
    if (dir.trim() === '') continue;
    for (const name of programNames(host)) {
      const found = join(dir, name);
      if (!host.isFile(found)) continue;
      const root = shimPackageRoot(found, host);
      if (root !== undefined) {
        const native = nativeInPackage(root, host);
        if (native !== undefined) return { path: native, via: 'npm', env: shimEnv(root) };
        continue;
      }
      // A native binary (not a script the shell would need to run).
      const lower = name.toLowerCase();
      if (host.platform === 'win32' && !lower.endsWith('.exe')) continue;
      return { path: found, via: 'path', env: {} };
    }
  }
  throw new CodexNotFoundError(
    'Codex was not found on the PATH. Install it (npm install -g @openai/codex) and sign in with "codex login", or pass --codex-path <path to the codex program>.',
  );
}

/** What the npm shim sets for the native binary. */
function shimEnv(root: string): Record<string, string> {
  return { CODEX_MANAGED_PACKAGE_ROOT: root, CODEX_MANAGED_BY_NPM: '1' };
}
