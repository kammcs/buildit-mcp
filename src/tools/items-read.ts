/**
 * Reading items: search_items and get_item.
 */
import { z } from 'zod';

import type { Development, Feedback } from '../api/generated/schemas.js';
import type { SearchItemsQuery } from '../api/generated/strict.js';
import { defineTool } from '../toolsets/registry.js';
import { sanitizeLabel, wrapUntrusted } from '../untrusted.js';
import {
  apiAtLeast,
  assigneeText,
  commentOut,
  CommentOutSchema,
  commentText,
  CursorInput,
  customLine,
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
  requireApi,
  scopesOf,
  searchItemOut,
  type SearchItemOut,
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
- With query: best matches first, at most 50 a page, paged with cursor too. With query and sort: only the items matching every word, in the sort's order. query can be an exact key (DEMO-12), a number, or words that must all match the title, description or key.
- has_link: a link kind (blocks, blocked_by, relates, duplicates, duplicated_by), then optionally ":" and the other item's category or "open" ("blocked_by:open"). activity_since counts comments; updated_since doesn't.
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
    has_link: z.array(z.string().min(1).max(40)).min(1).max(10).optional(),
    activity_since: z
      .string()
      .min(1)
      .max(40)
      .optional()
      .describe('RFC 3339: changed or commented on after it.'),
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
    text_search: z.boolean().describe('True when query was used without sort: best first.'),
  }),
  async run(args, ctx) {
    if (args.query !== undefined && (args.sort !== undefined || args.cursor !== undefined)) {
      requireApi(ctx.api, '1.1.0', 'query with sort or cursor');
    }
    if (args.has_link !== undefined) requireApi(ctx.api, '1.2.0', 'has_link');
    if (args.activity_since !== undefined) requireApi(ctx.api, '1.2.0', 'activity_since');
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
      ...(args.has_link ? { has_link: args.has_link } : {}),
      ...(args.activity_since !== undefined ? { activity_since: args.activity_since } : {}),
      ...(args.sort ? { sort: args.sort } : {}),
      ...(detail === 'full' ? { detail } : {}),
      ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    };
    const page = await ctx.call('search_items', { query });
    const items = page.items.map((i) => searchItemOut(i, FULL_DESCRIPTION_CHARS));
    const textSearch = args.query !== undefined && args.sort === undefined;

    const parts: string[] = [];
    if (items.length === 0) {
      parts.push('No items match.');
    } else {
      parts.push(
        `${items.length} item(s)${textSearch ? ', best match first' : ''}${clamped ? ` (page size cut to ${FULL_MAX_LIMIT} for detail="full")` : ''}:`,
      );
      // With the link or activity filters, each line says what matched.
      const line = (i: SearchItemOut): string => {
        const extra: string[] = [];
        const c = i.link_counts;
        if (args.has_link && c) {
          const kinds = [
            c.blocks > 0 ? `blocks ${c.blocks}` : '',
            c.blocked_by > 0 ? `blocked by ${c.blocked_by} (${c.blocked_by_open} open)` : '',
            c.relates > 0 ? `relates ${c.relates}` : '',
            c.duplicates > 0 ? `duplicates ${c.duplicates}` : '',
            c.duplicated_by > 0 ? `duplicated by ${c.duplicated_by}` : '',
          ].filter(Boolean);
          if (kinds.length > 0) extra.push(`links: ${kinds.join(', ')}`);
        }
        if (args.activity_since !== undefined && i.activity_at) {
          extra.push(`activity ${i.activity_at}`);
        }
        return [itemLine(i), ...extra].join(' · ');
      };
      if (detail === 'full') {
        for (const i of items) {
          parts.push(wrapLines([line(i)], 'item'));
          if (i.description !== undefined) parts.push(i.description);
        }
      } else {
        // The snippet goes into the list's one block as a flattened line.
        const lines = items.map((i, n) => {
          const snippet = page.items[n]?.match?.snippet;
          return snippet ? `${line(i)}\n  match: ${sanitizeLabel(snippet, 300)}` : line(i);
        });
        parts.push(wrapLines(lines, 'item_list'));
      }
    }
    // An API older than 1.1.0 answers a text search with one page of at most 50.
    parts.push(
      textSearch &&
        page.next_cursor === null &&
        items.length >= 50 &&
        apiAtLeast(ctx.api, '1.1.0') !== true
        ? 'This may be all: an older buildIt.Social server returns one page of text results; narrow with filters for more.'
        : nextPageHint('search_items', page.next_cursor),
    );
    return {
      structured: { items, next_cursor: page.next_cursor, text_search: textSearch },
      text: parts.join('\n'),
    };
  },
});

