/**
 * Smoke test with the official MCP Inspector CLI, against the in-process
 * fake API (never a real server).
 *
 *   npm run inspect
 *
 * It checks the built server three ways: over stdio, and over HTTP with a
 * 2025-11-25 client and a 2026-07-28 client. The Inspector's own files go to
 * a temporary folder, not the user's home.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCli } from '../src/config.js';
import { createLogger } from '../src/log.js';
import { startHttp } from '../src/transports/http.js';
import { FakeApi, TOKENS } from '../test/support/fake-api.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const bin = join(root, 'dist', 'index.js');
const inspector = join(
  root,
  'node_modules',
  '@modelcontextprotocol',
  'inspector',
  'clients',
  'launcher',
  'build',
  'index.js',
);

if (!existsSync(bin)) throw new Error('dist/index.js is missing: run `npm run build` first.');

const home = mkdtempSync(join(tmpdir(), 'buildit-mcp-inspect-'));
const inspectorEnv: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  MCP_STORAGE_DIR: join(home, 'storage'),
  MCP_CATALOG_PATH: join(home, 'mcp.json'),
  MCP_CLIENT_CONFIG_PATH: join(home, 'client.json'),
  MCP_INSPECTOR_OAUTH_STATE_PATH: join(home, 'oauth.json'),
  NO_COLOR: '1',
};
delete inspectorEnv.BUILDIT_TOKEN;

let failures = 0;

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs the Inspector CLI: the server command (if any) first, then the
 * Inspector's options. Asynchronous, so the in-process servers keep answering.
 */
async function inspect(label: string, target: string[], args: string[]): Promise<unknown> {
  const run = await new Promise<Run>((resolve) => {
    const child = spawn(
      process.execPath,
      [inspector, '--cli', ...target, '--format', 'json', ...args],
      { env: inspectorEnv, timeout: 60_000 },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
  if (run.status !== 0) {
    console.error(`FAIL ${label}: exit ${String(run.status)}\n${run.stderr}\n${run.stdout}`);
    failures++;
    return undefined;
  }
  try {
    return (JSON.parse(run.stdout) as { result?: unknown }).result;
  } catch {
    console.error(`FAIL ${label}: output is not JSON\n${run.stdout}`);
    failures++;
    return undefined;
  }
}

function check(label: string, ok: boolean, detail: unknown): void {
  if (ok) {
    console.log(`ok   ${label}`);
  } else {
    console.error(`FAIL ${label}: ${JSON.stringify(detail)}`);
    failures++;
  }
}

const toolNames = (out: unknown): string[] =>
  ((out as { tools?: { name: string }[] } | undefined)?.tools ?? []).map((t) => t.name);

const structured = (out: unknown): Record<string, unknown> | undefined =>
  (out as { structuredContent?: Record<string, unknown> } | undefined)?.structuredContent;

const api = await new FakeApi().start();
try {
  // stdio: the built command, as a client would start it.
  const stdioTarget = [process.execPath, bin];
  const stdioEnv = ['-e', `BUILDIT_API_URL=${api.url}`, '-e', `BUILDIT_TOKEN=${TOKENS.full}`];
  const listed = await inspect('stdio tools/list', stdioTarget, [
    ...stdioEnv,
    '--method',
    'tools/list',
  ]);
  check('stdio lists whoami', toolNames(listed).includes('whoami'), listed);
  const called = await inspect('stdio tools/call whoami', stdioTarget, [
    ...stdioEnv,
    '--method',
    'tools/call',
    '--tool-name',
    'whoami',
  ]);
  check(
    'stdio whoami returns the org',
    (structured(called)?.org as { name?: string } | undefined)?.name === 'Example Org',
    called,
  );

  // HTTP, both protocol eras.
  const action = parseCli(['--http', '--port', '0', '--api-url', api.url], {});
  if (action.kind !== 'run') throw new Error('unexpected config');
  const server = await startHttp(action.config, createLogger({ sink: () => undefined }));
  try {
    for (const era of ['legacy', 'modern']) {
      const httpArgs = [
        '--server-url',
        server.url,
        '--transport',
        'http',
        '--protocol-era',
        era,
        '--stored-auth-only',
        '--header',
        `Authorization: Bearer ${TOKENS.read}`,
      ];
      const list = await inspect(
        `http (${era}) tools/list`,
        [],
        [...httpArgs, '--method', 'tools/list'],
      );
      check(`http (${era}) lists whoami`, toolNames(list).includes('whoami'), list);
      const call = await inspect(
        `http (${era}) tools/call whoami`,
        [],
        [...httpArgs, '--method', 'tools/call', '--tool-name', 'whoami'],
      );
      check(
        `http (${era}) whoami returns the scopes`,
        JSON.stringify(structured(call)?.scopes) === '["projects:read"]',
        call,
      );
    }
  } finally {
    await server.close();
  }
} finally {
  await api.close();
  rmSync(home, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log('Inspector smoke test passed.');
