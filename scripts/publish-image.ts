/**
 * Builds the container image for linux/amd64 and linux/arm64 and pushes it
 * to GitHub Container Registry as ghcr.io/kammcs/buildit-mcp:<version> and
 * :<major>, from a maintainer's machine.
 *
 *   docker login ghcr.io -u <user>          (a token with write:packages, never in a file)
 *   npm run image:publish                  push
 *   npm run image:publish -- --dry-run     build both platforms, push nothing
 *
 * Multi-platform builds need a docker-container builder; one named
 * "buildit-mcp" is created the first time. The working tree must be clean,
 * so the image matches a commit.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const IMAGE = 'ghcr.io/kammcs/buildit-mcp';
const PLATFORMS = 'linux/amd64,linux/arm64';
const BUILDER = 'buildit-mcp';

const root = fileURLToPath(new URL('..', import.meta.url));
const dryRun = process.argv.includes('--dry-run');

function run(cmd: string, args: string[], quiet = false): { status: number; out: string } {
  const r = spawnSync(cmd, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  // stdout is null when it is inherited.
  return { status: r.status ?? 1, out: ((r.stdout as string | null) ?? '').trim() };
}

function fail(message: string): never {
  console.error(`image:publish: ${message}`);
  process.exit(1);
}

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  version: string;
};
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`package.json version "${version}" is not x.y.z.`);
const major = version.split('.')[0]!;

if (run('git', ['status', '--porcelain'], true).out !== '') {
  fail('the working tree has changes; commit or stash them first.');
}
const revision = run('git', ['rev-parse', 'HEAD'], true).out;

if (run('docker', ['buildx', 'inspect', BUILDER], true).status !== 0) {
  if (
    run('docker', ['buildx', 'create', '--name', BUILDER, '--driver', 'docker-container'])
      .status !== 0
  ) {
    fail(`could not create the buildx builder "${BUILDER}".`);
  }
}

const tags = [`${IMAGE}:${version}`, `${IMAGE}:${major}`];
const build = run('docker', [
  'buildx',
  'build',
  '--builder',
  BUILDER,
  '--platform',
  PLATFORMS,
  '--build-arg',
  `VERSION=${version}`,
  '--build-arg',
  `REVISION=${revision}`,
  ...tags.flatMap((t) => ['--tag', t]),
  ...(dryRun ? [] : ['--push']),
  '.',
]);
if (build.status !== 0) fail('the build failed.');
console.log(dryRun ? `Built ${tags.join(' and ')} (not pushed).` : `Pushed ${tags.join(' and ')}.`);
