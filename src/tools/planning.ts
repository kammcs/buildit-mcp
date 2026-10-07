/**
 * Planning: list_sprints, plan_sprint, list_releases, plan_release and
 * write_release_notes.
 *
 * plan_sprint and plan_release take an action, so an agent sees two tools
 * for the whole lifecycle instead of ten. Writing release notes is its own
 * tool because it can overwrite the notes page, which makes it destructive;
 * the other planning actions only move items between sprints and releases.
 */
import { z } from 'zod';

import type { Release, Sprint } from '../api/generated/schemas.js';
import { ToolInputError } from '../errors.js';
import { defineTool } from '../toolsets/registry.js';
import { sanitizeLabel, wrapUntrusted } from '../untrusted.js';
import {
  CursorInput,
  itemRef,
  ItemRefInput,
  limitInput,
  nextPageHint,
  ProjectKeyInput,
  scopesOf,
} from './shared.js';

const label = (v: string, max = 200): string => sanitizeLabel(v, max);
const DateInput = z.iso.date();
const ItemsInput = z
  .array(ItemRefInput)
  .min(1)
  .max(50)
  .describe('Item keys of the project, such as ["DEMO-12", "DEMO-13"]; at most 50.');

// ---------------------------------------------------------------------------
// Sprints
// ---------------------------------------------------------------------------

const SprintOut = z.object({
  id: z.string(),
  number: z.number(),
  name: z.string(),
  goal: z.string().nullable().describe('People-written; wrapped as untrusted content.'),
  state: z.string().describe('planned, active or completed.'),
  starts_on: z.string().nullable(),
  ends_on: z.string().nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  item_count: z.number(),
  done_count: z.number(),
});
type SprintOut = z.infer<typeof SprintOut>;

function sprintOut(s: Sprint): SprintOut {
  return {
    id: s.id,
    number: s.number,
    name: label(s.name, 80),
    goal: s.goal === null ? null : wrapUntrusted(s.goal, { source: 'sprint_goal', maxChars: 500 }),
    state: s.state,
    starts_on: s.starts_on,
    ends_on: s.ends_on,
    started_at: s.started_at,
    completed_at: s.completed_at,
    item_count: s.item_count,
    done_count: s.done_count,
  };
}

/** A sprint's line; without its counts when the caller states them another way. */
function sprintLine(s: SprintOut, counts = true): string {
  const dates = s.starts_on || s.ends_on ? ` · ${s.starts_on ?? '?'} to ${s.ends_on ?? '?'}` : '';
  return `- #${s.number} ${s.name} · ${s.state}${dates}${counts ? ` · done ${s.done_count} of ${s.item_count}` : ''}`;
}

/** A sprint's line, then its goal (people-written) in its own block. */
function sprintText(s: SprintOut, counts = true): string {
  const line = sprintLine(s, counts);
  return s.goal ? `${line}\n${s.goal}` : line;
}

/**
 * What completing a sprint did, with one set of counts: the completion's
 * (committed, completed, carried), which agree with each other. The
 * sprint's own counts are left out, since carried items no longer count
 * in it.
 */
function completionText(
  s: SprintOut,
  r: {
    committed_count: number;
    committed_points: number;
    completed_count: number;
    completed_points: number;
    carried_count: number;
  },
  carriedTo: string | null,
): string {
  const lines = [
    `Completed sprint #${s.number} ${s.name}: done ${r.completed_count} of ${r.committed_count} item(s) committed (${r.completed_points} of ${r.committed_points} points).`,
  ];
  if (r.carried_count > 0) {
    lines.push(
      `${r.carried_count} open item(s) were carried to ${carriedTo ?? 'the backlog (no sprint)'}; they count there now, no longer in this sprint.`,
    );
  } else {
    lines.push('No open items were left to carry.');
  }
  const rest = r.committed_count - r.completed_count - r.carried_count;
  if (rest > 0) lines.push(`${rest} canceled item(s) stay in this sprint, not done.`);
  lines.push(sprintText(s, false));
  return lines.join('\n');
}

