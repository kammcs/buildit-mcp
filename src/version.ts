import { readFileSync } from 'node:fs';

/** The server's name, as reported to MCP clients and in the User-Agent header. */
export const SERVER_NAME = 'buildit-mcp';

function readVersion(): string {
  // Both src/ (tests) and dist/ (the built server) sit one level below package.json.
  const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(raw) as { version?: unknown };
  return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
}

/** The server's own version, from package.json. */
export const SERVER_VERSION = readVersion();

/** Compares dotted numeric versions ("1.2.10" > "1.2.9"); pre-release tags are ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] =>
    v
      .replace(/^v/, '')
      .split(/[-+]/, 1)
      .join('')
      .split('.')
      .map((p) => Number.parseInt(p, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
