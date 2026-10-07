/**
 * Smoke test of the built command (dist/index.js) over stdio, as an MCP
 * client would run it. Needs `npm run build` first (`npm run check` does it).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { FakeApi, TOKENS } from './support/fake-api.js';

const BIN = fileURLToPath(new URL('../dist/index.js', import.meta.url));

let api: FakeApi;
const clients: Client[] = [];

beforeAll(async () => {
  if (!existsSync(BIN)) throw new Error('dist/index.js is missing: run `npm run build` first.');
  api = await new FakeApi().start();
});
afterAll(async () => {
  await api.close();
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

function baseEnv(token: string): Record<string, string> {
  return {
    BUILDIT_API_URL: api.url,
    BUILDIT_TOKEN: token,
    PATH: process.env.PATH ?? '',
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
}

async function connect(
  token: string,
  options: { auto?: boolean; env?: Record<string, string> } = {},
): Promise<{ client: Client; stderr: () => string }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN],
    env: { ...baseEnv(token), ...options.env },
    stderr: 'pipe',
  });
  let errText = '';
  const stream = transport.stderr as PassThrough | null;
  stream?.setEncoding('utf8');
  stream?.on('data', (chunk: string) => (errText += chunk));
  const client = new Client(
    { name: 'stdio-test', version: '1.0.0' },
    options.auto ? { versionNegotiation: { mode: 'auto' } } : {},
  );
  await client.connect(transport);
  clients.push(client);
  return { client, stderr: () => errText };
}

describe('stdio (built binary)', () => {
  it('lists the tools and answers whoami (2025-11-25 client)', async () => {
    const { client, stderr } = await connect(TOKENS.read);
    expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
    expect(client.getServerVersion()?.name).toBe('buildit-mcp');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['whoami']);
    const result = await client.callTool({ name: 'whoami', arguments: {} });
    expect(result.structuredContent).toMatchObject({ org: { name: 'Example Org' } });

    // Logs are JSON lines on stderr, and never contain the token.
    await new Promise((r) => setTimeout(r, 100));
    const lines = stderr().trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(() => JSON.parse(line) as unknown).not.toThrow();
    expect(stderr()).toContain('"msg":"tool call"');
    expect(stderr()).not.toContain(TOKENS.read);
  });

  it('negotiates 2026-07-28 with a modern client', async () => {
    const { client } = await connect(TOKENS.full, { auto: true });
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['whoami']);
  });

  it('hides tools excluded by configuration', async () => {
    const { client } = await connect(TOKENS.full, { env: { BUILDIT_EXCLUDE_TOOLS: 'whoami' } });
    expect((await client.listTools()).tools).toEqual([]);
  });

  it('exits with a clear message when the token is missing', () => {
    const run = spawnSync(process.execPath, [BIN], {
      env: { PATH: process.env.PATH ?? '', BUILDIT_API_URL: api.url },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(run.status).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('BUILDIT_TOKEN is not set');
  });

  it('prints its version and help on stdout', () => {
    const version = spawnSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' });
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const help = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
    expect(help.stdout).toContain('Usage: buildit-mcp');
  });
});