// ---------------------------------------------------------------------------
// get_item
// ---------------------------------------------------------------------------

const CONCISE_DESCRIPTION_CHARS = 2000;
const FULL_DESCRIPTION_MAX = 20_000;
/** A window is 20,000 code points, which can be twice as many UTF-16 characters. */
const WINDOW_MAX_CHARS = 40_000;
const COMMENT_CHARS = { concise: 2000, full: 600 } as const;

const ChildOut = ItemOutSchema.pick({
  key: true,
  title: true,
  type: true,
  status: true,
  status_category: true,
  assignee: true,
  assignee_agent: true,
  estimate: true,
});

// The development block: pull requests, branches and commits on GitHub that
// name the item's key. Their titles, branch names and author names are written on
// GitHub, outside buildIt.Social, so each is wrapped (source "git"); the text
// output lists them all inside one block (links only for pull requests: the
// structured content has every link). Values are cut short, so 20 of each
// with the longest values stay a small part of a response.

const GIT_SOURCE = 'git';
const GIT_TITLE_CHARS = 120;
const GIT_NAME_CHARS = 100;
const GIT_AUTHOR_CHARS = 50;
/** The API sends at most 20 of each; the server keeps to that whatever it gets. */
const DEVELOPMENT_MAX = 20;
/** A GitHub login: letters, digits and single hyphens, at most 39 characters. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** One line of outside text, cut with an ellipsis, in its own block. */
function wrappedLine(value: string, maxChars: number, source: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  let end = maxChars - 1;
  const code = flat.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1; // don't split a surrogate pair
  const short = flat.length > maxChars ? `${flat.slice(0, end)}…` : flat;
  return wrapUntrusted(short, { source, maxChars: maxChars + 1 });
}
/** One line of GitHub text (the link has the rest), in its own git block. */
const gitText = (value: string, maxChars: number): string =>
  wrappedLine(value, maxChars, GIT_SOURCE);
const gitNullable = (value: string | null | undefined, maxChars: number): string | null =>
  value === null || value === undefined || value === '' ? null : gitText(value, maxChars);
/** An author: a GitHub login is a plain label; anything else (a name from git) is free text, wrapped. */
const gitAuthor = (value: string | null | undefined): string | null =>
  value !== null && value !== undefined && GITHUB_LOGIN.test(value)
    ? value
    : gitNullable(value, GIT_AUTHOR_CHARS);

const DevelopmentOutSchema = z
  .object({
    pull_requests: z.array(
      z.object({
        number: z.number(),
        title: z.string().nullable(),
        state: z.string(),
        repo: z.string(),
        url: z.string(),
        author: z.string().nullable(),
        updated_at: z.string(),
      }),
    ),
    branches: z.array(
      z.object({ name: z.string(), state: z.string(), repo: z.string(), url: z.string() }),
    ),
    commits: z.array(
      z.object({
        sha: z.string(),
        title: z.string().nullable(),
        repo: z.string(),
        url: z.string(),
        author: z.string().nullable(),
        committed_at: z.string(),
      }),
    ),
    counts: z
      .object({ pull_requests: z.number(), branches: z.number(), commits: z.number() })
      .describe('Totals; the lists hold at most 20 of each.'),
  })
  .describe(
    'Titles, branch names and authors that are not GitHub logins are wrapped as untrusted content (source "git").',
  );
type DevelopmentOut = z.infer<typeof DevelopmentOutSchema>;

