#!/usr/bin/env node
// The buildit plugin's hooks: hands one hook's input to this folder's buildit
// server, over the local endpoint it opened, and prints the hook's answer for
// the hooks that decide something (approve, ask).
//
//   node forward.mjs <hook>      (the hook's JSON on stdin, as Claude Code sends it)
//
// When no buildit server listens for the folder (the server is off for the
// project, not connected, or not running), it exits at once with nothing
// printed, so Claude Code goes on as without the plugin. It always exits 0,
// prints only a hook answer on stdout, and never prints to stderr.
//
// No dependencies: it runs from the plugin's folder, before any npm install.
// The paths and the folder key must match src/channel/hook-bridge.ts (a test
// checks).
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOOKS = new Set([
  'approve',
  'ask',
  'tool_seen',
  'tool_done',
  'agent_done',
  'prompt_typed',
  'turn_ended',
]);
/** The hooks whose answer is printed (the others' is always "nothing to do"). */
const DECIDING = new Set(['approve', 'ask']);
/** How long connecting may take before giving up silently. */
export const CONNECT_TIMEOUT_MS = 400;
/** How long a hook that decides nothing waits for the server's acknowledgement. */
export const ACK_TIMEOUT_MS = 5_000;
/** The largest hook input read (an approval's tool input may be large). */
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
/** The largest answer read. */
const MAX_ANSWER_BYTES = 1024 * 1024;

/** The folder of the rendezvous files (hookDir in hook-bridge.ts). */
export function hookDir(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    const base = env.APPDATA ?? win32.join(homedir(), 'AppData', 'Roaming');
    return win32.join(base, 'buildit-mcp', 'hooks');
  }
  if (platform === 'darwin') {
    return posix.join(homedir(), 'Library', 'Application Support', 'buildit-mcp', 'hooks');
  }
  const base = env.XDG_CONFIG_HOME ?? posix.join(homedir(), '.config');
  return posix.join(base, 'buildit-mcp', 'hooks');
}

/** A folder's key (folderKey in hook-bridge.ts). */
export function folderKey(folder, platform = process.platform) {
  const lib = platform === 'win32' ? win32 : posix;
  let normalized = lib.resolve(folder);
  if (platform === 'win32' || platform === 'darwin') normalized = normalized.toLowerCase();
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 32);
}

const str = (v) => (typeof v === 'string' ? v : undefined);

/**
 * The hook tool's arguments from Claude Code's hook input: the same fields
 * the plugin's MCP hooks passed (`${tool_name}` and so on). A prompt is cut
 * to its start: only whether the person typed it matters.
 */
export function hookArgs(hook, input) {
  const i = input !== null && typeof input === 'object' ? input : {};
  const pick = (entries) => {
    const out = {};
    for (const [key, value] of entries) if (value !== undefined) out[key] = value;
    return out;
  };
  switch (hook) {
    case 'approve':
      return pick([
        ['tool_name', str(i.tool_name) ?? ''],
        ['tool_input', i.tool_input ?? {}],
        ['tool_use_id', str(i.tool_use_id)],
        ['agent_id', str(i.agent_id)],
        ['agent_type', str(i.agent_type)],
        ['session_id', str(i.session_id)],
        ['prompt_id', str(i.prompt_id)],
        ['suggestions', i.permission_suggestions],
        ['mode', str(i.permission_mode)],
      ]);
    case 'ask': {
      const toolInput =
        i.tool_input !== null && typeof i.tool_input === 'object' ? i.tool_input : {};
      return pick([
        ['questions', toolInput.questions],
        ['tool_use_id', str(i.tool_use_id)],
        ['session_id', str(i.session_id)],
        ['format', 'hook'],
        ['agent_id', str(i.agent_id)],
        ['agent_type', str(i.agent_type)],
      ]);
    }
    case 'tool_seen':
      return pick([
        ['tool_name', str(i.tool_name)],
        ['tool_input', i.tool_input],
        ['tool_use_id', str(i.tool_use_id)],
        ['agent_id', str(i.agent_id)],
      ]);
    case 'tool_done':
      return pick([
        ['tool_use_id', str(i.tool_use_id)],
        ['agent_id', str(i.agent_id)],
      ]);
    case 'agent_done':
      return pick([
        ['agent_id', str(i.agent_id)],
        ['agent_type', str(i.agent_type)],
      ]);
    case 'prompt_typed': {
      const prompt = str(i.prompt);
      return pick([['prompt', prompt === undefined ? undefined : prompt.trimStart().slice(0, 64)]]);
    }
    default:
      return {};
  }
}

