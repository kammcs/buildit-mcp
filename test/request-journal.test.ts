/**
 * The request journal: a meeting's notes request's scope (ids only) kept
 * across a restart, and nothing it shouldn't keep.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { ChannelState } from '../src/channel/loop.js';
import {
  JOURNAL_MAX,
  readRequestJournal,
  type JournalEntry,
} from '../src/channel/request-journal.js';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bmcp-journal-'));
  path = join(dir, 'locks', 'x.requests.json');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function remember(state: ChannelState, n: number, expires = '2099-10-14T14:00:00Z'): void {
  state.rememberRequest(id(n), {
    kind: 'meeting_notes',
    place: 'meeting_thread',
    thread: id(1000 + n),
    project: n % 2 === 0 ? 'DEMO' : null,
    transcript: [
      { message_id: id(2000 + n), file_id: id(3000 + n) },
      { message_id: id(4000 + n), file_id: id(5000 + n) },
    ],
    expiresAt: expires,
  });
}

it("keeps meeting's notes requests only, and a new state reads them back", () => {
  const state = new ChannelState();
  state.requestJournal = path;
  remember(state, 1);
  state.rememberRequest(id(9), { kind: 'catch_up', place: 'dm' });
  const back = new ChannelState();
  back.requestJournal = path;
  expect(back.loadRequestJournal(NOW)).toBe(1);
  expect(back.requests.get(id(1))).toMatchObject({
    kind: 'meeting_notes',
    place: 'meeting_thread',
    thread: id(1001),
    project: null,
    transcript: [
      { message_id: id(2001), file_id: id(3001) },
      { message_id: id(4001), file_id: id(5001) },
    ],
  });
  expect(back.requests.has(id(9))).toBe(false);
});

it('drops expired, malformed and excess entries', () => {
  const state = new ChannelState();
  state.requestJournal = path;
  for (let n = 1; n <= JOURNAL_MAX + 5; n++) remember(state, n);
  expect(readRequestJournal(path, NOW)).toHaveLength(JOURNAL_MAX);
  // Past their expiry, nothing is read back.
  expect(readRequestJournal(path, Date.parse('2099-10-15T00:00:00Z'))).toEqual([]);

  const good: JournalEntry = {
    id: id(7),
    kind: 'meeting_notes',
    thread: id(8),
    project: 'DEMO',
    transcript: [{ message_id: id(10), file_id: id(11) }],
    expires_at: '2099-10-14T14:00:00Z',
  };
  writeFileSync(
    path,
    JSON.stringify({
      v: 1,
      requests: [
        good,
        { ...good, id: 'not-a-uuid' },
        { ...good, kind: 'catch_up' },
        { ...good, thread: '../x' },
        { ...good, project: 'demo; drop' },
        { ...good, transcript: [{ message_id: id(1), file_id: 'x' }] },
        { ...good, transcript: [] },
        { ...good, expires_at: 'soon' },
      ],
    }),
  );
  expect(readRequestJournal(path, NOW)).toEqual([good]);
  writeFileSync(path, 'not json');
  expect(readRequestJournal(path, NOW)).toEqual([]);
});

it('holds ids and times only', () => {
  const state = new ChannelState();
  state.requestJournal = path;
  remember(state, 2);
  const text = readFileSync(path, 'utf8');
  expect(text).toMatch(/^\{"v":1,"requests":\[/);
  expect(
    text.replace(/[0-9a-f-]{36}|"[a-z_]+":|2099-10-14T14:00:00Z|DEMO|meeting_notes/g, ''),
  ).toMatch(/^[{}[\]",:0-9]*$/);
});
