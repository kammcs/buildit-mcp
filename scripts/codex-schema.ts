/**
 * Checks the installed Codex's app-server protocol against what the bridge
 * uses. It runs only `codex --version` and `codex app-server
 * generate-json-schema --experimental` (no model turn, no sign-in needed).
 *
 *   npm run codex:schema                  regenerate, check and diff against the vendored subset
 *   npm run codex:schema -- --write       the same, then write the new subset
 *                                         (test/fixtures/codex/app-server-protocol.json)
 *   npm run codex:schema -- --from <dir>  use a schema folder generated before
 *                                         (with --version <v>), instead of running Codex
 *   --codex-path <path>                   the codex program (default: found on the PATH)
 *
 * It fails (exit 1) when a method or field the bridge relies on is gone,
 * or a request the bridge sends gained a required field; other changes in
 * the types it uses are listed for review. After taking a new Codex line:
 * --write, run the tests, update the tested-range table in the README and
 * TESTED_CODEX_LINES in src/codex/version.ts.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { format, resolveConfig } from 'prettier';

import { findCodex } from '../src/codex/binary.js';
import { BRIDGE_SURFACE } from '../src/codex/surface.js';
import {
  diffSubsets,
  extractSubset,
  surfaceProblems,
  type JsonObject,
  type VendoredProtocol,
} from './codex-protocol.js';

const root = fileURLToPath(new URL('..', import.meta.url));
export const VENDORED_PATH = join(root, 'test', 'fixtures', 'codex', 'app-server-protocol.json');
const BUNDLE = 'codex_app_server_protocol.schemas.json';

const { values } = parseArgs({
  options: {
    write: { type: 'boolean' },
    from: { type: 'string' },
    version: { type: 'string' },
    'codex-path': { type: 'string' },
  },
});

let dir: string;
let version: string;
let temp: string | undefined;
if (values.from !== undefined) {
  dir = values.from;
  version = values.version ?? 'unknown';
} else {
  const binary = findCodex(values['codex-path'] ?? process.env.BUILDIT_CODEX_PATH);
  const env = { ...process.env, ...binary.env };
  const said = execFileSync(binary.path, ['--version'], { encoding: 'utf8', env }).trim();
  version = /(\d+\.\d+\.\d+\S*)/.exec(said)?.[1] ?? 'unknown';
  temp = mkdtempSync(join(tmpdir(), 'codex-schema-'));
  dir = temp;
  execFileSync(
    binary.path,
    ['app-server', 'generate-json-schema', '--experimental', '--out', dir],
    { stdio: ['ignore', 'ignore', 'inherit'], env },
  );
}

try {
  const doc = JSON.parse(readFileSync(join(dir, BUNDLE), 'utf8')) as { definitions: JsonObject };
  const { subset, missing } = extractSubset(doc, BRIDGE_SURFACE, version);
  const problems = [...missing, ...surfaceProblems(doc, subset['x-methods'], BRIDGE_SURFACE)];
  let vendored: VendoredProtocol | undefined;
  try {
    vendored = JSON.parse(readFileSync(VENDORED_PATH, 'utf8')) as VendoredProtocol;
  } catch {
    vendored = undefined;
  }
  console.log(
    `Codex ${version}: ${Object.keys(subset['x-methods'].clientRequests).length} requests, ${Object.keys(subset['x-methods'].serverNotifications).length} notifications and ${Object.keys(subset['x-methods'].serverRequests).length} server requests used by the bridge.`,
  );
  if (vendored !== undefined) {
    console.log(`Compared with the vendored subset of Codex ${vendored['x-codex'].version}:`);
    const { breaking, changes } = diffSubsets(vendored, subset);
    for (const b of breaking) console.log(`  BREAKING ${b}`);
    for (const c of changes) console.log(`  changed  ${c}`);
    if (breaking.length === 0 && changes.length === 0)
      console.log('  no changes in what the bridge uses.');
    problems.push(...breaking);
  }
  for (const p of problems) console.log(`  MISSING  ${p}`);
  if (values.write === true) {
    const config = (await resolveConfig(join(root, '.prettierrc.json'))) ?? {};
    const text = await format(JSON.stringify(subset), { ...config, parser: 'json' });
    writeFileSync(VENDORED_PATH, text);
    console.log(`wrote ${VENDORED_PATH.slice(root.length)}`);
  }
  if (problems.length > 0) {
    console.log('Not compatible with this bridge: see above.');
    process.exitCode = 1;
  } else {
    console.log('Compatible.');
  }
} finally {
  if (temp !== undefined) rmSync(temp, { recursive: true, force: true });
}
