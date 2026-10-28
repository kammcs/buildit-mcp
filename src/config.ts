/**
 * Configuration from environment variables and command-line flags.
 *
 * Flags win over environment variables. The token is only ever read from the
 * environment (a flag would be visible to other processes), and no message
 * produced here ever contains it.
 */
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { LOG_LEVELS, scrubString, type LogLevel } from './log.js';
import {
  DEFAULT_TOOLSETS,
  isToolsetName,
  TOOLSET_NAMES,
  type ToolsetName,
} from './toolsets/toolsets.js';

export const DEFAULT_API_URL = 'https://api.buildit.social/functions/v1/agent-api';
export const DEFAULT_HTTP_HOST = '127.0.0.1';
export const DEFAULT_HTTP_PORT = 8765;

export type Mode = 'stdio' | 'http';

export interface HttpConfig {
  host: string;
  port: number;
  /** Hostnames accepted in the Host header; undefined means the loopback default (or none off loopback). */
  allowedHosts?: string[];
  /** Origin hostnames accepted in the Origin header; undefined means the loopback default (or none off loopback). */
  allowedOrigins?: string[];
  /**
   * Off loopback without allowedHosts, serve anyway with the Host header
   * unchecked (the operator's explicit choice, for example behind a proxy
   * that checks it). Without it, that configuration is refused.
   */
  allowAnyHost?: boolean;
}

/** --channel mode: the session's folder, and where its token comes from. */
export interface ChannelConfig {
  /** The folder whose saved session is used (--folder, BUILDIT_FOLDER, else the working directory). */
  folder: string;
  /** `env`: BUILDIT_TOKEN; `store`: the token `connect` saved for the folder (read at startup). */
  tokenSource: 'env' | 'store';
}

export interface Config {
  mode: Mode;
  /** The agent API base URL, without a trailing slash. */
  apiUrl: string;
  /**
   * stdio mode only. In HTTP mode each request brings its own token; in
   * channel mode without BUILDIT_TOKEN it is read from the token store.
   */
  token?: string;
  /** Set in --channel mode (stdio only): push the session's messages into Claude Code. */
  channel?: ChannelConfig;
  toolsets: ToolsetName[];
  readOnly: boolean;
  excludeTools: string[];
  http: HttpConfig;
  logLevel: LogLevel;
  /** Problems that don't stop the server but should be logged at startup. */
  warnings: string[];
}

/** What `connect`, `disconnect` and `status` work on: one folder's session with one deployment. */
export interface SessionCommandOptions {
  apiUrl: string;
  folder: string;
}

export interface ConnectOptions extends SessionCommandOptions {
  /** Project keys, upper-cased, 1 to 10. */
  projects: string[];
  /** The session's name in buildIt.Social (1 to 40 characters). */
  label: string;
}

export type SessionCommand = 'connect' | 'disconnect' | 'status';

export type CliAction =
  | { kind: 'run'; config: Config }
  | { kind: 'help'; command?: SessionCommand }
  | { kind: 'version' }
  | { kind: 'connect'; options: ConnectOptions }
  | { kind: 'disconnect'; options: SessionCommandOptions }
  | { kind: 'status'; options: SessionCommandOptions };

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export type Env = Readonly<Record<string, string | undefined>>;

