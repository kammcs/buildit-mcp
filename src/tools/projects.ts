/**
 * Project tools: list_projects, describe_project, find_users.
 */
import { z } from 'zod';

import { ApiError } from '../api/client.js';
import type { DescribeProjectResponse, ProjectMember } from '../api/generated/schemas.js';
import { defineTool, type ToolContext } from '../toolsets/registry.js';
import { sanitizeLabel } from '../untrusted.js';
import { CursorInput, limitInput, nextPageHint, ProjectKeyInput, scopesOf } from './shared.js';

const label = (v: string, max = 200): string => sanitizeLabel(v, max);

// ---------------------------------------------------------------------------
// list_projects
// ---------------------------------------------------------------------------

const ProjectOut = z.object({
  key: z.string(),
  name: z.string(),
  id: z.string(),
  archived: z.boolean(),
  sprints_enabled: z.boolean(),
  releases_enabled: z.boolean(),
  estimate_scale: z.string().describe('none, points or tshirt.'),
  item_counts: z.object({
    not_started: z.number(),
    started: z.number(),
    done: z.number(),
    canceled: z.number(),
  }),
});

export const listProjectsTool = defineTool({
  name: 'list_projects',
  toolset: 'items',
  title: 'List projects',
  description:
    'Lists the projects the token can reach, with their keys (such as DEMO), names, settings (sprints, releases, estimate scale) and item counts by status category. Use it to find a project key; then describe_project for its statuses, types, labels, fields and members. Paged: pass next_cursor as cursor for more.',
  scopes: scopesOf('list_projects'),
  annotations: {
    title: 'List projects',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    include_archived: z.boolean().optional().describe('Also list archived projects.'),
    cursor: CursorInput.optional(),
    limit: limitInput(100, 25),
  }),
  outputSchema: z.object({
    projects: z.array(ProjectOut),
    next_cursor: z.string().nullable(),
  }),
  async run(args, ctx) {
    const page = await ctx.call('list_projects', {
      query: {
        ...(args.include_archived ? { include_archived: 'true' } : {}),
        ...(args.cursor ? { cursor: args.cursor } : {}),
        ...(args.limit ? { limit: args.limit } : {}),
      },
    });
    const projects = page.items.map((p) => ({
      key: p.key,
      name: label(p.name),
      id: p.id,
      archived: p.archived,
      sprints_enabled: p.sprints_enabled,
      releases_enabled: p.releases_enabled,
      estimate_scale: p.estimate_scale,
      item_counts: {
        not_started: p.item_counts.not_started,
        started: p.item_counts.started,
        done: p.item_counts.done,
        canceled: p.item_counts.canceled,
      },
    }));
    const lines = projects.map((p) => {
      const c = p.item_counts;
      return `- ${p.key}: ${p.name}${p.archived ? ' (archived)' : ''} · ${c.not_started} not started, ${c.started} started, ${c.done} done, ${c.canceled} canceled`;
    });
    const text = [
      projects.length === 0 ? 'No projects in reach.' : `${projects.length} project(s):`,
      ...lines,
      nextPageHint('list_projects', page.next_cursor),
    ].join('\n');
    return { structured: { projects, next_cursor: page.next_cursor }, text };
  },
});

// ---------------------------------------------------------------------------
// describe_project
// ---------------------------------------------------------------------------

const MemberOut = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  role: z.string().describe('owner, admin, member or guest (in the org).'),
  is_project_admin: z.boolean(),
});
type MemberOut = z.infer<typeof MemberOut>;

function memberOut(m: ProjectMember): MemberOut {
  return {
    id: m.id,
    name: label(m.display_name, 100),
    email: m.email === null ? null : label(m.email, 320),
    role: m.role,
    is_project_admin: m.is_project_admin,
  };
}

function memberText(m: MemberOut): string {
  const who = m.email ? `${m.name} <${m.email}>` : m.name;
  const role = [m.role, ...(m.is_project_admin ? ['project admin'] : [])].join(', ');
  return `${who} (${role})`;
}

