/**
 * What status finds of the folder's Codex setup: the buildit plugin for
 * Codex and buildit-mcp servers in Codex's config.toml (the user's and the
 * folder's), and the bridge (its lock mark, its files next to the locks).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acquireChannelLock, lockHolders } from '../src/channel/lock.js';
import { codexConfigs, codexHome, codexSetupOf, splitKey } from '../src/cli/codex-config.js';
import { runStatus } from '../src/cli/commands.js';
import { createLogger } from '../src/log.js';
import { FileTokenStore, sessionKey } from '../src/secrets/keychain.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'buildit-mcp-codex-config-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const API = 'https://api.example.com/functions/v1/agent-api';

describe("Codex's config, scanned", () => {
  it('splits dotted keys, bare and quoted', () => {
    expect(splitKey('plugins."buildit@buildit-mcp"')).toEqual(['plugins', 'buildit@buildit-mcp']);
    expect(splitKey(" mcp_servers . 'my server' . args ")).toEqual([
      'mcp_servers',
      'my server',
      'args',
    ]);
    expect(splitKey('a."b.c"')).toEqual(['a', 'b.c']);
  });

  it('finds the buildit plugin when it is on, and only then', () => {
    expect(
      codexSetupOf(
        [
          '[plugins."browser@openai-bundled"]',
          'enabled = true',
          '',
          '[plugins."buildit@buildit-mcp"]',
          'enabled = true # installed',
        ].join('\n'),
      ).plugins,
    ).toEqual(['buildit@buildit-mcp']);
    expect(codexSetupOf('[plugins."buildit@buildit-mcp"]\nenabled = false\n').plugins).toEqual([]);
    expect(codexSetupOf('[plugins]\n"buildit@x" = { enabled = false }\n').plugins).toEqual([]);
    expect(codexSetupOf('[plugins]\n"buildit@x" = { enabled = true }\n').plugins).toEqual([
      'buildit@x',
    ]);
    // Another plugin whose name starts the same way is not ours.
    expect(codexSetupOf('[plugins."buildit-other@x"]\nenabled = true\n').plugins).toEqual([]);
  });

  it('finds the mcp_servers entries that run buildit-mcp, in any TOML shape', () => {
    const text = [
      '# my servers',
      '[mcp_servers.node_repl]',
      "command = 'node_repl.exe'",
      '',
      '[mcp_servers.buildit]',
      'command = "npx"',
      'args = [',
      '  "-y",',
      '  "@kammcs/buildit-mcp@latest",',
      ']',
      '',
      '[mcp_servers.buildit.env]',
      'BUILDIT_LOG_LEVEL = "info"',
      '',
      '[mcp_servers."team buildit"]',
      'command = "cmd"',
      'args = ["/c", "npx", "-y", "@kammcs/buildit-mcp@0.17.0"]',
      '',
      '[mcp_servers.off]',
      'command = "npx"',
      'args = ["-y", "@kammcs/buildit-mcp"]',
      'enabled = false',
      '',
      '[mcp_servers]',
      'inline = { command = "npx", args = ["-y", "@kammcs/buildit-mcp"] }',
      'inline_off = { command = "npx", args = ["@kammcs/buildit-mcp"], enabled = false }',
      '',
      '[[profiles.list]]',
      'x = "buildit-mcp"',
    ].join('\n');
    expect(codexSetupOf(text)).toEqual({
      plugins: [],
      servers: ['buildit', 'team buildit', 'inline'],
    });
  });

  it("reads Codex's home and the folder's own config, and names where", () => {
    const home = join(dir, 'codex-home');
    const folder = join(dir, 'proj');
    mkdirSync(home, { recursive: true });
    mkdirSync(join(folder, '.codex'), { recursive: true });
    writeFileSync(join(home, 'config.toml'), '[plugins."buildit@buildit-mcp"]\nenabled = true\n');
    writeFileSync(
      join(folder, '.codex', 'config.toml'),
      '[mcp_servers.buildit]\ncommand = "npx"\nargs = ["-y", "@kammcs/buildit-mcp@latest"]\n',
    );
    expect(codexConfigs(folder, { codexHome: home })).toEqual([
      { place: '~/.codex/config.toml', plugins: ['buildit@buildit-mcp'], servers: [] },
      { place: '.codex/config.toml', plugins: [], servers: ['buildit'] },
    ]);
    expect(codexConfigs(folder, { env: { CODEX_HOME: home } })[0]?.place).toBe(
      '$CODEX_HOME/config.toml',
    );
    expect(codexHome({ CODEX_HOME: home })).toBe(home);
    expect(codexHome({}, join(dir, 'me'))).toBe(join(dir, 'me', '.codex'));
    // None, or no file: nothing.
    expect(codexConfigs(join(dir, 'empty'), { codexHome: join(dir, 'none') })).toEqual([]);
  });
});

describe('status, with Codex', () => {
  const lockDir = (): string => join(dir, 'locks');
  const folder = (): string => join(dir, 'proj');
  const home = (): string => join(dir, 'home');

  const status = async (): Promise<string> => {
    let out = '';
    await runStatus(
      { apiUrl: API, folder: folder() },
      {
        out: (t) => (out += t),
        err: () => undefined,
        store: new FileTokenStore(join(dir, 'sessions.json')),
        logger: createLogger({ sink: () => undefined }),
        home: home(),
        lockDir: lockDir(),
      },
    );
    return out;
  };

  it('says nothing of Codex when nothing of it is set up', async () => {
    expect(await status()).not.toContain('Codex:');
  });

  it('names the plugin and the servers, and points to the bridge', async () => {
    mkdirSync(join(home(), '.codex'), { recursive: true });
    writeFileSync(
      join(home(), '.codex', 'config.toml'),
      [
        '[plugins."buildit@buildit-mcp"]',
        'enabled = true',
        '[mcp_servers.bi]',
        'command = "npx"',
        'args = ["-y", "@kammcs/buildit-mcp@latest"]',
      ].join('\n'),
    );
    const out = await status();
    expect(out).toContain(
      'Codex:    the buildit plugin (buildit@buildit-mcp: tools and skills, no messages; in ~/.codex/config.toml); the server "bi" (buildit-mcp, in ~/.codex/config.toml)',
    );
    expect(out).toContain('run the bridge in this folder: buildit-mcp codex --project <KEY>');
    // The Claude Code side is unchanged by it.
    expect(out).not.toContain('Servers:');
  });

  it('says the bridge ran here, and names it as the channel while it runs', async () => {
    mkdirSync(lockDir(), { recursive: true });
    writeFileSync(join(lockDir(), `${sessionKey(folder(), API)}.codex-threads.json`), '{}');
    let out = await status();
    expect(out).toContain('Codex:    the bridge (buildit-mcp codex) has run in this folder');
    expect(out).not.toContain('run the bridge in this folder');

    const bridge = acquireChannelLock(folder(), API, {
      plugin: true,
      codex: true,
      dir: lockDir(),
      releaseOnExit: false,
    })!;
    try {
      expect(lockHolders(folder(), API, { dir: lockDir() }).plugin).toMatchObject({
        pid: process.pid,
        plugin: true,
        codex: true,
      });
      out = await status();
      expect(out).toContain(
        `Channel:  the Codex bridge (buildit-mcp codex, pid ${process.pid}) receives this folder's messages.`,
      );
    } finally {
      bridge.release();
    }
    // The plugin's own server is not marked.
    const plugin = acquireChannelLock(folder(), API, {
      plugin: true,
      dir: lockDir(),
      releaseOnExit: false,
    })!;
    try {
      expect(lockHolders(folder(), API, { dir: lockDir() }).plugin?.codex).toBe(false);
      expect(await status()).toContain("Channel:  the buildit plugin's server");
    } finally {
      plugin.release();
    }
  });
});
