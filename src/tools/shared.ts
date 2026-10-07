/**
 * Shapes and helpers shared by the item and comment tools.
 *
 * Every tool returns structured content (matching its outputSchema) and a
 * short markdown summary. People-written text is never passed through as is:
 *
 * - short labels (names of people, projects, statuses, types, labels,
 *   fields, sprints, releases, and item titles in structured content) go
 *   through sanitizeLabel: one line, defused, capped;
 * - free text (descriptions, comments, search snippets, history values) goes
 *   through wrapUntrusted, in structured content and in the text;
 * - in the text, a list of items is one <untrusted_content> block, since its
 *   lines carry titles.
 */
import { z } from 'zod';

import {
  OPERATIONS,
  PLAN_SCOPES,
  type OperationId,
  type PlanActionName,
} from '../api/generated/operations.js';
import type {
  Comment,
  CustomFieldValue,
  HistoryEvent,
  ItemDetail,
  ItemSearchResult,
  ItemSummary,
  Link,
  User,
} from '../api/generated/schemas.js';
import type { Scope } from '../toolsets/toolsets.js';
import { sanitizeLabel, wrapUntrusted } from '../untrusted.js';

// ---------------------------------------------------------------------------
// Scopes and annotations from the contract
// ---------------------------------------------------------------------------

/**
 * Every scope the given operations need, from the contract's
 * x-buildit-required-scopes (or x-buildit-scope where that is absent): a
 * tool needs all of them. Plan operations (create_plan, apply_plan) take
 * the scopes of the plan's action: pass the actions to planScopesOf instead.
 */
export function scopesOf(...ids: OperationId[]): Scope[] {
  const out = new Set<Scope>();
  for (const id of ids) {
    if (OPERATIONS[id].scope === 'plan_action') {
      throw new Error(`${id} takes its plan action's scopes; use planScopesOf`);
    }
    for (const scope of OPERATIONS[id].requiredScopes) out.add(scope);
  }
  return [...out];
}

/** Every scope the given plan actions need, from the contract's x-buildit-plan-required-scopes. */
export function planScopesOf(...actions: PlanActionName[]): Scope[] {
  return [...new Set(actions.flatMap((a) => PLAN_SCOPES[a]))];
}

// ---------------------------------------------------------------------------
// Input fields
// ---------------------------------------------------------------------------

const ITEM_REF_RE =
  /^(#?[A-Za-z][A-Za-z0-9]{1,5}-[1-9][0-9]{0,8}|[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})$/;

export const ItemRefInput = z
  .string()
  .regex(ITEM_REF_RE, 'An item key such as DEMO-12, or an item uuid.')
  .describe('An item key such as DEMO-12 (any case, a leading # is fine) or the item uuid.');

export const ProjectKeyInput = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9]{1,5}$/, 'A project key such as DEMO.')
  .describe('A project key such as DEMO (any case). whoami and list_projects list them.');

export const UserRefInput = z
  .string()
  .min(1)
  .max(320)
  .describe(
    'A person: "me", an email, or an exact display name, among the project\'s members (find_users lists them).',
  );

export const IdempotencyKeyInput = z
  .uuid()
  .describe(
    'A random uuid you choose. Sending the same call again with it returns the first result instead of creating twice. If you leave it out, one is generated and returned, so you can retry safely with it.',
  );

export const CursorInput = z
  .string()
  .min(1)
  .max(2048)
  .describe('The next_cursor of the previous page, to read the next one (same other arguments).');

export const limitInput = (max: number, def: number) =>
  z.number().int().min(1).max(max).optional().describe(`Page size, 1 to ${max} (default ${def}).`);

/** Removes a leading # from an item key, keeps uuids as they are. */
export function itemRef(ref: string): string {
  return ref.startsWith('#') ? ref.slice(1) : ref;
}

// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

const label = (value: string, max = 200): string => sanitizeLabel(value, max);
const nullableLabel = (value: string | null | undefined, max = 200): string | null =>
  value === null || value === undefined || value === '' ? null : sanitizeLabel(value, max);

export const PersonSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
});
export type Person = z.infer<typeof PersonSchema>;

export function person(u: User): Person {
  return { id: u.id, name: label(u.display_name, 100), email: nullableLabel(u.email, 320) };
}

export function personText(p: Person | null): string {
  if (p === null) return 'nobody';
  return p.email ? `${p.name} <${p.email}>` : p.name;
}

export const ItemOutSchema = z.object({
  key: z.string(),
  id: z.string(),
  title: z.string().describe('People-written; flattened to one defused line.'),
  project: z.string(),
  type: z.string(),
  level: z.string().describe('epic, standard or subtask.'),
  status: z.string(),
  status_category: z.string().describe('not_started, started, done or canceled.'),
  priority: z.string(),
  assignee: PersonSchema.nullable(),
  parent: z.string().nullable().describe("The parent's key."),
  labels: z.array(z.string()),
  estimate: z.number().nullable(),
  sprint: z.string().nullable(),
  fix_release: z.string().nullable(),
  start_date: z.string().nullable(),
  due_date: z.string().nullable(),
  updated_at: z.string(),
  version: z.number().describe('Send as if_version to update_item or transition_item.'),
  description_version: z.number().describe('Send with description_replace to update_item.'),
});
export type ItemOut = z.infer<typeof ItemOutSchema>;

