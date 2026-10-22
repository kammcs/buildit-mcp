/**
 * The files that describe a release to other registries stay in step with
 * package.json: the MCP Registry's server.json and the Claude Desktop
 * bundle's manifest.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const read = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));

const pkg = read('package.json') as { name: string; version: string; mcpName: string };

interface Env {
  name: string;
  isSecret?: boolean;
  isRequired?: boolean;
  value?: string;
}
interface ServerJson {
  name: string;
  description: string;
  version: string;
  packages: {
    registryType: string;
    identifier: string;
    version?: string;
    environmentVariables: Env[];
  }[];
}

describe('server.json (MCP Registry)', () => {
  const server = read('server.json') as ServerJson;
  const npm = server.packages.find((p) => p.registryType === 'npm')!;
  const oci = server.packages.find((p) => p.registryType === 'oci')!;

  it("has package.json's name and version, for every package", () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    expect(npm).toMatchObject({ identifier: pkg.name, version: pkg.version });
    expect(oci.identifier).toBe(`ghcr.io/kammcs/buildit-mcp:${pkg.version}`);
    expect(server.description.length).toBeLessThanOrEqual(100);
  });

  it('asks for the token as a required secret, and runs the image over stdio', () => {
    for (const p of [npm, oci]) {
      expect(p.environmentVariables.find((e) => e.name === 'BUILDIT_TOKEN')).toMatchObject({
        isSecret: true,
        isRequired: true,
      });
    }
    expect(oci.environmentVariables.find((e) => e.name === 'BUILDIT_HTTP')?.value).toBe('false');
  });
});

describe('bundle/manifest.json (Claude Desktop)', () => {
  const manifest = read('bundle/manifest.json') as {
    name: string;
    server: { mcp_config: { env: Record<string, string> } };
    user_config: Record<string, { sensitive?: boolean; required?: boolean }>;
  };

  it('takes the token from a sensitive, required setting', () => {
    expect(manifest.name).toBe('buildit-mcp');
    expect(manifest.server.mcp_config.env.BUILDIT_TOKEN).toBe('${user_config.token}');
    expect(manifest.user_config.token).toMatchObject({ sensitive: true, required: true });
  });
});