const TransitionOut = z.object({
  to: z.string(),
  required_fields: z.array(z.string()),
  admins_only: z.boolean(),
});

const DescribeOut = z.object({
  project: z.object({
    key: z.string(),
    name: z.string(),
    id: z.string(),
    archived: z.boolean(),
    sprints_enabled: z.boolean(),
    releases_enabled: z.boolean(),
    estimate_scale: z.string(),
    estimate_values: z
      .array(z.number())
      .describe('The allowed estimates; empty means any (points) or the t-shirt sizes.'),
    default_type: z.string().nullable(),
    time_zone: z.string(),
  }),
  types: z.array(
    z.object({
      name: z.string(),
      level: z.string().describe('epic, standard or subtask.'),
      workflow: z.string(),
    }),
  ),
  workflows: z.array(
    z.object({
      name: z.string(),
      types: z.array(z.string()),
      restrict_transitions: z
        .boolean()
        .describe('true: only the listed moves are allowed; false: any move.'),
      statuses: z.array(
        z.object({
          name: z.string(),
          category: z.string(),
          is_initial: z.boolean(),
          board_column: z.string().nullable(),
          allowed: z.array(TransitionOut).describe('Moves allowed from this status.'),
        }),
      ),
    }),
  ),
  labels: z.array(z.string()),
  fields: z.array(
    z.object({
      name: z.string(),
      kind: z.string(),
      options: z.array(z.string()),
      types: z.array(z.string()).nullable().describe('Types it applies to; null means all.'),
      required_on_create: z.boolean(),
    }),
  ),
  members: z.array(MemberOut),
});
type DescribeOut = z.infer<typeof DescribeOut>;

const MAX_MEMBERS_IN_TEXT = 40;

function describeOut(r: DescribeProjectResponse): DescribeOut {
  const p = r.project;
  return {
    project: {
      key: p.key,
      name: label(p.name),
      id: p.id,
      archived: p.archived,
      sprints_enabled: p.sprints_enabled,
      releases_enabled: p.releases_enabled,
      estimate_scale: p.estimate_scale,
      estimate_values: p.estimate_values,
      default_type: p.default_type === null ? null : label(p.default_type, 60),
      time_zone: label(p.time_zone, 60),
    },
    types: r.types.map((t) => ({
      name: label(t.name, 60),
      level: t.level,
      workflow: label(t.workflow.name, 60),
    })),
    workflows: r.workflows.map((w) => ({
      name: label(w.name, 60),
      types: w.types.map((t) => label(t, 60)),
      restrict_transitions: w.restrict_transitions,
      statuses: w.statuses.map((s) => ({
        name: label(s.name, 60),
        category: s.category,
        is_initial: s.is_initial,
        board_column: s.board_column === null ? null : label(s.board_column, 60),
        allowed: s.allowed.map((a) => ({
          to: label(a.to, 60),
          required_fields: a.required_fields.map((f) => label(f, 60)),
          admins_only: a.admins_only,
        })),
      })),
    })),
    labels: r.labels.map((l) => label(l.name, 40)),
    fields: r.fields.map((f) => ({
      name: label(f.name, 60),
      kind: f.kind,
      options: f.options.map((o) => label(o.label, 100)),
      types: f.types === null ? null : f.types.map((t) => label(t, 60)),
      required_on_create: f.required_on_create,
    })),
    members: r.members.map(memberOut),
  };
}

/** "Done (needs assignee; admins only)" */
export function transitionText(a: z.infer<typeof TransitionOut>): string {
  const notes = [
    ...(a.required_fields.length > 0 ? [`needs ${a.required_fields.join(', ')}`] : []),
    ...(a.admins_only ? ['project admins only'] : []),
  ];
  return notes.length > 0 ? `${a.to} (${notes.join('; ')})` : a.to;
}

