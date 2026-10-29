/**
 * What a tool approval's details hold: the shared masking corpus (every
 * credential-shaped value is assembled here at runtime from pieces, so no
 * file holds one whole), the cleaning, the mapping of a tool's input to
 * fields (goldens for Bash, PowerShell, Write, Edit, an MCP tool and a
 * nested input), the cuts and the 12 KB limit, and which session rules are
 * offered.
 */
import { describe, expect, it } from 'vitest';

import {
  buildDetails,
  cleanApprovalKey,
  cleanApprovalText,
  CUT_MARKER,
  cutValue,
  DETAILS_MAX_BYTES,
  maskCredentials,
  maskField,
  REDACTED,
  sessionRuleFrom,
} from '../src/channel/mask.js';

const j = (...p: string[]): string => p.join('');
const R = (s: string, n: number): string => s.repeat(n);
const ch = (code: number): string => String.fromCharCode(code);
const X = REDACTED;

// The corpus's secrets, from pieces.
const GH = j('gh', 'p_', R('aB3', 12));
const GOOGLE = j('AI', 'za', R('Sy0_', 9));

/** The corpus: id, input, expected (the input with the secret parts replaced). */
const CORPUS: [string, string, string][] = [
  ['M01', j('export X=', GH), `export X=${X}`],
  ['M02', j('github', '_pat_', R('A1b_', 20)), X],
  ['M03', j('glp', 'at-', R('x9Y', 7)), X],
  ['M04', j('key ', 'sk-', 'ant-', R('k9Q', 10)), `key ${X}`],
  ['M05', j('xo', 'xb-', '1234-5678-', R('ab', 6)), X],
  ['M06a', j('AK', 'IA', R('Q7', 8)), X],
  ['M06b', j('AS', 'IA', R('Z3', 8)), X],
  ['M07', GOOGLE, X],
  ['M08a', j('sk', '_live_', R('4eC3', 6)), X],
  ['M08b', j('rk', '_test_', R('9x', 8)), X],
  ['M08c', j('wh', 'sec_', R('ab12', 4)), X],
  ['M09a', j('buildit', '_pat_', R('A1', 25)), X],
  ['M09b', j('buildit', '_ags_', R('A1', 25)), X],
  ['M09c', j('buildit', '_app_', R('A1', 25)), X],
  ['M09d', j('buildit', '_whsec_', R('0f', 16)), X],
  ['M10', j('ey', 'J', R('hbGc', 4), '.', 'ey', 'J', R('zdWI', 4), '.', R('sig', 5)), X],
  [
    'M11',
    j(
      '-----BEGIN RSA PRIV',
      'ATE KEY-----\n',
      R('MIIE', 10),
      '\n-----END RSA PRIV',
      'ATE KEY-----\nafter',
    ),
    `${X}\nafter`,
  ],
  ['M12', j('-----BEGIN RSA PRIV', 'ATE KEY-----\n', R('MIIE', 10)), X],
  [
    'M13',
    j('curl -H "Authorization: Bearer ', R('abc.DEF-', 4), '" https://x.test'),
    `curl -H "Authorization: Bearer ${X}" https://x.test`,
  ],
  ['M14', j('pass', 'word=hunter2 next'), `password=${X} next`],
  ['M15', j('mysql --pass', 'word secretpw -h db'), `mysql --password ${X} -h db`],
  ['M16', j('GITHUB_TOK', 'EN=', R('q1', 10)), `GITHUB_TOKEN=${X}`],
  ['M17', j('{"api_', 'key": "', R('v', 12), '"}'), `{"api_key": ${X}}`],
  [
    'M18',
    j('post', 'gres://app:pa', '55word', '@', 'db.test:5432/x'),
    j('post', 'gres://app:', X, '@', 'db.test:5432/x'),
  ],
  [
    'M19',
    j('git show ', R('0123456789abcdef', 2), '01234567'),
    j('git show ', R('0123456789abcdef', 2), '01234567'),
  ],
  ['M20', 'id 123e4567-e89b-12d3-a456-426614174000', 'id 123e4567-e89b-12d3-a456-426614174000'],
  [
    'M21',
    'npm run sk-learn; max_tokens=4096; token_type=bearer; the token is old',
    'npm run sk-learn; max_tokens=4096; token_type=bearer; the token is old',
  ],
  ['M22', 'the AKIA prefix', 'the AKIA prefix'],
  ['M25', j(GH, ' ', GOOGLE), `${X} ${X}`],
];

