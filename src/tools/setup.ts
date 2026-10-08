/**
 * Setting up work, in the admin toolset: create_channel and create_project.
 *
 * Neither changes or removes anything that exists, so they apply directly
 * (no plan): create_channel makes a new channel, and create_project turns a
 * channel into a project from a template. Both need projects:admin and a
 * token without project or channel limits, so they aren't listed for a
 * limited token (`unlimitedOnly`). Both take an idempotency key, generated
 * and returned when the agent gives none, so a retry can't create twice.
 */
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { ApiError } from '../api/client.js';
import { ToolInputError } from '../errors.js';
import { defineTool, type ToolContext } from '../toolsets/registry.js';
import { sanitizeLabel, wrapUntrusted } from '../untrusted.js';
import { ChannelOut, channelOut } from './chat.js';
import { ChannelRefInput } from './pages.js';
import { ProjectOut, projectOut } from './projects.js';
import { IdempotencyKeyInput, PersonSchema, person, personText, scopesOf } from './shared.js';

/** The note for a token with limits: these tools need one without. */
const LIMITS_NOTE =
  'Creating channels and projects needs a token without project or channel limits, so this token cannot do it. Ask the person for a token with projects:admin and no limits.';

const NEW_KEY_NOTE =
  'Leave idempotency_key out to have a new one generated (or send a new random uuid).';

/** One entry of an error's details, if the details are an object. */
function detail(err: ApiError, key: string): unknown {
  const d = err.details;
  return d !== null && typeof d === 'object' && key in d
    ? (d as Record<string, unknown>)[key]
    : undefined;
}

/** The paths of a validation error's fields. */
function fieldPaths(err: ApiError): string[] {
  const fields = detail(err, 'fields');
  if (!Array.isArray(fields)) return [];
  return fields.map((f: unknown) =>
    f !== null && typeof f === 'object' && 'path' in f ? String(f.path) : '',
  );
}

/** Calls the API; an error gets the tool's note for its code, when it has one. */
async function withNotes<T>(
  call: () => Promise<T>,
  note: (err: ApiError) => string | undefined,
): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof ApiError) {
      const text = note(err);
      if (text !== undefined) throw err.withNote(text);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// create_channel
// ---------------------------------------------------------------------------

function channelNote(err: ApiError): string | undefined {
  switch (err.code) {
    case 'validation':
      return fieldPaths(err).includes('name')
        ? 'The name is taken: channel names are unique in the org, ignoring case. Ask the person for another name, or use the existing channel (list_channels lists the ones they belong to).'
        : 'name is 1 to 100 characters, description at most 1000, members at most 50 people.';
    case 'not_found':
      return 'Nothing was created. Name each member by the email of an active person in the org (or their exact display name or id), then call create_channel again, without the unknown person or with their email.';
    case 'ambiguous':
      return 'Nothing was created. Name that person by their email.';
    case 'outside_limits':
      return LIMITS_NOTE;
    case 'forbidden':
      return detail(err, 'reason') === 'guest'
        ? "Guests can't create channels. Nothing was created."
        : 'The person may not create this channel. Nothing was created.';
    case 'idempotency_conflict':
      return `That key was used for something else, or for a channel with another name or visibility. ${NEW_KEY_NOTE}`;
    default:
      return undefined;
  }
}

export const createChannelTool = defineTool({
  name: 'create_channel',
  toolset: 'admin',
  title: 'Create a channel',
  description: `Creates a channel in the org, as the person, who becomes its first member.
- visibility: "public" (the org's members, not guests, can find and join it) or "private" (only its members see it).
- name: 1 to 100 characters, unique in the org (ignoring case). description is optional.
- members: other people to add, by email (best), exact display name or id; active people of the org, guests included; at most 50. An unknown person fails the call and nothing is created.
- idempotency_key: retrying with the same key returns the first channel instead of creating a second, and adds listed people still missing; one is generated and returned if you leave it out.
To start a project, create the channel here, then call create_project with it. Needs a token without project or channel limits.
Returns the channel with its id, and its members.`,
  scopes: scopesOf('create_channel'),
  unlimitedOnly: true,
  annotations: {
    title: 'Create a channel',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    name: z
      .string()
      .min(1)
      .max(100)
      .refine((s) => s.trim().length > 0, 'The name cannot be blank.')
      .describe('The channel name, unique in the org.'),
    visibility: z.enum(['public', 'private']).describe('public or private (ask the person).'),
    description: z.string().max(1000).optional().describe('What the channel is for.'),
    members: z
      .array(z.string().min(1).max(320))
      .max(50)
      .optional()
      .describe('People to add besides the person: emails, exact display names or ids.'),
    idempotency_key: IdempotencyKeyInput.optional(),
  }),
  outputSchema: z.object({
    channel: ChannelOut,
    members: z.array(PersonSchema).describe("The channel's members after the call."),
    created: z.boolean().describe('false: an earlier call with this idempotency_key created it.'),
    idempotency_key: z.string(),
  }),
  async run(args, ctx: ToolContext) {
    const key = args.idempotency_key ?? randomUUID();
    const r = await withNotes(
      () =>
        ctx.call('create_channel', {
          body: {
            name: args.name,
            visibility: args.visibility,
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(args.members !== undefined && args.members.length > 0
              ? { members: args.members }
              : {}),
            idempotency_key: key,
          },
        }),
      channelNote,
    );
    const channel = channelOut(r.channel);
    const members = r.members.map(person);
    const headline = r.created
      ? `Created ${channel.visibility} channel ${channel.id}.`
      : `Nothing new: channel ${channel.id} was already created with this idempotency_key; listed people who were missing were added.`;
    const facts = wrapUntrusted(
      [
        `Name: ${channel.name}`,
        `Members (${members.length}): ${members.map(personText).join(', ') || 'none'}`,
      ].join('\n'),
      { source: 'channel', maxChars: 20_000 },
    );
    const next =
      channel.project === null
        ? `Next: to make it a project, call create_project with channel="${channel.id}" and a key.`
        : `It is the channel of project ${channel.project}.`;
    return {
      structured: { channel, members, created: r.created, idempotency_key: key },
      text: [
        headline,
        facts,
        ...(channel.description ? [channel.description] : []),
        `idempotency_key: ${key}`,
        next,
      ].join('\n'),
    };
  },
});

