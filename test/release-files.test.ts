/**
 * The files that describe a release to other registries stay in step with
 * package.json: the MCP Registry's server.json and the Claude Desktop
 * bundle's manifest.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_APPROVAL_TIMEOUT_MINUTES, DEFAULT_MAX_PARALLEL_ITEMS } from '../src/config.js';

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
    userConfig: Record<string, { default: unknown; type?: string; min?: number; max?: number }>;
  };
  const hooks = read('plugin/hooks/hooks.json') as {
    hooks: Record<
      string,
      {
        matcher?: string;
        hooks: {
          type: string;
          command: string;
          args: string[];
          timeout: number;
          async?: boolean;
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
      BUILDIT_MAX_PARALLEL_ITEMS: '${user_config.max_parallel_items}',
      BUILDIT_APPROVALS_IN_APP: '${user_config.approvals_in_app}',
      BUILDIT_APPROVAL_TIMEOUT_MINUTES: '${user_config.approval_timeout_minutes}',
    });
    expect(plugin.userConfig.approvals_in_app).toMatchObject({ type: 'boolean', default: true });
    expect(plugin.userConfig.approval_timeout_minutes).toMatchObject({
      type: 'number',
      default: DEFAULT_APPROVAL_TIMEOUT_MINUTES,
      min: 1,
      max: 60,
    });
    expect(plugin.userConfig.ask_timeout_minutes?.default).toBe(60);
    expect(plugin.userConfig.questions_in_app?.default).toBe(true);
    expect(plugin.userConfig.max_parallel_items).toMatchObject({
      type: 'number',
      default: DEFAULT_MAX_PARALLEL_ITEMS,
      min: 1,
      max: 10,
    });
  });

  it('has the item worker subagent that the lead instructions name', async () => {
    const { ITEM_WORKER_AGENT } = await import('../src/server.js');
    const text = readFileSync(
      new URL('../plugin/agents/buildit-item-worker.md', import.meta.url),
      'utf8',
    );
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text.replace(/\r\n/g, '\n'))?.[1] ?? '';
    const field = (name: string): string | undefined =>
      new RegExp(`^${name}: (.+)$`, 'm').exec(front)?.[1];
    // Named <plugin>:<name> once installed.
    expect(`${plugin.name}:${field('name') ?? ''}`).toBe(ITEM_WORKER_AGENT);
    expect(field('description')).toBeDefined();
    // Its own git worktree, and it runs while the lead takes the next events.
    expect(field('isolation')).toBe('worktree');
    expect(field('background')).toBe('true');
    // Only the fields a plugin agent may have.
    for (const line of front.split('\n')) {
      expect(['name', 'description', 'isolation', 'background']).toContain(line.split(':')[0]);
    }
    expect(text).toContain('untrusted_content');
    expect(text).toContain('card_thread');
  });

  it('has the request worker that the lead instructions name', async () => {
    const { REQUEST_WORKER_AGENT } = await import('../src/server.js');
    const text = readFileSync(
      new URL('../plugin/agents/buildit-request-worker.md', import.meta.url),
      'utf8',
    );
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text.replace(/\r\n/g, '\n'))?.[1] ?? '';
    const field = (name: string): string | undefined =>
      new RegExp(`^${name}: (.+)$`, 'm').exec(front)?.[1];
    expect(`${plugin.name}:${field('name') ?? ''}`).toBe(REQUEST_WORKER_AGENT);
    expect(field('description')).toBeDefined();
    // It reads and writes one message: no worktree of its own.
    expect(field('isolation')).toBeUndefined();
    expect(field('background')).toBe('true');
    for (const line of front.split('\n')) {
      expect(['name', 'description', 'isolation', 'background']).toContain(line.split(':')[0]);
    }
    for (const phrase of [
      'untrusted_content',
      'request_id',
      'buildit-catch-up',
      'buildit-thread-to-items',
      'buildit-triage',
      'buildit-item-helper',
      'buildit-meeting-notes',
      'ask_reporter',
      'locale',
    ]) {
      expect(text).toContain(phrase);
    }
  });

  it("ships the shared request rules, each request kind's skill and the work updates skill, and only those", async () => {
    const { REQUEST_KINDS } = await import('../src/channel/requests.js');
    const skills = readdirSync(new URL('../plugin/skills/', import.meta.url)).sort();
    expect(skills).toEqual([
      'buildit-catch-up',
      'buildit-item-helper',
      'buildit-meeting-notes',
      'buildit-requests',
      'buildit-thread-to-items',
      'buildit-triage',
      'buildit-work-updates',
    ]);
    for (const skill of skills) {
      const text = readFileSync(
        new URL(`../plugin/skills/${skill}/SKILL.md`, import.meta.url),
        'utf8',
      ).replace(/\r\n/g, '\n');
      const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
      expect(/^name: (.+)$/m.exec(front)?.[1]).toBe(skill);
      expect(/^description: (.+)$/m.exec(front)?.[1]).toBeDefined();
      expect(text).toContain('untrusted_content');
    }
    // Every kind names a shipped skill, and every skill but the shared rules and the work
    // updates (item work, not a request) handles a kind.
    const named = new Set<string>();
    for (const kind of Object.values(REQUEST_KINDS)) {
      expect(kind.skill).toBeDefined();
      if (kind.skill !== undefined) named.add(kind.skill);
    }
    expect([...named, 'buildit-requests', 'buildit-work-updates'].sort()).toEqual(skills);
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
      for (const file of [
        'hooks/forward.mjs',
        'agents/buildit-item-worker.md',
        'agents/buildit-request-worker.md',
        'skills/buildit-requests/SKILL.md',
        'skills/buildit-catch-up/SKILL.md',
        'skills/buildit-thread-to-items/SKILL.md',
        'skills/buildit-triage/SKILL.md',
        'skills/buildit-item-helper/SKILL.md',
        'skills/buildit-meeting-notes/SKILL.md',
        'skills/buildit-work-updates/SKILL.md',
      ]) {
        expect(readFileSync(join(out, 'buildit', file), 'utf8')).toBe(
          readFileSync(new URL(`../plugin/${file}`, import.meta.url), 'utf8'),
        );
      }
      expect(devCommands(out)).toEqual([
        `claude plugin marketplace add ${out}`,
        'claude plugin install buildit@buildit-dev',
        'claude --dangerously-load-development-channels plugin:buildit@buildit-dev',
      ]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  /** A hook that hands its input to the server's hook tool (plugin/hooks/forward.mjs). */
  const forward = (tool: string, timeout: number, extra: { async?: boolean } = {}) => ({
    type: 'command',
    command: 'node',
    args: ['${CLAUDE_PLUGIN_ROOT}/hooks/forward.mjs', tool],
    timeout,
    ...extra,
  });

  it("calls ask from AskUserQuestion's hook with the server's timeout, and turn_ended on Stop", async () => {
    const { HOOK_TIMEOUT_S } = await import('../src/transports/stdio.js');
    const ask = hooks.hooks.PreToolUse?.find((h) => h.matcher === 'AskUserQuestion')?.hooks;
    expect(ask).toEqual([forward('ask', HOOK_TIMEOUT_S)]);
    // Stop closes the main agent's approvals: it runs before the next turn can start.
    expect(hooks.hooks.Stop?.[0]?.hooks).toEqual([forward('turn_ended', 30)]);
  });

  it('asks tool approvals from PermissionRequest, and ends them from the other hooks', async () => {
    const { HOOK_TIMEOUT_S } = await import('../src/transports/stdio.js');
    const only = (event: string) => {
      const entries = hooks.hooks[event] ?? [];
      expect(entries, event).toHaveLength(1);
      expect(entries[0]?.hooks, event).toHaveLength(1);
      return entries[0];
    };
    const approve = only('PermissionRequest');
    expect(approve?.matcher).toBe('*');
    expect(approve?.hooks[0]).toEqual(forward('approve', HOOK_TIMEOUT_S));
    // Before the call's PermissionRequest (it names the call), so it doesn't run in the background.
    const seen = hooks.hooks.PreToolUse?.find((h) => h.matcher === '*');
    expect(seen?.hooks).toEqual([forward('tool_seen', 10)]);
    // A tool call's and a subagent's ids are their own: these may run in the background.
    for (const event of ['PostToolUse', 'PostToolUseFailure']) {
      const entry = only(event);
      expect(entry?.matcher, event).toBe('*');
      expect(entry?.hooks[0], event).toEqual(forward('tool_done', 10, { async: true }));
    }
    expect(only('SubagentStop')?.hooks[0]).toEqual(forward('agent_done', 30, { async: true }));
    // A typed prompt closes the main agent's approvals before the turn starts: not in the background.
    expect(only('UserPromptSubmit')?.hooks[0]).toEqual(forward('prompt_typed', 30));
    // Every hook calls a tool the server has, through the bridge.
    const { createApprovalHookTools } = await import('../src/tools/approve.js');
    const { ChannelState } = await import('../src/channel/loop.js');
    const { HOOK_NAMES } = await import('../src/channel/hook-bridge.js');
    const names = new Set([
      'ask',
      'approve',
      'turn_ended',
      ...createApprovalHookTools(new ChannelState()).map((t) => t.name),
    ]);
    expect(new Set(HOOK_NAMES)).toEqual(names);
    for (const entries of Object.values(hooks.hooks)) {
      for (const entry of entries) {
        for (const hook of entry.hooks) {
          // No mcp_tool hooks: those show an error on every call while the server is off.
          expect(hook.type).toBe('command');
          expect(names).toContain(hook.args[1]);
        }
      }
    }
    expect(existsSync(new URL('../plugin/hooks/forward.mjs', import.meta.url))).toBe(true);
  });
});