export const listSprintsTool = defineTool({
  name: 'list_sprints',
  toolset: 'planning',
  title: 'List sprints',
  description:
    'Lists a project\'s sprints, newest first: number, name, goal, state (planned, active, completed), dates and how many items each holds and has done. Filter by state, for example state=["active"] for the current sprint. Sprints are named in other tools by number, name, or "active". Paged: pass next_cursor as cursor for more.',
  scopes: scopesOf('list_sprints'),
  annotations: {
    title: 'List sprints',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    project: ProjectKeyInput,
    state: z
      .array(z.enum(['planned', 'active', 'completed']))
      .min(1)
      .max(3)
      .optional()
      .describe('Only sprints in these states.'),
    cursor: CursorInput.optional(),
    limit: limitInput(100, 25),
  }),
  outputSchema: z.object({
    project: z.string(),
    sprints: z.array(SprintOut),
    next_cursor: z.string().nullable(),
  }),
  async run(args, ctx) {
    const page = await ctx.call('list_sprints', {
      path: { key: args.project },
      query: {
        ...(args.state ? { state: args.state } : {}),
        ...(args.cursor ? { cursor: args.cursor } : {}),
        ...(args.limit ? { limit: args.limit } : {}),
      },
    });
    const sprints = page.items.map(sprintOut);
    const key = args.project.toUpperCase();
    const text = [
      sprints.length === 0 ? `No sprints in ${key}.` : `${sprints.length} sprint(s) in ${key}:`,
      ...sprints.map((s) => sprintText(s)),
      nextPageHint('list_sprints', page.next_cursor),
    ].join('\n');
    return { structured: { project: key, sprints, next_cursor: page.next_cursor }, text };
  },
});

const SprintActions = ['create', 'start', 'complete', 'add_items', 'remove_items'] as const;

export const planSprintTool = defineTool({
  name: 'plan_sprint',
  toolset: 'planning',
  title: 'Plan a sprint',
  description: `Creates, starts or completes a sprint, or moves items in or out of one. action:
- "create": a planned sprint; needs name, optional goal, starts_on and ends_on (YYYY-MM-DD). The number is assigned.
- "start": starts a planned sprint (project admins); optional starts_on, ends_on, goal. Only one sprint can be active.
- "complete": completes the active sprint (project admins); its open items go to carry_to: "next" (the next planned sprint, created if there is none; the default), "new" (a new sprint) or "backlog" (no sprint). Returns the committed, completed and carried counts.
- "add_items": puts up to 50 items of the project in the sprint (taking them out of any other).
- "remove_items": takes up to 50 items out of the sprint, to the backlog.
sprint names the sprint for every action but create: its number, name, or "active". Adding or removing items that are already where they should be changes nothing.`,
  scopes: scopesOf(
    'create_sprint',
    'start_sprint',
    'complete_sprint',
    'add_sprint_items',
    'remove_sprint_items',
  ),
  annotations: {
    title: 'Plan a sprint',
    readOnlyHint: false,
    destructiveHint: false,
    // Creating twice makes two sprints.
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    project: ProjectKeyInput,
    action: z.enum(SprintActions),
    sprint: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe('The sprint: a number, a name or "active". Not for create.'),
    name: z.string().min(1).max(80).optional().describe('For create: the sprint name.'),
    goal: z.string().max(500).optional().describe('For create and start: the sprint goal.'),
    starts_on: DateInput.optional().describe('For create and start: YYYY-MM-DD.'),
    ends_on: DateInput.optional().describe('For create and start: YYYY-MM-DD.'),
    carry_to: z
      .enum(['next', 'new', 'backlog'])
      .optional()
      .describe('For complete: where open items go (default next).'),
    items: ItemsInput.optional().describe('For add_items and remove_items: item keys, at most 50.'),
  }),
  outputSchema: z.object({
    action: z.string(),
    sprint: SprintOut,
    changed: z
      .array(z.string())
      .optional()
      .describe('add_items, remove_items: the keys of the items that moved.'),
    summary: z
      .object({
        committed_count: z.number(),
        committed_points: z.number(),
        completed_count: z.number(),
        completed_points: z.number(),
        carried_count: z.number(),
        carried_to: z.string().nullable(),
      })
      .optional()
      .describe('complete: the sprint in numbers.'),
  }),
  async run(args, ctx) {
    const key = args.project;
    const needSprint = (): string => {
      if (args.sprint === undefined) {
        throw new ToolInputError(
          `action "${args.action}" needs sprint (a number, a name or "active").`,
        );
      }
      return args.sprint;
    };
    const needItems = (): string[] => {
      if (args.items === undefined)
        throw new ToolInputError(`action "${args.action}" needs items.`);
      return args.items.map(itemRef);
    };
    switch (args.action) {
      case 'create': {
        if (args.name === undefined) throw new ToolInputError('action "create" needs name.');
        const r = await ctx.call('create_sprint', {
          path: { key },
          body: {
            name: args.name,
            ...(args.goal !== undefined ? { goal: args.goal } : {}),
            ...(args.starts_on !== undefined ? { starts_on: args.starts_on } : {}),
            ...(args.ends_on !== undefined ? { ends_on: args.ends_on } : {}),
          },
        });
        const sprint = sprintOut(r.sprint);
        return {
          structured: { action: args.action, sprint },
          text: `Created sprint #${sprint.number} in ${key.toUpperCase()}:\n${sprintText(sprint)}`,
        };
      }
      case 'start': {
        const r = await ctx.call('start_sprint', {
          path: { key, sprint: needSprint() },
          body: {
            ...(args.goal !== undefined ? { goal: args.goal } : {}),
            ...(args.starts_on !== undefined ? { starts_on: args.starts_on } : {}),
            ...(args.ends_on !== undefined ? { ends_on: args.ends_on } : {}),
          },
        });
        const sprint = sprintOut(r.sprint);
        return {
          structured: { action: args.action, sprint },
          text: `Started sprint #${sprint.number}:\n${sprintText(sprint)}`,
        };
      }
      case 'complete': {
        const r = await ctx.call('complete_sprint', {
          path: { key, sprint: needSprint() },
          body: args.carry_to !== undefined ? { carry_to: args.carry_to } : {},
        });
        const sprint = sprintOut(r.sprint);
        const carriedTo = r.carried_to
          ? `#${r.carried_to.number} ${label(r.carried_to.name, 80)}`
          : null;
        const summary = {
          committed_count: r.committed_count,
          committed_points: r.committed_points,
          completed_count: r.completed_count,
          completed_points: r.completed_points,
          carried_count: r.carried_count,
          carried_to: carriedTo,
        };
        return {
          structured: { action: args.action, sprint, summary },
          text: completionText(sprint, r, carriedTo),
        };
      }
      case 'add_items':
      case 'remove_items': {
        const add = args.action === 'add_items';
        const r = await ctx.call(add ? 'add_sprint_items' : 'remove_sprint_items', {
          path: { key, sprint: needSprint() },
          body: { items: needItems() },
        });
        const sprint = sprintOut(r.sprint);
        const changed = r.changed.map((i) => i.key);
        return {
          structured: { action: args.action, sprint, changed },
          text: [
            changed.length === 0
              ? 'Nothing changed: the items were already where they should be.'
              : `${add ? 'Added to' : 'Removed from'} sprint #${sprint.number}: ${changed.join(', ')}.`,
            sprintLine(sprint),
          ].join('\n'),
        };
      }
    }
  },
});

