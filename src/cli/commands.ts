/**
 * The session commands: `connect`, `disconnect` and `status`.
 *
 * They run in a terminal (not under an MCP client), so they write plain
 * text for a person to stdout, and problems to stderr. Nothing they print
 * contains the token. Text that comes from the server (the link, the code,
 * names) is stripped of control and direction characters first, so it can't
 * move the cursor or disguise itself in the terminal.
 */
import { hostname } from 'node:os';

import { ApiError, ApiClient } from '../api/client.js';
import {
  connectPoll,
  connectStart,
  getSession,
  POLL_CODES,
  revokeSession,
  SESSION_ENDED_CODES,
  type SessionInfo,
} from '../channel/api.js';
import { FORBIDDEN_CHARS, type ConnectOptions, type SessionCommandOptions } from '../config.js';
import { isTokenRefused, isTransientFailure } from '../identity.js';
import type { Logger } from '../log.js';
import { duplicateChannelWarning } from './claude-config.js';
import {
  forgetSession,
  forgetStaleApi,
  savedApiUrl,
  sessionApiKey,
  sessionKey,
  type TokenStore,
} from '../secrets/keychain.js';

/** The name a session's client shows in buildIt.Social ("Claude Code on <machine>"). */
export const CONNECT_CLIENT = 'Claude Code';

export interface CommandIO {
  out(text: string): void;
  err(text: string): void;
  store: TokenStore;
  logger: Logger;
  /** For tests. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  machine?: string;
  /** For tests: the script this command runs as (process.argv[1]), for the next-step commands. */
  entry?: string;
  /** Asks the person a question and returns their answer ('' when there is no one to ask). */
  ask?: (question: string) => Promise<string>;
  /** For tests: the home folder whose Claude Code files status reads. */
  home?: string;
}