// ---------------------------------------------------------------------------
// create_project
// ---------------------------------------------------------------------------

const TEMPLATES = ['software_scrum', 'software_kanban', 'design', 'ops', 'marketing'] as const;

function projectNote(err: ApiError): string | undefined {
  switch (err.code) {
    case 'validation': {
      const paths = fieldPaths(err);
      if (paths.includes('key')) {
        return 'The key is taken (another project uses it or used it before; keys stay reserved) or not 2 to 6 letters and digits starting with a letter. Ask the person for another key; list_projects shows the keys in use.';
      }
      if (paths.includes('channel')) {
        return 'That channel is already a project (an archived one counts); list_projects shows the projects. For a new project, create a channel with create_channel first.';
      }
      if (paths.some((p) => p.startsWith('estimate_values'))) {
        return 'estimate_values go only with estimate_scale "points": numbers from 0 to 9999.99, at most 30.';
      }
      return 'Check key, template and the estimate settings against the tool description, then retry.';
    }
    case 'not_found':
      return 'The person must be a member of the channel; list_channels lists theirs, and create_channel makes a new one.';
    case 'ambiguous':
      return 'Name the channel by its id.';
    case 'archived':
      return 'Or pick another channel (create_channel makes a new one).';
    case 'forbidden':
      return detail(err, 'reason') === 'admins_only'
        ? 'Only org admins can turn an org-wide channel into a project. Pick another channel, or create one with create_channel.'
        : 'The person may not turn this channel into a project. Pick another channel, or create one with create_channel.';
    case 'projects_off':
      return 'An org admin can turn Projects on in buildIt.Social; create_channel works without it.';
    case 'outside_limits':
      return LIMITS_NOTE;
    case 'idempotency_conflict':
      return `That key was used for something else, or for another channel or project key. ${NEW_KEY_NOTE}`;
    default:
      return undefined;
  }
}

const CreatedProjectOut = ProjectOut.extend({
  template: z.string().describe('The template it started from.'),
  channel: z.object({ id: z.string(), name: z.string() }),
});