export const USAGE = `Usage: buildit-mcp [options]
       buildit-mcp connect --project <KEY> [--label <name>] [--folder <path>] [--api-url <url>]
       buildit-mcp disconnect [--folder <path>] [--api-url <url>]
       buildit-mcp status [--folder <path>] [--api-url <url>]

An MCP server for buildIt.Social. By default it serves one person over stdio,
with the personal access token in the BUILDIT_TOKEN environment variable.
With --channel it is also a Claude Code channel: the messages its owner sends
to the agent in buildIt.Social arrive in the Claude Code session, which
answers with the reply tool. Its token is the session token that
"buildit-mcp connect" saved for the folder (or BUILDIT_TOKEN).

Commands (run them in a terminal, in the folder where Claude Code runs):
  connect                   Connect this folder to buildIt.Social as an agent
                            session: shows a code to approve in the app, then
                            saves the session token in the OS keychain
  disconnect                Forget this folder's saved session
  status                    Show this folder's session
  Run "buildit-mcp <command> --help" for a command's options.

Options (each also has an environment variable):
  --api-url <url>           BUILDIT_API_URL           Agent API base URL
                                                      (default ${DEFAULT_API_URL})
  --toolsets <list>         BUILDIT_TOOLSETS          Comma-separated toolsets, or "all"
                                                      (default ${DEFAULT_TOOLSETS.join(',')};
                                                      known: ${TOOLSET_NAMES.join(', ')})
  --read-only               BUILDIT_READ_ONLY=true    Only list tools that change nothing
  --exclude-tools <list>    BUILDIT_EXCLUDE_TOOLS     Comma-separated tool names to hide
  --log-level <level>       BUILDIT_LOG_LEVEL         ${LOG_LEVELS.join(', ')} (default info)
  --http                    BUILDIT_HTTP=true         Serve Streamable HTTP instead of stdio
  --host <host>             BUILDIT_HOST              HTTP bind address (default ${DEFAULT_HTTP_HOST})
  --port <port>             BUILDIT_PORT              HTTP port (default ${DEFAULT_HTTP_PORT})
  --allowed-hosts <list>    BUILDIT_ALLOWED_HOSTS     Hostnames accepted in the Host header
  --allowed-origins <list>  BUILDIT_ALLOWED_ORIGINS   Hostnames accepted in the Origin header
  --channel                 BUILDIT_CHANNEL=true      Claude Code channel mode (stdio only)
  --folder <path>           BUILDIT_FOLDER            The folder whose saved session --channel uses
                                                      (default: the working directory)
  --allow-any-host          BUILDIT_ALLOW_ANY_HOST=true
                                                      Off loopback, serve without checking the
                                                      Host header (otherwise BUILDIT_ALLOWED_HOSTS
                                                      is required there)
  -h, --help                                          Show this help
  -v, --version                                       Show the version

The token is never accepted as a flag. In stdio mode set BUILDIT_TOKEN; in HTTP
mode every request carries its own "Authorization: Bearer <token>" header.
`;

export const COMMAND_USAGE: Record<SessionCommand, string> = {
  connect: `Usage: buildit-mcp connect --project <KEY> [options]

Connects this folder to buildIt.Social as a session of your personal agent,
for Claude Code's channel mode (buildit-mcp --channel). It shows a code and a
link: open the link, check the code, and approve in buildIt.Social. The
session token is then saved in the OS keychain for this folder and API.

Options:
  --project <KEY>           A project the session may reach (repeat it, or
                            separate keys with commas; 1 to 10)
  --label <name>            The session's name in buildIt.Social, 1 to 40
                            characters (default: the folder's name)
  --folder <path>           The folder (default: the working directory)
  --api-url <url>           BUILDIT_API_URL  Agent API base URL
                            (default ${DEFAULT_API_URL})
  -h, --help                Show this help
`,
  disconnect: `Usage: buildit-mcp disconnect [options]

Forgets the session token saved for this folder. The session stays in
buildIt.Social until you revoke it there, or it expires after 30 days unused.

Options:
  --folder <path>           The folder (default: the working directory)
  --api-url <url>           BUILDIT_API_URL  Agent API base URL
  -h, --help                Show this help
`,
  status: `Usage: buildit-mcp status [options]

Shows the session saved for this folder: its agent, name, org and reach, and
whether buildIt.Social still accepts it.

Options:
  --folder <path>           The folder (default: the working directory)
  --api-url <url>           BUILDIT_API_URL  Agent API base URL
  -h, --help                Show this help
`,
};

const SESSION_COMMANDS: readonly SessionCommand[] = ['connect', 'disconnect', 'status'];

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', '']);

export function parseBoolean(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  throw new ConfigError(`${name} must be true or false (got "${raw}").`);
}

function splitList(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  ];
}

/** Parses a toolset list such as "items,comments" or "all". Throws ConfigError on unknown names. */
export function parseToolsets(raw: string, source = 'BUILDIT_TOOLSETS'): ToolsetName[] {
  const names = splitList(raw.toLowerCase());
  if (names.length === 0) return [...DEFAULT_TOOLSETS];
  if (names.includes('all')) return [...TOOLSET_NAMES];
  const unknown = names.filter((n) => !isToolsetName(n));
  if (unknown.length > 0) {
    throw new ConfigError(
      `${source} has unknown toolset(s): ${unknown.join(', ')}. Known toolsets: ${TOOLSET_NAMES.join(', ')}, or "all".`,
    );
  }
  // Keep the canonical order so the tool list doesn't depend on how the list was written.
  return TOOLSET_NAMES.filter((n) => names.includes(n));
}

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

