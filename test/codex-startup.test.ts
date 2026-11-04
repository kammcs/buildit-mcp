/**
 * A Codex app-server that won't start: the terminal says what it said and
 * the likely cause, instead of only "closed its output", and the logs
 * never hold its words.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { cleanLine, likelyCause, usefulLine } from '../src/codex/startup.js';
import { CodexBench } from './support/codex-run.js';
import { FakeApi } from './support/fake-api.js';
import { SESSION_TOKENS } from './support/fake-sessions.js';

let api: FakeApi;
let bench: CodexBench;

beforeAll(async () => {
  api = await new FakeApi().start();
});
afterAll(async () => {
  await api.close();
});
beforeEach(() => {
  api.reset();
  bench = new CodexBench(api);
});
afterEach(async () => {
  expect(await bench.cleanup()).toEqual([]);
  expect(api.violations).toEqual([]);
});

const ESC = String.fromCharCode(27);

describe('codex bridge: an app-server that does not start', () => {
  it('says what it said and the likely cause, for a setting it refuses', async () => {
    api.sessions.open(SESSION_TOKENS.first, 'demo-folder');
    const codex = bench.fake();
    codex.failStart = [
      'WARNING: proceeding, even though we could not update PATH',
      `${ESC}[31mError:${ESC}[0m approval_policy = "untrusted" is no longer supported; remove this setting`,
    ];
    const r = await bench.start(codex, { codexConfig: ['approval_policy="untrusted"'] });
    expect(await r.done).toBe(1);
    const err = r.err.join('');
    expect(err).toContain('The Codex app-server did not start');
    expect(err).toContain(
      'It said: Error: approval_policy = "untrusted" is no longer supported; remove this setting',
    );
    expect(err).toContain('check the -c overrides you passed (approval_policy)');
    expect(err).not.toContain(ESC);
    // Its words go to the terminal only.
    expect(r.logs.join('\n')).not.toContain('no longer supported');
  });

  it('says it said nothing when stderr is empty', async () => {
    api.sessions.open(SESSION_TOKENS.first, 'demo-folder');
    const codex = bench.fake();
    codex.failStart = [];
    const r = await bench.start(codex);
    expect(await r.done).toBe(1);
    expect(r.err.join('')).toContain('It said nothing.');
  });

  it('stops keeping stderr once the handshake is done', async () => {
    api.sessions.open(SESSION_TOKENS.first, 'demo-folder');
    const codex = bench.fake();
    const r = await bench.start(codex);
    const until = Date.now() + 4000;
    while (!codex.startedCalled && Date.now() < until) await new Promise((x) => setTimeout(x, 10));
    expect(codex.startedCalled).toBe(true);
    await r.stop();
  });
});

describe('codex bridge: startup lines', () => {
  it('picks the line that says error, else the last one, cleaned and cut', () => {
    expect(usefulLine(['starting', 'Error: bad', 'more'])).toBe('Error: bad');
    expect(usefulLine(['one', '', 'two  '])).toBe('two');
    expect(usefulLine([])).toBeUndefined();
    expect(cleanLine(`a${String.fromCharCode(7)}b\tc`)).toBe('a b c');
    expect(Array.from(cleanLine('x'.repeat(400)))).toHaveLength(300);
  });

  it('names the likely cause', () => {
    expect(likelyCause('Error: not logged in', [])).toContain('codex login');
    expect(likelyCause('Error: invalid config.toml', [])).toContain('config.toml');
    expect(likelyCause('something else', [])).toContain('codex app-server');
  });
});
