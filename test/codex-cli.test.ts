/**
 * `buildit-mcp codex`'s options, and how it finds the native codex program
 * (the npm shim followed to its platform package, or a native binary on
 * the PATH), on a made-up file system.
 */
import { delimiter, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CodexNotFoundError, findCodex, type BinaryHost } from '../src/codex/binary.js';
import { COMMAND_USAGE, ConfigError, parseCli, USAGE } from '../src/config.js';

describe('buildit-mcp codex options', () => {
  const cwd = resolve('/', 'work', 'repo');

  it("runs the folder's saved session by default", () => {
    const action = parseCli(['codex'], {}, cwd);
    expect(action).toMatchObject({
      kind: 'codex',
      options: { folder: cwd, projects: [], codexConfig: [], logLevel: 'info', yes: false },
    });
  });

  it("takes connect's flags, Codex overrides and the program", () => {
    const action = parseCli(
      [
        'codex',
        '--project',
        'demo',
        '--label',
        'Codex box',
        '-c',
        'model="some-model"',
        '--config',
        'model_reasoning_effort="low"',
        '--codex-path',
        'tools/codex',
        '--log-level',
        'debug',
      ],
      {},
      cwd,
    );
    expect(action).toMatchObject({
      kind: 'codex',
      options: {
        projects: ['DEMO'],
        label: 'Codex box',
        codexConfig: ['model="some-model"', 'model_reasoning_effort="low"'],
        codexPath: join(cwd, 'tools', 'codex'),
        logLevel: 'debug',
      },
    });
    expect(parseCli(['codex'], { BUILDIT_CODEX_PATH: '/opt/codex' }, cwd)).toMatchObject({
      options: { codexPath: resolve('/opt/codex') },
    });
  });

  it('refuses -c without key=value, and unknown flags', () => {
    expect(() => parseCli(['codex', '-c', 'model'], {}, cwd)).toThrow(ConfigError);
    expect(() => parseCli(['codex', '--channel'], {}, cwd)).toThrow(ConfigError);
    expect(() => parseCli(['codex', '--token', 'x'], {}, cwd)).toThrow(/never accepted as a flag/);
  });

  it('has its help, marked preview', () => {
    expect(parseCli(['codex', '--help'], {}, cwd)).toEqual({ kind: 'help', command: 'codex' });
    expect(COMMAND_USAGE.codex).toContain('Preview');
    expect(USAGE).toContain('buildit-mcp codex');
  });
});

/** A made-up machine: files (and links) only. */
function host(
  platform: NodeJS.Platform,
  files: string[],
  path: string[],
  links: Record<string, string> = {},
): BinaryHost {
  const set = new Set(files);
  return {
    platform,
    arch: 'x64',
    env:
      platform === 'win32'
        ? { Path: path.join(delimiter), PATHEXT: '.EXE;.CMD' }
        : { PATH: path.join(delimiter) },
    isFile: (p) => set.has(p),
    realpath: (p) => links[p] ?? p,
  };
}

describe('finding the native codex program', () => {
  const prefix = join('C:', 'Program Files', 'nodejs');
  const pkg = join(prefix, 'node_modules', '@openai', 'codex');
  const shim = join(pkg, 'bin', 'codex.js');
  const nested = join(
    pkg,
    'node_modules',
    '@openai',
    'codex-win32-x64',
    'vendor',
    'x86_64-pc-windows-msvc',
    'bin',
    'codex.exe',
  );

  it("follows npm's Windows shim to the platform package's binary", () => {
    const h = host(
      'win32',
      [join(prefix, 'codex.cmd'), shim, nested],
      [join('C:', 'other'), prefix],
    );
    expect(findCodex(undefined, h)).toEqual({
      path: nested,
      via: 'npm',
      env: { CODEX_MANAGED_PACKAGE_ROOT: pkg, CODEX_MANAGED_BY_NPM: '1' },
    });
  });

  it('finds a hoisted platform package', () => {
    const hoisted = join(
      prefix,
      'node_modules',
      '@openai',
      'codex-win32-x64',
      'vendor',
      'x86_64-pc-windows-msvc',
      'bin',
      'codex.exe',
    );
    const h = host('win32', [join(prefix, 'codex.cmd'), shim, hoisted], [prefix]);
    expect(findCodex(undefined, h).path).toBe(hoisted);
  });

  it('follows a Unix symlink to the shim', () => {
    const bin = join('/', 'usr', 'local', 'bin');
    const root = join('/', 'usr', 'local', 'lib', 'node_modules', '@openai', 'codex');
    const native = join(
      root,
      'node_modules',
      '@openai',
      'codex-linux-x64',
      'vendor',
      'x86_64-unknown-linux-musl',
      'bin',
      'codex',
    );
    const h = host('linux', [join(bin, 'codex'), native], [bin], {
      [join(bin, 'codex')]: join(root, 'bin', 'codex.js'),
    });
    expect(findCodex(undefined, h)).toMatchObject({ path: native, via: 'npm' });
  });

  it('uses a native binary on the PATH as is, and skips scripts it cannot follow', () => {
    const dir = join('C:', 'tools');
    const exe = join(dir, 'codex.exe');
    expect(findCodex(undefined, host('win32', [exe], [dir]))).toEqual({
      path: exe,
      via: 'path',
      env: {},
    });
    expect(() => findCodex(undefined, host('win32', [join(dir, 'codex.cmd')], [dir]))).toThrow(
      CodexNotFoundError,
    );
  });

  it('takes --codex-path as given, or follows it when it is the shim', () => {
    const own = join('C:', 'mine', 'codex.exe');
    expect(findCodex(own, host('win32', [own], []))).toEqual({ path: own, via: 'option', env: {} });
    expect(
      findCodex(
        join(prefix, 'codex.cmd'),
        host('win32', [join(prefix, 'codex.cmd'), shim, nested], []),
      ).path,
    ).toBe(nested);
    expect(() => findCodex(join('C:', 'missing'), host('win32', [], []))).toThrow(/No program at/);
  });

  it('says how to install Codex when there is none', () => {
    expect(() => findCodex(undefined, host('linux', [], [join('/', 'usr', 'bin')]))).toThrow(
      /npm install -g @openai\/codex/,
    );
  });
});
