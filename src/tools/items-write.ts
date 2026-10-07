/**
 * Changing items: create_item, update_item, transition_item, assign_item,
 * link_items, unlink_items and rank_item.
 */
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { ApiError } from '../api/client.js';
import type { UpdateItemBody } from '../api/generated/strict.js';
import { ToolInputError } from '../errors.js';
import { defineTool, type ToolContext } from '../toolsets/registry.js';
import { sanitizeLabel } from '../untrusted.js';
import { transitionText } from './projects.js';
import {
  commentOut,
  CommentOutSchema,
  commentText,
  IdempotencyKeyInput,
  itemLine,
  itemOut,
  ItemOutSchema,
  itemRef,
  ItemRefInput,
  ProjectKeyInput,
  scopesOf,
  UserRefInput,
  wrapLines,
} from './shared.js';

const NameInput = (what: string) => z.string().min(1).max(60).describe(what);
const DateInput = z.iso.date();
const EstimateInput = z
  .number()
  .min(0)
  .max(9999.99)
  .describe('Points; must be a value the project allows (describe_project).');
const CustomInput = z
  .record(
    z.string().min(1).max(60),
    z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]),
  )
  .describe(
    'Custom fields by name: {"Severity": "High", "Due QA": "2026-10-20"}. Select fields take option labels, people fields "me" or emails, and null clears a value.',
  );
const PriorityInput = z.enum(['none', 'low', 'medium', 'high', 'urgent']);
const TitleInput = z
  .string()
  .min(1)
  .max(255)
  .refine((s) => s.trim().length > 0, 'The title cannot be blank.')
  .describe('1 to 255 characters.');
const DescriptionInput = z
  .string()
  .max(262_144)
  .describe(
    'GitHub-flavored Markdown. Mention people as @email or @[Display Name]. Images by URL are refused.',
  );