function parseToolNames(raw: string, source: string): string[] {
  const names = splitList(raw.toLowerCase());
  const bad = names.filter((n) => !TOOL_NAME.test(n));
  if (bad.length > 0) {
    throw new ConfigError(
      `${source} has invalid tool name(s): ${bad.join(', ')}. Tool names are lowercase letters, digits and underscores.`,
    );
  }
  return names;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

export function parseApiUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ConfigError(`BUILDIT_API_URL is not a valid URL (got "${raw}").`);
  }
  if (url.username || url.password) {
    throw new ConfigError('BUILDIT_API_URL must not contain credentials.');
  }
  if (url.search || url.hash) {
    throw new ConfigError('BUILDIT_API_URL must not have a query string or fragment.');
  }
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new ConfigError(
      'BUILDIT_API_URL must use https:// (plain http:// is only allowed for localhost).',
    );
  }
  return url.toString().replace(/\/+$/, '');
}

const HOSTNAME =
  /^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)$/;
const EXTENSION_ORIGIN = /^[a-z][a-z0-9+.-]*:\/\/\*$/;

/** Normalises a host or origin entry to the bare hostname the SDK's validators compare. */
function normaliseHostEntry(entry: string, source: string, allowSchemeWildcard: boolean): string {
  const value = entry.toLowerCase();
  if (allowSchemeWildcard && EXTENSION_ORIGIN.test(value)) {
    if (value === 'http://*' || value === 'https://*') {
      throw new ConfigError(`${source}: "${entry}" would allow every web page; list hostnames.`);
    }
    return value;
  }
  let host: string;
  if (value.includes('://')) {
    try {
      host = new URL(value).hostname;
    } catch {
      throw new ConfigError(`${source}: "${entry}" is not a valid origin.`);
    }
  } else if (!value.startsWith('[')) {
    host = value.replace(/:\d+$/, '');
  } else {
    host = value.replace(/\]:\d+$/, ']');
  }
  if (host === '::1') host = '[::1]';
  if (!HOSTNAME.test(host)) {
    throw new ConfigError(`${source}: "${entry}" is not a valid hostname.`);
  }
  return host;
}

function parseHostList(raw: string, source: string, allowSchemeWildcard: boolean): string[] {
  return [
    ...new Set(splitList(raw).map((e) => normaliseHostEntry(e, source, allowSchemeWildcard))),
  ];
}

function parsePort(raw: string): number {
  const value = raw.trim();
  if (!/^\d+$/.test(value)) throw new ConfigError(`The port must be a number (got "${raw}").`);
  const port = Number(value);
  if (port > 65535) throw new ConfigError(`The port must be at most 65535 (got ${port}).`);
  return port;
}

function parseLogLevel(raw: string): LogLevel {
  const value = raw.trim().toLowerCase();
  if ((LOG_LEVELS as readonly string[]).includes(value)) return value as LogLevel;
  throw new ConfigError(`The log level must be one of ${LOG_LEVELS.join(', ')} (got "${raw}").`);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9]{1,5}$/;
export const LABEL_MAX_CHARS = 40;
/** Control, direction and zero-width characters (a RegExp character class), which a session label may not hold. */
export const FORBIDDEN_CHARS =
  '[\\u0000-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2069\\uFEFF]';

/** Project keys from --project flags (each may list several, comma-separated). */
export function parseProjects(values: readonly string[]): string[] {
  const keys = [...new Set(values.flatMap((v) => splitList(v)).map((k) => k.toUpperCase()))];
  if (keys.length === 0) {
    throw new ConfigError(
      'Name the project the session may reach with --project <KEY>, for example --project DEMO.',
    );
  }
  const bad = keys.filter((k) => !PROJECT_KEY.test(k));
  if (bad.length > 0) {
    throw new ConfigError(
      `Not a project key: ${bad.join(', ')}. Keys are 2 to 6 letters and digits, starting with a letter (for example DEMO).`,
    );
  }
  if (keys.length > 10) throw new ConfigError('A session may reach at most 10 projects.');
  return keys;
}

/** The --label given, checked; or the folder's name, made to fit. */
export function sessionLabel(raw: string | undefined, folder: string): string {
  if (raw !== undefined) {
    const label = raw.trim();
    if (label.length === 0 || Array.from(label).length > LABEL_MAX_CHARS) {
      throw new ConfigError(`The label must be 1 to ${LABEL_MAX_CHARS} characters.`);
    }
    if (new RegExp(FORBIDDEN_CHARS, 'u').test(label)) {
      throw new ConfigError('The label may not hold control, direction or invisible characters.');
    }
    return label;
  }
  const name = Array.from(basename(folder).replace(new RegExp(FORBIDDEN_CHARS, 'gu'), '').trim())
    .slice(0, LABEL_MAX_CHARS)
    .join('')
    .trim();
  return name.length > 0 ? name : 'session';
}

