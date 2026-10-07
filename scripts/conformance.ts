/**
 * Runs the official MCP conformance suite against the HTTP mode, offline:
 * the server talks to the in-process fake API, and a small local proxy adds
 * the bearer token (the suite sends none, and this server requires one).
 *
 *   npm run conformance
 *
 * Most scenarios a spec revision requires exercise the suite's own fixture
 * tools, prompts and resources (test_simple_text, test_image_content, ...),
 * which a real server doesn't have. This script runs the scenarios about the
 * protocol itself, for both revisions the server speaks, and judges each
 * check from the suite's checks.json: it fails on any failed check except
 * the few listed in NOT_APPLICABLE, each with its reason.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCli } from '../src/config.js';
import { createLogger } from '../src/log.js';
import { startHttp } from '../src/transports/http.js';
import { FakeApi, TOKENS } from '../test/support/fake-api.js';

/** The scenarios about the protocol itself, per spec revision. */
const SCENARIOS: Record<string, string[]> = {
  '2026-07-28': ['server-stateless', 'tools-list', 'caching', 'dns-rebinding-protection'],
  '2025-11-25': ['server-initialize', 'ping', 'tools-list', 'dns-rebinding-protection'],
};

/** Checks that can't pass on a real server, and why. */
const NOT_APPLICABLE: Record<string, string> = {
  'sep-2575-server-rejects-undeclared-capability':
    "needs the suite's diagnostic tool test_missing_capability",
  'sep-2575-missing-capability-http-400':
    "needs the suite's diagnostic tool test_missing_capability",
  'sep-2575-http-server-no-independent-requests-on-stream':
    "needs the suite's diagnostic tool test_streaming_elicitation",
  'sep-2575-server-no-log-without-loglevel': "needs the suite's diagnostic tool test_logging_tool",
  'sep-2549-prompts-list-caching-hints': 'this server offers no prompts (not declared)',
  'sep-2549-resources-list-caching-hints': 'this server offers no resources (not declared)',
  'sep-2549-resources-templates-list-caching-hints':
    'this server offers no resources (not declared)',
};

interface Check {
  id: string;
  status: string;
  description?: string;
  errorMessage?: string;
}

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'node_modules', '@modelcontextprotocol', 'conformance', 'dist', 'index.js');

function run(args: string[]): Promise<void> {
  return new Promise((resolve) => {
    // The suite's own exit code counts the not-applicable checks; the checks.json files decide.
    const child = spawn(process.execPath, [cli, ...args], { stdio: 'ignore' });
    child.on('close', () => {
      resolve();
    });
  });
}

const api = await new FakeApi().start();
const action = parseCli(['--http', '--port', '0', '--api-url', api.url], {});
if (action.kind !== 'run') throw new Error('unexpected config');
const server = await startHttp(action.config, createLogger({ sink: () => undefined }));
const target = new URL(server.url);

// Forwards everything to the server, adding the token. Host and Origin pass
// through unchanged, so the server's DNS-rebinding checks see what the suite sent.
const proxy = createServer((req, res) => {
  const upstream = httpRequest(
    {
      host: target.hostname,
      port: target.port,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, authorization: `Bearer ${TOKENS.full}` },
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    res.writeHead(502).end();
  });
  req.pipe(upstream);
});
await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
const proxyUrl = `http://127.0.0.1:${String((proxy.address() as AddressInfo).port)}/mcp`;

const out = mkdtempSync(join(tmpdir(), 'buildit-mcp-conformance-'));
let unexpected = 0;
let passed = 0;
let skipped = 0;
try {
  for (const [revision, scenarios] of Object.entries(SCENARIOS)) {
    for (const scenario of scenarios) {
      const dir = join(out, `${revision}-${scenario}`);
      await run([
        'server',
        '--url',
        proxyUrl,
        '--scenario',
        scenario,
        '--spec-version',
        revision,
        '-o',
        dir,
      ]);
      const results = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) =>
        f.endsWith('checks.json'),
      );
      if (results.length === 0) {
        console.error(`FAIL ${revision} ${scenario}: the suite wrote no results`);
        unexpected++;
        continue;
      }
      for (const file of results) {
        const checks = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Check[];
        for (const check of checks) {
          const label = `${revision} ${scenario} ${check.id}`;
          if (check.status === 'FAILURE') {
            const reason = NOT_APPLICABLE[check.id];
            if (reason) {
              console.log(`n/a  ${label} (${reason})`);
              skipped++;
            } else {
              console.error(`FAIL ${label}: ${check.errorMessage ?? check.description ?? ''}`);
              unexpected++;
            }
          } else if (check.status === 'SUCCESS') {
            console.log(`ok   ${label}`);
            passed++;
          }
        }
      }
    }
  }
} finally {
  proxy.closeAllConnections();
  proxy.close();
  await server.close();
  await api.close();
  rmSync(out, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${skipped} not applicable, ${unexpected} failed.`);
if (unexpected > 0) process.exit(1);