/** A short text block for an item that just changed: facts, then the line (with its title) wrapped. */
function changedText(headline: string, item: z.infer<typeof ItemOutSchema>): string {
  return [
    headline,
    `version ${item.version} · description_version ${item.description_version}`,
    wrapLines([itemLine(item)], 'item'),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// create_item
// ---------------------------------------------------------------------------

export const createItemTool = defineTool({
  name: 'create_item',
  toolset: 'items',
  title: 'Create an item',
  description: `Creates an item at any level: an epic, a standard item (story, task, bug) or a subtask.
- Give project (a key such as DEMO), or parent: a story's parent is an epic, a subtask's parent is a story or task, and the project then comes from the parent.
- type, status, labels, sprint, fix_release and custom fields are names from describe_project. Without type, the project's default type at the parent's child level is used; without status, the workflow's initial status.
- assignee: "me", an email or an exact display name. Mention people in the description as @email or @[Display Name].
- position: {"before": "DEMO-3"} or {"after": "DEMO-3"}; default is last.
- idempotency_key: retrying with the same key returns the first item instead of creating a second; one is generated and returned if you leave it out.
Returns the new item's key and versions.`,
  scopes: scopesOf('create_item'),
  annotations: {
    title: 'Create an item',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    project: ProjectKeyInput.optional().describe('Required unless parent is given.'),
    parent: ItemRefInput.optional().describe(
      'An epic (for a story, task or bug) or a story or task (for a subtask).',
    ),
    type: NameInput('A type name, such as Story, Bug, Task, Epic or Subtask.').optional(),
    title: TitleInput,
    description: DescriptionInput.optional(),
    status: NameInput('A status name; default: the initial status.').optional(),
    assignee: UserRefInput.optional(),
    priority: PriorityInput.optional(),
    labels: z.array(z.string().min(1).max(40)).max(100).optional().describe('Label names.'),
    estimate: EstimateInput.optional(),
    start_date: DateInput.optional().describe('YYYY-MM-DD.'),
    due_date: DateInput.optional().describe('YYYY-MM-DD.'),
    sprint: z.string().min(1).max(80).optional().describe('A sprint number, name or "active".'),
    fix_release: z.string().min(1).max(80).optional().describe('A release name.'),
    initiative: z.string().min(1).max(50).optional().describe('An initiative key (epics only).'),
    custom: CustomInput.optional(),
    position: z
      .object({
        before: ItemRefInput.optional(),
        after: ItemRefInput.optional(),
      })
      .optional()
      .describe('Exactly one of before or after.'),
    idempotency_key: IdempotencyKeyInput.optional(),
  }),
  outputSchema: z.object({
    item: ItemOutSchema,
    created: z.boolean().describe('false: an earlier call with this idempotency_key created it.'),
    idempotency_key: z.string(),
  }),
  async run(args, ctx) {
    if (args.project === undefined && args.parent === undefined) {
      throw new ToolInputError('Give project (a key such as DEMO) or parent (an item key).');
    }
    if (
      args.position &&
      (args.position.before === undefined) === (args.position.after === undefined)
    ) {
      throw new ToolInputError('position takes exactly one of before or after.');
    }
    const key = args.idempotency_key ?? randomUUID();
    const r = await ctx.call('create_item', {
      body: {
        ...(args.project !== undefined ? { project: args.project } : {}),
        ...(args.parent !== undefined ? { parent: itemRef(args.parent) } : {}),
        ...(args.type !== undefined ? { type: args.type } : {}),
        title: args.title,
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.status !== undefined ? { status: args.status } : {}),
        ...(args.assignee !== undefined ? { assignee: args.assignee } : {}),
        ...(args.priority !== undefined ? { priority: args.priority } : {}),
        ...(args.labels !== undefined ? { labels: args.labels } : {}),
        ...(args.estimate !== undefined ? { estimate: args.estimate } : {}),
        ...(args.start_date !== undefined ? { start_date: args.start_date } : {}),
        ...(args.due_date !== undefined ? { due_date: args.due_date } : {}),
        ...(args.sprint !== undefined ? { sprint: args.sprint } : {}),
        ...(args.fix_release !== undefined ? { fix_release: args.fix_release } : {}),
        ...(args.initiative !== undefined ? { initiative: args.initiative } : {}),
        ...(args.custom !== undefined ? { custom: args.custom } : {}),
        ...(args.position
          ? {
              position: args.position.before
                ? { before: itemRef(args.position.before) }
                : { after: itemRef(args.position.after ?? '') },
            }
          : {}),
        idempotency_key: key,
      },
    });
    const item = itemOut(r.item);
    const headline = r.created
      ? `Created ${item.key} (${item.type}, ${item.status}).`
      : `Nothing new: ${item.key} was already created with this idempotency_key.`;
    return {
      structured: { item, created: r.created, idempotency_key: key },
      text: changedText(headline, item),
    };
  },
});

// ---------------------------------------------------------------------------
// update_item
// ---------------------------------------------------------------------------

const UpdateInput = z.object({
  item: ItemRefInput,
  if_version: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("The item's version you read; the update is refused if someone changed it since."),
  title: TitleInput.optional(),
  description_append: DescriptionInput.optional().describe(
    'Markdown added at the end of the description after a blank line. Safe: it never overwrites anyone.',
  ),
  description_replace: DescriptionInput.optional().describe(
    'Markdown that replaces the whole description. Needs description_version.',
  ),
  description_version: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('The description_version you read (get_item); required with description_replace.'),
  type: NameInput('A new type name.').optional(),
  status: NameInput(
    'Only with type, when the new type follows another workflow: the status in it. To change status otherwise, use transition_item.',
  ).optional(),
  parent: ItemRefInput.nullable().optional().describe('A new parent, or null to detach.'),
  assignee: UserRefInput.nullable().optional().describe('A person, or null to unassign.'),
  priority: PriorityInput.optional(),
  labels: z.array(z.string().min(1).max(40)).max(100).optional().describe('Replaces all labels.'),
  add_labels: z.array(z.string().min(1).max(40)).max(100).optional(),
  remove_labels: z.array(z.string().min(1).max(40)).max(100).optional(),
  estimate: EstimateInput.nullable().optional(),
  start_date: DateInput.nullable().optional(),
  due_date: DateInput.nullable().optional(),
  sprint: z.string().min(1).max(80).nullable().optional().describe('A sprint, or null.'),
  fix_release: z.string().min(1).max(80).nullable().optional().describe('A release, or null.'),
  initiative: z.string().min(1).max(50).nullable().optional(),
  custom: CustomInput.optional(),
});

