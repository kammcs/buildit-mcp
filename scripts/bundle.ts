/**
 * Builds the Claude Desktop bundle, buildit-mcp-<version>.mcpb, from dist/:
 *
 *   npm run bundle
 *
 * The bundle holds what the npm package ships (dist/ and the documents),
 * bundle/manifest.json with the package's version, and the production
 * dependencies at the locked versions. The privacy guard runs over its
 * files (not node_modules), and the official mcpb CLI, at a pinned version
 * and fetched with npx (so its own dependencies stay out of this
 * repository's lockfile), validates the manifest and packs it. The token is
 * a sensitive user setting: Claude Desktop keeps it in the system's secure
 * storage, never in a config file. Last, the bundle is unpacked and run as
 * Claude Desktop would, against the in-process fake API (never a real
 * server). The .mcpb file is gitignored; it is attached to the GitHub
 * release.
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { FakeApi, TOKENS } from '../test/support/fake-api.js';
import { scanText, type Finding } from './privacy.js';

const MCPB = '@anthropic-ai/mcpb@2.1.2';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  version: string;
  files: string[];
};

if (!existsSync(join(root, 'dist', 'index.js'))) {
  throw new Error('dist/index.js is missing: run `npm run build` first.');
}

/** npm or npx through this Node when run by npm, else through a shell on Windows (npm.cmd). */
function npm(tool: 'npm' | 'npx', args: string[], cwd: string): string {
  const cli = process.env.npm_execpath;
  if (cli && /npm-cli\.c?js$/.test(cli)) {
    const script = tool === 'npm' ? cli : cli.replace(/npm-cli(\.c?js)$/, 'npx-cli$1');
    return execFileSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
  }
  const shell = process.platform === 'win32';
  return execFileSync(tool, shell ? args.map((a) => `"${a}"`) : args, {
    cwd,
    encoding: 'utf8',
    shell,
  });
}

function filesUnder(dir: string, skip: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (relative(dir, full) === skip) continue;
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

const stage = mkdtempSync(join(tmpdir(), 'buildit-mcp-bundle-'));
try {
  for (const entry of [...pkg.files, 'package.json', 'package-lock.json', '.npmrc']) {
    cpSync(join(root, entry), join(stage, entry), { recursive: true });
  }
  const manifest = JSON.parse(readFileSync(join(root, 'bundle', 'manifest.json'), 'utf8')) as {
    version: string;
  };
  manifest.version = pkg.version;
  writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  npm('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stage);
  rmSync(join(stage, 'package-lock.json'));
  rmSync(join(stage, '.npmrc'));

  // The privacy guard over every file of ours in the bundle.
  const ours = filesUnder(stage, 'node_modules');
  const findings: Finding[] = [];
  for (const file of ours) {
    const data = readFileSync(join(stage, file));
    if (!data.includes(0)) findings.push(...scanText(file, data.toString('utf8')));
  }
  if (findings.length > 0) {
    for (const f of findings) console.error(`${f.file}:${f.line}: ${f.rule}: ${f.match}`);
    throw new Error(`privacy guard: ${findings.length} finding(s) in the bundle`);
  }

  const out = join(root, `buildit-mcp-${pkg.version}.mcpb`);
  npm('npx', ['--yes', MCPB, 'validate', join(stage, 'manifest.json')], root);
  npm('npx', ['--yes', MCPB, 'pack', stage, out], root);
  await smokeTest(out);
  console.log(`Wrote ${relative(root, out)} (${ours.length} files of ours, privacy guard clean).`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}

/**
 * Unpacks the bundle and starts it as Claude Desktop would, from its
 * manifest (the user settings at their defaults, a test token, the fake
 * API's URL), then calls whoami over stdio.
 */
async function smokeTest(file: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'buildit-mcp-unpacked-'));
  const api = await new FakeApi().start();
  try {
    npm('npx', ['--yes', MCPB, 'unpack', file, dir], root);
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
      server: { mcp_config: { command: string; args: string[]; env: Record<string, string> } };
      user_config: Record<string, { default?: string | number | boolean }>;
    };
    const settings: Record<string, string> = { token: TOKENS.full, api_url: api.url };
    const fill = (v: string): string =>
      v
        .replaceAll('${__dirname}', dir)
        .replace(/\$\{user_config\.(\w+)\}/g, (_, k: string) =>
          String(settings[k] ?? m.user_config[k]?.default ?? ''),
        );
    const { command, args, env } = m.server.mcp_config;
    const transport = new StdioClientTransport({
      command: command === 'node' ? process.execPath : command,
      args: args.map(fill),
      env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, fill(v)])),
      stderr: 'ignore',
    });
    const client = new Client({ name: 'bundle-smoke-test', version: '1.0.0' });
    await client.connect(transport);
    try {
      const r = await client.callTool({ name: 'whoami', arguments: {} });
      const org = (r.structuredContent as { org?: { name?: string } } | undefined)?.org?.name;
      if (r.isError === true || org !== 'Example Org') {
        throw new Error(`the unpacked bundle's whoami failed: ${JSON.stringify(r.content)}`);
      }
    } finally {
      await client.close();
    }
  } finally {
    await api.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
