/**
 * Plan mode on Codex (`collaborationMode: plan`, experimental): a work
 * item's turns plan first, and the finished plan (a `plan` item of the
 * turn) becomes an Approve/Deny card in the item's thread. Approve starts
 * the next turn in default mode, telling Codex to carry the plan out;
 * Deny leaves the item planning (the person writes what to change).
 *
 * - **The card shows the whole plan:** split into fields of at most 3,000
 *   characters at line breaks. A plan too long for one card (more than
 *   three fields) is posted in full in the thread first, in messages of at
 *   most 4,000 characters, and the card says so. Masked or cut, it can't
 *   be approved (the approval cards' rule).
 * - **Plan updates** (`turn/plan/updated`, Codex's checklist while it
 *   works) are posted only when the setting says so (off by default): one
 *   message per update in the turn's thread.
 */
import type { CardSpec } from './approvals.js';
import { splitText } from './text.js';

/** A field of the plan card holds at most this many characters. */
export const PLAN_FIELD_MAX = 3000;
/** A plan card has at most this many plan fields. */
export const PLAN_FIELDS_MAX = 3;

/** The plan card's words (static text). */
export const PLAN_DESCRIPTION = "Codex's plan for this item. Approve to let Codex carry it out.";
export const PLAN_ABOVE = 'The plan is in the messages just above this card, in full.';

/** What Codex is told when the person approves its plan (static text). */
export const PLAN_APPROVED =
  'The person approved your plan in buildIt.Social. Carry it out now, step by step, and keep them up to date in the thread.';

/** Splits a plan into fields' values at line breaks (a longer line is cut). */
export function planParts(text: string, max: number = PLAN_FIELD_MAX): string[] {
  const parts: string[] = [];
  let current = '';
  for (const line of text.trim().split('\n')) {
    let rest = line;
    while (rest.length > max) {
      if (current !== '') parts.push(current);
      current = '';
      parts.push(rest.slice(0, max));
      rest = rest.slice(max);
    }
    const next = current === '' ? rest : `${current}\n${rest}`;
    if (next.length > max) {
      parts.push(current);
      current = rest;
    } else {
      current = next;
    }
  }
  if (current.trim() !== '') parts.push(current);
  return parts;
}

/** The plan's card, and the posts that must come before it when it doesn't fit. */
export function planCard(text: string): { spec: CardSpec; before: string[] } {
  const parts = planParts(text);
  const fits = parts.length <= PLAN_FIELDS_MAX;
  const input: Record<string, unknown> = {};
  if (fits) {
    parts.forEach((p, i) => {
      input[i === 0 ? 'plan' : `plan (${i + 1})`] = p;
    });
  } else {
    input.plan = PLAN_ABOVE;
  }
  return {
    spec: { toolName: 'plan', description: PLAN_DESCRIPTION, input, accept: {}, decline: {} },
    before: fits ? [] : splitText(text),
  };
}

/** One step of Codex's checklist. */
interface Step {
  step: string;
  status: string;
}

const MARK: Readonly<Record<string, string>> = {
  completed: '[x]',
  inProgress: '[~]',
  pending: '[ ]',
};

/** A plan update as a post: its explanation (when given), then the steps as a checklist. */
export function planUpdateText(params: Record<string, unknown>): string | undefined {
  const plan = Array.isArray(params.plan) ? params.plan : [];
  const steps: Step[] = plan
    .map((s) => s as Partial<Step>)
    .filter((s): s is Step => typeof s.step === 'string' && s.step.trim() !== '')
    .map((s) => ({ step: s.step, status: typeof s.status === 'string' ? s.status : 'pending' }));
  if (steps.length === 0) return undefined;
  const explanation =
    typeof params.explanation === 'string' && params.explanation.trim() !== ''
      ? [params.explanation.trim(), '']
      : [];
  return [
    ...explanation,
    ...steps.map((s) => `- ${MARK[s.status] ?? '[ ]'} ${s.step.replace(/\s+/g, ' ').trim()}`),
  ].join('\n');
}