function updateBody(args: z.infer<typeof UpdateInput>): UpdateItemBody {
  if (args.description_append !== undefined && args.description_replace !== undefined) {
    throw new ToolInputError('Give description_append or description_replace, not both.');
  }
  if (args.description_replace !== undefined && args.description_version === undefined) {
    throw new ToolInputError(
      'description_replace needs description_version: read the item with get_item first and pass its description_version. To add text without reading, use description_append.',
    );
  }
  if (args.status !== undefined && args.type === undefined) {
    throw new ToolInputError(
      'status goes with type only (when the new type follows another workflow). To move the item to another status, use transition_item.',
    );
  }
  const body: UpdateItemBody = {
    ...(args.if_version !== undefined ? { if_version: args.if_version } : {}),
    ...(args.title !== undefined ? { title: args.title } : {}),
    ...(args.description_append !== undefined
      ? { description: { mode: 'append', text: args.description_append } }
      : {}),
    ...(args.description_replace !== undefined && args.description_version !== undefined
      ? {
          description: {
            mode: 'replace',
            text: args.description_replace,
            description_version: args.description_version,
          },
        }
      : {}),
    ...(args.type !== undefined ? { type: args.type } : {}),
    ...(args.status !== undefined ? { status: args.status } : {}),
    ...(args.parent !== undefined
      ? { parent: args.parent === null ? null : itemRef(args.parent) }
      : {}),
    ...(args.assignee !== undefined ? { assignee: args.assignee } : {}),
    ...(args.priority !== undefined ? { priority: args.priority } : {}),
    ...(args.labels !== undefined ? { labels: args.labels } : {}),
    ...(args.add_labels !== undefined ? { add_labels: args.add_labels } : {}),
    ...(args.remove_labels !== undefined ? { remove_labels: args.remove_labels } : {}),
    ...(args.estimate !== undefined ? { estimate: args.estimate } : {}),
    ...(args.start_date !== undefined ? { start_date: args.start_date } : {}),
    ...(args.due_date !== undefined ? { due_date: args.due_date } : {}),
    ...(args.sprint !== undefined ? { sprint: args.sprint } : {}),
    ...(args.fix_release !== undefined ? { fix_release: args.fix_release } : {}),
    ...(args.initiative !== undefined ? { initiative: args.initiative } : {}),
    ...(args.custom !== undefined ? { custom: args.custom } : {}),
  };
  if (Object.keys(body).every((k) => k === 'if_version')) {
    throw new ToolInputError('Nothing to change: give at least one field to update.');
  }
  return body;
}

export const updateItemTool = defineTool({
  name: 'update_item',
  toolset: 'items',
  title: 'Update an item',
  description: `Changes fields of one item: title, description, type, parent, assignee, priority, labels, estimate, dates, sprint, fix release, initiative and custom fields. Only the fields you give change; null clears a field.
- Description: description_append adds Markdown at the end and never overwrites anyone's edit (prefer it); description_replace replaces it all and needs the description_version from get_item.
- if_version (from get_item or search_items) makes the update fail with a conflict if someone changed the item since you read it.
- Labels: labels replaces all; add_labels and remove_labels change some.
- To change the status use transition_item; to only assign, assign_item is simpler.
Returns the item with its new versions.`,
  scopes: scopesOf('update_item'),
  annotations: {
    title: 'Update an item',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: UpdateInput,
  outputSchema: z.object({ item: ItemOutSchema }),
  async run(args, ctx) {
    const body = updateBody(args);
    const r = await ctx.call('update_item', { path: { key: itemRef(args.item) }, body });
    const item = itemOut(r.item);
    return { structured: { item }, text: changedText(`Updated ${item.key}.`, item) };
  },
});

// ---------------------------------------------------------------------------
// assign_item
// ---------------------------------------------------------------------------

export const assignItemTool = defineTool({
  name: 'assign_item',
  toolset: 'items',
  title: 'Assign an item',
  description:
    'Assigns one item to a person, or unassigns it. assignee is "me", an email, or an exact display name among the project\'s members (find_users lists them); null or "none" unassigns. A display name shared by two people fails with the candidates to choose from. Returns the item.',
  scopes: scopesOf('update_item'),
  annotations: {
    title: 'Assign an item',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    item: ItemRefInput,
    assignee: UserRefInput.nullable().describe(
      '"me", an email or a display name; null or "none" to unassign.',
    ),
    if_version: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('The version you read, to guard against concurrent changes.'),
  }),
  outputSchema: z.object({ item: ItemOutSchema }),
  async run(args, ctx) {
    const assignee =
      args.assignee === null || args.assignee.trim().toLowerCase() === 'none'
        ? null
        : args.assignee;
    const r = await ctx.call('update_item', {
      path: { key: itemRef(args.item) },
      body: {
        assignee,
        ...(args.if_version !== undefined ? { if_version: args.if_version } : {}),
      },
    });
    const item = itemOut(r.item);
    const headline = item.assignee
      ? `${item.key} is assigned to ${item.assignee.name}.`
      : `${item.key} is unassigned.`;
    return { structured: { item }, text: changedText(headline, item) };
  },
});

