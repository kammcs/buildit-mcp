/**
 * What Codex is configured to load for buildIt.Social, as far as its
 * config files show it: for `buildit-mcp status`, which names the Codex
 * setup (the buildit plugin for Codex, buildit-mcp servers in Codex's
 * `mcp_servers`) next to the bridge's own marks.
 *
 * It only reads: `config.toml` in Codex's home (`CODEX_HOME`, else
 * `~/.codex`) and the folder's `.codex/config.toml`. The TOML is scanned,
 * not fully parsed: table headers and `key = value` lines (dotted and
 * quoted keys, values over several lines), enough to find
 * `[plugins."buildit@<marketplace>"]` and `[mcp_servers.<name>]` entries
 * that run buildit-mcp. Nothing from these files is printed but the
 * plugin's and the servers' names and where they were found.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { PLUGIN_NAME } from './claude-config.js';

/** Codex's home folder: `CODEX_HOME`, else `~/.codex`. */
export function codexHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const set = env.CODEX_HOME?.trim();
  return set !== undefined && set.length > 0 ? set : join(home, '.codex');
}

/** One `key = value` of a TOML file: its full key path and its raw value text. */
interface TomlEntry {
  path: string[];
  value: string;
}

/** A dotted TOML key split into its parts (bare or quoted). */
export function splitKey(raw: string): string[] {
  const parts: string[] = [];
  let i = 0;
  const text = raw.trim();
  while (i < text.length) {
    while (text[i] === ' ' || text[i] === '\t') i++;
    const c = text[i];
    let part = '';
    if (c === '"' || c === "'") {
      i++;
      while (i < text.length && text[i] !== c) {
        if (c === '"' && text[i] === '\\' && i + 1 < text.length) {
          part += text.charAt(i + 1);
          i += 2;
          continue;
        }
        part += text.charAt(i);
        i++;
      }
      i++;
    } else {
      while (i < text.length && text[i] !== '.') {
        part += text.charAt(i);
        i++;
      }
      part = part.trim();
    }
    parts.push(part);
    while (text[i] === ' ' || text[i] === '\t') i++;
    if (text[i] === '.') i++;
  }
  return parts;
}

/** How many brackets and braces a value leaves open, outside strings. */
function openBrackets(text: string): number {
  let depth = 0;
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote !== undefined) {
      if (quote === '"' && c === '\\') i++;
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === '#') break;
    if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
  }
  return depth;
}

/** Where a `key = value` line's `=` is (outside a quoted key), or -1. */
function equalsAt(line: string): number {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '=') return i;
    else if (c === '#') return -1;
  }
  return -1;
}

/** The entries of a TOML text, each with its table's path in front (tolerant: odd lines are skipped). */
export function scanToml(text: string): { tables: string[][]; entries: TomlEntry[] } {
  const tables: string[][] = [];
  const entries: TomlEntry[] = [];
  let table: string[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let n = 0; n < lines.length; n++) {
    const line = (lines[n] ?? '').trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const header = /^\[\s*([^[\]]+?)\s*\]\s*(#.*)?$/.exec(line);
    if (header !== null) {
      table = splitKey(header[1] ?? '');
      tables.push(table);
      continue;
    }
    // An array of tables ([[x]]) holds nothing this looks for.
    if (line.startsWith('[[')) {
      table = ['[['];
      continue;
    }
    const eq = equalsAt(line);
    if (eq <= 0) continue;
    let value = line.slice(eq + 1).trim();
    // A value over several lines: an array or inline table left open, or a multi-line string.
    const multi = /^("""|''')/.exec(value)?.[1];
    if (multi !== undefined && value.indexOf(multi, 3) === -1) {
      while (n + 1 < lines.length) {
        const next = lines[++n] ?? '';
        value += `\n${next}`;
        if (next.includes(multi)) break;
      }
    } else {
      let depth = openBrackets(value);
      while (depth > 0 && n + 1 < lines.length) {
        const next = lines[++n] ?? '';
        value += `\n${next}`;
        depth += openBrackets(next);
      }
    }
    entries.push({ path: [...table, ...splitKey(line.slice(0, eq))], value });
  }
  return { tables, entries };
}

/** What a Codex config file sets up for buildIt.Social. */
export interface CodexSetup {
  /** The buildit plugin's ids that are on (`buildit@<marketplace>`). */
  plugins: string[];
  /** The `mcp_servers` entries that run buildit-mcp and aren't turned off, by name. */
  servers: string[];
}

const FALSE = /^false\b/;

/** The buildit plugin and buildit-mcp servers a Codex config text sets up. */
export function codexSetupOf(text: string): CodexSetup {
  const { tables, entries } = scanToml(text);
  const plugins = new Map<string, boolean>();
  const servers = new Map<string, { buildit: boolean; off: boolean }>();
  const isPlugin = (id: string | undefined): id is string =>
    id !== undefined && (id === PLUGIN_NAME || id.startsWith(`${PLUGIN_NAME}@`));
  for (const t of tables) {
    if (t[0] === 'plugins' && t.length === 2 && isPlugin(t[1])) {
      if (!plugins.has(t[1])) plugins.set(t[1], true);
    }
  }
  for (const { path, value } of entries) {
    if (path[0] === 'plugins' && isPlugin(path[1])) {
      const on = plugins.get(path[1]) ?? true;
      if (path.length === 2) {
        // plugins."buildit@x" = { enabled = false }
        plugins.set(path[1], on && !/enabled\s*=\s*false/.test(value));
      } else if (path[2] === 'enabled') {
        plugins.set(path[1], !FALSE.test(value));
      } else if (!plugins.has(path[1])) {
        plugins.set(path[1], on);
      }
      continue;
    }
    if (path[0] === 'mcp_servers' && path[1] !== undefined) {
      const s = servers.get(path[1]) ?? { buildit: false, off: false };
      if (/buildit-mcp/.test(value)) s.buildit = true;
      if (path.length === 2 && /enabled\s*=\s*false/.test(value)) s.off = true;
      if (path[2] === 'enabled' && path.length === 3 && FALSE.test(value)) s.off = true;
      servers.set(path[1], s);
    }
  }
  return {
    plugins: [...plugins].filter(([, on]) => on).map(([id]) => id),
    servers: [...servers].filter(([, s]) => s.buildit && !s.off).map(([name]) => name),
  };
}

/** A Codex config file that sets up buildIt.Social, and what it sets up. */
export interface CodexConfigFound extends CodexSetup {
  /** "~/.codex/config.toml", "$CODEX_HOME/config.toml" or ".codex/config.toml". */
  place: string;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * The Codex config files that set up the buildit plugin or a buildit-mcp
 * server: Codex's home's (`home` given: that folder's; else CODEX_HOME or
 * ~/.codex) and the folder's own.
 */
export function codexConfigs(
  folder: string,
  options: { codexHome?: string; env?: NodeJS.ProcessEnv } = {},
): CodexConfigFound[] {
  const env = options.env ?? process.env;
  const home = options.codexHome ?? codexHome(env);
  const userPlace =
    options.codexHome === undefined && (env.CODEX_HOME?.trim() ?? '') !== ''
      ? '$CODEX_HOME/config.toml'
      : '~/.codex/config.toml';
  const found: CodexConfigFound[] = [];
  for (const [path, place] of [
    [join(home, 'config.toml'), userPlace],
    [join(folder, '.codex', 'config.toml'), '.codex/config.toml'],
  ] as const) {
    const text = readText(path);
    if (text === undefined) continue;
    const setup = codexSetupOf(text);
    if (setup.plugins.length > 0 || setup.servers.length > 0) found.push({ place, ...setup });
  }
  return found;
}