/** This hook's Claude Code: CLAUDE_PID, and the parent (Claude Code spawns hooks directly). */
export function claudePids(env = process.env, ppid = process.ppid) {
  const pids = [];
  const fromEnv = Number(env.CLAUDE_PID);
  if (Number.isInteger(fromEnv) && fromEnv > 1) pids.push(fromEnv);
  if (Number.isInteger(ppid) && ppid > 1 && !pids.includes(ppid)) pids.push(ppid);
  return pids;
}

/** The hash of Claude Code's messaging socket's name (socketTag in hook-bridge.ts). */
export function socketTag(socket) {
  const s = typeof socket === 'string' ? socket.trim() : '';
  if (s === '') return undefined;
  return createHash('sha256').update(`buildit-mcp:${s}`, 'utf8').digest('hex');
}

/** The endpoint the folder's server named; undefined when there is none to trust. */
export function findEndpoint(folder, dir, platform = process.platform) {
  const lib = platform === 'win32' ? win32 : posix;
  if (platform !== 'win32') {
    // The user's own private folder only.
    try {
      const st = lstatSync(dir);
      if (!st.isDirectory() || (st.mode & 0o022) !== 0) return undefined;
      if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return undefined;
    } catch {
      return undefined;
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(lib.join(dir, `${folderKey(folder, platform)}.json`), 'utf8'));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.v !== 1) return undefined;
  const endpoint = parsed.endpoint;
  if (typeof endpoint !== 'string' || endpoint.length > 300) return undefined;
  if (platform === 'win32') {
    return /^\\\\\.\\pipe\\buildit-mcp-hooks-[0-9a-f]{32}$/.test(endpoint) ? endpoint : undefined;
  }
  return /^\/.*\/[0-9a-f]{16}\.sock$/.test(endpoint) ? endpoint : undefined;
}

/**
 * Sends one message and resolves to the server's answer text (undefined for
 * none): never rejects, never waits past the caps.
 */
export function send(endpoint, message, options = {}) {
  const connectMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const ackMs = options.ackTimeoutMs;
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const socket = connect(endpoint);
    socket.on('error', () => finish(undefined));
    timer = setTimeout(() => finish(undefined), connectMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      if (ackMs !== undefined) timer = setTimeout(() => finish(undefined), ackMs);
      // Kept open while it waits: its end tells the server Claude Code cancelled the hook.
      socket.write(`${JSON.stringify(message)}\n`);
    });
    const chunks = [];
    let size = 0;
    socket.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_ANSWER_BYTES) return finish(undefined);
      chunks.push(chunk);
    });
    socket.on('close', () => {
      try {
        const answer = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        finish(
          answer !== null && answer.ok === true && typeof answer.text === 'string'
            ? answer.text
            : undefined,
        );
      } catch {
        finish(undefined);
      }
    });
  });
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    process.stdin.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_INPUT_BYTES) resolve(undefined);
      else chunks.push(chunk);
    });
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(undefined));
  });
}

/** One hook run: the answer to print, or undefined. */
export async function forward(hook, raw, env = process.env, options = {}) {
  if (!HOOKS.has(hook) || raw === undefined) return undefined;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const folder = str(env.CLAUDE_PROJECT_DIR)?.trim() || str(input?.cwd);
  if (!folder) return undefined;
  const platform = options.platform ?? process.platform;
  const endpoint = findEndpoint(folder, options.dir ?? hookDir(env, platform), platform);
  if (endpoint === undefined) return undefined;
  const tag = socketTag(env.CLAUDE_CODE_MESSAGING_SOCKET);
  const sessionId = str(input?.session_id);
  const message = {
    v: 1,
    hook,
    pids: claudePids(env, options.ppid),
    ...(tag === undefined ? {} : { tag }),
    ...(sessionId === undefined || sessionId.length > 200 ? {} : { session_id: sessionId }),
    args: hookArgs(hook, input),
  };
  const text = await send(endpoint, message, {
    ...(DECIDING.has(hook) ? {} : { ackTimeoutMs: ACK_TIMEOUT_MS }),
    ...(options.connectTimeoutMs === undefined
      ? {}
      : { connectTimeoutMs: options.connectTimeoutMs }),
  });
  return DECIDING.has(hook) && text !== undefined && text !== '' ? text : undefined;
}

async function main() {
  const quit = () => process.exit(0);
  process.on('uncaughtException', quit);
  process.on('unhandledRejection', quit);
  let out;
  try {
    out = await forward(process.argv[2] ?? '', await readStdin());
  } catch {
    out = undefined;
  }
  if (out === undefined) return quit();
  process.stdout.write(out, quit);
}

/** Whether this file is the program run (not imported, as the tests do). */
function isMain() {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  try {
    return norm(realpathSync(argv1)) === norm(realpathSync(fileURLToPath(import.meta.url)));
  } catch {
    return false;
  }
}

if (isMain()) void main();