// ---------------------------------------------------------------------------
// transition_item
// ---------------------------------------------------------------------------

const MOVE_ADVICE =
  'Call transition_item again with one of these; pass the fields a move needs in set (for example set={"assignee": "me"}). To reach another status, move in steps.';

/** The error's own moves (the API lists them in details.moves), as a note. */
function movesNote(err: ApiError, key: string): string | undefined {
  const details = err.details as { moves?: unknown; from?: unknown } | undefined;
  if (!Array.isArray(details?.moves)) return undefined;
  const moves = (
    details.moves as { to?: unknown; required_fields?: unknown; admins_only?: unknown }[]
  ).map((m) =>
    transitionText({
      to: sanitizeLabel(typeof m.to === 'string' ? m.to : '', 60),
      required_fields: Array.isArray(m.required_fields)
        ? m.required_fields.map((f) => sanitizeLabel(typeof f === 'string' ? f : '', 60))
        : [],
      admins_only: m.admins_only === true,
    }),
  );
  const from = typeof details.from === 'string' ? sanitizeLabel(details.from, 60) : 'its status';
  return [
    `From ${from}, ${key.toUpperCase()} can move to: ${moves.join('; ') || 'nothing'}.`,
    MOVE_ADVICE,
  ].join('\n');
}

/**
 * The moves allowed from the item's current status, read from its project,
 * for an error from an older API that doesn't list them.
 */
async function allowedMovesNote(ctx: ToolContext, key: string): Promise<string | undefined> {
  try {
    const { item } = await ctx.call('get_item', { path: { key } });
    const project = await ctx.call('describe_project', { path: { key: item.project.key } });
    const type = project.types.find((t) => t.id === item.type.id);
    const workflow = project.workflows.find((w) => w.id === type?.workflow.id);
    const status = workflow?.statuses.find((s) => s.id === item.status.id);
    if (!workflow || !status) return undefined;
    const moves = status.allowed.map((a) =>
      transitionText({
        to: sanitizeLabel(a.to, 60),
        required_fields: a.required_fields.map((f) => sanitizeLabel(f, 60)),
        admins_only: a.admins_only,
      }),
    );
    return [
      `From ${sanitizeLabel(status.name, 60)} (workflow ${sanitizeLabel(workflow.name, 60)}), ${item.key} can move to: ${moves.join('; ') || 'nothing'}.`,
      MOVE_ADVICE,
    ].join('\n');
  } catch {
    return undefined;
  }
}

const FIELD_REQUIRED_NOTE =
  'Pass them in set: assignee ("me" or an email), estimate, due_date, sprint and fix_release by those names, and custom fields as set.custom, for example set={"assignee": "me", "custom": {"Severity": "High"}}.';

