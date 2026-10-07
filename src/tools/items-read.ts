/**
 * Reading items: search_items and get_item.
 */
import { z } from 'zod';

import type { SearchItemsQuery } from '../api/generated/strict.js';
import { ToolInputError } from '../errors.js';
import { defineTool } from '../toolsets/registry.js';
import { sanitizeLabel, wrapUntrusted } from '../untrusted.js';
import {
  commentOut,
  CommentOutSchema,
  commentText,
  CursorInput,
  historyOut,
  HistoryOutSchema,
  ItemFullSchema,
  itemFull,
  itemLine,
  itemOut,
  ItemOutSchema,
  itemRef,
  ItemRefInput,
  linkOut,
  LinkOutSchema,
  nextPageHint,
  personText,
  scopesOf,
  searchItemOut,
  SearchItemOutSchema,
  wrapLines,
} from './shared.js';

// ---------------------------------------------------------------------------
// search_items
// ---------------------------------------------------------------------------

const SORT_RE =
  /^-?(rank|number|title|priority|status_category|due_date|start_date|estimate|created_at|updated_at)$/;

/** detail="full" returns descriptions, so pages are smaller and descriptions are cut. */
const FULL_MAX_LIMIT = 20;
const FULL_DESCRIPTION_CHARS = 1500;

const names = (max: number, what: string) =>
  z.array(z.string().min(1).max(320)).min(1).max(max).optional().describe(what);

export const searchItemsTool = defineTool({
  name: 'search_items',
  toolset: 'items',
  title: 'Search items',
  description: `Finds items (epics, stories, tasks, bugs, subtasks) by filters and, optionally, text.
- Filters combine with AND; the values inside one filter combine with OR. Statuses, types and labels are names (describe_project lists them); people are "me", "none" (unassigned), an email or a display name.
- Without query: sorted by rank (or sort) and paged; pass next_cursor as cursor for the next page.
- With query: best matches first, at most 50, one page; sort and cursor can't be used with it. query can be an exact key (DEMO-12), a number, or words that must all match the title, description or key.
- detail="concise" (default) returns one line per item; detail="full" adds descriptions (cut at ${FULL_DESCRIPTION_CHARS} characters) and custom fields, at most ${FULL_MAX_LIMIT} per page. For one item, get_item is better.
Examples: my open work: assignees=["me"], categories=["not_started","started"]. Bugs in a sprint: projects=["DEMO"], types=["Bug"], sprint="active". An epic's children: parent="DEMO-12".`,
  scopes: scopesOf('search_items'),
  annotations: {
    title: 'Search items',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    query: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Text to search for: a key, a number, or words.'),
    projects: names(20, 'Project keys, such as ["DEMO"].'),
    types: names(20, 'Type names, such as ["Bug", "Story"].'),
    statuses: names(20, 'Status names, such as ["In review"].'),
    categories: z
      .array(z.enum(['not_started', 'started', 'done', 'canceled']))
      .min(1)
      .max(4)
      .optional()
      .describe('Status categories; open work is ["not_started", "started"].'),
    priorities: z
      .array(z.enum(['none', 'low', 'medium', 'high', 'urgent']))
      .min(1)
      .max(5)
      .optional(),
    assignees: names(20, '"me", "none" (unassigned), emails or display names.'),
    labels: names(20, 'Items with any of these labels.'),
    sprint: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe('A sprint number, name, "active", or "none" (in no sprint).'),
    release: z.string().min(1).max(80).optional().describe('A fix version by name, or "none".'),
    parent: ItemRefInput.optional().describe(
      'Only the children of this item (an epic or a story).',
    ),
    updated_since: z.iso
      .datetime({ offset: true })
      .optional()
      .describe('Only items changed after this time, RFC 3339 (2026-10-01T00:00:00Z).'),
    sort: z
      .array(z.string().regex(SORT_RE))
      .min(1)
      .max(5)
      .optional()
      .describe(
        'Sort keys: rank, number, title, priority, status_category, due_date, start_date, estimate, created_at, updated_at; a leading "-" sorts descending ("-updated_at").',
      ),
    detail: z.enum(['concise', 'full']).optional().describe('concise (default) or full.'),
    cursor: CursorInput.optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(`Page size, 1 to 100 (default 25; at most ${FULL_MAX_LIMIT} with detail="full").`),
  }),
  outputSchema: z.object({
    items: z.array(SearchItemOutSchema),
    next_cursor: z.string().nullable(),
    text_search: z.boolean().describe('True when query was used: best first, no further pages.'),
  }),
  async run(args, ctx) {
    if (args.query !== undefined && (args.sort !== undefined || args.cursor !== undefined)) {
      throw new ToolInputError(
        'query cannot be combined with sort or cursor: text results come best first, in one page. Drop sort and cursor, or drop query and use filters.',
      );
    }
    const detail = args.detail ?? 'concise';
    let limit = args.limit;
    let clamped = false;
    if (detail === 'full' && (limit ?? 25) > FULL_MAX_LIMIT) {
      limit = FULL_MAX_LIMIT;
      clamped = true;
    }
    const query: SearchItemsQuery = {
      ...(args.query !== undefined ? { q: args.query } : {}),
      ...(args.projects ? { project: args.projects } : {}),
      ...(args.types ? { type: args.types } : {}),
      ...(args.statuses ? { status: args.statuses } : {}),
      ...(args.categories ? { category: args.categories } : {}),
      ...(args.priorities ? { priority: args.priorities } : {}),
      ...(args.assignees ? { assignee: args.assignees } : {}),
      ...(args.labels ? { label: args.labels } : {}),
      ...(args.sprint !== undefined ? { sprint: args.sprint } : {}),
      ...(args.release !== undefined ? { release: args.release } : {}),
      ...(args.parent !== undefined ? { parent: itemRef(args.parent) } : {}),
      ...(args.updated_since !== undefined ? { updated_since: args.updated_since } : {}),
      ...(args.sort ? { sort: args.sort } : {}),
      ...(detail === 'full' ? { detail } : {}),
      ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
    const page = await ctx.call('search_items', { query });
    const items = page.items.map((i) => searchItemOut(i, FULL_DESCRIPTION_CHARS));
    const textSearch = args.query !== undefined;

    const parts: string[] = [];
    if (items.length === 0) {
      parts.push('No items match.');
    } else {
      parts.push(
        `${items.length} item(s)${textSearch ? ', best match first' : ''}${clamped ? ` (page size cut to ${FULL_MAX_LIMIT} for detail="full")` : ''}:`,
      );
      if (detail === 'full') {
        for (const i of items) {
          parts.push(wrapLines([itemLine(i)], 'item'));
          if (i.description !== undefined) parts.push(i.description);
        }
      } else {
        const lines = items.map((i) =>
          i.match?.snippet ? `${itemLine(i)}\n  match: ${stripWrap(i.match.snippet)}` : itemLine(i),
        );
        parts.push(wrapLines(lines, 'item_list'));
      }
    }
    parts.push(
      textSearch
        ? 'Text search returns one page of at most 50; narrow it with filters for more.'
        : nextPageHint('search_items', page.next_cursor),
    );
    return {
      structured: { items, next_cursor: page.next_cursor, text_search: textSearch },
      text: parts.join('\n'),
    };
  },
});

