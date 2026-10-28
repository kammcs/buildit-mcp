/**
 * ask's pieces on their own: reading the questions, the card (always a
 * form: each question's text, a choice with its options' descriptions, and
 * Other), splitting a set that doesn't fit one card, decoding answers, the
 * words in each language, the card message's ids, and the hook's exact JSON.
 */
import { describe, expect, it } from 'vitest';

import {
  askMessageId,
  buildQuestionCard,
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
  it("is a form: the question's text, a required choice under its header, Other, Send (golden)", () => {
    const built = buildQuestionCard([color], ctx);
    expect(built.text).toBe('Claude asks: Which color?');
    expect(built.card).toEqual({
      v: 1,
      header: { title: 'Claude has questions' },
      body: [{ type: 'text', text: 'Which color?' }],
      inputs: [
        {
          type: 'choice',
          id: 'q1',
          label: 'Color',
          required: true,
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
    expect(questionCardProblem(built.card, NOW)).toBeUndefined();
  });

  it('asks several questions in one form, in order, multi-select where asked', () => {
    const built = buildQuestionCard([color, targets], ctx);
    expect(built.text).toBe('Claude asks:\n- Which color?\n- Which targets?');
    expect(bodyOf(built.card).map((b) => b.text)).toEqual(['Which color?', 'Which targets?']);
    const inputs = inputsOf(built.card);
    expect(inputs.map((i) => [i.type, i.id, i.label])).toEqual([
      ['choice', 'q1', 'Color'],
      ['text_input', 'q1_other', 'Other'],
      ['choice', 'q2', 'Targets'],
      ['text_input', 'q2_other', 'Other'],
    ]);
    expect(inputs[0]).not.toHaveProperty('multiple');
    expect(inputs[2]).toMatchObject({ multiple: true, required: true });
    expect(inputs[2]?.options).toEqual([
      { id: 'o1', label: 'Windows' },
      { id: 'o2', label: 'macOS' },
      { id: 'o3', label: 'Linux' },
    ]);
    expect(inputs[1]).not.toHaveProperty('required');
    expect(questionCardProblem(built.card, NOW)).toBeUndefined();
  });

  it('keeps line breaks and Markdown in questions and descriptions, and cuts only over 2,000', () => {
    const rich: Question = {
      question: `Pick **one**:\n\n- the\tfirst${BIDI_OVERRIDE}\n- the second${BELL}`,
      header: 'Pick\nit',
      options: [
        { label: 'Long', description: `First *line*\nsecond line ${'w'.repeat(2100)}` },
        { label: 'Blank', description: ` \n\t${BIDI_OVERRIDE} ` },
        { label: 'Two\nlines', description: 'Use `code` and a [link](https://example.com).' },
      ],
    };
    const card = buildQuestionCard([rich], ctx).card;
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

  it('splits a question over 2,000 characters over text elements, cutting nothing', () => {
    const paragraph = `${'word '.repeat(150).trim()}\n`;
    const long: Question = { ...color, question: paragraph.repeat(7).trim() };
    const body = bodyOf(buildQuestionCard([long], ctx).card);
    expect(body.length).toBeGreaterThan(1);
    for (const b of body) expect(Array.from(b.text).length).toBeLessThanOrEqual(2000);
    expect(body.map((b) => b.text).join('\n')).toBe(long.question);
    expect(splitText('x'.repeat(4500), 2000).map((p) => p.length)).toEqual([2000, 2000, 500]);
  });

  it('removes control and bidi characters, and keeps labels to one line of 80', () => {
    const hostile: Question = {
      question: `Pick${BIDI_OVERRIDE} one${BELL} now?`,
      header: `H${String.fromCharCode(0x2066)}dr`,
      options: [{ label: `A${String.fromCharCode(0x200f)}\tB` }, { label: 'x'.repeat(100) }],
    };
    const card = buildQuestionCard([hostile], ctx).card;
    expect(bodyOf(card)[0]?.text).toBe('Pick one now?');
    const choice = inputsOf(card)[0];
    expect(choice?.label).toBe('Hdr');
    expect(choice?.options?.[0]?.label).toBe('A B');
    expect(Array.from(choice?.options?.[1]?.label as string)).toHaveLength(80);
    expect(cleanLine('x'.repeat(40), 30)).toBe(`${'x'.repeat(29)}…`);
  });

  it('closes a minute after the wait, at most a day after it is posted', () => {
    expect(closesAt(NOW, 600)).toBe('2026-10-28T10:11:00.000Z');
    expect(closesAt(NOW, 86_400)).toBe('2026-10-29T10:00:00.000Z');
  });
});

describe('a set that does not fit one card', () => {
  const wordy = (n: number): Question => ({
    question: `Question ${n}?`,
    header: `Q${n}`,
    options: [1, 2, 3, 4].map((o) => ({ label: `Option ${o}`, description: 'd'.repeat(1500) })),
  });

  it('stays one card when it fits', () => {
    const cards = buildQuestionCards([color, targets], ctx);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.questions).toEqual([color, targets]);
  });

  it('is one card per question, in order, each within the limits', () => {
    const set = [wordy(1), wordy(2), wordy(3), wordy(4)];
    expect(cardSize(buildQuestionCard(set, ctx).card).bytes).toBeGreaterThan(CARD_MAX_BYTES);
    const cards = buildQuestionCards(set, ctx);
    expect(cards.map((c) => c.questions)).toEqual(set.map((q) => [q]));
    expect(cards.map((c) => c.text)).toEqual(set.map((q) => `Claude asks: ${q.question}`));
    for (const c of cards) {
      expect(questionCardProblem(c.card, NOW)).toBeUndefined();
      // Nothing was cut: each description is whole.
      expect(inputsOf(c.card)[0]?.options?.[0]?.description).toBe('d'.repeat(1500));
    }
  });

  it('splits by elements too, and shrinks a single question that alone is too big', () => {
    const tall: Question = { ...color, question: `${'line of text\n'.repeat(1500)}?` };
    const cards = buildQuestionCards([tall, targets], ctx);
    expect(cards).toHaveLength(2);
    const size = cardSize(cards[0]!.card);
    expect(size.bytes).toBeLessThanOrEqual(CARD_MAX_BYTES);
    expect(size.elements).toBeLessThanOrEqual(CARD_MAX_ELEMENTS);
    expect(questionCardProblem(cards[0]!.card, NOW)).toBeUndefined();
    const huge: Question = {
      question: 'q'.repeat(20_000),
      header: 'Huge',
      options: [1, 2, 3, 4].map((o) => ({ label: `O${o}`, description: 'd'.repeat(10_000) })),
    };
    const [one] = buildQuestionCards([huge], ctx);
    expect(questionCardProblem(one!.card, NOW)).toBeUndefined();
  });

  it("gives each card its own id, the first one the tool call's", () => {
    const first = uuidV5('toolu_1');
    const ids = cardIds(first, 3);
    expect(ids[0]).toBe(first);
    expect(new Set(ids).size).toBe(3);
    expect(cardIds(first, 3)).toEqual(ids);
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
    for (const [locale, other, placeholder, send, title] of [
      ['es-419', 'Otra', 'O escribe tu propia respuesta', 'Enviar', 'Claude tiene preguntas'],
      ['fr-CA', 'Autre', 'Ou écrivez votre propre réponse', 'Envoyer', 'Claude a des questions'],
      ['sr-Cyrl', 'Друго', 'Или упишите свој одговор', 'Пошаљи', 'Claude има питања'],
      ['sr-Latn', 'Drugo', 'Ili upišite svoj odgovor', 'Pošalji', 'Claude ima pitanja'],
    ] as const) {
      const form = buildQuestionCard([color, targets], { ...ctx, locale });
      expect(form.card.header).toEqual({ title });
      expect(inputsOf(form.card)[1]).toMatchObject({ label: other, placeholder });
      expect(form.card.actions).toEqual([{ type: 'submit', label: send }]);
    }
  });
});

describe('decodeAnswer', () => {
  it('joins labels in option order, then the Other text, per question', () => {
    expect(
      decodeAnswer([color, targets], {
        inputs: { q1: 'o1', q2: ['o3', 'o1'], q2_other: 'FreeBSD' },
      }),
    ).toEqual({
      kind: 'answers',
      answers: { 'Which color?': 'Blue', 'Which targets?': 'Windows, Linux, FreeBSD' },
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

  it('refuses a question left unanswered, or an answer that is not a form', () => {
    expect(decodeAnswer([color, targets], { inputs: { q1: 'o1' } })).toEqual({
      kind: 'reject',
      note: 'answer_each',
    });
    expect(decodeAnswer([color], { inputs: { q1: 'o9', q1_other: '  ' } })).toEqual({
      kind: 'reject',
      note: 'answer_each',
    });
    expect(decodeAnswer([color], { action: 'o1' })).toEqual({
      kind: 'reject',
      note: 'answer_each',
    });
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
