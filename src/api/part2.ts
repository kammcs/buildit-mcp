/**
 * Agent API 1.15.0: the parts this version uses before the API's 1.15.0
 * contract is copied into openapi/openapi.json.
 *
 * TODO(lane B openapi): this whole file is written by hand from the API's
 * announced 1.15.0 contract. Once openapi/openapi.json is 1.15.0 and
 * `npm run generate` has run, delete it: the plan actions create_items and
 * edit_items come from CreatePlanBody and PLAN_SCOPES, post_plan_card's
 * `request` from its body, ask_session_reporter from OPERATIONS (called
 * through ctx.call), and the error codes from ERROR_STATUS and ERROR_HINTS.
 *
 * - The plan actions create_items (new items, with subtasks and fields)
 *   and edit_items (fields, links and a description edit, per item), both
 *   at projects:write, one project per plan.
 * - post_plan_card's `request`: the card is that request's result, posted
 *   in the request's place (a channel thread or an item's thread).
 * - ask_session_reporter: a question to the person who sent a feedback
 *   report, through buildIt.Social's own template.
 * - PlanEffect's op and kind `link`.
 */
import { z } from 'zod';

import { OPERATIONS, type Scope } from './generated/operations.js';
import { ApplyPlanResponseSchema, PlanResultSchema } from './generated/schemas.js';
import type { OperationIO } from './generated/strict.js';
import type { ApiClient, ApiRequestOptions } from './client.js';
import { ToolInputError } from '../errors.js';

/** The agent API version that has everything here. */
export const PART2_API = '1.15.0';

// ---------------------------------------------------------------------------
// The plan actions
// ---------------------------------------------------------------------------

/** A label, a type or a status, by name. */
type NameRef = string;

/** A custom field's value by the field's name, as update_item takes them. */
type CustomValues = Record<string, string | number | boolean | string[] | null>;

/** A link's kind, seen from the item. */
export type LinkKind = 'blocks' | 'blocked_by' | 'relates' | 'duplicates' | 'duplicated_by';

/** One new item of create_items. */
export interface NewItemArgs {
  /** 1 to 20 characters, unique in the plan: a later item's parent may name it. */
  ref: string;
  title: string;
  type?: NameRef;
  description?: string;
  /** An existing item of the project (its key), or an earlier new one ({ref}). */
  parent?: string | { ref: string };
  priority?: 'none' | 'low' | 'medium' | 'high' | 'urgent';
  labels?: NameRef[];
  custom?: CustomValues;
  estimate?: number;
  assignee?: string;
  status?: NameRef;
}

/** create_items' args: 1 to 25 new items in one project. */
export interface CreateItemsArgs {
  project: string;
  items: NewItemArgs[];
}

/** One item's changes in edit_items. */
export interface ItemChangesArgs {
  item: string;
  type?: NameRef;
  status?: NameRef;
  priority?: 'none' | 'low' | 'medium' | 'high' | 'urgent';
  assignee?: string | null;
  estimate?: number | null;
  add_labels?: NameRef[];
  remove_labels?: NameRef[];
  custom?: CustomValues;
  description?: { mode: 'append' | 'replace'; text: string; description_version: number };
  add_links?: { kind: LinkKind; target: string }[];
}

/** edit_items' args: 1 to 20 items of one project, at most 10 links each. */
export interface EditItemsArgs {
  items: ItemChangesArgs[];
}

/** create_plan's body for the two new actions. */
export type Part2PlanBody =
  { action: 'create_items'; args: CreateItemsArgs } | { action: 'edit_items'; args: EditItemsArgs };

/** The scopes each new action needs (x-buildit-plan-required-scopes). */
export const PART2_PLAN_SCOPES: Readonly<Record<Part2PlanBody['action'], readonly Scope[]>> = {
  create_items: ['projects:write'],
  edit_items: ['projects:write'],
};

/** The most items create_items and edit_items take, and links per item. */
export const CREATE_ITEMS_MAX = 25;
export const EDIT_ITEMS_MAX = 20;
export const LINKS_PER_ITEM_MAX = 10;

/** apply_plan's answer, with the two new actions' results (tolerant, as the generated one). */
export const ApplyPlanResponse2Schema = ApplyPlanResponseSchema.extend({
  result: z.union([
    PlanResultSchema,
    z.looseObject({ action: z.literal('create_items'), items: z.array(z.unknown()) }),
    z.looseObject({
      action: z.literal('edit_items'),
      items: z.array(z.unknown()),
      links_added: z.number(),
    }),
  ]),
});