/** The corpus as one value goes through it: cleaned first, then masked. */
const mask = (text: string): string => maskCredentials(cleanApprovalText(text));

describe('the masking corpus', () => {
  it.each(CORPUS)('%s', (_id, input, expected) => {
    expect(mask(input)).toBe(expected);
  });

  it('M23: a field whose name is a secret has its whole value masked', () => {
    expect(maskField(j('api_', 'key'), 'abc')).toBe(X);
    expect(maskField(j('Authori', 'zation'), 'x')).toBe(X);
    expect(maskField('client_secret', 'plain words')).toBe(X);
    expect(maskField('credentials', 'a')).toBe(X);
    // Empty stays empty; other names keep their value.
    expect(maskField('token', '')).toBe('');
    expect(maskField('command', 'npm test')).toBe('npm test');
    expect(maskField('token_type', 'bearer')).toBe('bearer');
    expect(maskField('max_tokens', '4096')).toBe('4096');
  });

  it('M24: a bidi control inside a secret is removed before masking', () => {
    expect(mask(j('gh', ch(0x202e), 'p_', R('aB3', 12)))).toBe(X);
  });

  it('M26: masked first, then cut, the secret inside the head', () => {
    // A space after the secret: R7 would otherwise take the run of letters after it as part of it.
    const input = j(R('a ', 1195), GH, ' ', R('b', 2609));
    expect(Array.from(input)).toHaveLength(5040);
    const masked = mask(input);
    expect(Array.from(masked)).toHaveLength(5010);
    expect(masked.indexOf(X)).toBe(2390);
    const cut = cutValue(masked);
    expect(cut.cut).toBe(1610);
    expect(cut.value).toBe(j(R('a ', 1195), X, CUT_MARKER, R('b', 1000)));
    expect(Array.from(cut.value)).toHaveLength(3403);
  });

  it('M27: masking again changes nothing', () => {
    for (const [, , expected] of CORPUS) expect(mask(expected)).toBe(expected);
    expect(mask(mask(j(R('a ', 1195), GH, ' ', R('b', 2609))))).toBe(
      mask(j(R('a ', 1195), GH, ' ', R('b', 2609))),
    );
  });
});

describe('cleaning', () => {
  it('turns line breaks into line feeds and removes control, bidi and zero-width characters', () => {
    const text = j(
      'a\r\nb\rc',
      ch(0x2028),
      'd',
      ch(0x2029),
      'e\tf',
      ch(7),
      ch(0x1b),
      ch(0x85),
      ch(0x061c),
      ch(0x200b),
      ch(0x200e),
      ch(0x202a),
      ch(0x2060),
      ch(0x2066),
      ch(0xfeff),
      'g',
    );
    expect(cleanApprovalText(text)).toBe('a\nb\nc\nd\ne\tfg');
  });

  it('folds a key to one trimmed line', () => {
    expect(cleanApprovalKey(j(' a\nb\tc', ch(0x202e), ' '))).toBe('a b c');
  });
});

