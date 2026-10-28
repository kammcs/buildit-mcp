/**
 * ask's pieces on their own: reading the questions, the card for each
 * shape (buttons, the Other form, the form), decoding answers, the words
 * in each language, the card message's id, and the hook's exact JSON.
 */
import { describe, expect, it } from 'vitest';

import {
  askMessageId,
  buildQuestionCard,
  cardLocale,
  cleanLine,
  cleanOther,
  closesAt,
  decodeAnswer,
  hookAllow,
  hookDeny,
  HOOK_PASS,
  noAnswerText,
  otherFormCard,
  parseQuestions,
  usesButtons,
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
    ['no header', [{ question: 'Q?', options: color.options }]],
    ['an object', { questions: [color] }],
    ['empty text (a hook path that is missing)', ''],
  ])('refuses %s', (_name, value) => {
    expect(parseQuestions(value)).toBeUndefined();
  });
});

describe('the card', () => {
  it('uses buttons for one single-choice question with short labels, with Other…', () => {
    expect(usesButtons([color])).toBe(true);
    const built = buildQuestionCard([color], ctx);
    expect(built.kind).toBe('buttons');
    expect(built.text).toBe('Claude asks: Which color?');
    expect(built.card).toEqual({
      v: 1,
      header: { title: 'Which color?', subtitle: 'Color' },
      body: [{ type: 'facts', items: [{ label: 'Blue', value: 'The default; runs everywhere.' }] }],
      actions: [
        { type: 'button', id: 'o1', label: 'Blue' },
        { type: 'button', id: 'o2', label: 'Green' },
        { type: 'button', id: 'other', label: 'Other…' },
      ],
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

  it('puts a long question in the body, with the header as the title', () => {
    const long = { ...color, question: `${'Which one of these should we use '.repeat(6)}?` };
    const built = buildQuestionCard([long], ctx);
    expect(built.card.header).toEqual({ title: 'Color', subtitle: 'Color' });
    expect((built.card.body as unknown[])[0]).toEqual({ type: 'text', text: long.question });
    expect(questionCardProblem(built.card, NOW)).toBeUndefined();
  });

  it('turns into a one-field form for Other, with the same header, deadline and map', () => {
    const built = buildQuestionCard([color], ctx);
    const other = otherFormCard(built.card, 'fr-CA');
    expect(other.actions).toEqual([{ type: 'submit', label: 'Envoyer' }]);
    expect(other.inputs).toEqual([
      { type: 'text_input', id: 'other', label: 'Votre réponse', max_length: 500, required: true },
    ]);
    expect(other.header).toEqual(built.card.header);
    expect(other.responses).toEqual(built.card.responses);
    expect(other.private).toEqual(built.card.private);
    expect(questionCardProblem(other, NOW)).toBeUndefined();
  });

  it('uses a form for several questions, multi-select, or long labels', () => {
    const longLabel = {
      ...color,
      options: [{ label: 'A label that is far too long for a button' }, { label: 'B' }],
    };
    expect(usesButtons([longLabel])).toBe(false);
    expect(usesButtons([targets])).toBe(false);
    expect(usesButtons([color, targets])).toBe(false);
    const built = buildQuestionCard([color, targets], ctx);
    expect(built.kind).toBe('form');
    expect(built.text).toBe('Claude asks:\n- Which color?\n- Which targets?');
    expect(built.card).toMatchObject({
      v: 1,
      header: { title: 'Claude has questions' },
      body: [{ type: 'text', text: '**Color**\n• Blue: The default; runs everywhere.' }],
      inputs: [
        {
          type: 'choice',
          id: 'q1',
          label: 'Which color?',
          options: [
            { id: 'o1', label: 'Blue' },
            { id: 'o2', label: 'Green' },
          ],
        },
        { type: 'text_input', id: 'q1_other', label: 'Other answer', max_length: 500 },
        { type: 'choice', id: 'q2', label: 'Which targets?', multiple: true },
        { type: 'text_input', id: 'q2_other' },
      ],
      actions: [{ type: 'submit', label: 'Send' }],
    });
    expect((built.card.inputs as Record<string, unknown>[])[0]).not.toHaveProperty('multiple');
    expect(JSON.stringify(built.card)).not.toContain('required');
    expect(questionCardProblem(built.card, NOW)).toBeUndefined();
  });

  it('fits four questions with long text in the limits', () => {
    const big: Question = {
      question: `${'q'.repeat(1990)}?`,
      header: 'h'.repeat(200),
      options: [1, 2, 3, 4].map((n) => ({
        label: `${'x'.repeat(490)}${n}`,
        description: 'd'.repeat(1900),
      })),
      multiSelect: true,
    };
    const built = buildQuestionCard([big, big, big, big], ctx);
    expect(questionCardProblem(built.card, NOW)).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(built.card.private), 'utf8')).toBeLessThanOrEqual(2048);
    expect(Array.from(built.text).length).toBeLessThanOrEqual(4000);
  });

  it('removes control and bidi characters, and collapses white space in lines', () => {
    const hostile: Question = {
      question: 'Pick‮ one\u0007\nnow?',
      header: 'H⁦dr',
      options: [{ label: 'A‏\tB' }, { label: 'C' }],
    };
    const built = buildQuestionCard([hostile], ctx);
    expect(built.card.header).toEqual({ title: 'Pick one now?', subtitle: 'Hdr' });
    expect((built.card.actions as { label: string }[])[0]?.label).toBe('A B');
    expect(cleanLine('x'.repeat(40), 30)).toBe(`${'x'.repeat(29)}…`);
  });

  it('closes a minute after the wait, at most a day after it is posted', () => {
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
    for (const [locale, other, title] of [
      ['es-419', 'Otra…', 'Claude tiene preguntas'],
      ['fr-CA', 'Autre…', 'Claude a des questions'],
      ['sr-Cyrl', 'Друго…', 'Claude има питања'],
      ['sr-Latn', 'Drugo…', 'Claude ima pitanja'],
    ] as const) {
      const buttons = buildQuestionCard([color], { ...ctx, locale });
      expect((buttons.card.actions as { label: string }[]).at(-1)?.label).toBe(other);
      const form = buildQuestionCard([color, targets], { ...ctx, locale });
      expect(form.card.header).toEqual({ title });
    }
  });
});

describe('decodeAnswer', () => {
  it('maps a button to its label, and Other to the Other form', () => {
    expect(decodeAnswer([color], 'buttons', { action: 'o2' })).toEqual({
      kind: 'answers',
      answers: { 'Which color?': 'Green' },
    });
    expect(decodeAnswer([color], 'buttons', { action: 'other' })).toEqual({ kind: 'other' });
    expect(decodeAnswer([color], 'buttons', { action: 'o9' })).toEqual({
      kind: 'reject',
      note: 'answer_each',
    });
  });

  it("takes the Other form's text, cleaned, and refuses it empty", () => {
    expect(decodeAnswer([color], 'other_form', { inputs: { other: ' my‮ own\ntext ' } })).toEqual({
      kind: 'answers',
      answers: { 'Which color?': 'my own text' },
    });
    expect(decodeAnswer([color], 'other_form', { inputs: { other: '  ' } })).toEqual({
      kind: 'reject',
      note: 'type_below',
    });
    expect(cleanOther('y'.repeat(900))).toHaveLength(500);
  });

  it('joins labels in option order, then the Other text, per question', () => {
    expect(
      decodeAnswer([color, targets], 'form', {
        inputs: { q1: 'o1', q2: ['o3', 'o1'], q2_other: 'FreeBSD' },
      }),
    ).toEqual({
      kind: 'answers',
      answers: { 'Which color?': 'Blue', 'Which targets?': 'Windows, Linux, FreeBSD' },
    });
    // Only Other text answers a question too.
    expect(decodeAnswer([color], 'form', { inputs: { q1_other: 'Red' } })).toEqual({
      kind: 'answers',
      answers: { 'Which color?': 'Red' },
    });
  });

  it('refuses a form with a question left unanswered', () => {
    expect(decodeAnswer([color, targets], 'form', { inputs: { q1: 'o1' } })).toEqual({
      kind: 'reject',
      note: 'answer_each',
    });
    expect(decodeAnswer([color], 'form', { action: 'o1' })).toEqual({
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