/** POST /v1/plans/{handle}/apply, parsed with ApplyPlanResponse2Schema. */
export function applyPlan(
  api: ApiClient,
  handle: string,
  options: ApiRequestOptions = {},
): Promise<z.infer<typeof ApplyPlanResponse2Schema>> {
  const op = OPERATIONS.apply_plan;
  return api.requestParsed(
    op.method,
    op.path.replace('{handle}', encodeURIComponent(handle)),
    ApplyPlanResponse2Schema,
    { ...options, operation: 'apply_plan', pathTemplate: op.path, body: {} },
  );
}

// ---------------------------------------------------------------------------
// post_plan_card's request
// ---------------------------------------------------------------------------

/** post_plan_card's body with `request` (1.15.0): the card answers that request. */
export type PostPlanCardBodyWithRequest = OperationIO['post_plan_card']['body'] & {
  request?: string;
};

// ---------------------------------------------------------------------------
// ask_session_reporter
// ---------------------------------------------------------------------------

/** The operation's id, as /v1/meta lists it. */
export const ASK_SESSION_REPORTER = 'ask_session_reporter';

const ASK_SESSION_REPORTER_PATH = '/v1/session/reporter-questions';

/** POST /v1/session/reporter-questions body. */
export interface AskSessionReporterBody {
  /** The triage request this question belongs to. */
  request: string;
  /** The item: a feedback report in the request's context. */
  item: string;
  /** Idempotency: a retry with the same id answers the first question. */
  id: string;
  /** The question, as the reporter reads it (the API checks its form). */
  text: string;
}

/** Its answer, parsed tolerantly (unknown fields kept, unknown statuses accepted). */
export const AskSessionReporterResponseSchema = z.looseObject({
  created: z.boolean(),
  question: z.looseObject({
    id: z.string(),
    item: z.unknown(),
    status: z.string(),
    sends_at: z.string().nullable().optional(),
  }),
});
export type AskSessionReporterResponse = z.infer<typeof AskSessionReporterResponseSchema>;

/**
 * POST /v1/session/reporter-questions, refused before any call on a server
 * whose /v1/meta leaves the operation out (as callOperation does).
 */
export async function askSessionReporter(
  api: ApiClient,
  body: AskSessionReporterBody,
  options: ApiRequestOptions = {},
): Promise<AskSessionReporterResponse> {
  const served = api.served;
  if (served?.operations !== undefined && !served.operations.has(ASK_SESSION_REPORTER)) {
    throw new ToolInputError(
      `This buildIt.Social server (API ${served.apiVersion}) doesn't serve ${ASK_SESSION_REPORTER} yet, which this needs. Ask nothing; tell the person in your direct message that the question couldn't be sent until their buildIt.Social server is updated.`,
    );
  }
  return api.requestParsed('POST', ASK_SESSION_REPORTER_PATH, AskSessionReporterResponseSchema, {
    ...options,
    operation: ASK_SESSION_REPORTER,
    pathTemplate: ASK_SESSION_REPORTER_PATH,
    body,
  });
}

// ---------------------------------------------------------------------------
// The error codes
// ---------------------------------------------------------------------------

/** The new codes and their HTTP statuses. */
export const PART2_ERROR_STATUS = {
  request_post_limit: 429,
  reporter_questions_off: 403,
  reporter_question_limit: 429,
  reporter_text_invalid: 422,
  not_a_report: 409,
  request_kind_mismatch: 409,
  reporter_question_locked: 409,
} as const;

export type Part2ErrorCode = keyof typeof PART2_ERROR_STATUS;

/** What to do, for an API that sends no hint (the generated ERROR_HINTS, until then). */
export const PART2_ERROR_HINTS: Readonly<Record<Part2ErrorCode, string>> = {
  request_post_limit:
    'This request has already posted 3 times in that place. Post nothing more there for it; anything else goes to your direct message (reply with dm: true, without request).',
  reporter_questions_off:
    'Questions to reporters are turned off (details.by: "agent", the person\'s switch, or "platform"). Ask nothing; put your question for the team in the card or a note in the item\'s thread instead.',
  reporter_question_limit:
    'No more questions to this reporter for now (details.limit: "per_report", "org_day" or "platform_day"). Ask nothing more; a person on the team has to reply in the item\'s thread first (per_report), or wait a day.',
  reporter_text_invalid:
    'The question broke a rule (details.rule): only a question, at most 500 characters and 4 lines, with no links, domains, item keys, ids, mentions, emails, HTML or code. Rewrite it in plain words about the report, then ask again.',
  not_a_report:
    "This item isn't an open feedback report, so it has no reporter to ask. Ask nothing; questions go in the card or the item's thread.",
  request_kind_mismatch: 'Only a triage request may ask a reporter. Ask nothing for this request.',
  reporter_question_locked:
    "A question to a reporter can't be edited or changed by the session once asked. Leave it; a person can delete it.",
};