describe('the Codex plugin', () => {
  // The npm package is the plugin: Codex installs it from npm (the marketplace's npm source).
  const marketplace = read('.agents/plugins/marketplace.json') as {
    name: string;
    plugins: {
      name: string;
      source: { source: string; package?: string; version?: string };
      policy: { installation: string; authentication: string };
      category: string;
    }[];
  };
  const manifest = read('.codex-plugin/plugin.json') as Record<string, unknown> & {
    name: string;
    version: string;
    skills: string;
    mcpServers: string;
  };
  const mcp = read('.codex-plugin/mcp.json') as {
    mcpServers: Record<string, Record<string, unknown> & { args: string[] }>;
  };
  const files = (read('package.json') as { files: string[] }).files;

  it("installs package.json's release from npm, with the Claude Code marketplace's name", () => {
    const claude = read('.claude-plugin/marketplace.json') as { name: string };
    expect(marketplace.name).toBe(claude.name);
    expect(marketplace.plugins).toEqual([
      {
        name: 'buildit',
        source: { source: 'npm', package: pkg.name, version: pkg.version },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: expect.any(String) as string,
      },
    ]);
    expect(manifest.name).toBe('buildit');
    expect(manifest.version).toBe(pkg.version);
  });

  it('ships its manifest and MCP config in the package, and no hooks', () => {
    expect(files).toEqual(
      expect.arrayContaining(['.codex-plugin/plugin.json', '.codex-plugin/mcp.json']),
    );
    expect(manifest.mcpServers).toBe('./.codex-plugin/mcp.json');
    // Approvals reach the app only through the bridge (as server requests), never by a hook.
    expect(manifest).not.toHaveProperty('hooks');
    expect(manifest).not.toHaveProperty('extensions');
    expect(files.some((f) => /hooks/.test(f))).toBe(false);
  });

  it("gives Codex the Claude Code plugin's own skill files, no copies", async () => {
    const { BRIDGE_SKILLS } = await import('../src/codex/skills.js');
    expect(manifest.skills).toBe('./plugin/skills/');
    expect(files).toContain('plugin/skills/*/SKILL.md');
    const shipped = readdirSync(new URL('../plugin/skills/', import.meta.url)).sort();
    expect([...BRIDGE_SKILLS].sort()).toEqual(shipped);
  });

  it('runs the released server in plain mode, approved without asking but for apply_plan', () => {
    expect(Object.keys(mcp.mcpServers)).toEqual(['buildit']);
    const server = mcp.mcpServers.buildit!;
    expect(server.command).toBe('npx');
    // Plain tools: no channel (the bridge is the channel), the token from the environment.
    expect(server.args).toEqual(['-y', `${pkg.name}@${pkg.version}`]);
    expect(server).not.toHaveProperty('env');
    expect(server.env_vars).toContain('BUILDIT_TOKEN');
    expect(server.env_vars).not.toContain('BUILDIT_CHANNEL');
    expect(server.env_vars).not.toContain('BUILDIT_HTTP');
    expect(server.default_tools_approval_mode).toBe('approve');
    expect(server.tools).toEqual({ apply_plan: { approval_mode: 'prompt' } });
    expect(server.tool_timeout_sec).toBeGreaterThanOrEqual(120);
    expect(server.startup_timeout_sec).toBeGreaterThanOrEqual(30);
  });
});