/** A status as workflowLines shows it. */
export interface StatusForText {
  name: string;
  category: string;
  is_initial: boolean;
  id?: string;
  allowed: readonly z.infer<typeof TransitionOut>[];
}

/**
 * A workflow's statuses and moves, as lines. A workflow that restricts
 * transitions lists the moves from each status. One that doesn't allows any
 * move ("any status → any status"), so only the moves with rules (required
 * fields, project admins only) are listed.
 */
export function workflowLines(restrict: boolean, statuses: readonly StatusForText[]): string[] {
  const head = (s: StatusForText): string =>
    `${s.name} [${s.category}${s.is_initial ? ', initial' : ''}]${s.id ? ` (id ${s.id})` : ''}`;
  if (restrict) {
    return [
      'Moves: only the ones listed below.',
      ...statuses.map(
        (s) => `- ${head(s)} -> ${s.allowed.map(transitionText).join('; ') || 'none'}`,
      ),
    ];
  }
  const rules = statuses.flatMap((s) =>
    s.allowed
      .filter((a) => a.admins_only || a.required_fields.length > 0)
      .map((a) => `${s.name} → ${transitionText(a)}`),
  );
  return [
    'Moves: any status → any status.',
    ...statuses.map((s) => `- ${head(s)}`),
    `Moves with rules: ${rules.join('; ') || 'none'}.`,
  ];
}

function describeText(d: DescribeOut): string {
  const p = d.project;
  const estimates =
    p.estimate_scale === 'none'
      ? 'no estimates'
      : `estimates in ${p.estimate_scale}${p.estimate_values.length > 0 ? ` (${p.estimate_values.join(', ')})` : ''}`;
  const lines = [
    `Project ${p.key}: ${p.name}${p.archived ? ' (archived)' : ''}`,
    `Settings: ${estimates}; sprints ${p.sprints_enabled ? 'on' : 'off'}; releases ${p.releases_enabled ? 'on' : 'off'}; default type ${p.default_type ?? 'none'}; time zone ${p.time_zone}.`,
    `Types: ${d.types.map((t) => `${t.name} (${t.level}, workflow ${t.workflow})`).join('; ') || 'none'}.`,
  ];
  for (const w of d.workflows) {
    lines.push(`Workflow ${w.name} (types: ${w.types.join(', ') || 'none'}):`);
    lines.push(...workflowLines(w.restrict_transitions, w.statuses));
  }
  lines.push(`Labels: ${d.labels.join(', ') || 'none'}.`);
  lines.push(
    `Custom fields: ${
      d.fields
        .map((f) => {
          const extra = [
            f.kind,
            ...(f.options.length > 0 ? [`options ${f.options.join(', ')}`] : []),
            ...(f.required_on_create ? ['required on create'] : []),
            ...(f.types ? [`types ${f.types.join(', ')}`] : []),
          ];
          return `${f.name} (${extra.join('; ')})`;
        })
        .join('; ') || 'none'
    }.`,
  );
  const shown = d.members.slice(0, MAX_MEMBERS_IN_TEXT).map(memberText);
  const more =
    d.members.length > MAX_MEMBERS_IN_TEXT
      ? `; and ${d.members.length - MAX_MEMBERS_IN_TEXT} more (use find_users)`
      : '';
  lines.push(`Members (${d.members.length}): ${shown.join('; ')}${more}.`);
  return lines.join('\n');
}

async function readProject(ctx: ToolContext, key: string): Promise<DescribeProjectResponse> {
  return ctx.call('describe_project', { path: { key } });
}