export function itemOut(i: ItemSummary): ItemOut {
  return {
    key: i.key,
    id: i.id,
    title: label(i.title, 300),
    project: i.project.key,
    type: label(i.type.name, 60),
    level: i.type.level,
    status: label(i.status.name, 60),
    status_category: i.status.category,
    priority: i.priority,
    assignee: i.assignee ? person(i.assignee) : null,
    parent: i.parent?.key ?? null,
    labels: i.labels.map((l) => label(l.name, 40)),
    estimate: i.estimate,
    sprint: nullableLabel(i.sprint?.name, 80),
    fix_release: nullableLabel(i.fix_release?.name, 80),
    start_date: i.start_date,
    due_date: i.due_date,
    updated_at: i.updated_at,
    version: i.version,
    description_version: i.description_version,
  };
}

export const CustomOutSchema = z.object({
  field: z.string(),
  kind: z.string(),
  value: z.unknown().describe('Text and url values are wrapped as untrusted content.'),
});

function customValue(c: CustomFieldValue): unknown {
  const v = c.value;
  if (typeof v === 'string') {
    return c.kind === 'text' || c.kind === 'url'
      ? wrapUntrusted(v, { source: 'field', maxChars: 2000 })
      : label(v, 200);
  }
  if (Array.isArray(v)) {
    return v.map((x) => (typeof x === 'string' ? label(x, 200) : person(x)));
  }
  if (typeof v === 'object') return person(v);
  return v;
}

export function customOut(c: CustomFieldValue) {
  return { field: label(c.field, 60), kind: c.kind, value: customValue(c) };
}

