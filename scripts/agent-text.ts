/**
 * Writes the Claude Code plugin's worker agents (plugin/agents/*.md) from
 * their one source, src/agent-text.ts, which the Codex bridge's threads
 * read too. Each file keeps its own frontmatter; the body after it is the
 * Claude text. test/agent-text.test.ts fails when a file drifts.
 *
 *   npx tsx scripts/agent-text.ts           check (exit 1 when a file differs)
 *   npx tsx scripts/agent-text.ts --write   write them
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { itemWorkerText, requestWorkerText, type AgentClient } from '../src/agent-text.js';

/** Each plugin agent file and its text. */
export const AGENT_FILES: Readonly<Record<string, (client: AgentClient) => string>> = {
  'plugin/agents/buildit-item-worker.md': itemWorkerText,
  'plugin/agents/buildit-request-worker.md': requestWorkerText,
};

const root = fileURLToPath(new URL('..', import.meta.url));

/** The file as it should be: its frontmatter as it is, then a blank line and the Claude text. */
export function expectedAgentFile(current: string, body: string): string {
  const text = current.replace(/\r\n/g, '\n');
  const end = text.indexOf('\n---\n', 4);
  if (!text.startsWith('---\n') || end < 0) throw new Error('no frontmatter');
  return `${text.slice(0, end + 5)}\n${body}`;
}

/** The files that differ from their source (relative paths). */
export function staleAgentFiles(write = false): string[] {
  const stale: string[] = [];
  for (const [file, text] of Object.entries(AGENT_FILES)) {
    const path = `${root}${file}`;
    const current = readFileSync(path, 'utf8');
    const want = expectedAgentFile(current, text('claude'));
    if (current === want) continue;
    stale.push(file);
    if (write) writeFileSync(path, want);
  }
  return stale;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const write = process.argv.includes('--write');
  const stale = staleAgentFiles(write);
  for (const f of stale) console.log(`${write ? 'wrote' : 'differs'}: ${f}`);
  if (stale.length === 0) console.log('The plugin agents match src/agent-text.ts.');
  else if (!write) process.exitCode = 1;
}
