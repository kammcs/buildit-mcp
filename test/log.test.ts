/**
 * The logger (src/log.ts): JSON lines on stderr, with tokens scrubbed as a
 * second line of defence. Every token here is made up.
 */
import { describe, expect, it } from 'vitest';

import { createLogger, scrubString, type LoggerOptions } from '../src/log.js';

const PAT = 'buildit_pat_test_logscrub_abc123';
const OTHER_PAT = 'buildit_pat_test_another_one_xyz789';
const STDIO_SECRET = 'not-token-shaped-secret-42';

/** A logger that keeps its lines, and the records they parse to. */
function capture(options: LoggerOptions = {}): {
  logger: ReturnType<typeof createLogger>;
  lines: string[];
  records: () => Record<string, unknown>[];
} {
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', ...options, sink: (l) => lines.push(l) });
  return {
    logger,
    lines,
    records: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

/** Fails if any captured line still holds one of the values. */
function expectAbsent(lines: readonly string[], ...values: string[]): void {
  for (const line of lines) {
    for (const value of values) expect(line).not.toContain(value);
  }
}

describe('scrubString', () => {
  it('redacts a Bearer credential, whatever its case and spacing', () => {
    expect(scrubString(`Authorization: Bearer ${PAT}`)).toBe('Authorization: [redacted]');
    expect(scrubString('sent bearer\tabc.def-ghi to the API')).toBe('sent [redacted] to the API');
    expect(scrubString('"Bearer abc", "BEARER xyz"; done')).toBe(
      '"[redacted]", "[redacted]"; done',
    );
  });

  it('redacts buildit_pat_ tokens anywhere in a string', () => {
    expect(scrubString(PAT)).toBe('[redacted]');
    expect(scrubString(`token=${PAT}&x=1`)).toBe('token=[redacted]&x=1');
    expect(scrubString(`["${PAT}","${OTHER_PAT}"]`)).toBe('["[redacted]","[redacted]"]');
    expect(scrubString(`line one\n${PAT}\nline three`)).toBe('line one\n[redacted]\nline three');
  });

  it('redacts a buildit_pat_ token glued to a word or an underscore', () => {
    expect(scrubString(`MY_${PAT}`)).toBe('MY_[redacted]');
    expect(scrubString(`x${PAT}`)).toBe('x[redacted]');
    expect(scrubString(`42${PAT}`)).toBe('42[redacted]');
  });

  it('redacts every exact secret it is given, even when not token-shaped', () => {
    expect(scrubString(`the key is ${STDIO_SECRET}.`, [STDIO_SECRET])).toBe(
      'the key is [redacted].',
    );
    expect(scrubString(`${STDIO_SECRET}${STDIO_SECRET}`, [STDIO_SECRET])).toBe(
      '[redacted][redacted]',
    );
    // Characters that mean something in a regular expression are taken literally.
    expect(scrubString('a.*b and a-b', ['a.*b'])).toBe('[redacted] and a-b');
  });

  it('ignores secrets too short to redact safely', () => {
    expect(scrubString('abc abc', ['abc', ''])).toBe('abc abc');
  });

  it('leaves ordinary text alone', () => {
    const text = 'GET /v1/items/DEMO-12 answered 200 in 31 ms';
    expect(scrubString(text)).toBe(text);
    expect(scrubString('buildit_pat_')).toBe('buildit_pat_');
  });

  it('scrubs very long strings, to the end, in reasonable time', () => {
    const filler = 'x'.repeat(500_000);
    const started = Date.now();
    const out = scrubString(`${filler} Bearer ${PAT} ${filler}${OTHER_PAT}`, [STDIO_SECRET]);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(out).not.toContain(PAT);
    expect(out).not.toContain(OTHER_PAT);
    expect(out.endsWith(`${filler}[redacted]`)).toBe(true);

    // Many near-misses don't slow it down.
    const nearMisses = 'Bearer '.repeat(100_000) + 'buildit_pat'.repeat(50_000);
    const again = Date.now();
    scrubString(nearMisses);
    expect(Date.now() - again).toBeLessThan(2_000);
  });
});

describe('createLogger', () => {
  it('writes one JSON object per line, with time, level and message', () => {
    const { logger, lines, records } = capture();
    logger.info('started', { port: 8765 });
    logger.warn('two\nlines in a message');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).not.toContain('\n');
      expect(JSON.parse(line)).toBeTypeOf('object');
    }
    const [first, second] = records();
    expect(first).toMatchObject({ level: 'info', msg: 'started', port: 8765 });
    expect(Date.parse(String(first?.ts))).not.toBeNaN();
    expect(second).toMatchObject({ level: 'warn', msg: 'two\nlines in a message' });
  });

  it('drops lines below its level (info by default)', () => {
    const lines: string[] = [];
    const byDefault = createLogger({ sink: (l) => lines.push(l) });
    byDefault.debug('d');
    byDefault.info('i');
    expect(lines.map((l) => (JSON.parse(l) as { msg: string }).msg)).toEqual(['i']);

    const levels = (level: LoggerOptions['level']): string[] => {
      const { logger, records } = capture({ level });
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');
      return records().map((r) => String(r.level));
    };
    expect(levels('debug')).toEqual(['debug', 'info', 'warn', 'error']);
    expect(levels('info')).toEqual(['info', 'warn', 'error']);
    expect(levels('warn')).toEqual(['warn', 'error']);
    expect(levels('error')).toEqual(['error']);
  });

  it('scrubs Bearer credentials and tokens in the message', () => {
    const { logger, lines, records } = capture();
    logger.info(`calling with Bearer ${PAT}`);
    logger.error(`refused ${OTHER_PAT}`);
    expectAbsent(lines, PAT, OTHER_PAT);
    expect(records().map((r) => r.msg)).toEqual(['calling with [redacted]', 'refused [redacted]']);
  });

  it('scrubs tokens in nested fields and arrays', () => {
    const { logger, lines, records } = capture();
    logger.info('request', {
      request: {
        headers: { accept: 'application/json', 'x-forwarded': `Bearer ${PAT}` },
        attempts: [{ note: `retry with ${OTHER_PAT}` }, 'ok'],
      },
    });
    expectAbsent(lines, PAT, OTHER_PAT);
    expect(records()[0]).toMatchObject({
      request: {
        headers: { accept: 'application/json', 'x-forwarded': '[redacted]' },
        attempts: [{ note: 'retry with [redacted]' }, 'ok'],
      },
    });
  });

  it('replaces fields whose names look like credentials, at any depth', () => {
    const { logger, lines, records } = capture();
    logger.info('config', {
      token: 'plain-value-1',
      nested: {
        Authorization: 'plain-value-2',
        apiKey: 'plain-value-3',
        'x-api-key': 'plain-value-4',
        client_secret: 'plain-value-5',
        password: 'plain-value-6',
        cookie: 'plain-value-7',
        refresh_token: { value: 'plain-value-8' },
      },
      status: 200,
    });
    expectAbsent(lines, ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `plain-value-${n}`));
    expect(records()[0]).toMatchObject({
      token: '[redacted]',
      nested: {
        Authorization: '[redacted]',
        apiKey: '[redacted]',
        'x-api-key': '[redacted]',
        client_secret: '[redacted]',
        password: '[redacted]',
        cookie: '[redacted]',
        refresh_token: '[redacted]',
      },
      status: 200,
    });
  });

  it('scrubs tokens used as field names', () => {
    const { logger, lines } = capture({ secrets: [STDIO_SECRET] });
    logger.info('by caller', { [PAT]: 1, nested: { [STDIO_SECRET]: 2 } });
    expectAbsent(lines, PAT, STDIO_SECRET);
  });

  it('scrubs the explicit secrets list everywhere: message, fields, bound fields', () => {
    const { logger, lines } = capture({ secrets: [STDIO_SECRET] });
    logger.info(`secret ${STDIO_SECRET} in the message`, {
      a: `and ${STDIO_SECRET} in a field`,
      list: [[`deep ${STDIO_SECRET}`]],
    });
    logger.child({ who: `bound ${STDIO_SECRET}` }).warn('child line');
    expect(lines).toHaveLength(2);
    expectAbsent(lines, STDIO_SECRET);
    expect(lines.join('\n')).toContain('[redacted]');
  });

  it('logs errors by name and scrubbed message, never their stacks', () => {
    const { logger, lines, records } = capture({ secrets: [STDIO_SECRET] });
    const err = new TypeError(`fetch failed for Bearer ${PAT} (${STDIO_SECRET})`);
    err.stack = `TypeError: ${PAT}\n    at call (/srv/app/dist/api/client.js:10:5) ${OTHER_PAT}`;
    logger.error('call failed', { error: err, errors: [new Error(`inner ${OTHER_PAT}`)] });
    expectAbsent(lines, PAT, OTHER_PAT, STDIO_SECRET, 'client.js:10:5');
    expect(records()[0]).toMatchObject({
      error: { name: 'TypeError', message: 'fetch failed for [redacted] ([redacted])' },
      errors: [{ name: 'Error', message: 'inner [redacted]' }],
    });
    expect(records()[0]?.error).not.toHaveProperty('stack');

    const named = new Error('renamed');
    named.name = `Refused(${PAT})`;
    logger.warn('odd error', { error: named });
    expectAbsent(lines, PAT);
    expect(records()[1]).toMatchObject({ error: { name: 'Refused([redacted])' } });
  });

  it('keeps bound fields on child loggers, and scrubs them', () => {
    const { logger, records } = capture();
    const child = logger.child({ request_id: 'r-1' }).child({ tool: 'get_item', auth: PAT });
    child.info('done', { ms: 12 });
    expect(records()[0]).toMatchObject({
      request_id: 'r-1',
      tool: 'get_item',
      auth: '[redacted]',
      ms: 12,
    });
  });

  it('cuts very deep or circular values instead of looping', () => {
    const { logger, lines, records } = capture();
    const loop: Record<string, unknown> = { name: 'loop' };
    loop.self = loop;
    logger.info('deep', { loop });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[truncated]');
    expect(records()[0]).toMatchObject({ loop: { name: 'loop' } });
  });

  it('logs very long values whole, scrubbed to the end', () => {
    const { logger, lines } = capture();
    const long = `${'y'.repeat(200_000)} Bearer ${PAT}`;
    logger.info('long', { body_size: long.length, sample: long });
    expect(lines).toHaveLength(1);
    expectAbsent(lines, PAT);
    expect(lines[0]).toContain(`${'y'.repeat(1000)} [redacted]`);
  });

  it('never throws when the sink does', () => {
    const logger = createLogger({
      sink: () => {
        throw new Error('stderr closed');
      },
    });
    expect(() => {
      logger.error('still fine');
    }).not.toThrow();
  });
});