describe('the details of a tool call', () => {
  it('Bash: the description apart, then the command', () => {
    expect(
      buildDetails('Bash', { command: 'npm test', description: 'Run the tests', timeout: 120000 }),
    ).toEqual({
      description: 'Run the tests',
      fields: [
        { key: 'command', value: 'npm test' },
        { key: 'timeout', value: '120000' },
      ],
    });
  });

  it('PowerShell: the same, a secret in the command masked', () => {
    expect(
      buildDetails('PowerShell', {
        command: j('$env:GITHUB_TOK', 'EN="', R('q1', 10), '"; gh pr list'),
        description: j('List PRs with ', GH),
      }),
    ).toEqual({
      description: `List PRs with ${X}`,
      fields: [{ key: 'command', value: `$env:GITHUB_TOKEN=${X}; gh pr list` }],
    });
  });

  it('Write: the content is a field like any other; another tool keeps description as a field', () => {
    expect(
      buildDetails('Write', {
        file_path: 'C:\\work\\notes.md',
        content: '# Notes\n\nLine two',
        description: 'kept',
      }),
    ).toEqual({
      fields: [
        { key: 'file_path', value: 'C:\\work\\notes.md' },
        { key: 'content', value: '# Notes\n\nLine two' },
        { key: 'description', value: 'kept' },
      ],
    });
  });

  it('Edit: old_string and new_string, replace_all as JSON', () => {
    expect(
      buildDetails('Edit', {
        file_path: '/repo/a.ts',
        old_string: 'const a = 1;',
        new_string: 'const a = 2;',
        replace_all: false,
      }),
    ).toEqual({
      fields: [
        { key: 'file_path', value: '/repo/a.ts' },
        { key: 'old_string', value: 'const a = 1;' },
        { key: 'new_string', value: 'const a = 2;' },
        { key: 'replace_all', value: 'false' },
      ],
    });
  });

  it('an MCP tool with a nested input: objects and arrays as indented JSON, secrets in them masked', () => {
    expect(
      buildDetails('mcp__example__create', {
        title: 'Hello',
        options: { labels: ['a', 'b'], auth: { api_key: j('sk', '-', R('Z9', 12)) } },
        count: 3,
        nothing: null,
        api_token: 'anything at all',
      }),
    ).toEqual({
      fields: [
        { key: 'title', value: 'Hello' },
        {
          key: 'options',
          value: `{\n  "labels": [\n    "a",\n    "b"\n  ],\n  "auth": {\n    "api_key": ${X}\n  }\n}`,
        },
        { key: 'count', value: '3' },
        { key: 'nothing', value: 'null' },
        { key: 'api_token', value: X },
      ],
    });
  });

  it('cuts a long description with "…", long keys to 100, and cleans keys', () => {
    const d = buildDetails('Bash', {
      command: 'x',
      description: R('d', 1200),
      [j(R('k', 120), '\n')]: 'v',
    });
    expect(Array.from(d.description ?? '')).toHaveLength(1000);
    expect(d.description?.endsWith('…')).toBe(true);
    expect(d.fields[1]?.key).toBe(`${R('k', 99)}…`);
  });

  it('cuts a value over 3,500 code points to its ends, counting what it left out', () => {
    const value = j(R('h', 3000), R('t', 1500));
    const d = buildDetails('Write', { content: value });
    expect(d.fields[0]).toEqual({
      key: 'content',
      value: j(R('h', 2400), CUT_MARKER, R('t', 1000)),
      cut: 1100,
    });
    // Code points, not UTF-16 units.
    const emoji = R(String.fromCodePoint(0x1f600), 3600);
    expect(cutValue(emoji).cut).toBe(200);
  });

  it('keeps at most 20 fields, counting the rest', () => {
    const input = Object.fromEntries(Array.from({ length: 25 }, (_v, i) => [`k${i}`, `v${i}`]));
    const d = buildDetails('mcp__x__y', input);
    expect(d.fields).toHaveLength(20);
    expect(d.fields[19]).toEqual({ key: 'k19', value: 'v19' });
    expect(d.more_fields).toBe(5);
  });

  it('stays within 12 KB: the longest value is cut by half, never below 200; then fields go', () => {
    const big = (c: string): string => R(c, 3400);
    const d = buildDetails('mcp__x__y', { a: big('a'), b: big('b'), c: big('c'), d: big('d') });
    const bytes = Buffer.byteLength(JSON.stringify(d), 'utf8');
    expect(bytes).toBeLessThanOrEqual(DETAILS_MAX_BYTES);
    expect(d.fields).toHaveLength(4);
    // The first of the longest is cut to half (1,700 code points with the marker: 2/3 head,
    // 1/3 tail); that is enough here, so the others stay whole.
    expect(d.fields[0]).toEqual({
      key: 'a',
      value: j(R('a', 1132), CUT_MARKER, R('a', 565)),
      cut: 3400 - 1697,
    });
    expect(d.fields.slice(1).map((f) => [f.value.length, f.cut])).toEqual([
      [3400, undefined],
      [3400, undefined],
      [3400, undefined],
    ]);
    // Larger still: each is halved in turn, then halved again, and never below 200.
    const many = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((k) => [k, big(k)]));
    const m = buildDetails('mcp__x__y', many);
    expect(Buffer.byteLength(JSON.stringify(m), 'utf8')).toBeLessThanOrEqual(DETAILS_MAX_BYTES);
    expect(m.fields).toHaveLength(6);
    for (const f of m.fields) {
      expect(Array.from(f.value).length).toBeGreaterThanOrEqual(200);
      const kept = Array.from(f.value).length;
      expect(f.cut ?? 0).toBe(kept === 3400 ? 0 : 3400 - (kept - 3));
    }
    // Many 3-byte characters: values shrink to 200 each, then fields are dropped from the end.
    const wide = Object.fromEntries(Array.from({ length: 20 }, (_v, i) => [`f${i}`, R('€', 3500)]));
    const w = buildDetails('mcp__x__y', wide);
    expect(Buffer.byteLength(JSON.stringify(w), 'utf8')).toBeLessThanOrEqual(DETAILS_MAX_BYTES);
    expect(w.fields.every((f) => Array.from(f.value).length <= 200)).toBe(true);
    expect((w.more_fields ?? 0) + w.fields.length).toBe(20);
    expect(w.more_fields).toBeGreaterThan(0);
  });
});

