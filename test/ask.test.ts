/**
 * ask's pieces on their own: reading the questions, the cards (one per
 * question: its text, a choice with its options' descriptions, Other,
 * Send), decoding answers, the words in each language, the card messages'
 * ids, and the hook's exact JSON.
 */
import { describe, expect, it } from 'vitest';

import {
  askMessageId,
  buildQuestionCards,
  cardIds,
  cardLocale,
  cardSize,
  CARD_MAX_BYTES,
  CARD_MAX_ELEMENTS,
  cleanLine,
  cleanOther,
  cleanText,
  closesAt,
  decodeAnswer,
  hookAllow,
  hookDeny,
  HOOK_PASS,
  noAnswerText,
  parseQuestions,
  splitText,
  uuidV5,
  type Question,
} from '../src/tools/ask.js';
import { questionCardProblem } from './support/fake-sessions.js';

const NOW = Date.parse('2026-10-28T10:00:00.000Z');
const ctx = { agent: 'Claude', locale: 'en' as const, closesAt: closesAt(NOW, 3540) };

const color: Question = {
  question: 'Which color?',
  header: 'Color',
  options: [{ label: 'Blue', description: 'The default; runs everywhere.' }, { label: 'Green' }],
};
const targets: Question = {
  question: 'Which targets?',
  header: 'Targets',
  options: [{ label: 'Windows' }, { label: 'macOS' }, { label: 'Linux' }],
  multiSelect: true,
};

type Input = Record<string, unknown> & { options?: Record<string, unknown>[] };
const inputsOf = (card: Record<string, unknown>): Input[] => card.inputs as Input[];
const bodyOf = (card: Record<string, unknown>): { type: string; text: string }[] =>
  (card.body ?? []) as { type: string; text: string }[];
/** The card of one question asked alone. */
const cardOf = (q: Question, c = ctx): Record<string, unknown> =>
  buildQuestionCards([q], c)[0]?.card ?? {};
const BIDI_OVERRIDE = String.fromCharCode(0x202e);
const BELL = String.fromCharCode(7);

describe('parseQuestions', () => {
  it('takes the array, or its JSON text (as the hook passes it), keeping other keys', () => {
    const withExtra = [{ ...color, extra: 1 }];
    expect(parseQuestions(withExtra)).toEqual(withExtra);
    expect(parseQuestions(JSON.stringify([color, targets]))).toEqual([color, targets]);
  });

  it.each([
    ['not JSON', '[{'],
    ['empty', []],
    ['five questions', [color, color, color, color, color]],
    ['one option', [{ ...color, options: [{ label: 'Only' }] }]],
    ['five options', [{ ...color, options: [1, 2, 3, 4, 5].map((n) => ({ label: `O${n}` })) }]],
    ['a blank label', [{ ...color, options: [{ label: ' ' }, { label: 'B' }] }]],
    ['a blank header', [{ ...color, header: ' ' }]],
    ['no header', [{ question: 'Q?', options: color.options }]],
    ['an object', { questions: [color] }],
    ['empty text (a hook path that is missing)', ''],
  ])('refuses %s', (_name, value) => {
    expect(parseQuestions(value)).toBeUndefined();
  });
});