export const ItemFullSchema = ItemOutSchema.extend({
  reporter: PersonSchema.nullable(),
  initiative: z.string().nullable(),
  rank: z.string(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  canceled_at: z.string().nullable(),
  description: z
    .string()
    .describe('Markdown, wrapped as untrusted content; empty when the item has none.'),
  description_truncated: z
    .boolean()
    .describe('True when the description was cut; ask get_item with detail="full".'),
  custom: z.array(CustomOutSchema),
});
export type ItemFull = z.infer<typeof ItemFullSchema>;

/**
 * An item with its description, cut at `maxDescription` characters. In full
 * mode the API has sent everything, so a cut can't be read further here.
 */
export function itemFull(i: ItemDetail, maxDescription: number, full = false): ItemFull {
  const cut = i.description.length > maxDescription;
  return {
    ...itemOut(i),
    reporter: i.reporter ? person(i.reporter) : null,
    initiative: i.initiative?.key ?? null,
    rank: i.rank,
    created_at: i.created_at,
    started_at: i.started_at,
    completed_at: i.completed_at,
    canceled_at: i.canceled_at,
    // No description stays empty rather than becoming an empty block.
    description:
      i.description.trim() === ''
        ? ''
        : wrapUntrusted(i.description, {
            source: 'description',
            maxChars: maxDescription,
            moreHint: full
              ? 'The rest is too long to show here; the person can read it in buildIt.Social.'
              : `Call get_item with item="${i.key}" and detail="full" to read more.`,
          }),
    description_truncated: i.description_truncated || cut,
    custom: i.custom.map(customOut),
  };
}

export const SearchItemOutSchema = ItemOutSchema.extend({
  match: z
    .object({
      score: z.number(),
      title_highlight: z.string(),
      snippet: z.string().nullable().describe('Wrapped as untrusted content.'),
    })
    .optional()
    .describe('With a text query only.'),
  description: z.string().optional().describe('With detail="full" only; wrapped, may be cut.'),
  custom: z.array(CustomOutSchema).optional().describe('With detail="full" only.'),
});
export type SearchItemOut = z.infer<typeof SearchItemOutSchema>;

export function searchItemOut(i: ItemSearchResult, maxDescription: number): SearchItemOut {
  const out: SearchItemOut = itemOut(i);
  if (i.match) {
    out.match = {
      score: i.match.score,
      title_highlight: label(i.match.title_highlight, 400),
      snippet:
        i.match.snippet === null
          ? null
          : wrapUntrusted(i.match.snippet, { source: 'snippet', maxChars: 500 }),
    };
  }
  if (i.description !== undefined) {
    out.description = wrapUntrusted(i.description, {
      source: 'description',
      maxChars: maxDescription,
      moreHint: `Call get_item with item="${i.key}" and detail="full" to read all of it.`,
    });
  }
  if (i.custom !== undefined) out.custom = i.custom.map(customOut);
  return out;
}

export const CommentOutSchema = z.object({
  id: z.string(),
  author: PersonSchema.nullable(),
  body: z.string().describe('Plain text, wrapped as untrusted content.'),
  mentions: z.array(z.string()).describe('Display names of the people mentioned.'),
  created_at: z.string(),
  edited_at: z.string().nullable(),
  via_agent: z.string().nullable().describe('The token name, when an agent wrote it.'),
});
export type CommentOut = z.infer<typeof CommentOutSchema>;

export function commentOut(c: Comment, maxChars: number, moreHint?: string): CommentOut {
  const author = c.author ? person(c.author) : null;
  return {
    id: c.id,
    author,
    body: wrapUntrusted(c.body, {
      source: 'comment',
      author: author?.name,
      maxChars,
      ...(moreHint ? { moreHint } : {}),
    }),
    mentions: c.mentions.map((m) => label(m.display_name, 100)),
    created_at: c.created_at,
    edited_at: c.edited_at,
    via_agent: nullableLabel(c.via_agent, 100),
  };
}

/** A comment for the text output: a line of facts, then the wrapped body. */
export function commentText(c: CommentOut): string {
  const facts = [
    c.created_at,
    c.author ? c.author.name : 'unknown author',
    ...(c.via_agent ? [`via agent ${c.via_agent}`] : []),
    ...(c.edited_at ? [`edited ${c.edited_at}`] : []),
    `id ${c.id}`,
  ];
  return `- ${facts.join(' · ')}\n${c.body}`;
}

export const LinkOutSchema = z.object({
  id: z.string().describe('The link id (link_items with action="remove" can take it).'),
  kind: z.string().describe('blocks, blocked_by, relates, duplicates or duplicated_by.'),
  key: z.string().nullable().describe("The other item's key; null when it can't be seen."),
  title: z.string().nullable(),
  status: z.string().nullable(),
});
export type LinkOut = z.infer<typeof LinkOutSchema>;

export function linkOut(l: Link): LinkOut {
  return {
    id: l.id,
    kind: l.kind,
    key: l.item?.key ?? null,
    title: l.item ? label(l.item.title, 300) : null,
    status: l.item ? label(l.item.status.name, 60) : null,
  };
}

export const HistoryOutSchema = z.object({
  at: z.string(),
  actor: z.string().nullable(),
  via_agent: z.string().nullable(),
  kind: z.string(),
  field: z.string().nullable(),
  old: z
    .string()
    .nullable()
    .describe('The old value as recorded (ids), wrapped as untrusted content.'),
  new: z
    .string()
    .nullable()
    .describe('The new value as recorded (ids), wrapped as untrusted content.'),
  old_label: z
    .string()
    .nullable()
    .describe('The old value as people read it now (names, keys), flattened to one line.'),
  new_label: z
    .string()
    .nullable()
    .describe('The new value as people read it now (names, keys), flattened to one line.'),
});
export type HistoryOut = z.infer<typeof HistoryOutSchema>;

function historyValue(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const text = typeof v === 'string' ? v : JSON.stringify(v);
  return wrapUntrusted(text, { source: 'history', maxChars: 500, moreHint: 'Read the item.' });
}

export function historyOut(h: HistoryEvent): HistoryOut {
  return {
    at: h.at,
    actor: h.actor ? label(h.actor.display_name, 100) : null,
    via_agent: nullableLabel(h.via_agent, 100),
    kind: h.kind,
    field: nullableLabel(h.field, 60),
    old: historyValue(h.old),
    new: historyValue(h.new),
    old_label: nullableLabel(h.old_label, 300),
    new_label: nullableLabel(h.new_label, 300),
  };
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** One line about an item, for lists (it carries the title, so lists are wrapped). */
export function itemLine(i: ItemOut): string {
  const parts = [
    i.key,
    i.type,
    `${i.status} (${i.status_category})`,
    ...(i.priority !== 'none' ? [i.priority] : []),
    i.assignee ? `@${i.assignee.name}` : 'unassigned',
    ...(i.estimate !== null ? [`est ${i.estimate}`] : []),
    ...(i.parent ? [`parent ${i.parent}`] : []),
    ...(i.sprint ? [i.sprint] : []),
    ...(i.due_date ? [`due ${i.due_date}`] : []),
    ...(i.labels.length > 0 ? [`labels ${i.labels.join(', ')}`] : []),
  ];
  return `${parts.join(' · ')} — ${i.title}`;
}

/** A list of lines inside one untrusted block (they carry people-written titles). */
export function wrapLines(lines: string[], source: string): string {
  return wrapUntrusted(lines.join('\n'), { source, maxChars: 100_000 });
}

/** The line that tells the agent how to read the next page. */
export function nextPageHint(tool: string, cursor: string | null): string {
  return cursor === null
    ? 'This is the last page.'
    : [
        `More results: call ${tool} again with the same arguments and this cursor:`,
        sanitizeLabel(cursor, 2048),
      ].join('\n');
}