function developmentOut(d: Development): DevelopmentOut {
  return {
    pull_requests: d.pull_requests.slice(0, DEVELOPMENT_MAX).map((p) => ({
      number: p.number,
      title: gitNullable(p.title, GIT_TITLE_CHARS),
      state: sanitizeLabel(p.state, 30),
      repo: sanitizeLabel(p.repo, 200),
      url: sanitizeLabel(p.url, 2048),
      author: gitAuthor(p.author),
      updated_at: sanitizeLabel(p.updated_at, 40),
    })),
    branches: d.branches.slice(0, DEVELOPMENT_MAX).map((b) => ({
      name: gitText(b.name, GIT_NAME_CHARS),
      state: sanitizeLabel(b.state, 30),
      repo: sanitizeLabel(b.repo, 200),
      url: sanitizeLabel(b.url, 2048),
    })),
    commits: d.commits.slice(0, DEVELOPMENT_MAX).map((c) => ({
      sha: sanitizeLabel(c.sha, 64),
      title: gitNullable(c.title, GIT_TITLE_CHARS),
      repo: sanitizeLabel(c.repo, 200),
      url: sanitizeLabel(c.url, 2048),
      author: gitAuthor(c.author),
      committed_at: sanitizeLabel(c.committed_at, 40),
    })),
    counts: {
      pull_requests: d.counts.pull_requests,
      branches: d.counts.branches,
      commits: d.counts.commits,
    },
  };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

// The feedback block: the report behind an item that another organization
// filed through the Feedback app. The reporter's name, their organization's
// name and label, and the device values were written in that organization,
// so each is wrapped (source "feedback"); the text output lists them in one
// block. kind, severity and state are the API's words.

const FEEDBACK_SOURCE = 'feedback';
const FEEDBACK_NAME_CHARS = 100;
const FEEDBACK_DEVICE_CHARS = 80;
const FEEDBACK_NOTE = 'Your comments never reach the reporter: only a person can ask the customer.';

const FeedbackOutSchema = z
  .object({
    reporter_name: z.string().nullable(),
    org_name: z.string(),
    org_label: z.string(),
    kind: z.string(),
    severity: z.string(),
    device: z.object({
      app: z.string().nullable(),
      build: z.string().nullable(),
      platform: z.string().nullable(),
      os: z.string().nullable(),
      form: z.string().nullable(),
    }),
    plus_ones: z.number(),
    state: z.string().describe('open: updates reach the reporter.'),
  })
  .describe('Names, label and device values: untrusted content (source "feedback").');
type FeedbackOut = z.infer<typeof FeedbackOutSchema>;

const feedbackNullable = (value: string | null | undefined, maxChars: number): string | null =>
  value === null || value === undefined || value === ''
    ? null
    : wrappedLine(value, maxChars, FEEDBACK_SOURCE);

function feedbackOut(f: Feedback): FeedbackOut {
  return {
    reporter_name: feedbackNullable(f.reporter_name, FEEDBACK_NAME_CHARS),
    org_name: wrappedLine(f.org_name, FEEDBACK_NAME_CHARS, FEEDBACK_SOURCE),
    org_label: wrappedLine(f.org_label, FEEDBACK_NAME_CHARS, FEEDBACK_SOURCE),
    kind: sanitizeLabel(f.kind, 30),
    severity: sanitizeLabel(f.severity, 30),
    device: {
      app: feedbackNullable(f.device.app, FEEDBACK_DEVICE_CHARS),
      build: feedbackNullable(f.device.build, FEEDBACK_DEVICE_CHARS),
      platform: feedbackNullable(f.device.platform, FEEDBACK_DEVICE_CHARS),
      os: feedbackNullable(f.device.os, FEEDBACK_DEVICE_CHARS),
      form: feedbackNullable(f.device.form, FEEDBACK_DEVICE_CHARS),
    },
    plus_ones: f.plus_ones,
    state: sanitizeLabel(f.state, 30),
  };
}

/** The feedback block for the text output: the API's facts, then the reporter's words in one block. */
function feedbackText(f: Feedback): string {
  const one = (v: string | null | undefined, max: number): string =>
    v === null || v === undefined || v === '' ? 'unknown' : sanitizeLabel(v, max);
  const d = f.device;
  const device = [
    `app ${one(d.app, FEEDBACK_DEVICE_CHARS)}`,
    `build ${one(d.build, FEEDBACK_DEVICE_CHARS)}`,
    `platform ${one(d.platform, FEEDBACK_DEVICE_CHARS)}`,
    `os ${one(d.os, FEEDBACK_DEVICE_CHARS)}`,
    `form ${one(d.form, FEEDBACK_DEVICE_CHARS)}`,
  ].join(' · ');
  return [
    `Feedback report, filed through the Feedback app by another organization: ${sanitizeLabel(f.kind, 30)} · severity ${sanitizeLabel(f.severity, 30)} · ${plural(f.plus_ones, 'plus-one', 'plus-ones')} · state ${sanitizeLabel(f.state, 30)}`,
    wrapLines(
      [
        `reporter: ${f.reporter_name === null ? 'gone (account or organization deleted)' : one(f.reporter_name, FEEDBACK_NAME_CHARS)}`,
        `organization: ${one(f.org_name, FEEDBACK_NAME_CHARS)} (label ${one(f.org_label, FEEDBACK_NAME_CHARS)})`,
        `device: ${device}`,
      ],
      FEEDBACK_SOURCE,
    ),
    FEEDBACK_NOTE,
  ].join('\n');
}

/** The development block for the text output: a line of counts, then every ref in one git block. */
function developmentText(key: string, d: Development): string {
  const { counts } = d;
  if (counts.pull_requests + counts.branches + counts.commits === 0) {
    return `Development on GitHub: nothing names ${key} yet (or the org hasn't connected GitHub).`;
  }
  const shown = (list: unknown[], total: number): string =>
    list.length < total ? ` (the ${list.length} latest shown)` : '';
  const head = [
    plural(counts.pull_requests, 'pull request', 'pull requests') +
      shown(d.pull_requests.slice(0, DEVELOPMENT_MAX), counts.pull_requests),
    plural(counts.branches, 'branch', 'branches') +
      shown(d.branches.slice(0, DEVELOPMENT_MAX), counts.branches),
    plural(counts.commits, 'commit', 'commits') +
      shown(d.commits.slice(0, DEVELOPMENT_MAX), counts.commits),
  ];
  const one = (v: string | null | undefined, max: number): string =>
    v === null || v === undefined || v === '' ? 'unknown' : sanitizeLabel(v, max);
  const lines: string[] = [];
  if (d.pull_requests.length > 0) {
    lines.push('Pull requests:');
    for (const p of d.pull_requests.slice(0, DEVELOPMENT_MAX)) {
      lines.push(
        `- #${p.number} ${one(p.state, 30)} · ${one(p.repo, 200)} · by ${one(p.author, GIT_AUTHOR_CHARS)} · updated ${one(p.updated_at, 40)} — ${one(p.title, GIT_TITLE_CHARS)} · ${one(p.url, 300)}`,
      );
    }
  }
  if (d.branches.length > 0) {
    lines.push('Branches:');
    for (const b of d.branches.slice(0, DEVELOPMENT_MAX)) {
      lines.push(`- ${one(b.name, GIT_NAME_CHARS)} (${one(b.state, 30)}) · ${one(b.repo, 200)}`);
    }
  }
  if (d.commits.length > 0) {
    lines.push('Commits:');
    for (const c of d.commits.slice(0, DEVELOPMENT_MAX)) {
      lines.push(
        `- ${one(c.sha, 64).slice(0, 7)} · ${one(c.repo, 200)} · by ${one(c.author, GIT_AUTHOR_CHARS)} · ${one(c.committed_at, 40)} — ${one(c.title, GIT_TITLE_CHARS)}`,
      );
    }
  }
  return (
    `Development on GitHub: ${head.join(', ')}, newest first:\n` + wrapLines(lines, GIT_SOURCE)
  );
}

export const getItemTool = defineTool({
  name: 'get_item',
  toolset: 'items',
  title: 'Get an item',
  description: `Reads one item by key (DEMO-12): its fields, description (Markdown), custom fields, children, links, the latest comments and, optionally, its history.
- detail="concise" (default): the description cut at ${CONCISE_DESCRIPTION_CHARS} characters and the 5 latest comments.
- detail="full": the description up to 20,000 characters and the 20 latest comments (each cut at ${COMMENT_CHARS.full} characters).
- description_offset reads a longer description in windows of 20,000 characters: start at 0, then pass description_next_offset until it is null.
- include_history=true adds the 50 latest history events.
- include_development=true adds the GitHub pull requests, branches and commits that name the item's key (at most 20 of each, newest first, with totals); their text comes from GitHub, wrapped as untrusted content (source "git").
- An item filed through the Feedback app by another organization adds feedback: the report, with the reporter, organization and device as untrusted content. Your comments never reach the reporter.
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
    include_development: z
      .boolean()
      .optional()
      .describe('Add its GitHub pull requests, branches and commits.'),
    description_offset: z
      .number()
      .int()
      .min(0)
      .max(262_144)
      .optional()
      .describe('Read the description in a window from this character.'),
  }),
  outputSchema: z.object({
    item: ItemFullSchema,
    description_window: z
      .object({ offset: z.number(), next_offset: z.number().nullable(), length: z.number() })
      .optional()
      .describe('With description_offset: next_offset is null at the end.'),
    children: z.array(ChildOut),
    links: z.array(LinkOutSchema),
    comments: z.array(CommentOutSchema).describe('The latest comments, oldest first.'),
    comments_next_cursor: z
      .string()
      .nullable()
      .describe('For list_comments with order="desc", to read older comments.'),
    history: z.array(HistoryOutSchema).optional(),
    development: DevelopmentOutSchema.optional(),
    feedback: FeedbackOutSchema.optional(),
  }),
  async run(args, ctx) {
    const detail = args.detail ?? 'concise';
    const windowAt = args.description_offset;
    if (windowAt !== undefined) requireApi(ctx.api, '1.1.0', 'description_offset');
    const r = await ctx.call('get_item', {
      path: { key: itemRef(args.item) },
      query: {
        ...(detail === 'full' ? { detail } : {}),
        ...(args.include_history ? { include_history: 'true' } : {}),
        ...(args.include_development ? { include_development: 'true' } : {}),
        ...(windowAt !== undefined ? { description_offset: windowAt } : {}),
      },
    });
    // A window answers with its offsets; an API older than 1.1.0 ignores the parameter.
    const window =
      windowAt !== undefined && r.item.description_offset !== undefined
        ? {
            offset: r.item.description_offset,
            next_offset: r.item.description_next_offset ?? null,
            length: r.item.description_length ?? r.item.description.length,
          }
        : undefined;
    const item = itemFull(
      r.item,
      window
        ? WINDOW_MAX_CHARS
        : detail === 'full'
          ? FULL_DESCRIPTION_MAX
          : CONCISE_DESCRIPTION_CHARS,
      detail === 'full',
      detail === 'full' && apiAtLeast(ctx.api, '1.1.0') !== false
        ? `Call get_item with item="${r.item.key}" and description_offset=0 to read all of it in windows.`
        : undefined,
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
        assignee_agent: o.assignee_agent,
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
    // The server's facts, then the fields that carry names people wrote
    // (type, status, people, labels, sprint, release) in their own block.
    const facts = [
      [
        `${i.key} · project ${i.project}`,
        ...(i.parent ? [`parent ${i.parent}`] : []),
        ...(i.initiative ? [`initiative ${i.initiative}`] : []),
        `estimate ${i.estimate ?? 'none'}`,
        `start ${i.start_date ?? 'none'}`,
        `due ${i.due_date ?? 'none'}`,
      ].join(' · '),
      `version ${i.version} · description_version ${i.description_version} · created ${i.created_at} · updated ${i.updated_at}`,
    ];
    const fields = [
      `${i.key} · ${i.type} (${i.level}) · ${i.status} (${i.status_category}) · priority ${i.priority}`,
      `assignee ${i.assignee_agent && i.assignee ? `${i.assignee_agent} · for ${personText(i.assignee)}` : personText(i.assignee)} · reporter ${personText(i.reporter)}`,
      [
        `labels ${i.labels.join(', ') || 'none'}`,
        ...(i.needs.length > 0 ? [`needs ${i.needs.join(', ')}`] : []),
        `sprint ${i.sprint ?? 'none'}`,
        `fix release ${i.fix_release ?? 'none'}`,
      ].join(' · '),
    ];
    const parts = [
      facts.join('\n'),
      wrapLines(fields, 'item_fields'),
      wrapUntrusted(r.item.title, { source: 'title', maxChars: 300 }),
      ...(window
        ? [
            `Description, characters ${window.offset} to ${window.next_offset ?? window.length} of ${window.length}: ${window.next_offset === null ? 'the last window.' : `the next window is description_offset=${window.next_offset}.`}`,
          ]
        : windowAt !== undefined
          ? [
              'This buildIt.Social server ignored description_offset (its API is older than 1.1.0), so the description is cut as usual.',
            ]
          : []),
      i.description === '' ? '(no description)' : i.description,
    ];
    if (r.item.custom.length > 0) {
      parts.push(
        `Custom fields (${r.item.custom.length}):\n` +
          wrapLines(r.item.custom.map(customLine), 'custom_fields'),
      );
    }
    if (children.length > 0) {
      parts.push(
        `Children (${children.length}):\n` +
          wrapLines(
            children.map(
              (c) =>
                `${c.key} · ${c.type} · ${c.status} (${c.status_category}) · ${assigneeText(c)}${c.estimate !== null ? ` · est ${c.estimate}` : ''} — ${c.title}`,
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
    const feedback = r.feedback ? feedbackOut(r.feedback) : undefined;
    if (r.feedback) parts.push(feedbackText(r.feedback));
    const development = r.development ? developmentOut(r.development) : undefined;
    if (r.development) parts.push(developmentText(r.item.key, r.development));
    return {
      structured: {
        item,
        children,
        links,
        comments,
        comments_next_cursor: r.comments_next_cursor,
        ...(history ? { history } : {}),
        ...(development ? { development } : {}),
        ...(feedback ? { feedback } : {}),
        ...(window ? { description_window: window } : {}),
      },
      text: parts.join('\n\n'),
    };
  },
});