describe('the cards', () => {
  it('are one per question: its text, its choice under its header, Other, Send (golden)', () => {
    const [only, ...rest] = buildQuestionCards([color], ctx);
    expect(rest).toEqual([]);
    expect(only?.text).toBe('Claude asks: Which color?');
    expect(only?.card).toEqual({
      v: 1,
      header: { title: 'Claude asks' },
      body: [{ type: 'text', text: 'Which color?' }],
      inputs: [
        {
          type: 'choice',
          id: 'q1',
          label: 'Color',
          required: false,
          options: [
            { id: 'o1', label: 'Blue', description: 'The default; runs everywhere.' },
            { id: 'o2', label: 'Green' },
          ],
        },
        {
          type: 'text_input',
          id: 'q1_other',
          label: 'Other',
          placeholder: 'Or type your own answer',
          multiline: true,
          max_length: 2000,
          required: false,
        },
      ],
      actions: [{ type: 'submit', label: 'Send' }],
      responses: {
        mode: 'once',
        visibility: 'private',
        results: 'hidden',
        guests: false,
        confirm: true,
        closes_at: '2026-10-28T11:00:00.000Z',
      },
      private: { v: 1, map: { q1: { o1: 'Blue', o2: 'Green' } } },
    });
    expect(questionCardProblem(only?.card, NOW)).toBeUndefined();
  });

  it('number themselves "Question n of N" when there are several, in order', () => {
    const cards = buildQuestionCards([color, targets], ctx);
    expect(cards.map((c) => c.question)).toEqual([color, targets]);
    expect(cards.map((c) => c.text)).toEqual([
      'Claude asks: Which color?',
      'Claude asks: Which targets?',
    ]);
    expect(cards.map((c) => c.card.header)).toEqual([
      { title: 'Claude asks', subtitle: 'Question 1 of 2' },
      { title: 'Claude asks', subtitle: 'Question 2 of 2' },
    ]);
    const second = cards[1]!.card;
    expect(bodyOf(second)).toEqual([{ type: 'text', text: 'Which targets?' }]);
    const [choice, other] = inputsOf(second);
    expect(choice).toMatchObject({ id: 'q1', label: 'Targets', multiple: true, required: false });
    expect(choice?.options).toEqual([
      { id: 'o1', label: 'Windows' },
      { id: 'o2', label: 'macOS' },
      { id: 'o3', label: 'Linux' },
    ]);
    expect(other).toMatchObject({ id: 'q1_other', required: false });
    expect(inputsOf(cards[0]!.card)[0]).not.toHaveProperty('multiple');
    expect(second.private).toEqual({
      v: 1,
      map: { q1: { o1: 'Windows', o2: 'macOS', o3: 'Linux' } },
    });
    for (const c of cards) expect(questionCardProblem(c.card, NOW)).toBeUndefined();
  });

  it('keep line breaks and Markdown in questions and descriptions, and cut only over 2,000', () => {
    const rich: Question = {
      question: `Pick **one**:\n\n- the\tfirst${BIDI_OVERRIDE}\n- the second${BELL}`,
      header: 'Pick\nit',
      options: [
        { label: 'Long', description: `First *line*\nsecond line ${'w'.repeat(2100)}` },
        { label: 'Blank', description: ` \n\t${BIDI_OVERRIDE} ` },
        { label: 'Two\nlines', description: 'Use `code` and a [link](https://example.com).' },
      ],
    };
    const card = cardOf(rich);
    expect(bodyOf(card)).toEqual([
      { type: 'text', text: 'Pick **one**:\n\n- the first\n- the second' },
    ]);
    const [choice] = inputsOf(card);
    expect(choice?.label).toBe('Pick it');
    const options = choice?.options ?? [];
    const long = options[0]?.description as string;
    expect(long.startsWith('First *line*\nsecond line www')).toBe(true);
    expect(Array.from(long)).toHaveLength(2000);
    expect(long.endsWith('…')).toBe(true);
    expect(options[1]).toEqual({ id: 'o2', label: 'Blank' });
    expect(options[2]).toEqual({
      id: 'o3',
      label: 'Two lines',
      description: 'Use `code` and a [link](https://example.com).',
    });
    expect(questionCardProblem(card, NOW)).toBeUndefined();
    // A description at the limit is left whole.
    expect(cleanText('d'.repeat(2000), 2000)).toBe('d'.repeat(2000));
  });

  it('split a question over 2,000 characters over text elements, cutting nothing', () => {
    const paragraph = `${'word '.repeat(150).trim()}\n`;
    const long: Question = { ...color, question: paragraph.repeat(7).trim() };
    const body = bodyOf(cardOf(long));
    expect(body.length).toBeGreaterThan(1);
    for (const b of body) expect(Array.from(b.text).length).toBeLessThanOrEqual(2000);
    expect(body.map((b) => b.text).join('\n')).toBe(long.question);
    expect(splitText('x'.repeat(4500), 2000).map((p) => p.length)).toEqual([2000, 2000, 500]);
  });

  it('keep every description whole when each question has long ones', () => {
    const wordy = (n: number): Question => ({
      question: `Question ${n}?`,
      header: `Q${n}`,
      options: [1, 2, 3, 4].map((o) => ({ label: `Option ${o}`, description: 'd'.repeat(1500) })),
    });
    for (const c of buildQuestionCards([wordy(1), wordy(2), wordy(3), wordy(4)], ctx)) {
      expect(questionCardProblem(c.card, NOW)).toBeUndefined();
      expect(inputsOf(c.card)[0]?.options?.map((o) => o.description)).toEqual(
        Array(4).fill('d'.repeat(1500)),
      );
    }
  });

  it('shrink a single question that alone is over the limits until it fits', () => {
    const tall: Question = { ...color, question: `${'line of text\n'.repeat(1500)}?` };
    const size = cardSize(cardOf(tall));
    expect(size.bytes).toBeLessThanOrEqual(CARD_MAX_BYTES);
    expect(size.elements).toBeLessThanOrEqual(CARD_MAX_ELEMENTS);
    expect(questionCardProblem(cardOf(tall), NOW)).toBeUndefined();
    const huge: Question = {
      question: 'q'.repeat(20_000),
      header: 'Huge',
      options: [1, 2, 3, 4].map((o) => ({ label: `O${o}`, description: 'd'.repeat(10_000) })),
    };
    expect(questionCardProblem(cardOf(huge), NOW)).toBeUndefined();
  });

  it('remove control and bidi characters, and keep labels to one line of 80', () => {
    const hostile: Question = {
      question: `Pick${BIDI_OVERRIDE} one${BELL} now?`,
      header: `H${String.fromCharCode(0x2066)}dr`,
      options: [{ label: `A${String.fromCharCode(0x200f)}\tB` }, { label: 'x'.repeat(100) }],
    };
    const card = cardOf(hostile);
    expect(bodyOf(card)[0]?.text).toBe('Pick one now?');
    const choice = inputsOf(card)[0];
    expect(choice?.label).toBe('Hdr');
    expect(choice?.options?.[0]?.label).toBe('A B');
    expect(Array.from(choice?.options?.[1]?.label as string)).toHaveLength(80);
    expect(cleanLine('x'.repeat(40), 30)).toBe(`${'x'.repeat(29)}…`);
  });

  it("get their own ids, the first one the tool call's", () => {
    const first = uuidV5('toolu_1');
    const ids = cardIds(first, 3);
    expect(ids[0]).toBe(first);
    expect(new Set(ids).size).toBe(3);
    expect(cardIds(first, 3)).toEqual(ids);
  });

  it('close a minute after the wait, at most a day after they are posted', () => {
    expect(closesAt(NOW, 600)).toBe('2026-10-28T10:11:00.000Z');
    expect(closesAt(NOW, 86_400)).toBe('2026-10-29T10:00:00.000Z');
  });
});

