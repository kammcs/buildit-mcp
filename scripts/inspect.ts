/**
 * Smoke test with the official MCP Inspector CLI, against the in-process
 * fake API (never a real server).
 *
 *   npm run inspect
 *
 * It checks the built server three ways: over stdio, and over HTTP with a
 * 2025-11-25 client and a 2026-07-28 client. The Inspector's own files go to
 * a temporary folder, not the user's home.
 *
 *   npm run inspect:docker
 *
 * also runs the HTTP checks against the container image (built first),
 * waiting for its health check. The container reaches the fake API on the
 * host through a sidecar that shares its network and forwards its localhost
 * to host.docker.internal (Docker Desktop), so the API URL stays on localhost.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

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

/** The default toolsets' tools, which a full-access token sees. */
const EXPECTED_TOOLS = [
  'whoami',
  'list_projects',
  'describe_project',
  'find_users',
  'search_items',
  'get_item',
  'create_item',
  'update_item',
  'assign_item',
  'transition_item',
  'link_items',
  'unlink_items',
  'rank_item',
  'list_comments',
  'add_comment',
];

/** With BUILDIT_TOOLSETS=all, these join them. */
const MORE_TOOLS = [
  'list_sprints',
  'plan_sprint',
  'list_releases',
  'plan_release',
  'write_release_notes',
  'list_pages',
  'search_pages',
  'get_page',
  'create_page',
  'update_page',
  'list_channels',
  'read_channel',
  'read_thread',
  'create_channel',
  'create_project',
  'get_workflow',
  'list_work_types',
  'propose_workflow_change',
  'propose_work_type_change',
  'propose_field_change',
  'propose_label_change',
  'propose_delete_item',
  'propose_move_item',
  'propose_bulk_update',
  'propose_archive_status',
  'apply_plan',
];

const toolNames = (out: unknown): string[] =>
  ((out as { tools?: { name: string }[] } | undefined)?.tools ?? []).map((t) => t.name);

const structured = (out: unknown): Record<string, unknown> | undefined =>
  (out as { structuredContent?: Record<string, unknown> } | undefined)?.structuredContent;

/** The HTTP checks, against a server at this URL, in both protocol eras. */
async function httpChecks(where: string, url: string): Promise<void> {
  for (const era of ['legacy', 'modern']) {
    const httpArgs = [
      '--server-url',
      url,
      '--transport',
      'http',
      '--protocol-era',
      era,
      '--stored-auth-only',
      '--header',
      `Authorization: Bearer ${TOKENS.read}`,
    ];
    const list = await inspect(
      `${where} (${era}) tools/list`,
      [],
      [...httpArgs, '--method', 'tools/list'],
    );
    check(
      `${where} (${era}) lists the read tools only`,
      toolNames(list).includes('search_items') && !toolNames(list).includes('create_item'),
      list,
    );
    const call = await inspect(
      `${where} (${era}) tools/call whoami`,
      [],
      [...httpArgs, '--method', 'tools/call', '--tool-name', 'whoami'],
    );
    check(
      `${where} (${era}) whoami returns the scopes`,
      JSON.stringify(structured(call)?.scopes) === '["projects:read"]',
      call,
    );
  }
}

const exec = promisify(execFile);
const docker = async (...args: string[]): Promise<string> =>
  (await exec('docker', args, { timeout: 60_000 })).stdout.trim();