// ---------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------

const ReleaseOut = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().describe('People-written; wrapped as untrusted content.'),
  status: z.string().describe('unreleased, released or archived.'),
  start_date: z.string().nullable(),
  target_date: z.string().nullable(),
  released_at: z.string().nullable(),
  notes_page_id: z.string().nullable().describe('The release notes page (get_page reads it).'),
  item_count: z.number(),
  done_count: z.number(),
});
type ReleaseOut = z.infer<typeof ReleaseOut>;

function releaseOut(r: Release): ReleaseOut {
  return {
    id: r.id,
    name: label(r.name, 80),
    description:
      r.description === null
        ? null
        : wrapUntrusted(r.description, { source: 'release_description', maxChars: 1000 }),
    status: r.status,
    start_date: r.start_date,
    target_date: r.target_date,
    released_at: r.released_at,
    notes_page_id: r.notes_page_id,
    item_count: r.item_count,
    done_count: r.done_count,
  };
}

function releaseLine(r: ReleaseOut): string {
  return `- ${r.name} · ${r.status}${r.target_date ? ` · target ${r.target_date}` : ''}${r.released_at ? ` · released ${r.released_at}` : ''} · ${r.done_count}/${r.item_count} done`;
}

function releaseText(r: ReleaseOut): string {
  return r.description ? `${releaseLine(r)}\n${r.description}` : releaseLine(r);
}