describe('the session rule offered', () => {
  const allow = {
    type: 'addRules',
    rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
    behavior: 'allow',
    destination: 'session',
  };

  it('takes the first session-scoped allow rule or accept-edits mode, from JSON text or an array', () => {
    expect(sessionRuleFrom(JSON.stringify([allow]))).toEqual(allow);
    expect(
      sessionRuleFrom([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]),
    ).toEqual({ type: 'setMode', mode: 'acceptEdits', destination: 'session' });
    expect(
      sessionRuleFrom([
        { type: 'addDirectories', directories: ['C:\\b'], destination: 'session' },
        { ...allow, rules: [{ toolName: 'Read' }] },
      ]),
    ).toEqual({ ...allow, rules: [{ toolName: 'Read' }] });
  });

  it('never offers another destination, a deny or ask rule, directories, another mode or extra keys', () => {
    for (const bad of [
      { ...allow, destination: 'localSettings' },
      { ...allow, destination: 'projectSettings' },
      { ...allow, destination: 'userSettings' },
      { ...allow, behavior: 'deny' },
      { ...allow, behavior: 'ask' },
      { ...allow, type: 'replaceRules' },
      { type: 'addDirectories', directories: ['/'], destination: 'session' },
      { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
      { type: 'setMode', mode: 'plan', destination: 'session' },
      { ...allow, extra: 1 },
      { ...allow, rules: [{ toolName: 'Bash', ruleContent: 'x', other: 1 }] },
      { ...allow, rules: [] },
      { ...allow, rules: Array.from({ length: 6 }, () => ({ toolName: 'Bash' })) },
      { ...allow, rules: [{ toolName: 'bad name' }] },
      { ...allow, rules: [{ toolName: 'Bash', ruleContent: 'a\nb' }] },
      { ...allow, rules: [{ toolName: 'Bash', ruleContent: '' }] },
      { ...allow, rules: [{ toolName: 'Bash', ruleContent: R('x', 501) }] },
    ]) {
      expect(sessionRuleFrom([bad]), JSON.stringify(bad).slice(0, 80)).toBeUndefined();
    }
    expect(sessionRuleFrom('not json')).toBeUndefined();
    expect(sessionRuleFrom('${permission_suggestions}')).toBeUndefined();
    expect(sessionRuleFrom('')).toBeUndefined();
    expect(sessionRuleFrom(undefined)).toBeUndefined();
  });

  it("cleans a rule's content by the strip rules only (a bidi control goes)", () => {
    expect(
      sessionRuleFrom([
        { ...allow, rules: [{ toolName: 'Bash', ruleContent: j('npm', ch(0x202e), ' test:*') }] },
      ]),
    ).toEqual(allow);
  });
});