describe('words', () => {
  it("follow the owner's locale, English when unknown", () => {
    expect(cardLocale('es-MX')).toBe('es-419');
    expect(cardLocale('fr')).toBe('fr-CA');
    expect(cardLocale('sr-Cyrl-RS')).toBe('sr-Cyrl');
    expect(cardLocale('sr')).toBe('sr-Latn');
    expect(cardLocale('de')).toBe('en');
    expect(cardLocale(undefined)).toBe('en');
    for (const [locale, other, placeholder, send, title, subtitle] of [
      [
        'es-419',
        'Otra',
        'O escribe tu propia respuesta',
        'Enviar',
        'Claude pregunta',
        'Pregunta 2 de 2',
      ],
      [
        'fr-CA',
        'Autre',
        'Ou écrivez votre propre réponse',
        'Envoyer',
        'Claude demande',
        'Question 2 sur 2',
      ],
      ['sr-Cyrl', 'Друго', 'Или упишите свој одговор', 'Пошаљи', 'Claude пита', 'Питање 2 од 2'],
      ['sr-Latn', 'Drugo', 'Ili upišite svoj odgovor', 'Pošalji', 'Claude pita', 'Pitanje 2 od 2'],
    ] as const) {
      const card = buildQuestionCards([color, targets], { ...ctx, locale })[1]!.card;
      expect(card.header).toEqual({ title, subtitle });
      expect(inputsOf(card)[1]).toMatchObject({ label: other, placeholder });
      expect(card.actions).toEqual([{ type: 'submit', label: send }]);
    }
  });
});