/** The answers that confirm: only an explicit yes. */
const YES = /^y(es)?$/i;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Server text made safe for a terminal: no control, escape or direction characters. */
export function plain(text: string, max = 200): string {
  const flat = text
    .replace(new RegExp(`${FORBIDDEN_CHARS}+`, 'gu'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The machine's name as buildIt.Social shows it (1 to 64 characters). */
export function machineName(raw: string = hostname()): string {
  const name = Array.from(plain(raw, 64)).slice(0, 64).join('').trim();
  return name.length > 0 ? name : 'computer';
}

/** A link from the server, if it is an http(s) URL; otherwise undefined (it is not printed). */
function safeLink(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function apiFor(options: SessionCommandOptions, io: CommandIO, token?: string): ApiClient {
  return new ApiClient({
    baseUrl: options.apiUrl,
    token,
    logger: io.logger,
    ...(io.fetch ? { fetch: io.fetch } : {}),
    ...(io.sleep ? { sleep: io.sleep } : {}),
  });
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    const hint = err.hint ? ` ${plain(err.hint, 300)}` : '';
    return `${plain(err.message, 300)} (${err.code}).${hint}`;
  }
  return err instanceof Error ? plain(err.message, 300) : 'Unknown error.';
}

function sessionLines(info: SessionInfo): string[] {
  const s = info.session;
  const lines = [
    `Agent:    ${plain(info.agent.name, 80)} · ${plain(s.label, 40)}`,
    `Org:      ${plain(info.org.name, 80)}`,
    `Owner:    ${plain(info.owner.name, 80)}`,
  ];
  if (s.scopes.length > 0) {
    lines.push(`Scopes:   ${s.scopes.map((x) => plain(x, 40)).join(', ')}`);
  }
  lines.push(
    `Projects: ${s.project_ids.length}`,
    `Expires:  ${plain(s.expires_at, 40)} (30 days after it was last used)`,
  );
  return lines;
}

/** The commands to start Claude Code with this folder's session, after connecting. */
export function nextSteps(
  platform: NodeJS.Platform = process.platform,
  entry: string | undefined = process.argv[1],
): string[] {
  return [
    'Next, in this folder:',
    `  ${serverCommand(platform, entry)}`,
    '  claude --dangerously-load-development-channels server:buildit',
    'Messages you send to the agent in buildIt.Social then arrive in that Claude Code session.',
  ];
}

/**
 * The `claude mcp add` line for this folder, run the way this command was:
 * through npx, or a local build's dist/index.js (before a release is on
 * npm). The server finds the API connect saved, so the line needs no
 * --api-url.
 */
export function serverCommand(
  platform: NodeJS.Platform = process.platform,
  entry: string | undefined = process.argv[1],
): string {
  const viaNpx = entry === undefined || /[\\/](_npx|node_modules)[\\/]/.test(entry);
  if (!viaNpx) return `claude mcp add buildit -- node "${entry}" --channel`;
  return platform === 'win32'
    ? 'claude mcp add buildit -- cmd /c npx -y "@kammcs/buildit-mcp@latest" --channel'
    : 'claude mcp add buildit -- npx -y @kammcs/buildit-mcp@latest --channel';
}

/** The API a command works with: --api-url, else the one connect saved for the folder. */
async function apiUrlOf(options: SessionCommandOptions, store: TokenStore): Promise<string> {
  if (options.apiUrlFlag === true) return options.apiUrl;
  return (await savedApiUrl(store, options.folder)) ?? options.apiUrl;
}

/**
 * buildit-mcp connect: starts the device-code flow, shows the code and the
 * link, polls at the server's interval until the person approves (or denies,
 * or the code expires), and saves the session token for the folder.
 */
export async function runConnect(options: ConnectOptions, io: CommandIO): Promise<number> {
  const sleep = io.sleep ?? defaultSleep;
  const now = io.now ?? Date.now;
  const key = sessionKey(options.folder, options.apiUrl);

  const existing = await io.store.get(key);
  if (existing !== undefined) {
    try {
      const info = await getSession(apiFor(options, io, existing));
      io.out(
        [
          `This folder is already connected:`,
          ...sessionLines(info).map((l) => `  ${l}`),
          'Run "buildit-mcp disconnect" first to connect it again.',
        ].join('\n') + '\n',
      );
      return 0;
    } catch (err) {
      if (!isTokenRefused(err)) {
        io.err(`Could not check the saved session: ${describeError(err)}\n`);
        return 1;
      }
      io.out(
        `The saved session is no longer accepted (${(err as ApiError).code}); connecting again.\n`,
      );
    }
  }

  const api = apiFor(options, io);
  const body = {
    client: CONNECT_CLIENT,
    machine: io.machine ?? machineName(),
    label: options.label,
    projects: options.projects,
  };
  let start;
  try {
    start = await connectStart(api, body);
  } catch (err) {
    // A short rate limit is waited out once (the client already retried one of 10 s or less).
    const wait = rateLimitWait(err);
    if (wait === undefined || wait > MAX_START_WAIT_S) {
      io.err(`Could not start connecting: ${startRefusal(err, wait)}\n`);
      return 1;
    }
    io.out(`buildIt.Social asks to wait ${Math.ceil(wait)} s before connecting; waiting...\n`);
    await sleep(Math.ceil(wait) * 1000);
    try {
      start = await connectStart(api, body);
    } catch (again) {
      io.err(`Could not start connecting: ${startRefusal(again, rateLimitWait(again))}\n`);
      return 1;
    }
  }

  const link = safeLink(start.verification_uri_complete) ?? safeLink(start.verification_uri);
  const page = safeLink(start.verification_uri);
  const code = plain(start.user_code, 20);
  const minutes = Math.max(1, Math.round(start.expires_in / 60));
  io.out(
    [
      `To connect "${options.label}" (${options.projects.join(', ')}) to buildIt.Social, open:`,
      `  ${link ?? '(the server sent no usable link)'}`,
      `and check that buildIt.Social shows this code: ${code}`,
      ...(page !== undefined && page !== link ? [`(Or open ${page} and type the code.)`] : []),
      `Approve it only if you started this. The code works for ${minutes} minutes.`,
      'Waiting for approval...',
    ].join('\n') + '\n',
  );

  let intervalMs = Math.max(1, start.interval) * 1000;
  const deadline = now() + start.expires_in * 1000;
  for (;;) {
    await sleep(intervalMs);
    if (now() > deadline) {
      io.err('The code expired before it was approved. Run "buildit-mcp connect" again.\n');
      return 1;
    }
    try {
      const done = await connectPoll(api, start.device_code);
      // The projects as approved, which the person may have changed from the ones asked for.
      const keys = done.session.projects.map((p) => plain(p.key, 10));
      const plural = keys.length === 1 ? 'project' : 'projects';
      io.out(
        `Connected as ${plain(done.agent.name, 80)} (${plain(done.owner.name, 80)}) in ${plain(done.org.name, 80)}, ${plural} ${keys.join(', ')}; session "${plain(done.session.label, 40)}".\n`,
      );
      // Whoever approves a code gets the session: check it was the person here.
      const answer = options.yes ? 'y' : ((await io.ask?.('Is this you? [y/N] ')) ?? '');
      if (!YES.test(answer.trim())) {
        const cancelled = await cancel(apiFor(options, io, done.token));
        io.err(
          [
            cancelled === undefined
              ? 'Not saved, and the session was cancelled: the connection was not confirmed.'
              : `Not saved: the connection was not confirmed. The session could not be cancelled (${cancelled}): revoke the session "${plain(done.session.label, 40)}" in buildIt.Social (Settings → Agents), or have its owner do it.`,
            'If that was not you, someone else may have approved your code.',
            'Run "buildit-mcp connect" again for a new code, and approve it yourself.',
          ].join('\n') + '\n',
        );
        return 1;
      }
      await io.store.set(key, done.token);
      await io.store.set(sessionApiKey(options.folder), options.apiUrl);
      io.out(
        [
          io.store.kind === 'keyring'
            ? `The session token is saved in ${io.store.location}, for this folder.`
            : `The session token is saved in ${io.store.location} (readable only by your user account), for this folder.`,
          '',
          ...nextSteps(process.platform, io.entry ?? process.argv[1]),
        ].join('\n') + '\n',
      );
      return 0;
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      const interval = intervalOf(err.details);
      switch (err.code) {
        case POLL_CODES.pending:
          if (interval !== undefined) intervalMs = interval * 1000;
          continue;
        case POLL_CODES.slowDown:
          intervalMs = interval !== undefined ? interval * 1000 : intervalMs + 5000;
          continue;
        case POLL_CODES.denied:
          io.err(
            'The connection was denied in buildIt.Social, or it can no longer be used: the agent was turned off or deleted, or its owner is no longer a member of the org. Nothing was saved.\n',
          );
          return 1;
        case POLL_CODES.expired:
          io.err('The code expired or was already used. Run "buildit-mcp connect" again.\n');
          return 1;
        default:
          if (isTransientFailure(err)) {
            const wait = (err.retryAfterSeconds ?? 0) * 1000;
            if (wait > intervalMs) intervalMs = Math.min(wait, 60_000);
            continue;
          }
          io.err(`Connecting failed: ${describeError(err)}\n`);
          return 1;
      }
    }
  }
}

/** The longest Retry-After that connect waits out before starting. */
const MAX_START_WAIT_S = 60;

/** The seconds a rate limit asks to wait, when the error is one. */
function rateLimitWait(err: unknown): number | undefined {
  if (!(err instanceof ApiError) || (err.code !== 'rate_limited' && err.status !== 429)) {
    return undefined;
  }
  return err.retryAfterSeconds ?? 60;
}

function bucketOf(err: unknown): string | undefined {
  if (!(err instanceof ApiError) || err.details === null || typeof err.details !== 'object') {
    return undefined;
  }
  const bucket = (err.details as Record<string, unknown>).bucket;
  return typeof bucket === 'string' ? bucket : undefined;
}

/** Why connect_start refused, in plain words, with how long to wait when it said. */
function startRefusal(err: unknown, wait: number | undefined): string {
  if (wait === undefined) return describeError(err);
  const minutes = Math.max(1, Math.ceil(wait / 60));
  const later = `Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`;
  switch (bucketOf(err)) {
    case 'connect_pending_per_address':
      return `too many connections from this network are waiting for approval. Approve or deny the codes already shown (or let them expire), then run connect again. ${later}`;
    case 'connect_starts_per_hour':
      return `too many connections were started from this network in the last hour. ${later}`;
    case 'connect_pending_grants':
      return `buildIt.Social has too many connections waiting for approval right now. ${later}`;
    default:
      return `too many requests. ${later}`;
  }
}

function intervalOf(details: unknown): number | undefined {
  if (details === null || typeof details !== 'object') return undefined;
  const value = (details as Record<string, unknown>).interval;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 300
    ? value
    : undefined;
}

/** buildit-mcp disconnect: says the session is offline and forgets its token here. */
export async function runDisconnect(given: SessionCommandOptions, io: CommandIO): Promise<number> {
  const options = { ...given, apiUrl: await apiUrlOf(given, io.store) };
  const key = sessionKey(options.folder, options.apiUrl);
  const token = await io.store.get(key);
  if (token === undefined) {
    // A record of the deployment can outlive its token (an older version left it after a revoke).
    const stale = await forgetStaleApi(io.store, options.folder);
    io.out(
      stale
        ? 'No session is saved for this folder; removed the leftover record of its deployment.\n'
        : 'No session is saved for this folder.\n',
    );
    return 0;
  }
  // Best effort: the session ends in buildIt.Social too, before its token is forgotten here.
  const failed = await cancel(apiFor(options, io, token));
  await forgetSession(io.store, options.folder, options.apiUrl);
  io.out(
    failed === undefined
      ? 'Disconnected: the session is cancelled in buildIt.Social, and this folder no longer has a saved token.\n'
      : `Disconnected: this folder no longer has a saved token. The session could not be cancelled in buildIt.Social (${failed}): revoke it there (Settings → Agents).\n`,
  );
  return 0;
}

/**
 * Ends the session with DELETE /v1/session. Returns undefined when it is
 * over (a session already revoked or expired counts), else why it failed.
 */
async function cancel(api: ApiClient): Promise<string | undefined> {
  try {
    await revokeSession(api, { signal: AbortSignal.timeout(10_000) });
    return undefined;
  } catch (err) {
    if (err instanceof ApiError && SESSION_ENDED_CODES.has(err.code)) return undefined;
    return err instanceof ApiError ? err.code : 'unknown error';
  }
}

/** buildit-mcp status: the folder's saved session, as buildIt.Social sees it. */
export async function runStatus(given: SessionCommandOptions, io: CommandIO): Promise<number> {
  const options = { ...given, apiUrl: await apiUrlOf(given, io.store) };
  const key = sessionKey(options.folder, options.apiUrl);
  const token = await io.store.get(key);
  const duplicate = duplicateChannelWarning(options.folder, io.home);
  const header = [
    `Folder:   ${options.folder}`,
    `API:      ${options.apiUrl}`,
    ...(duplicate === undefined ? [] : [duplicate]),
  ];
  if (token === undefined) {
    io.out(
      [...header, 'Not connected. Run "buildit-mcp connect --project <KEY>" in this folder.'].join(
        '\n',
      ) + '\n',
    );
    return 1;
  }
  const stored = `Token:    in ${io.store.location}`;
  try {
    const info = await getSession(apiFor(options, io, token));
    io.out([...header, stored, ...sessionLines(info)].join('\n') + '\n');
    return 0;
  } catch (err) {
    const refused = isTokenRefused(err);
    io.out(
      [
        ...header,
        stored,
        refused
          ? `buildIt.Social no longer accepts this session: ${describeError(err)} Run "buildit-mcp disconnect", then connect again.`
          : `Could not check the session: ${describeError(err)}`,
      ].join('\n') + '\n',
    );
    return 1;
  }
}