export const transitionItemTool = defineTool({
  name: 'transition_item',
  toolset: 'items',
  title: 'Move an item to a status',
  description: `Moves one item to another status, by the status name (In progress, Done, ...), following its workflow, as the app does.
- Some moves require fields (an assignee, an estimate, ...): set them in the same call with set, for example set={"assignee": "me"}.
- comment is posted on the item after the move (plain text; mention people as @email or @[Display Name]).
- if_version guards against concurrent changes.
- When the workflow doesn't allow the move, the error lists the statuses the item can move to from where it is and what each needs; move in steps if needed.
describe_project shows every workflow's statuses and allowed moves. Returns the item and the comment.`,
  scopes: scopesOf('transition_item'),
  annotations: {
    title: 'Move an item to a status',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    item: ItemRefInput,
    status: NameInput('The status to move to, by name.'),
    comment: z
      .string()
      .min(1)
      .max(20_000)
      .optional()
      .describe('A comment to post after the move (plain text, at most 20,000 characters).'),
    set: z
      .object({
        assignee: UserRefInput.nullable().optional(),
        estimate: EstimateInput.nullable().optional(),
        due_date: DateInput.nullable().optional(),
        sprint: z.string().min(1).max(80).nullable().optional(),
        fix_release: z.string().min(1).max(80).nullable().optional(),
        custom: CustomInput.optional(),
      })
      .optional()
      .describe("Fields to set in the same change, to meet the move's required fields."),
    if_version: z.number().int().min(1).optional(),
  }),
  outputSchema: z.object({
    item: ItemOutSchema,
    comment: CommentOutSchema.nullable(),
  }),
  async run(args, ctx) {
    const key = itemRef(args.item);
    let r;
    try {
      r = await ctx.call('transition_item', {
        path: { key },
        body: {
          status: args.status,
          ...(args.comment !== undefined ? { comment: args.comment } : {}),
          ...(args.set !== undefined ? { set: args.set } : {}),
          ...(args.if_version !== undefined ? { if_version: args.if_version } : {}),
        },
      });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'transition_not_allowed') {
        const note = movesNote(err, key) ?? (await allowedMovesNote(ctx, key));
        throw note ? err.withNote(note) : err;
      }
      if (err instanceof ApiError && err.code === 'field_required') {
        throw err.withNote(FIELD_REQUIRED_NOTE);
      }
      throw err;
    }
    const item = itemOut(r.item);
    const comment = r.comment ? commentOut(r.comment, 2000) : null;
    const parts = [
      changedText(`Moved ${item.key} to ${item.status} (${item.status_category}).`, item),
    ];
    if (comment) parts.push('Comment posted:', commentText(comment));
    return { structured: { item, comment }, text: parts.join('\n') };
  },
});

// ---------------------------------------------------------------------------
// link_items
// ---------------------------------------------------------------------------

const LINK_KINDS = ['blocks', 'blocked_by', 'relates', 'duplicates', 'duplicated_by'] as const;

function sameItem(a: string, b: string): boolean {
  return itemRef(a).toLowerCase() === itemRef(b).toLowerCase();
}

const LinkKindInput = z.enum(LINK_KINDS).describe("The link's kind, seen from item.");

export const linkItemsTool = defineTool({
  name: 'link_items',
  toolset: 'items',
  title: 'Link two items',
  description: `Adds a link between two items.
- kind, from item's side: blocks, blocked_by, relates, duplicates or duplicated_by. "DEMO-1 blocks DEMO-2" is the same link as "DEMO-2 blocked_by DEMO-1".
- Adding a link that exists changes nothing, so a retry is safe.
- The target can be in another project.
To remove a link, use unlink_items. Returns the link id and whether it was new.`,
  scopes: scopesOf('add_link'),
  annotations: {
    title: 'Link two items',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    item: ItemRefInput,
    kind: LinkKindInput,
    target: ItemRefInput.describe('The other item.'),
  }),
  outputSchema: z.object({
    item: z.string(),
    kind: z.string(),
    target: z.string(),
    link_id: z.string(),
    created: z.boolean().describe('false: the link already existed.'),
  }),
  async run(args, ctx) {
    const key = itemRef(args.item);
    const r = await ctx.call('add_link', {
      path: { key },
      body: { kind: args.kind, target: itemRef(args.target) },
    });
    const target = r.link.item?.key ?? itemRef(args.target).toUpperCase();
    const structured = {
      item: key.toUpperCase(),
      kind: r.link.kind,
      target,
      link_id: r.link.id,
      created: r.created,
    };
    const text = r.created
      ? `Linked: ${structured.item} ${r.link.kind} ${target} (link id ${r.link.id}).`
      : `Nothing changed: ${structured.item} already ${r.link.kind} ${target} (link id ${r.link.id}).`;
    return { structured, text };
  },
});