describe('decodeAnswer', () => {
  it('joins labels in option order, then the Other text', () => {
    expect(decodeAnswer([targets], { inputs: { q1: ['o3', 'o1'], q1_other: 'FreeBSD' } })).toEqual({
      kind: 'answers',
      answers: { 'Which targets?': 'Windows, Linux, FreeBSD' },
    });
    expect(decodeAnswer([color], { inputs: { q1: 'o2' } })).toEqual({
      kind: 'answers',
      answers: { 'Which color?': 'Green' },
    });
  });

  it('takes the Other text alone, its lines kept, cleaned and cut to 2,000', () => {
    expect(
      decodeAnswer([color], { inputs: { q1_other: ` my${BIDI_OVERRIDE} own\ntext${BELL} ` } }),
    ).toEqual({
      kind: 'answers',
      answers: { 'Which color?': 'my own\ntext' },
    });
    expect(cleanOther('y'.repeat(2000))).toHaveLength(2000);
    expect(cleanOther('y'.repeat(2900))).toHaveLength(2000);
    expect(cleanOther('y'.repeat(2900)).endsWith('…')).toBe(true);
  });

  it('refuses an answer with neither a choice nor Other text', () => {
    for (const answer of [
      { inputs: {} },
      { inputs: { q1: 'o9', q1_other: '  ' } },
      { action: 'o1' },
    ]) {
      expect(decodeAnswer([color], answer)).toEqual({ kind: 'reject', note: 'answer_each' });
    }
  });
});

describe('the message id', () => {
  it('is a version 5 UUID (RFC 9562 vector)', () => {
    expect(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    );
  });

  it("comes from the tool call's id, else the session, the questions and the minute", () => {
    const a = askMessageId({
      toolUseId: 'toolu_1',
      sessionId: 's',
      questions: [color],
      nowMs: NOW,
    });
    expect(a).toBe(uuidV5('toolu_1'));
    expect(askMessageId({ toolUseId: 'toolu_1', sessionId: 'x', questions: [], nowMs: 0 })).toBe(a);
    const b = askMessageId({ sessionId: 's', questions: [color], nowMs: NOW });
    expect(
      askMessageId({ toolUseId: '', sessionId: 's', questions: [color], nowMs: NOW + 1000 }),
    ).toBe(b);
    expect(askMessageId({ sessionId: 's', questions: [color], nowMs: NOW + 60_000 })).not.toBe(b);
    expect(askMessageId({ sessionId: 's', questions: [targets], nowMs: NOW })).not.toBe(b);
  });
});

describe("the hook's output", () => {
  it('allows AskUserQuestion with the answers (golden)', () => {
    expect(
      hookAllow([color, targets], {
        'Which color?': 'Blue',
        'Which targets?': 'Windows, macOS',
      }),
    ).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"questions":[{"question":"Which color?","header":"Color","options":[{"label":"Blue","description":"The default; runs everywhere."},{"label":"Green"}]},{"question":"Which targets?","header":"Targets","options":[{"label":"Windows"},{"label":"macOS"},{"label":"Linux"}],"multiSelect":true}],"answers":{"Which color?":"Blue","Which targets?":"Windows, macOS"}}}}',
    );
  });

  it('denies with the reason Claude reads (golden), or passes with {}', () => {
    expect(hookDeny(noAnswerText('timeout', 59))).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Nobody answered this question in buildIt.Social within 59 minutes, so the card was closed. Don\'t ask it again now: make a safe assumption and say which one you made, or stop and tell the person what you need."}}',
    );
    expect(JSON.parse(hookDeny(noAnswerText('dismissed', 1)))).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('dismissed this question') as unknown,
      },
    });
    expect(noAnswerText('session_ended', 1)).toContain('session ended before anyone answered');
    expect(noAnswerText('closed', 1)).toContain('card was closed in buildIt.Social');
    expect(HOOK_PASS).toBe('{}');
  });
});
