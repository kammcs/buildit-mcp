/**
 * Where the plugin's AskUserQuestion hook posts a question.
 *
 * The hook can't name a thread, but Claude Code tells it who is asking:
 * its input carries `agent_id` and `agent_type` when the tool call comes
 * from a subagent (both empty for the main agent; checked with Claude Code
 * 2.1.312, where `agent_type` is the plugin-scoped name, such as
 * `buildit:buildit-item-worker`, and `agent_id` the id the Agent tool gave
 * the lead). So:
 *
 * - the main agent (the lead) asks in the direct message: its latest
 *   thread there, else a new message;
 * - an item worker asks in its item's thread, found in the lead's table of
 *   workers (`.claude/buildit-workers.json` in the folder, which the lead
 *   keeps: `{"workers": [{"agent_id", "item", "thread_id"}]}`);
 * - anything else (another subagent, a worker the table doesn't name) is
 *   not placed, and the hook lets the terminal ask.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The lead's table of item workers, relative to the folder. */
export const WORKERS_FILE = join('.claude', 'buildit-workers.json');

/** The item worker's agent name (the plugin's agents/buildit-item-worker.md). */
export const ITEM_WORKER_NAME = 'buildit-item-worker';

/** The largest table read. */
const WORKERS_FILE_MAX_BYTES = 256 * 1024;

/** Whether the hook's agent_type is the plugin's item worker (scoped or not). */
export function isItemWorker(agentType: string): boolean {
  return agentType === ITEM_WORKER_NAME || agentType.endsWith(`:${ITEM_WORKER_NAME}`);
}

/** A worker's entry in the lead's table: its item's thread id and key, as recorded. */
export interface WorkerEntry {
  thread_id: string | undefined;
  item: string | undefined;
}

/** The lead's entry for the worker with this agent id, if the table names it. */
export function workerEntry(folder: string, agentId: string): WorkerEntry | undefined {
  const path = join(folder, WORKERS_FILE);
  let parsed: unknown;
  try {
    if (statSync(path).size > WORKERS_FILE_MAX_BYTES) return undefined;
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === 'object'
      ? (parsed as { workers?: unknown }).workers
      : undefined;
  if (!Array.isArray(list)) return undefined;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() !== '' && v.length <= 200 ? v.trim() : undefined;
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (str(e.agent_id) !== agentId) continue;
    const found = { thread_id: str(e.thread_id), item: str(e.item) };
    if (found.thread_id !== undefined || found.item !== undefined) return found;
  }
  return undefined;
}
