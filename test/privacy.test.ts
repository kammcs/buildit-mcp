/**
 * The privacy guard (scripts/privacy.ts): this repository is public, and no
 * file may carry the product's private details.
 */
import { describe, expect, it } from 'vitest';

import { RULES, repoFiles, scanRepo, scanText, selfTest } from '../scripts/privacy.js';

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