/** The body of a wrapped snippet, for one line inside an already wrapped list. */
function stripWrap(wrapped: string): string {
  return sanitizeLabel(
    wrapped
      .replace(/^<untrusted_content[^>]*>\n/, '')
      .replace(/\n<\/untrusted_content>[\s\S]*$/, ''),
    300,
  );
}

// ---------------------------------------------------------------------------
// get_item
// ---------------------------------------------------------------------------

const CONCISE_DESCRIPTION_CHARS = 2000;
const FULL_DESCRIPTION_MAX = 20_000;
const COMMENT_CHARS = { concise: 2000, full: 600 } as const;

const ChildOut = ItemOutSchema.pick({
  key: true,
  title: true,
  type: true,
  status: true,
  status_category: true,
  assignee: true,
  estimate: true,
});

export const getItemTool = defineTool({
  name: 'get_item',
  toolset: 'items',
  title: 'Get an item',
  description: `Reads one item by key (DEMO-12): its fields, description (Markdown), custom fields, children, links, the latest comments and, optionally, its history.
- detail="concise" (default): the description cut at ${CONCISE_DESCRIPTION_CHARS} characters and the 5 latest comments.
- detail="full": the description up to 20,000 characters and the 20 latest comments (each cut at ${COMMENT_CHARS.full} characters).
- include_history=true adds the 50 latest history events.
The result carries version and description_version: pass them to update_item (if_version, and description_version to replace the description) and transition_item. For older comments use list_comments.`,
  scopes: scopesOf('get_item'),
  annotations: {
    title: 'Get an item',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    item: ItemRefInput,
    detail: z.enum(['concise', 'full']).optional().describe('concise (default) or full.'),
    include_history: z.boolean().optional().describe('Add the 50 latest history events.'),
  }),
  outputSchema: z.object({
    item: ItemFullSchema,
    children: z.array(ChildOut),
    links: z.array(LinkOutSchema),
    comments: z.array(CommentOutSchema).describe('The latest comments, oldest first.'),
    comments_next_cursor: z
      .string()
      .nullable()
      .describe('For list_comments with order="desc", to read older comments.'),
    history: z.array(HistoryOutSchema).optional(),
  }),
  async run(args, ctx) {
    const detail = args.detail ?? 'concise';
    const r = await ctx.call('get_item', {
      path: { key: itemRef(args.item) },
      query: {
        ...(detail === 'full' ? { detail } : {}),
        ...(args.include_history ? { include_history: 'true' } : {}),
      },
    });
    const item = itemFull(
      r.item,
      detail === 'full' ? FULL_DESCRIPTION_MAX : CONCISE_DESCRIPTION_CHARS,
      detail === 'full',
    );
    const children = r.children.map((c) => {
      const o = itemOut(c);
      return {
        key: o.key,
        title: o.title,
        type: o.type,
        status: o.status,
        status_category: o.status_category,
        assignee: o.assignee,
        estimate: o.estimate,
      };
    });
    const links = r.links.map(linkOut);
    const comments = r.comments.map((c) =>
      commentOut(
        c,
        COMMENT_CHARS[detail],
        `Call list_comments with item="${r.item.key}" to read it.`,
      ),
    );
    const history = r.history?.map(historyOut);

    const i = item;
    const facts = [
      `${i.key} · ${i.type} (${i.level}) · ${i.status} (${i.status_category}) · priority ${i.priority}`,
      `Project ${i.project}${i.parent ? ` · parent ${i.parent}` : ''}${i.initiative ? ` · initiative ${i.initiative}` : ''} · assignee ${personText(i.assignee)} · reporter ${personText(i.reporter)}`,
      [
        `labels ${i.labels.join(', ') || 'none'}`,
        `estimate ${i.estimate ?? 'none'}`,
        `sprint ${i.sprint ?? 'none'}`,
        `fix release ${i.fix_release ?? 'none'}`,
        `start ${i.start_date ?? 'none'}`,
        `due ${i.due_date ?? 'none'}`,
      ].join(' · '),
      `version ${i.version} · description_version ${i.description_version} · created ${i.created_at} · updated ${i.updated_at}`,
    ];
    const parts = [
      facts.join('\n'),
      wrapUntrusted(r.item.title, { source: 'title', maxChars: 300 }),
      i.description,
    ];
    if (i.custom.length > 0) {
      parts.push(
        'Custom fields:\n' +
          i.custom
            .map(
              (c) =>
                `- ${c.field} (${c.kind}): ${typeof c.value === 'string' ? c.value : JSON.stringify(c.value)}`,
            )
            .join('\n'),
      );
    }
    if (children.length > 0) {
      parts.push(
        `Children (${children.length}):\n` +
          wrapLines(
            children.map(
              (c) =>
                `${c.key} · ${c.type} · ${c.status} (${c.status_category}) · ${c.assignee ? `@${c.assignee.name}` : 'unassigned'}${c.estimate !== null ? ` · est ${c.estimate}` : ''} — ${c.title}`,
            ),
            'item_list',
          ),
      );
    }
    if (links.length > 0) {
      parts.push(
        `Links (${links.length}):\n` +
          wrapLines(
            links.map((l) =>
              l.key
                ? `${l.kind} ${l.key} · ${l.status ?? ''} — ${l.title ?? ''} (link id ${l.id})`
                : `${l.kind} an item you can't see (link id ${l.id})`,
            ),
            'link_list',
          ),
      );
    }
    if (comments.length > 0) {
      parts.push(`Latest comments (${comments.length}, oldest first):`);
      for (const c of comments) parts.push(commentText(c));
      if (r.comments_next_cursor !== null) {
        parts.push(
          `Older comments: call list_comments with item="${r.item.key}", order="desc" and this cursor:\n${sanitizeLabel(r.comments_next_cursor, 2048)}`,
        );
      }
    } else {
      parts.push('No comments.');
    }
    if (history && r.history) {
      // One block for the whole history: old and new values can be people-written.
      // Labels (names and keys as people read them now) are shown; when the API
      // gives none (a deleted or hidden value), the raw value is.
      const value = (label: string | null, raw: unknown): string => {
        if (label !== null) return sanitizeLabel(label, 200);
        if (raw === null || raw === undefined) return 'none';
        return sanitizeLabel(typeof raw === 'string' ? raw : JSON.stringify(raw), 200);
      };
      parts.push(
        `History (${history.length}, newest first):\n` +
          wrapLines(
            r.history.map((h, n) => {
              const o = history[n];
              const who = `${o?.actor ?? 'system'}${o?.via_agent ? ` via ${o.via_agent}` : ''}`;
              const change =
                h.old !== null || h.new !== null
                  ? `: ${value(h.old_label, h.old)} -> ${value(h.new_label, h.new)}`
                  : '';
              return `- ${h.at} · ${who} · ${h.kind}${o?.field ? ` ${o.field}` : ''}${change}`;
            }),
            'history',
          ),
      );
    }
    return {
      structured: {
        item,
        children,
        links,
        comments,
        comments_next_cursor: r.comments_next_cursor,
        ...(history ? { history } : {}),
      },
      text: parts.join('\n\n'),
    };
  },
});
