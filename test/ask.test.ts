/**
 * ask's pieces on their own: reading the questions, the card (one per ask:
 * a text per question, then each question's choice with its options'
 * descriptions and its Other field, Send), shrinking it to the limits,
 * decoding answers, the words in each language, the card message's id, the
 * older server's refusal, and the hook's exact JSON.
 */
import { describe, expect, it } from 'vitest';

import { ApiError } from '../src/api/client.js';
import {
  askMessageId,
  buildQuestionCard,
  cardLocale,
  cardResponses,
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
  refusesResponses,
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
const cardOf = (q: Question, c = ctx): Record<string, unknown> => buildQuestionCard([q], c).card;
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

describe('the card', () => {
  const responses = {
    mode: 'once',
    visibility: 'private',
    results: 'hidden',
    guests: false,
    confirm: true,
    closes_at: '2026-10-28T11:00:00.000Z',
  };
  const other = (n: number) => ({
    type: 'text_input',
    id: `q${n}_other`,
    label: 'Other',
    placeholder: 'Or type your own answer',
    multiline: true,
    max_length: 2000,
    required: false,
  });
  const colorChoice = (n: number) => ({
    type: 'choice',
    id: `q${n}`,
    label: 'Color',
    required: false,
    options: [
      { id: 'o1', label: 'Blue', description: 'The default; runs everywhere.' },
      { id: 'o2', label: 'Green' },
    ],
  });
  const targetsChoice = (n: number) => ({
    type: 'choice',
    id: `q${n}`,
    label: 'Targets',
    multiple: true,
    required: false,
    options: [
      { id: 'o1', label: 'Windows' },
      { id: 'o2', label: 'macOS' },
      { id: 'o3', label: 'Linux' },
    ],
  });

  it('for one question: its text, its choice under its header, Other, Send (golden)', () => {
    const built = buildQuestionCard([color], ctx);
    expect(built.questions).toEqual([color]);
    expect(built.text).toBe('Claude asks: Which color?');
    expect(built.card).toEqual({
      v: 1,
      header: { title: 'Claude asks' },
      body: [{ type: 'text', text: 'Which color?' }],
      inputs: [colorChoice(1), other(1)],
      actions: [{ type: 'submit', label: 'Send' }],
      responses,
      private: { v: 1, map: { q1: { o1: 'Blue', o2: 'Green' } } },
    });
    expect(questionCardProblem(built.card, NOW)).toBeUndefined();
  });

  it('for two questions: one card, "2 questions", a text and a pair of inputs each (golden)', () => {
    const built = buildQuestionCard([color, targets], ctx);
    expect(built.text).toBe('Claude asks 2 questions: Which color?');
    expect(built.card).toEqual({
      v: 1,
      header: { title: 'Claude asks', subtitle: '2 questions' },
      body: [
        { type: 'text', text: 'Which color?' },
        { type: 'text', text: 'Which targets?' },
      ],
      inputs: [colorChoice(1), other(1), targetsChoice(2), other(2)],
      actions: [{ type: 'submit', label: 'Send' }],
      responses,
      private: {
        v: 1,
        map: { q1: { o1: 'Blue', o2: 'Green' }, q2: { o1: 'Windows', o2: 'macOS', o3: 'Linux' } },
      },
    });
    expect(questionCardProblem(built.card, NOW)).toBeUndefined();
  });

  it('for four questions: 4 texts, q1..q4 with their Other fields, one submit (golden)', () => {
    const set = [color, targets, { ...color, question: 'And the border?' }, targets];
    const built = buildQuestionCard(set, ctx);
    expect(built.text).toBe('Claude asks 4 questions: Which color?');
    expect(built.card).toEqual({
      v: 1,
      header: { title: 'Claude asks', subtitle: '4 questions' },
      body: [
        { type: 'text', text: 'Which color?' },
        { type: 'text', text: 'Which targets?' },
        { type: 'text', text: 'And the border?' },
        { type: 'text', text: 'Which targets?' },
      ],
      inputs: [
        colorChoice(1),
        other(1),
        targetsChoice(2),
        other(2),
        colorChoice(3),
        other(3),
        targetsChoice(4),
        other(4),
      ],
      actions: [{ type: 'submit', label: 'Send' }],
      responses,
      private: {
        v: 1,
        map: {
          q1: { o1: 'Blue', o2: 'Green' },
          q2: { o1: 'Windows', o2: 'macOS', o3: 'Linux' },
          q3: { o1: 'Blue', o2: 'Green' },
          q4: { o1: 'Windows', o2: 'macOS', o3: 'Linux' },
        },
      },
    });
    expect(cardSize(built.card).elements).toBe(13);
    expect(questionCardProblem(built.card, NOW)).toBeUndefined();
  });

  it("takes shared answers, results on close, in an item's thread", () => {
    const card = buildQuestionCard([color, targets], { ...ctx, shared: true }).card;
    expect(card.responses).toEqual({ ...responses, visibility: 'shared', results: 'on_close' });
    expect(cardResponses(ctx.closesAt)).toEqual(responses);
    expect(questionCardProblem(card, NOW)).toBe('responses.visibility');
    expect(questionCardProblem(card, NOW, { sharedResults: true })).toBeUndefined();
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

  it('give each question exactly one text element, cut at 2,000 with "…"', () => {
    const paragraph = `${'word '.repeat(150).trim()}\n`;
    const long: Question = { ...color, question: paragraph.repeat(7).trim() };
    const body = bodyOf(buildQuestionCard([long, targets], ctx).card);
    expect(body).toHaveLength(2);
    expect(Array.from(body[0]!.text)).toHaveLength(2000);
    expect(body[0]!.text.endsWith('…')).toBe(true);
    expect(long.question.startsWith(body[0]!.text.slice(0, -1))).toBe(true);
    expect(body[1]).toEqual({ type: 'text', text: 'Which targets?' });
  });

  it('keep every description whole when the set fits', () => {
    const set = [1, 2].map((n) => ({
      question: `Question ${n}?`,
      header: `Q${n}`,
      options: [1, 2, 3].map((o) => ({ label: `Option ${o}`, description: 'd'.repeat(1500) })),
    }));
    const card = buildQuestionCard(set, ctx).card;
    expect(questionCardProblem(card, NOW)).toBeUndefined();
    for (const choice of inputsOf(card).filter((i) => i.type === 'choice')) {
      expect(choice.options?.map((o) => o.description)).toEqual(Array(3).fill('d'.repeat(1500)));
    }
  });

  describe('shrink to 16 KB and 25 elements', () => {
    const wordy = (n: number, description = 2000, question = 20): Question => ({
      question: `Question ${n}? ${'q'.repeat(question)}`,
      header: `Q${n}`,
      options: [1, 2, 3, 4].map((o) => ({
        label: `Option ${o}`,
        description: 'd'.repeat(description),
      })),
    });

    it('cutting the longest descriptions first, keeping the questions whole', () => {
      const set = [1, 2, 3, 4].map((n) => wordy(n, 2000, 1000));
      const card = buildQuestionCard(set, ctx).card;
      const size = cardSize(card);
      expect(size.bytes).toBeLessThanOrEqual(CARD_MAX_BYTES);
      expect(size.elements).toBe(13);
      expect(size.elements).toBeLessThanOrEqual(CARD_MAX_ELEMENTS);
      expect(questionCardProblem(card, NOW)).toBeUndefined();
      // Every question whole; every description cut, with "…", evenly.
      expect(bodyOf(card).map((b) => b.text)).toEqual(set.map((q) => q.question));
      const descriptions = inputsOf(card)
        .flatMap((i) => i.options ?? [])
        .map((o) => o.description as string);
      expect(descriptions).toHaveLength(16);
      for (const d of descriptions) {
        expect(d.endsWith('…')).toBe(true);
        expect(Array.from(d).length).toBeLessThan(2000);
        expect(Array.from(d).length).toBeGreaterThan(200);
      }
      // The private map still names every option.
      expect(Object.keys((card.private as { map: object }).map)).toEqual(['q1', 'q2', 'q3', 'q4']);
    });

    it('then the longest question texts, when descriptions are short already', () => {
      // Four 2,000-character questions of 3-byte characters are 24 KB alone.
      const wide = (n: number): Question => ({
        question: `${n}${'問'.repeat(5000)}`,
        header: `Q${n}`,
        options: [{ label: 'A', description: 'short' }, { label: 'B' }],
      });
      const card = buildQuestionCard([wide(1), wide(2), wide(3), wide(4)], ctx).card;
      expect(cardSize(card).bytes).toBeLessThanOrEqual(CARD_MAX_BYTES);
      expect(questionCardProblem(card, NOW)).toBeUndefined();
      const texts = bodyOf(card).map((b) => b.text);
      expect(texts).toHaveLength(4);
      for (const [i, t] of texts.entries()) {
        expect(t.startsWith(`${i + 1}問`)).toBe(true);
        expect(t.endsWith('…')).toBe(true);
      }
      expect(inputsOf(card)[0]?.options?.[0]?.description).toBe('short');
    });

    it('in every case, even the largest set this reads', () => {
      const huge = (n: number): Question => ({
        question: `${n}${'q'.repeat(20_000)}`,
        header: 'Huge',
        options: [1, 2, 3, 4].map((o) => ({ label: `O${o}`, description: 'd'.repeat(10_000) })),
      });
      const card = buildQuestionCard([huge(1), huge(2), huge(3), huge(4)], ctx).card;
      expect(questionCardProblem(card, NOW)).toBeUndefined();
      expect(bodyOf(card)).toHaveLength(4);
      const shared = buildQuestionCard([huge(1), huge(2), huge(3), huge(4)], {
        ...ctx,
        shared: true,
      }).card;
      expect(questionCardProblem(shared, NOW, { sharedResults: true })).toBeUndefined();
    });
  });

  it('cut the private map of every question to 2,048 bytes, the card keeping its labels', () => {
    // 16 labels of 80 three-byte characters are 3,840 bytes: the map takes them cut to 20.
    const wide = (n: number): Question => ({
      question: `Q${n}?`,
      header: `H${n}`,
      options: [1, 2, 3, 4].map((o) => ({ label: `${o}${'界'.repeat(90)}` })),
    });
    const card = buildQuestionCard([1, 2, 3, 4].map(wide), ctx).card;
    const map = (card.private as { v: number; map: Record<string, Record<string, string>> }).map;
    expect(Object.keys(map)).toEqual(['q1', 'q2', 'q3', 'q4']);
    expect(Buffer.byteLength(JSON.stringify(card.private))).toBeLessThanOrEqual(2048);
    expect(map.q4?.o4).toBe(`4${'界'.repeat(18)}…`);
    expect(Array.from(inputsOf(card)[6]?.options?.[3]?.label as string)).toHaveLength(80);
    expect(questionCardProblem(card, NOW)).toBeUndefined();
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
    for (const [locale, other, placeholder, send, title, subtitle, body] of [
      [
        'en',
        'Other',
        'Or type your own answer',
        'Send',
        'Claude asks',
        '3 questions',
        'Claude asks 3 questions: Which color?',
      ],
      [
        'es-419',
        'Otra',
        'O escribe tu propia respuesta',
        'Enviar',
        'Claude pregunta',
        '3 preguntas',
        'Claude hace 3 preguntas: Which color?',
      ],
      [
        'fr-CA',
        'Autre',
        'Ou écrivez votre propre réponse',
        'Envoyer',
        'Claude demande',
        '3 questions',
        'Claude pose 3 questions : Which color?',
      ],
      [
        'sr-Cyrl',
        'Друго',
        'Или упишите свој одговор',
        'Пошаљи',
        'Claude пита',
        '3 питања',
        'Claude поставља 3 питања: Which color?',
      ],
      [
        'sr-Latn',
        'Drugo',
        'Ili upišite svoj odgovor',
        'Pošalji',
        'Claude pita',
        '3 pitanja',
        'Claude postavlja 3 pitanja: Which color?',
      ],
    ] as const) {
      const built = buildQuestionCard([color, targets, color], { ...ctx, locale });
      expect(built.card.header).toEqual({ title, subtitle });
      expect(built.text).toBe(body);
      expect(inputsOf(built.card)[5]).toMatchObject({ id: 'q3_other', label: other, placeholder });
      expect(built.card.actions).toEqual([{ type: 'submit', label: send }]);
      // One question: no subtitle, "<agent> asks: <question>".
      const one = buildQuestionCard([color], { ...ctx, locale });
      expect(one.card.header).toEqual({ title });
    }
    expect(buildQuestionCard([color], { ...ctx, locale: 'fr-CA' }).text).toBe(
      'Claude demande : Which color?',
    );
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

  it('decodes every question of the card, by qn and qn_other', () => {
    const third: Question = { ...color, question: 'And the border?' };
    expect(
      decodeAnswer([color, targets, third], {
        inputs: { q1: 'o1', q2: ['o2', 'o1'], q2_other: 'FreeBSD', q3_other: 'None' },
      }),
    ).toEqual({
      kind: 'answers',
      answers: {
        'Which color?': 'Blue',
        'Which targets?': 'Windows, macOS, FreeBSD',
        'And the border?': 'None',
      },
    });
  });

  it('refuses an answer that leaves any question unanswered', () => {
    const third: Question = { ...color, question: 'And the border?' };
    for (const inputs of [
      { q1: 'o1', q2: ['o1'] },
      { q1: 'o1', q3: 'o2' },
      { q2: ['o1'], q3: 'o2', q1_other: ' ' },
    ]) {
      expect(decodeAnswer([color, targets, third], { inputs })).toEqual({
        kind: 'reject',
        note: 'answer_each',
      });
    }
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

describe('refusesResponses', () => {
  const refusal = (code: string, details: unknown) =>
    new ApiError({ status: 422, code, message: 'No.', requestId: 'req_test', details });

  it("is a card_invalid naming a path under responses (an older server's refusal)", () => {
    expect(
      refusesResponses(
        refusal('card_invalid', { errors: [{ path: 'responses.visibility', message: 'x' }] }),
      ),
    ).toBe(true);
    expect(
      refusesResponses(refusal('card_invalid', { errors: [{ path: 'responses', message: 'x' }] })),
    ).toBe(true);
    expect(refusesResponses(refusal('card_invalid', { path: 'responses.results' }))).toBe(true);
  });

  it('is nothing else', () => {
    expect(
      refusesResponses(
        refusal('card_invalid', { errors: [{ path: 'body[0].text', message: 'x' }] }),
      ),
    ).toBe(false);
    expect(
      refusesResponses(refusal('card_invalid', { errors: [{ path: 'responsesX', message: 'x' }] })),
    ).toBe(false);
    expect(refusesResponses(refusal('validation', { fields: [{ path: 'responses' }] }))).toBe(
      false,
    );
    expect(refusesResponses(new Error('responses'))).toBe(false);
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
