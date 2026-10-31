/**
 * The fake API's exact schemas for agent API 1.15.0's additions, written by
 * hand from src/api/part2.ts until the contract is copied in.
 *
 * TODO(lane B openapi): delete this file once openapi/openapi.json is
 * 1.15.0: REQUEST_SCHEMAS, RESPONSE_SCHEMAS, ERROR_STATUS and OPERATIONS
 * then hold all of it, and the fake routes ask_session_reporter like any
 * other operation.
 */
import { z } from 'zod';

import {
  ApplyPlanResponseSchema,
  CreatePlanRequestSchema,
  ItemRefSchema,
  ItemSummarySchema,
  PlanActionSchema,
  PlanEffectSchema,
  PlanHandleSchema,
  PlanResultSchema,
  PostPlanCardRequestSchema,
  PrioritySchema,
  ProjectRefSchema,
  TimestampSchema,
  UuidSchema,
} from '../../src/api/generated/strict.js';
import { PART2_ERROR_STATUS, type Part2ErrorCode } from '../../src/api/part2.js';

const NameRef = z.string().min(1).max(60);
const Label = z.string().min(1).max(40);
const Custom = z.record(
  z.string().min(1).max(60),
  z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]),
);
const Ref = z.string().regex(/^[A-Za-z0-9_-]{1,20}$/);
const Estimate = z.number().min(0).max(9999.99);

const NewItemSchema = z.strictObject({
  ref: Ref,
  title: z.string().min(1).max(255),
  type: NameRef.optional(),
  description: z.string().max(262_144).optional(),
  parent: z.union([ItemRefSchema, z.strictObject({ ref: Ref })]).optional(),
  priority: PrioritySchema.optional(),
  labels: z.array(Label).max(100).optional(),
  custom: Custom.optional(),
  estimate: Estimate.optional(),
  assignee: z.string().min(1).max(320).optional(),
  status: NameRef.optional(),
});

export const CreateItemsArgsSchema = z.strictObject({
  project: ProjectRefSchema,
  items: z.array(NewItemSchema).min(1).max(25),
});

const LinkKindSchema = z.enum(['blocks', 'blocked_by', 'relates', 'duplicates', 'duplicated_by']);

const ItemChangesSchema = z.strictObject({
  item: ItemRefSchema,
  type: NameRef.optional(),
  status: NameRef.optional(),
  priority: PrioritySchema.optional(),
  assignee: z.string().min(1).max(320).nullable().optional(),
  estimate: Estimate.nullable().optional(),
  add_labels: z.array(Label).max(100).optional(),
  remove_labels: z.array(Label).max(100).optional(),
  custom: Custom.optional(),
  description: z
    .strictObject({
      mode: z.enum(['append', 'replace']),
      text: z.string().min(1).max(262_144),
      description_version: z.int().min(1),
    })
    .optional(),
  add_links: z
    .array(z.strictObject({ kind: LinkKindSchema, target: ItemRefSchema }))
    .max(10)
    .optional(),
});

export const EditItemsArgsSchema = z.strictObject({
  items: z.array(ItemChangesSchema).min(1).max(20),
});

const Part2Action = z.enum(['create_items', 'edit_items']);

const PlanEffect2Schema = PlanEffectSchema.extend({
  op: z.union([PlanEffectSchema.shape.op, z.literal('link')]),
  kind: z.union([PlanEffectSchema.shape.kind, z.literal('link')]),
});

const PlanResult2Schema = z.union([
  PlanResultSchema,
  z.strictObject({ action: z.literal('create_items'), items: z.array(ItemSummarySchema) }),
  z.strictObject({
    action: z.literal('edit_items'),
    items: z.array(ItemSummarySchema),
    links_added: z.int(),
  }),
]);

/** Requests whose 1.15.0 shape differs. */
export const PART2_REQUEST_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  create_plan: z.union([
    CreatePlanRequestSchema,
    z.strictObject({ action: z.literal('create_items'), args: CreateItemsArgsSchema }),
    z.strictObject({ action: z.literal('edit_items'), args: EditItemsArgsSchema }),
  ]),
  post_plan_card: PostPlanCardRequestSchema.extend({ request: UuidSchema.optional() }),
};

/** Responses whose 1.15.0 shape differs. */
export const PART2_RESPONSE_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  create_plan: z.strictObject({
    handle: PlanHandleSchema,
    action: z.union([PlanActionSchema, Part2Action]),
    preview: z.strictObject({
      summary: z.string(),
      effects: z.array(PlanEffect2Schema).max(500),
      item_count: z.int(),
      warnings: z.array(z.string()),
    }),
    expires_at: TimestampSchema,
  }),
  apply_plan: ApplyPlanResponseSchema.extend({
    action: z.union([PlanActionSchema, Part2Action]),
    result: PlanResult2Schema,
  }),
};

/** POST /v1/session/reporter-questions */
export const ASK_REPORTER_PATH = '/v1/session/reporter-questions';

export const AskReporterRequestSchema = z.strictObject({
  request: UuidSchema,
  item: ItemRefSchema,
  id: UuidSchema,
  text: z.string().min(1).max(2000),
});

export const AskReporterResponseSchema = z.strictObject({
  created: z.boolean(),
  question: z.strictObject({
    id: UuidSchema,
    item: z.strictObject({ id: UuidSchema, key: z.string() }),
    status: z.enum(['pending', 'sent', 'not_sent']),
    sends_at: TimestampSchema.nullable(),
  }),
});

/** The new error codes' statuses. */
export const PART2_STATUS: Readonly<Record<Part2ErrorCode, number>> = PART2_ERROR_STATUS;

/** Whether a code is one of 1.15.0's new ones. */
export function isPart2Code(code: string): code is Part2ErrorCode {
  return Object.hasOwn(PART2_STATUS, code);
}