/** The folder a session belongs to: --folder, else BUILDIT_FOLDER, else the working directory. */
function folderOf(flag: unknown, env: Env, cwd: string): string {
  const raw = typeof flag === 'string' ? flag : nonEmpty(env.BUILDIT_FOLDER);
  if (raw !== undefined && raw.trim() === '') throw new ConfigError('--folder must not be empty.');
  return resolve(cwd, raw?.trim() ?? '.');
}

function parseSessionCommand(
  command: SessionCommand,
  argv: readonly string[],
  env: Env,
  cwd: string,
  secrets: readonly string[],
): CliAction {
  let values: Record<string, string | boolean | string[] | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        'api-url': { type: 'string' },
        folder: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        ...(command === 'connect'
          ? {
              project: { type: 'string', multiple: true },
              label: { type: 'string' },
            }
          : {}),
      },
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigError(
      `${scrubString(message, secrets)} Run "buildit-mcp ${command} --help" for the options.`,
    );
  }
  if (values.help === true) return { kind: 'help', command };
  const apiFlag = values['api-url'];
  const apiUrl = parseApiUrl(
    (typeof apiFlag === 'string' ? apiFlag : nonEmpty(env.BUILDIT_API_URL)) ?? DEFAULT_API_URL,
  );
  const folder = folderOf(values.folder, env, cwd);
  if (command !== 'connect') return { kind: command, options: { apiUrl, folder } };
  const projectFlags = values.project;
  const projects = parseProjects(Array.isArray(projectFlags) ? projectFlags : []);
  const label = sessionLabel(typeof values.label === 'string' ? values.label : undefined, folder);
  return { kind: 'connect', options: { apiUrl, folder, projects, label } };
}

/**
 * Parses flags and environment variables. Throws ConfigError with a message
 * that is safe to print (it never contains the token).
 */
