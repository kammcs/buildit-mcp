/**
 * What Claude Code is configured to start for a folder, as far as its
 * files show it: for `buildit-mcp status`, which warns when both a channel
 * server added with `claude mcp add` (or in the folder's .mcp.json) and the
 * buildit plugin are set up, since only one of them may be the folder's
 * channel.
 *
 * It only reads: `~/.claude.json` (user and per-project servers), the
 * folder's `.mcp.json`, and the plugin lists (`~/.claude/plugins/
 * installed_plugins.json`, `enabledPlugins` in the user's and the folder's
 * settings). A plugin loaded with --plugin-dir can't be seen. Nothing from
 * these files is printed but the places a server was found.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { folderIdentity } from '../secrets/keychain.js';

/** The plugin's name, as its manifest names it. */
export const PLUGIN_NAME = 'buildit';

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function recordOf(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/** Whether an mcpServers entry runs buildit-mcp in channel mode. */
export function isChannelServer(entry: unknown): boolean {
  const e = recordOf(entry);
  const args = Array.isArray(e.args)
    ? e.args.filter((a): a is string => typeof a === 'string')
    : [];
  const line = [typeof e.command === 'string' ? e.command : '', ...args].join(' ');
  if (!/buildit-mcp/.test(line)) return false;
  const env = recordOf(e.env);
  return (
    args.includes('--channel') ||
    /^(1|true|yes|on)$/i.test(typeof env.BUILDIT_CHANNEL === 'string' ? env.BUILDIT_CHANNEL : '')
  );
}

/** Where a buildit-mcp channel server is configured for the folder ("~/.claude.json", ".mcp.json"). */
export function channelServerPlaces(folder: string, home: string = homedir()): string[] {
  const places: string[] = [];
  const user = readJson(join(home, '.claude.json'));
  if (user !== undefined) {
    const servers = Object.values(recordOf(user.mcpServers));
    const id = folderIdentity(folder);
    const project = Object.entries(recordOf(user.projects)).find(
      ([path]) => folderIdentity(path) === id,
    )?.[1];
    const projectServers = Object.values(recordOf(recordOf(project).mcpServers));
    if ([...servers, ...projectServers].some(isChannelServer)) places.push('~/.claude.json');
  }
  const local = readJson(join(folder, '.mcp.json'));
  if (local !== undefined && Object.values(recordOf(local.mcpServers)).some(isChannelServer)) {
    places.push('.mcp.json');
  }
  return places;
}

const isPluginKey = (key: string): boolean =>
  key === PLUGIN_NAME || key.startsWith(`${PLUGIN_NAME}@`);

/** Whether the buildit plugin is installed or enabled (by the files Claude Code keeps). */
export function pluginConfigured(folder: string, home: string = homedir()): boolean {
  const installed = readJson(join(home, '.claude', 'plugins', 'installed_plugins.json'));
  if (Object.keys(recordOf(installed?.plugins)).some(isPluginKey)) return true;
  for (const path of [
    join(home, '.claude', 'settings.json'),
    join(folder, '.claude', 'settings.json'),
    join(folder, '.claude', 'settings.local.json'),
  ]) {
    const enabled = recordOf(readJson(path)?.enabledPlugins);
    if (Object.entries(enabled).some(([key, on]) => isPluginKey(key) && on === true)) return true;
  }
  return false;
}

/** The warning `status` prints when both are set up, or undefined. */
export function duplicateChannelWarning(
  folder: string,
  home: string = homedir(),
): string | undefined {
  const places = channelServerPlaces(folder, home);
  if (places.length === 0 || !pluginConfigured(folder, home)) return undefined;
  return `Warning:  the buildit plugin is installed, and ${places.join(' and ')} also starts "buildit-mcp --channel" for this folder. Only one of them can be the channel: remove the other server (claude mcp remove <name>), then restart Claude Code.`;
}