export const listReleasesTool = defineTool({
  name: 'list_releases',
  toolset: 'planning',
  title: 'List releases',
  description:
    "Lists a project's releases (fix versions): name, description, status (unreleased, released, archived), dates, the notes page and how many items each holds and has done. Filter with status. Releases are named in other tools by name. To see a release's items, use search_items with release. Paged: pass next_cursor as cursor for more.",
  scopes: scopesOf('list_releases'),
  annotations: {
    title: 'List releases',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    project: ProjectKeyInput,
    status: z
      .array(z.enum(['unreleased', 'released', 'archived']))
      .min(1)
      .max(3)
      .optional()
      .describe('Only releases with these statuses.'),
    cursor: CursorInput.optional(),
    limit: limitInput(100, 25),
  }),
  outputSchema: z.object({
    project: z.string(),
    releases: z.array(ReleaseOut),
    next_cursor: z.string().nullable(),
  }),
  async run(args, ctx) {
    const page = await ctx.call('list_releases', {
      path: { key: args.project },
      query: {
        ...(args.status ? { status: args.status } : {}),
        ...(args.cursor ? { cursor: args.cursor } : {}),
        ...(args.limit ? { limit: args.limit } : {}),
      },
    });
    const releases = page.items.map(releaseOut);
    const key = args.project.toUpperCase();
    const text = [
      releases.length === 0 ? `No releases in ${key}.` : `${releases.length} release(s) in ${key}:`,
      ...releases.map(releaseText),
      nextPageHint('list_releases', page.next_cursor),
    ].join('\n');
    return { structured: { project: key, releases, next_cursor: page.next_cursor }, text };
  },
});

const ReleaseActions = ['create', 'release', 'add_items', 'remove_items'] as const;

export const planReleaseTool = defineTool({
  name: 'plan_release',
  toolset: 'planning',
  title: 'Plan a release',
  description: `Creates or ships a release, or sets which items it holds. action:
- "create": an unreleased release; needs name (unique in the project), optional description, start_date and target_date (YYYY-MM-DD).
- "release": marks it released (project admins), on released_on (default today); its open items move to move_open_to (another release's name) or lose their fix version. Releasing it again changes nothing.
- "add_items": sets up to 50 items' fix version to this release.
- "remove_items": clears the fix version of up to 50 items, when it is this release.
release names the release (by name) for every action but create. To write its notes page, use write_release_notes.`,
  scopes: scopesOf(
    'create_release',
    'release_version',
    'add_release_items',
    'remove_release_items',
  ),
  annotations: {
    title: 'Plan a release',
    readOnlyHint: false,
    destructiveHint: false,
    // Creating twice is refused (names are unique), but it is a create.
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    project: ProjectKeyInput,
    action: z.enum(ReleaseActions),
    release: z.string().min(1).max(80).optional().describe('The release, by name. Not for create.'),
    name: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe('For create: the release name, such as 1.2.0.'),
    description: z.string().max(10_000).optional().describe('For create.'),
    start_date: DateInput.optional().describe('For create: YYYY-MM-DD.'),
    target_date: DateInput.optional().describe('For create: YYYY-MM-DD.'),
    released_on: DateInput.optional().describe('For release: YYYY-MM-DD (default today).'),
    move_open_to: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe('For release: the release that open items move to.'),
    items: ItemsInput.optional().describe('For add_items and remove_items: item keys, at most 50.'),
  }),
  outputSchema: z.object({
    action: z.string(),
    release: ReleaseOut,
    changed: z
      .array(z.string())
      .optional()
      .describe('add_items, remove_items: the keys of the items that changed.'),
  }),
  async run(args, ctx) {
    const key = args.project;
    const needRelease = (): string => {
      if (args.release === undefined) {
        throw new ToolInputError(`action "${args.action}" needs release (its name).`);
      }
      return args.release;
    };
    switch (args.action) {
      case 'create': {
        if (args.name === undefined) throw new ToolInputError('action "create" needs name.');
        const r = await ctx.call('create_release', {
          path: { key },
          body: {
            name: args.name,
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(args.start_date !== undefined ? { start_date: args.start_date } : {}),
            ...(args.target_date !== undefined ? { target_date: args.target_date } : {}),
          },
        });
        const release = releaseOut(r.release);
        return {
          structured: { action: args.action, release },
          text: `Created release ${release.name} in ${key.toUpperCase()}:\n${releaseText(release)}`,
        };
      }
      case 'release': {
        const r = await ctx.call('release_version', {
          path: { key, release: needRelease() },
          body: {
            ...(args.released_on !== undefined ? { released_on: args.released_on } : {}),
            ...(args.move_open_to !== undefined ? { move_open_to: args.move_open_to } : {}),
          },
        });
        const release = releaseOut(r.release);
        return {
          structured: { action: args.action, release },
          text: `Release ${release.name} is ${release.status}:\n${releaseLine(release)}`,
        };
      }
      case 'add_items':
      case 'remove_items': {
        if (args.items === undefined)
          throw new ToolInputError(`action "${args.action}" needs items.`);
        const add = args.action === 'add_items';
        const r = await ctx.call(add ? 'add_release_items' : 'remove_release_items', {
          path: { key, release: needRelease() },
          body: { items: args.items.map(itemRef) },
        });
        const release = releaseOut(r.release);
        const changed = r.changed.map((i) => i.key);
        return {
          structured: { action: args.action, release, changed },
          text: [
            changed.length === 0
              ? 'Nothing changed: the items were already as asked.'
              : `${add ? 'Added to' : 'Removed from'} release ${release.name}: ${changed.join(', ')}.`,
            releaseLine(release),
          ].join('\n'),
        };
      }
    }
  },
});