export const describeProjectTool = defineTool({
  name: 'describe_project',
  toolset: 'items',
  title: 'Describe a project',
  description:
    "Describes one project: its types (epic, standard, subtask levels) and the workflow each follows; each workflow's statuses with the moves allowed from each status and the fields those moves require; labels; custom fields with their options; the estimate scale and allowed values; and the members (people who can be assigned or mentioned). Call it before creating, transitioning or labelling items, so you use names that exist. Statuses, types, labels and fields are then given by name, case-insensitive.",
  scopes: scopesOf('describe_project'),
  annotations: {
    title: 'Describe a project',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({ project: ProjectKeyInput }),
  outputSchema: DescribeOut,
  async run(args, ctx) {
    const structured = describeOut(await readProject(ctx, args.project));
    return { structured, text: describeText(structured) };
  },
});

// ---------------------------------------------------------------------------
// find_users
// ---------------------------------------------------------------------------

function normalize(s: string): string {
  return s.normalize('NFKC').toLowerCase().trim();
}

/** An API from before the members route answers 404 with kind "route". */
function noMembersRoute(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.code !== 'not_found') return false;
  const details = err.details as { kind?: unknown } | undefined;
  return details?.kind === 'route';
}

export const findUsersTool = defineTool({
  name: 'find_users',
  toolset: 'items',
  title: 'Find people in a project',
  description:
    'Finds people among a project\'s members, the people who can be assigned items or mentioned there: by part of a name or email (case-insensitive), or "me". Leave query out to list everyone, by display name, one page at a time (pass next_cursor as cursor for more). Returns names, emails, org roles and whether each is a project admin. Use the email (or "me") to assign or mention someone; a display name works only when it is unique, and this tells two people with the same name apart.',
  scopes: scopesOf('list_project_members'),
  annotations: {
    title: 'Find people in a project',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    project: ProjectKeyInput,
    query: z
      .string()
      .max(100)
      .optional()
      .describe(
        'Part of a display name or email, case-insensitive; "me" for yourself. Leave it out to list everyone.',
      ),
    cursor: CursorInput.optional(),
    limit: limitInput(100, 25),
  }),
  outputSchema: z.object({
    project: z.string(),
    users: z.array(MemberOut),
    next_cursor: z.string().nullable(),
  }),
  async run(args, ctx) {
    const query = args.query?.trim() ?? '';
    const limit = args.limit ?? 25;
    let me: { id: string; email: string | null; display_name: string } | undefined;
    if (normalize(query) === 'me') me = (await ctx.api.getMe(ctx.apiOptions)).user;
    const q = me ? (me.email ?? me.display_name) : query;

    let members: ProjectMember[];
    let next: string | null;
    let fallback = false;
    try {
      const page = await ctx.call('list_project_members', {
        path: { key: args.project },
        query: {
          ...(q !== '' ? { q: q.slice(0, 100) } : {}),
          ...(args.cursor ? { cursor: args.cursor } : {}),
          limit,
        },
      });
      members = page.items;
      next = page.next_cursor;
    } catch (err) {
      if (!noMembersRoute(err)) throw err;
      // An older API: filter describe_project's members here, in one page.
      fallback = true;
      const needle = normalize(q);
      members = (await readProject(ctx, args.project)).members.filter(
        (m) =>
          needle === '' ||
          normalize(m.display_name).includes(needle) ||
          (m.email !== null && normalize(m.email).includes(needle)),
      );
      next = null;
    }
    if (me) {
      const id = me.id;
      members = members.filter((m) => m.id === id);
      next = null;
    }
    const users = members.slice(0, limit).map(memberOut);
    const key = args.project.toUpperCase();
    const header =
      users.length === 0
        ? `No member of ${key} matches${query ? ` "${sanitizeLabel(query, 100)}"` : ''}${args.cursor ? ' in this page' : ''}.`
        : `${users.length} member(s) of ${key}${query ? ` matching "${sanitizeLabel(query, 100)}"` : ''}:`;
    const lines = [header, ...users.map((u) => `- ${memberText(u)}`)];
    if (fallback && members.length > users.length) {
      lines.push(`Showing ${users.length} of ${members.length}; narrow the query or raise limit.`);
    } else {
      lines.push(nextPageHint('find_users', next));
    }
    return {
      structured: { project: key, users, next_cursor: next },
      text: lines.join('\n'),
    };
  },
});