export const createProjectTool = defineTool({
  name: 'create_project',
  toolset: 'admin',
  title: 'Create a project',
  description: `Turns a channel the person belongs to into a project, from a template: types, workflows, board, fields, labels and starter pages. The person becomes its project admin.
- The project's name is the channel's name; there is no separate project name. For a new project, call create_channel first, then this with that channel.
- channel: its name or id (list_channels); not archived, and not a project already.
- key: 2 to 6 characters, a letter then letters or digits, such as DEMO (any case; stored in upper case); items are numbered DEMO-1, DEMO-2. Agree it with the person: it can't easily be changed later, and a key in use or used before in the org is refused.
- template: software_scrum (default: sprints, story points), software_kanban (a board and releases), design, ops (requests and incidents) or marketing. sprints_enabled, releases_enabled and estimate_scale override the template's; estimate_values only with estimate_scale "points".
- idempotency_key: retrying with the same key returns the first project instead of creating a second; one is generated and returned if you leave it out.
Needs the org's Projects feature and a token without project or channel limits. Returns the project as list_projects shows it; then describe_project shows the template's configuration.`,
  scopes: scopesOf('create_project'),
  unlimitedOnly: true,
  annotations: {
    title: 'Create a project',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    channel: ChannelRefInput,
    key: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9]{1,5}$/, 'A letter, then 1 to 5 letters or digits.')
      .describe('The new project key, such as DEMO.'),
    template: z.enum(TEMPLATES).optional().describe('Default software_scrum.'),
    sprints_enabled: z.boolean().optional(),
    releases_enabled: z.boolean().optional(),
    estimate_scale: z.enum(['none', 'points', 'tshirt']).optional(),
    estimate_values: z
      .array(z.number().min(0).max(9999.99))
      .min(1)
      .max(30)
      .optional()
      .describe('The points allowed (default 1, 2, 3, 5, 8, 13).'),
    idempotency_key: IdempotencyKeyInput.optional(),
  }),
  outputSchema: z.object({
    project: CreatedProjectOut,
    created: z.boolean().describe('false: an earlier call with this idempotency_key created it.'),
    idempotency_key: z.string(),
  }),
  async run(args, ctx: ToolContext) {
    if (
      args.estimate_values !== undefined &&
      args.estimate_scale !== undefined &&
      args.estimate_scale !== 'points'
    ) {
      throw new ToolInputError(
        'estimate_values go only with estimate_scale "points": drop one of them.',
      );
    }
    const key = args.idempotency_key ?? randomUUID();
    const r = await withNotes(
      () =>
        ctx.call('create_project', {
          body: {
            channel: args.channel,
            key: args.key,
            ...(args.template !== undefined ? { template: args.template } : {}),
            ...(args.sprints_enabled !== undefined
              ? { sprints_enabled: args.sprints_enabled }
              : {}),
            ...(args.releases_enabled !== undefined
              ? { releases_enabled: args.releases_enabled }
              : {}),
            ...(args.estimate_scale !== undefined ? { estimate_scale: args.estimate_scale } : {}),
            ...(args.estimate_values !== undefined
              ? { estimate_values: args.estimate_values }
              : {}),
            idempotency_key: key,
          },
        }),
      projectNote,
    );
    const p = r.project;
    const project = {
      ...projectOut(p),
      template: sanitizeLabel(p.template_key, 60),
      channel: { id: p.channel.id, name: sanitizeLabel(p.channel.name, 100) },
    };
    const headline = r.created
      ? `Created project ${project.key} from the ${project.template} template, in channel ${project.channel.id}; the person is its project admin.`
      : `Nothing new: project ${project.key} was already created with this idempotency_key.`;
    const settings = [
      `sprints ${project.sprints_enabled ? 'on' : 'off'}`,
      `releases ${project.releases_enabled ? 'on' : 'off'}`,
      `estimates ${project.estimate_scale}`,
    ].join(', ');
    return {
      structured: { project, created: r.created, idempotency_key: key },
      text: [
        headline,
        wrapUntrusted(`Name (the channel's): ${project.name}`, { source: 'project' }),
        `Settings: ${settings}.`,
        `idempotency_key: ${key}`,
        `Next: describe_project with project="${project.key}" shows its types, workflows, fields and labels; create_item adds items (${project.key}-1, ...).`,
      ].join('\n'),
    };
  },
});