export const unlinkItemsTool = defineTool({
  name: 'unlink_items',
  toolset: 'items',
  title: 'Remove a link between items',
  description: `Removes a link between two items: the link of that kind between item and target, or the one with link_id (get_item lists links with their ids).
- kind, from item's side: blocks, blocked_by, relates, duplicates or duplicated_by.
- Removing a link that doesn't exist changes nothing, so a retry is safe.
Only the link is removed; both items stay. Returns whether a link was removed.`,
  scopes: scopesOf('remove_link', 'get_item'),
  annotations: {
    title: 'Remove a link between items',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    item: ItemRefInput,
    kind: LinkKindInput.optional().describe("The link's kind, seen from item (with target)."),
    target: ItemRefInput.optional().describe('The other item (with kind).'),
    link_id: z.uuid().optional().describe('The link id from get_item, instead of kind and target.'),
  }),
  outputSchema: z.object({
    item: z.string(),
    link_id: z.string().nullable(),
    removed: z.boolean().describe('false: there was no such link (or it was already gone).'),
  }),
  async run(args, ctx) {
    const key = itemRef(args.item);
    let linkId = args.link_id;
    if (linkId === undefined) {
      if (args.kind === undefined || args.target === undefined) {
        throw new ToolInputError('Give link_id, or both kind and target.');
      }
      const { kind, target } = args;
      const { links } = await ctx.call('get_item', { path: { key } });
      const match = links.find(
        (l) =>
          l.kind === kind &&
          l.item !== null &&
          (sameItem(l.item.key, target) || l.item.id.toLowerCase() === target.toLowerCase()),
      );
      if (!match) {
        return {
          structured: { item: key.toUpperCase(), link_id: null, removed: false },
          text: `Nothing changed: ${key.toUpperCase()} has no "${kind}" link to ${itemRef(target).toUpperCase()}. get_item lists its links.`,
        };
      }
      linkId = match.id;
    }
    const r = await ctx.call('remove_link', { path: { key, id: linkId } });
    return {
      structured: { item: key.toUpperCase(), link_id: r.id, removed: r.removed },
      text: r.removed
        ? `Unlinked: removed link ${r.id} from ${key.toUpperCase()}.`
        : `Nothing changed: link ${r.id} was already removed.`,
    };
  },
});

// ---------------------------------------------------------------------------
// rank_item
// ---------------------------------------------------------------------------

export const rankItemTool = defineTool({
  name: 'rank_item',
  toolset: 'items',
  title: 'Reorder an item',
  description:
    "Moves one item in its project's order (the backlog and board order): directly before or directly after another item of the same project. Give exactly one of before or after. Returns the item's new rank. search_items sorts by rank by default.",
  scopes: scopesOf('rank_item'),
  annotations: {
    title: 'Reorder an item',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    item: ItemRefInput,
    before: ItemRefInput.optional().describe('Put the item just before this one.'),
    after: ItemRefInput.optional().describe('Put the item just after this one.'),
  }),
  outputSchema: z.object({ item: ItemOutSchema, rank: z.string() }),
  async run(args, ctx) {
    if ((args.before === undefined) === (args.after === undefined)) {
      throw new ToolInputError('Give exactly one of before or after.');
    }
    const r = await ctx.call('rank_item', {
      path: { key: itemRef(args.item) },
      body: args.before ? { before: itemRef(args.before) } : { after: itemRef(args.after ?? '') },
    });
    const item = itemOut(r.item);
    const where = args.before
      ? `before ${itemRef(args.before).toUpperCase()}`
      : `after ${itemRef(args.after ?? '').toUpperCase()}`;
    return {
      structured: { item, rank: r.item.rank },
      text: changedText(`Moved ${item.key} ${where}.`, item),
    };
  },
});