export function parseCli(
  argv: readonly string[],
  env: Env,
  cwd: string = process.cwd(),
): CliAction {
  const secrets = env.BUILDIT_TOKEN ? [env.BUILDIT_TOKEN] : [];

  if (argv.some((a) => a === '--token' || a.startsWith('--token='))) {
    throw new ConfigError(
      'The token is never accepted as a flag (other processes can read flags). Set the BUILDIT_TOKEN environment variable instead.',
    );
  }

  const command = SESSION_COMMANDS.find((c) => c === argv[0]);
  if (command !== undefined) {
    return parseSessionCommand(command, argv.slice(1), env, cwd, secrets);
  }

  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        'api-url': { type: 'string' },
        toolsets: { type: 'string' },
        'read-only': { type: 'boolean' },
        'exclude-tools': { type: 'string' },
        'log-level': { type: 'string' },
        http: { type: 'boolean' },
        host: { type: 'string' },
        port: { type: 'string' },
        'allowed-hosts': { type: 'string' },
        'allowed-origins': { type: 'string' },
        'allow-any-host': { type: 'boolean' },
        channel: { type: 'boolean' },
        folder: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`${scrubString(message, secrets)} Run with --help for the options.`);
  }

  if (values.help === true) return { kind: 'help' };
  if (values.version === true) return { kind: 'version' };

  const str = (flag: string, envName: string): string | undefined => {
    const fromFlag = values[flag];
    return typeof fromFlag === 'string' ? fromFlag : nonEmpty(env[envName]);
  };

  const warnings: string[] = [];
  const http = values.http === true || parseBoolean('BUILDIT_HTTP', env.BUILDIT_HTTP, false);
  const mode: Mode = http ? 'http' : 'stdio';
  const channelMode =
    values.channel === true || parseBoolean('BUILDIT_CHANNEL', env.BUILDIT_CHANNEL, false);
  if (channelMode && mode === 'http') {
    throw new ConfigError(
      'Channel mode (--channel) runs over stdio only: Claude Code starts it as a local server.',
    );
  }

  const apiUrl = parseApiUrl(str('api-url', 'BUILDIT_API_URL') ?? DEFAULT_API_URL);
  const toolsetsRaw = str('toolsets', 'BUILDIT_TOOLSETS');
  const toolsets = toolsetsRaw === undefined ? [...DEFAULT_TOOLSETS] : parseToolsets(toolsetsRaw);
  const readOnly =
    values['read-only'] === true || parseBoolean('BUILDIT_READ_ONLY', env.BUILDIT_READ_ONLY, false);
  const excludeRaw = str('exclude-tools', 'BUILDIT_EXCLUDE_TOOLS');
  const excludeTools =
    excludeRaw === undefined ? [] : parseToolNames(excludeRaw, 'BUILDIT_EXCLUDE_TOOLS');
  const logLevelRaw = str('log-level', 'BUILDIT_LOG_LEVEL');
  const logLevel = logLevelRaw === undefined ? 'info' : parseLogLevel(logLevelRaw);

  const host = (str('host', 'BUILDIT_HOST') ?? DEFAULT_HTTP_HOST).trim();
  if (host === '') throw new ConfigError('The HTTP host must not be empty.');
  const portRaw = str('port', 'BUILDIT_PORT');
  const port = portRaw === undefined ? DEFAULT_HTTP_PORT : parsePort(portRaw);
  const hostsRaw = str('allowed-hosts', 'BUILDIT_ALLOWED_HOSTS');
  const originsRaw = str('allowed-origins', 'BUILDIT_ALLOWED_ORIGINS');
  const httpConfig: HttpConfig = { host, port };
  if (hostsRaw !== undefined) {
    httpConfig.allowedHosts = parseHostList(hostsRaw, 'BUILDIT_ALLOWED_HOSTS', false);
  }
  if (originsRaw !== undefined) {
    httpConfig.allowedOrigins = parseHostList(originsRaw, 'BUILDIT_ALLOWED_ORIGINS', true);
  }

  let token: string | undefined;
  let channel: ChannelConfig | undefined;
  const rawToken = env.BUILDIT_TOKEN;
  if (channelMode) {
    channel = { folder: folderOf(values.folder, env, cwd), tokenSource: 'store' };
    if (rawToken !== undefined && rawToken.trim() !== '') {
      token = rawToken.trim();
      channel.tokenSource = 'env';
      if (/\s/.test(token)) {
        throw new ConfigError('BUILDIT_TOKEN contains whitespace; check that it was copied whole.');
      }
      if (!token.startsWith('buildit_ags_')) {
        warnings.push(
          'BUILDIT_TOKEN does not start with "buildit_ags_": channel mode needs a session token, which "buildit-mcp connect" saves for the folder.',
        );
      }
    }
  } else if (mode === 'stdio') {
    if (rawToken === undefined || rawToken.trim() === '') {
      throw new ConfigError(
        'BUILDIT_TOKEN is not set. Create a personal access token in buildIt.Social and put it in the BUILDIT_TOKEN environment variable (never in a file you commit).',
      );
    }
    token = rawToken.trim();
    if (/\s/.test(token)) {
      throw new ConfigError('BUILDIT_TOKEN contains whitespace; check that it was copied whole.');
    }
    if (!token.startsWith('buildit_pat_') && !token.startsWith('buildit_ags_')) {
      warnings.push(
        'BUILDIT_TOKEN does not start with "buildit_pat_"; buildIt.Social personal access tokens do.',
      );
    }
  } else {
    if (rawToken !== undefined && rawToken.trim() !== '') {
      warnings.push(
        'BUILDIT_TOKEN is ignored in HTTP mode: each request must carry its own Authorization header.',
      );
    }
    if (!isLoopbackHost(host) && httpConfig.allowedHosts === undefined) {
      const anyHost =
        values['allow-any-host'] === true ||
        parseBoolean('BUILDIT_ALLOW_ANY_HOST', env.BUILDIT_ALLOW_ANY_HOST, false);
      if (!anyHost) {
        throw new ConfigError(
          `Binding to ${host} needs BUILDIT_ALLOWED_HOSTS (or --allowed-hosts): the hostnames clients use, so the Host header can be checked. To serve without that check (for example behind a proxy that checks it), set BUILDIT_ALLOW_ANY_HOST=true or pass --allow-any-host.`,
        );
      }
      httpConfig.allowAnyHost = true;
      warnings.push(
        `Binding to ${host} without BUILDIT_ALLOWED_HOSTS, as BUILDIT_ALLOW_ANY_HOST asks: the Host header is not checked.`,
      );
    }
  }

  return {
    kind: 'run',
    config: {
      mode,
      apiUrl,
      ...(token === undefined ? {} : { token }),
      ...(channel === undefined ? {} : { channel }),
      toolsets,
      readOnly,
      excludeTools,
      http: httpConfig,
      logLevel,
      warnings,
    },
  };
}
