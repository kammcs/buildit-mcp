/**
 * The privacy guard (scripts/privacy.ts): this repository is public, and no
 * file may carry the product's private details.
 */
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  readTar,
  RULES,
  repoFiles,
  scanPackage,
  scanRepo,
  scanText,
  selfTest,
} from '../scripts/privacy.js';

const j = (...parts: string[]): string => parts.join('');

describe('the privacy guard', () => {
  it('finds nothing private in the repository (the contract included)', () => {
    const files = repoFiles();
    expect(files).toContain('openapi/openapi.json');
    expect(files).toContain('README.md');
    expect(files).not.toContain('package-lock.json');
    expect(files.some((f) => f.includes('node_modules/'))).toBe(false);
    expect(scanRepo()).toEqual([]);
  });

  it('catches every example of every rule, and passes the look-alikes (self-test)', () => {
    expect(selfTest()).toEqual([]);
    for (const rule of RULES) expect(rule.examples.hit.length, rule.id).toBeGreaterThan(0);
  });

  it('covers what must never be published', () => {
    const ids = RULES.map((r) => r.id);
    for (const id of [
      'decision-number',
      'plan-section',
      'sql-file',
      'backend-vendor',
      'schema-change-files',
      'row-level-security',
      'database-rest-layer',
      'database-test-tooling',
      'owner-first-name',
      'owner-last-name',
      'private-repo',
      'project-key',
      'email',
      'local-path',
      'private-host',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('reports the file, line and rule of a finding', () => {
    const text = ['# Notes', '', j('Decided in D', '-12 with ana', '@', 'acme.io.')].join('\n');
    expect(scanText('docs/notes.md', text)).toEqual([
      { file: 'docs/notes.md', line: 3, rule: 'decision-number', match: j('D', '-12') },
      { file: 'docs/notes.md', line: 3, rule: 'email', match: j('ana', '@', 'acme.io') },
    ]);
  });

  it('allows the company name only where it is the copyright holder', () => {
    const holder = j('Copyright (c) 2026 K', 'amm Creative Solutions');
    expect(scanText('LICENSE', holder)).toEqual([]);
    expect(scanText('package.json', holder)).toEqual([]);
    expect(scanText('README.md', holder)).toHaveLength(1);
  });

  it('flags any buildIt.Social host but the public ones, without naming them', () => {
    const dev = j('https://api', '-dev.', 'buildit.social/functions/v1/agent-api');
    expect(scanText('README.md', dev)).toMatchObject([{ rule: 'private-host' }]);
    expect(scanText('README.md', 'https://api.buildit.social/functions/v1/agent-api')).toEqual([]);
  });
});

/** A ustar archive of the given files (a pax header for names over 100 bytes), as npm writes. */
function tar(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  const header = (name: string, size: number, type: string): Buffer => {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0, 'utf8');
    h.write(size.toString(8).padStart(11, '0'), 124, 'ascii');
    h.write(type, 156, 'ascii');
    h.write('ustar\u000000', 257, 'ascii');
    return h;
  };
  const body = (data: Buffer): Buffer =>
    Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    if (name.length > 100) {
      const record = ` path=${name}\n`;
      const pax = Buffer.from(`${record.length + String(record.length + 3).length}${record}`);
      blocks.push(header('PaxHeader', pax.length, 'x'), body(pax));
    }
    blocks.push(header(name, data.length, '0'), body(data));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

describe('the privacy guard over the published package', () => {
  const clean = {
    'package/package.json': '{"name":"@example/x"}',
    'package/README.md': '# x',
    'package/LICENSE': 'MIT',
    'package/SECURITY.md': '# Security',
    'package/CHANGELOG.md': '# Changelog',
    'package/dist/index.js': '#!/usr/bin/env node\n',
  };

  it('reads every file of a tarball, long names included', () => {
    const long = `package/dist/${'a'.repeat(120)}.js`;
    const entries = readTar(tar({ ...clean, [long]: 'x' }));
    expect(entries.map((e) => e.path)).toEqual([...Object.keys(clean), long]);
    expect(entries[5]?.data.toString('utf8')).toBe('#!/usr/bin/env node\n');
  });

  it('passes a package of the built server and its documents', () => {
    const { files, findings } = scanPackage(gzipSync(tar(clean)));
    expect(findings).toEqual([]);
    expect(files).toContain('dist/index.js');
  });

  it('flags tests, fixtures, the contract, env files and source maps', () => {
    const { findings } = scanPackage(
      gzipSync(
        tar({
          ...clean,
          'package/test/log.test.ts': '',
          'package/openapi/openapi.json': '{}',
          'package/.env': '',
          'package/dist/index.js.map': '{}',
        }),
      ),
    );
    expect(findings.filter((f) => f.rule === 'pack-contents').map((f) => f.file)).toEqual([
      '.env',
      'dist/index.js.map',
      'openapi/openapi.json',
      'test/log.test.ts',
    ]);
  });

  it('flags a package without the built server', () => {
    const unbuilt: Record<string, string> = { ...clean };
    delete unbuilt['package/dist/index.js'];
    const { findings } = scanPackage(gzipSync(tar(unbuilt)));
    expect(findings).toMatchObject([{ file: 'dist/index.js', rule: 'pack-contents' }]);
  });

  it('applies every rule to the packed files', () => {
    const map = j('{"sources":["C', ':', '\\', 'Users', '\\', 'ana', '\\', 'src.ts"]}');
    const { findings } = scanPackage(
      gzipSync(tar({ ...clean, 'package/dist/log.js': map, 'package/README.md': j('D', '-1') })),
    );
    expect(findings.map((f) => [f.file, f.rule])).toEqual([
      ['README.md', 'decision-number'],
      ['dist/log.js', 'local-path'],
    ]);
  });
});