/** The most of the written notes one result shows (the text and structured content both carry it). */
const NOTES_CHARS = 8000;

export const writeReleaseNotesTool = defineTool({
  name: 'write_release_notes',
  toolset: 'planning',
  title: 'Write release notes',
  description: `Writes a release's notes page (in the project channel's pages) from the items it holds.
- The first call creates the page; later calls rewrite it.
- If a person edited the page since it was last written, nothing is overwritten: the result says needs_confirmation and gives the page's current version. Show the person, and only if they agree, call again with page_version set to that version, which replaces their edits.
- locale: the language of the headings (en, es-419, fr-CA, sr-Cyrl or sr-Latn); default: the person's.
Needs pages:write as well, since the notes are a page. Returns the notes as written (cut at ${NOTES_CHARS.toLocaleString('en')} characters; get_page reads the whole page).`,
  scopes: scopesOf('generate_release_notes'),
  annotations: {
    title: 'Write release notes',
    readOnlyHint: false,
    // It can replace a page that people edited (only with page_version).
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    project: ProjectKeyInput,
    release: z.string().min(1).max(80).describe('The release, by name.'),
    locale: z.enum(['en', 'es-419', 'fr-CA', 'sr-Cyrl', 'sr-Latn']).optional(),
    page_version: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Only after the person agreed: the version from needs_confirmation, to replace their edits.',
      ),
  }),
  outputSchema: z.object({
    page_id: z.string().nullable(),
    page_version: z.number().nullable(),
    created: z.boolean(),
    overwrote_edits: z.boolean(),
    needs_confirmation: z
      .boolean()
      .describe('true: people edited the page; nothing was written (see page_version).'),
    markdown: z
      .string()
      .nullable()
      .describe(
        'The notes as written, wrapped as untrusted content and cut; null when nothing was written.',
      ),
  }),
  async run(args, ctx) {
    const r = await ctx.call('generate_release_notes', {
      path: { key: args.project, release: args.release },
      body: {
        ...(args.locale !== undefined ? { locale: args.locale } : {}),
        ...(args.page_version !== undefined ? { page_version: args.page_version } : {}),
      },
    });
    const structured = {
      page_id: r.page_id,
      page_version: r.page_version,
      created: r.created,
      overwrote_edits: r.overwrote_edits,
      needs_confirmation: r.needs_confirmation,
      // The notes quote item titles, which people wrote.
      markdown:
        r.markdown === undefined
          ? null
          : wrapUntrusted(r.markdown, {
              source: 'release_notes',
              maxChars: NOTES_CHARS,
              moreHint: `Call get_page with page="${r.page_id ?? ''}" to read the whole page.`,
            }),
    };
    const release = sanitizeLabel(args.release, 80);
    const text = r.needs_confirmation
      ? `Nothing written: people edited the notes page of ${release} (page ${r.page_id ?? '?'}, version ${r.page_version ?? '?'}) since it was last written. Ask the person; only if they want their edits replaced, call write_release_notes again with page_version=${r.page_version ?? '?'}.`
      : `${r.created ? 'Created' : 'Rewrote'} the notes page of ${release} (page ${r.page_id ?? '?'}, version ${r.page_version ?? '?'})${r.overwrote_edits ? ', replacing edits as confirmed' : ''}.`;
    return {
      structured,
      text: structured.markdown ? `${text}\n${structured.markdown}` : text,
    };
  },
});
