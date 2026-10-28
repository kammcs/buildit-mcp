/**
 * The files that describe a release to other registries stay in step with
 * package.json: the MCP Registry's server.json and the Claude Desktop
 * bundle's manifest.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const read = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const readJsonAt = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

const pkg = read('package.json') as { name: string; version: string; mcpName: string };

interface Env {
  name: string;
  isSecret?: boolean;
  isRequired?: boolean;
  value?: string;
}
interface ServerJson {
  name: string;
  description: string;
  version: string;
  packages: {
    registryType: string;
    identifier: string;
    version?: string;
    environmentVariables: Env[];
  }[];
}

describe('server.json (MCP Registry)', () => {
  const server = read('server.json') as ServerJson;
  const npm = server.packages.find((p) => p.registryType === 'npm')!;
  const oci = server.packages.find((p) => p.registryType === 'oci')!;

  it("has package.json's name and version, for every package", () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    expect(npm).toMatchObject({ identifier: pkg.name, version: pkg.version });
    expect(oci.identifier).toBe(`ghcr.io/kammcs/buildit-mcp:${pkg.version}`);
    expect(server.description.length).toBeLessThanOrEqual(100);
  });

  it('asks for the token as a required secret, and runs the image over stdio', () => {
    for (const p of [npm, oci]) {
      expect(p.environmentVariables.find((e) => e.name === 'BUILDIT_TOKEN')).toMatchObject({
        isSecret: true,
        isRequired: true,
      });
    }
    expect(oci.environmentVariables.find((e) => e.name === 'BUILDIT_HTTP')?.value).toBe('false');
  });
});

describe('bundle/manifest.json (Claude Desktop)', () => {
  const manifest = read('bundle/manifest.json') as {
    name: string;
    server: { mcp_config: { env: Record<string, string> } };
    user_config: Record<string, { sensitive?: boolean; required?: boolean }>;
  };

  it('takes the token from a sensitive, required setting', () => {
    expect(manifest.name).toBe('buildit-mcp');
    expect(manifest.server.mcp_config.env.BUILDIT_TOKEN).toBe('${user_config.token}');
    expect(manifest.user_config.token).toMatchObject({ sensitive: true, required: true });
  });
});

describe('the Claude Code plugin', () => {
  const marketplace = read('.claude-plugin/marketplace.json') as {
    name: string;
    plugins: { name: string; source: string; version: string }[];
  };
  const plugin = read('plugin/.claude-plugin/plugin.json') as {
    name: string;
    version: string;
    mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    channels: { server: string }[];
    userConfig: Record<string, { default: unknown }>;
  };
  const hooks = read('plugin/hooks/hooks.json') as {
    hooks: Record<
      string,
      {
        matcher?: string;
        hooks: {
          type: string;
          server: string;
          tool: string;
          timeout: number;
          input?: Record<string, unknown>;
        }[];
      }[]
    >;
  };

  it("pins package.json's version, in the marketplace, the manifest and the server it starts", () => {
    expect(marketplace.name).toBe('buildit-mcp');
    expect(marketplace.plugins).toEqual([
      expect.objectContaining({ name: 'buildit', source: './plugin', version: pkg.version }),
    ]);
    expect(plugin.name).toBe('buildit');
    expect(plugin.version).toBe(pkg.version);
    expect(plugin.mcpServers.buildit?.args).toEqual([
      '-y',
      `${pkg.name}@${pkg.version}`,
      '--channel',
      // The plugin's server takes the folder's channel over from one added with claude mcp add.
      '--from-plugin',
    ]);
    expect(plugin.channels).toEqual([expect.objectContaining({ server: 'buildit' })]);
  });

  it('passes the settings to the server, with the defaults the server has', () => {
    expect(plugin.mcpServers.buildit?.env).toEqual({
      // Every toolset: approvals need destructive and admin (the session's scopes still apply).
      BUILDIT_TOOLSETS: 'all',
      BUILDIT_ASK_TIMEOUT_MINUTES: '${user_config.ask_timeout_minutes}',
      BUILDIT_QUESTIONS_IN_APP: '${user_config.questions_in_app}',
    });
    expect(plugin.userConfig.ask_timeout_minutes?.default).toBe(60);
    expect(plugin.userConfig.questions_in_app?.default).toBe(true);
  });

  it("makes a local marketplace whose plugin runs the checkout's dist/ with the same hooks and settings", async () => {
    const { DEV_MARKETPLACE, devCommands, writeDevMarketplace } =
      await import('../scripts/dev-marketplace.js');
    const out = mkdtempSync(join(tmpdir(), 'buildit-dev-marketplace-'));
    try {
      const checkout = resolve(import.meta.dirname, '..');
      const { version } = writeDevMarketplace(checkout, out);
      expect(version).toBe(`${pkg.version}-local`);
      const market = readJsonAt(join(out, '.claude-plugin', 'marketplace.json'));
      expect(market).toMatchObject({
        name: DEV_MARKETPLACE,
        plugins: [{ name: 'buildit', source: './buildit', version }],
      });
      const local = readJsonAt(join(out, 'buildit', '.claude-plugin', 'plugin.json'));
      const published = plugin as unknown as Record<string, unknown>;
      // Named buildit with a server buildit, so the hooks' plugin:buildit:buildit resolve.
      for (const key of new Set([...Object.keys(local), ...Object.keys(published)])) {
        if (key === 'description' || key === 'mcpServers' || key === 'version') continue;
        expect(local[key], key).toEqual(published[key]);
      }
      expect((local.mcpServers as typeof plugin.mcpServers).buildit).toEqual({
        ...plugin.mcpServers.buildit,
        command: 'node',
        args: [join(checkout, 'dist', 'index.js'), '--channel', '--from-plugin'],
      });
      expect(readJsonAt(join(out, 'buildit', 'hooks', 'hooks.json'))).toEqual(hooks);
      expect(devCommands(out)).toEqual([
        `claude plugin marketplace add ${out}`,
        'claude plugin install buildit@buildit-dev',
        'claude --dangerously-load-development-channels plugin:buildit@buildit-dev',
      ]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("calls ask from AskUserQuestion's hook with the server's timeout, and turn_ended on Stop", async () => {
    const { HOOK_TIMEOUT_S } = await import('../src/transports/stdio.js');
    const ask = hooks.hooks.PreToolUse?.find((h) => h.matcher === 'AskUserQuestion')?.hooks[0];
    expect(ask).toMatchObject({
      type: 'mcp_tool',
      server: 'plugin:buildit:buildit',
      tool: 'ask',
      timeout: HOOK_TIMEOUT_S,
      input: {
        questions: '${tool_input.questions}',
        tool_use_id: '${tool_use_id}',
        session_id: '${session_id}',
        format: 'hook',
      },
    });
    expect(hooks.hooks.Stop?.[0]?.hooks[0]).toMatchObject({
      type: 'mcp_tool',
      server: 'plugin:buildit:buildit',
      tool: 'turn_ended',
    });
  });
});