/** The HTTP checks against the image, run as a container, once it reports healthy. */
async function containerChecks(image: string, apiUrl: string): Promise<void> {
  const apiPort = new URL(apiUrl).port;
  const started: string[] = [];
  try {
    const server = await docker(
      'run',
      '-d',
      '--rm',
      '-p',
      '127.0.0.1::8765',
      '--health-interval',
      '1s',
      '-e',
      'BUILDIT_ALLOWED_HOSTS=localhost,127.0.0.1',
      '-e',
      `BUILDIT_API_URL=${apiUrl}`,
      image,
    );
    started.push(server);
    // A forwarder in the server's network: its localhost:<port> is the host's fake API.
    const forward = `const net = require('node:net'); net.createServer((c) => { const u = net.connect(${apiPort}, 'host.docker.internal'); c.pipe(u).pipe(c); u.on('error', () => c.destroy()); c.on('error', () => u.destroy()); }).listen(${apiPort}, '127.0.0.1');`;
    started.push(
      await docker(
        'run',
        '-d',
        '--rm',
        '--network',
        `container:${server}`,
        '--entrypoint',
        'node',
        image,
        '-e',
        forward,
      ),
    );
    let health = '';
    for (let n = 0; n < 30 && health !== 'healthy'; n++) {
      await new Promise((r) => setTimeout(r, 1000));
      health = await docker('inspect', '--format', '{{.State.Health.Status}}', server);
    }
    check('container reports healthy', health === 'healthy', health);
    const published = (await docker('port', server, '8765')).split('\n')[0] ?? '';
    const port = /:(\d+)$/.exec(published)?.[1];
    check('container publishes port 8765', port !== undefined, port);
    if (health === 'healthy' && port !== undefined) {
      await httpChecks('container', `http://127.0.0.1:${port}/mcp`);
    }
  } finally {
    for (const id of started.reverse()) await docker('rm', '-f', id).catch(() => undefined);
  }
}

const imageAt = process.argv.indexOf('--image');
const image = imageAt === -1 ? undefined : process.argv[imageAt + 1];

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
  check(
    'stdio lists the item and comment tools, and no more by default',
    EXPECTED_TOOLS.every((name) => toolNames(listed).includes(name)) &&
      toolNames(listed).length === EXPECTED_TOOLS.length,
    listed,
  );
  const allEnv = [...stdioEnv, '-e', 'BUILDIT_TOOLSETS=all'];
  const everything = await inspect('stdio tools/list (all toolsets)', stdioTarget, [
    ...allEnv,
    '--method',
    'tools/list',
  ]);
  check(
    'stdio lists every toolset with BUILDIT_TOOLSETS=all',
    [...EXPECTED_TOOLS, ...MORE_TOOLS].every((name) => toolNames(everything).includes(name)) &&
      toolNames(everything).length === EXPECTED_TOOLS.length + MORE_TOOLS.length,
    toolNames(everything),
  );
  const templates = await inspect('stdio resources/templates/list', stdioTarget, [
    ...allEnv,
    '--method',
    'resources/templates/list',
  ]);
  check(
    'stdio lists the item and page resource templates',
    JSON.stringify(
      (
        templates as { resourceTemplates?: { uriTemplate: string }[] } | undefined
      )?.resourceTemplates?.map((t) => t.uriTemplate),
    ) === JSON.stringify(['buildit://items/{key}', 'buildit://pages/{id}']),
    templates,
  );
  const prompts = await inspect('stdio prompts/list', stdioTarget, [
    ...allEnv,
    '--method',
    'prompts/list',
  ]);
  check(
    'stdio lists the prompts',
    JSON.stringify(
      (prompts as { prompts?: { name: string }[] } | undefined)?.prompts?.map((p) => p.name),
    ) === JSON.stringify(['plan_epic', 'triage', 'standup']),
    prompts,
  );
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
  const item = await inspect('stdio tools/call get_item', stdioTarget, [
    ...stdioEnv,
    '--method',
    'tools/call',
    '--tool-name',
    'get_item',
    '--tool-arg',
    'item=DEMO-42',
  ]);
  check(
    'stdio get_item returns the item',
    (structured(item)?.item as { key?: string } | undefined)?.key === 'DEMO-42',
    item,
  );

  // HTTP, both protocol eras.
  const action = parseCli(['--http', '--port', '0', '--api-url', api.url], {});
  if (action.kind !== 'run') throw new Error('unexpected config');
  const server = await startHttp(action.config, createLogger({ sink: () => undefined }));
  try {
    await httpChecks('http', server.url);
  } finally {
    await server.close();
  }

  if (image !== undefined) await containerChecks(image, api.url);
} finally {
  await api.close();
  rmSync(home, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log('Inspector smoke test passed.');
