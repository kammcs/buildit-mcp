/**
 * npm run dev-marketplace [-- --out <dir>]: a Claude Code plugin
 * marketplace on this machine whose buildit plugin runs this checkout's
 * build (dist/index.js), to try channel mode before a release is on npm.
 *
 * Claude Code registers a plugin's channel only for an installed plugin
 * (--dangerously-load-development-channels plugin:<name>@<marketplace>),
 * and an installed plugin is copied into its plugin cache, so the plugin
 * can't find the checkout relative to itself: the server's path is written
 * in absolute. The plugin is made from plugin/ (the release plugin: the
 * same hooks, subagents, settings and channel), with the server `node
 * <checkout>/dist/index.js` and the version `<package version>-local`.
 *
 * The folder is written where you say (default: .dev-marketplace in this
 * checkout, which git ignores); nothing with an absolute path is written
 * into the repository.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The marketplace's name, and the plugin's. */
export const DEV_MARKETPLACE = 'buildit-dev';
const PLUGIN = 'buildit';
/** The npm package the release plugin runs (its args after it are kept). */
const PACKAGE_PREFIX = '@kammcs/buildit-mcp@';

type Json = Record<string, unknown>;

const readJson = (path: string): Json => JSON.parse(readFileSync(path, 'utf8')) as Json;
const writeJson = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

/** The commands that add the marketplace, install the plugin and start Claude Code with its channel. */
export function devCommands(out: string): string[] {
  const dir = /\s/.test(out) ? `"${out}"` : out;
  return [
    `claude plugin marketplace add ${dir}`,
    `claude plugin install ${PLUGIN}@${DEV_MARKETPLACE}`,
    `claude --dangerously-load-development-channels plugin:${PLUGIN}@${DEV_MARKETPLACE}`,
  ];
}

/**
 * Writes the marketplace into `out` (replacing what an earlier run wrote
 * there): .claude-plugin/marketplace.json and the plugin in ./buildit.
 */
export function writeDevMarketplace(checkout: string, out: string): { version: string } {
  const pkg = readJson(join(checkout, 'package.json'));
  const version = `${String(pkg.version)}-local`;
  const plugin = readJson(join(checkout, 'plugin', '.claude-plugin', 'plugin.json'));
  const servers = plugin.mcpServers as Record<string, { command: string; args: string[] }>;
  const server = servers[PLUGIN];
  if (server === undefined) throw new Error(`plugin/ has no "${PLUGIN}" server`);
  const at = server.args.findIndex((a) => a.startsWith(PACKAGE_PREFIX));
  if (at < 0) throw new Error(`plugin/'s server doesn't run ${PACKAGE_PREFIX}<version>`);
  const entry = resolve(checkout, 'dist', 'index.js');
  const local: Json = {
    ...plugin,
    version,
    description: `${String(plugin.description)} (This checkout's build: ${entry}.)`,
    mcpServers: {
      ...servers,
      [PLUGIN]: { ...server, command: 'node', args: [entry, ...server.args.slice(at + 1)] },
    },
  };
  const pluginDir = join(out, PLUGIN);
  rmSync(pluginDir, { recursive: true, force: true });
  writeJson(join(pluginDir, '.claude-plugin', 'plugin.json'), local);
  writeJson(
    join(pluginDir, 'hooks', 'hooks.json'),
    readJson(join(checkout, 'plugin', 'hooks', 'hooks.json')),
  );
  // The subagents (the item worker), as they are.
  cpSync(join(checkout, 'plugin', 'agents'), join(pluginDir, 'agents'), { recursive: true });
  const marketplace = readJson(join(checkout, '.claude-plugin', 'marketplace.json'));
  writeJson(join(out, '.claude-plugin', 'marketplace.json'), {
    name: DEV_MARKETPLACE,
    owner: marketplace.owner,
    description: "The buildit plugin running a local checkout's build, for development.",
    plugins: [
      {
        name: PLUGIN,
        source: `./${PLUGIN}`,
        version,
        description: "buildIt.Social as a Claude Code channel, running this checkout's build.",
      },
    ],
  });
  return { version };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const flag = process.argv.indexOf('--out');
  const outArg = flag >= 0 ? process.argv[flag + 1] : undefined;
  if (flag >= 0 && (outArg === undefined || outArg.startsWith('--'))) {
    console.error('usage: npm run dev-marketplace [-- --out <dir>]');
    process.exit(2);
  }
  const out = resolve(outArg ?? join(checkout, '.dev-marketplace'));
  const { version } = writeDevMarketplace(checkout, out);
  console.log(`Wrote the ${DEV_MARKETPLACE} marketplace (buildit ${version}) to ${out}.`);
  console.log("Its plugin runs this checkout's dist/index.js: build first (npm run build).");
  console.log('Then, once:');
  for (const line of devCommands(out).slice(0, 2)) console.log(`  ${line}`);
  console.log('And in the folder you connected (buildit-mcp connect):');
  console.log(`  ${devCommands(out)[2] ?? ''}`);
  console.log(
    `Run this again after rebuilding or pulling, then "claude plugin marketplace update ${DEV_MARKETPLACE}" and "claude plugin update ${PLUGIN}@${DEV_MARKETPLACE}", so Claude Code takes the new copy.`,
  );
}
