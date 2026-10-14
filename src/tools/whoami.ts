/**
 * whoami: who the token acts as, where, and with what reach.
 */
import { z } from 'zod';

import type { MetaResponse } from '../api/generated/schemas.js';
import { defineTool } from '../toolsets/registry.js';
import { expandScopes } from '../toolsets/toolsets.js';
import { sanitizeLabel } from '../untrusted.js';
import { compareVersions, SERVER_NAME, SERVER_VERSION } from '../version.js';
import { NAME_CHARS, PERSON_NAME_CHARS, wrapLines } from './shared.js';

const MAX_PROJECTS_IN_TEXT = 50;

const OutputSchema = z.object({
  user: z.object({
    id: z.string(),
    name: z.string().nullable(),
    email: z.string().nullable(),
  }),
  org: z.object({
    id: z.string(),
    name: z.string().nullable(),
  }),
  token: z.object({
    name: z.string().nullable(),
    expires_at: z.string().nullable(),
  }),
  scopes: z.array(z.string()).describe('As granted; a write scope also allows reading.'),
  limits: z.object({
    projects: z
      .array(z.string())
      .nullable()
      .describe('Keys of the projects the token is limited to; null means every project.'),
    channels: z
      .array(z.string())
      .nullable()
      .describe('Names of the channels the token is limited to; null means every channel.'),
  }),
  projects: z.array(
    z.object({
      key: z.string(),
      name: z.string().nullable(),
      id: z.string().nullable(),
    }),
  ),
  cannot: z.array(z.string()).describe("What the token can't do."),
  features: z.object({
    projects: z.boolean().describe('Whether Projects is enabled for the org.'),
  }),
  rate_limits: z.object({
    requests_per_minute: z.number().describe("The token's requests a minute."),
    user_requests_per_minute: z
      .number()
      .describe("The user's requests a minute, across all their tokens."),
    writes_per_minute: z.number().describe("The token's writes a minute."),
    writes_per_day: z.number().describe("The token's writes a day (UTC)."),
    org_requests_per_minute: z
      .number()
      .describe("The org's requests a minute, across all its tokens."),
  }),
  server: z.object({
    name: z.string(),
    version: z.string(),
    api_version: z.string().nullable(),
    update_required: z.boolean(),
  }),
});

/**
 * What a token can't do, in words, from its scopes (with the ones they imply)
 * and its limits. The API is the authority; this only tells the agent why a
 * tool isn't listed, so it can tell the person instead of looking for one.
 */
export function cannotDo(
  scopes: readonly string[],
  limits: { projects?: readonly unknown[] | null; channels?: readonly unknown[] | null },
): string[] {
  const has = expandScopes(scopes);
  const out: string[] = [];
  if (!has.has('projects:read')) out.push('read projects or items (needs projects:read)');
  if (!has.has('projects:write')) {
    out.push(
      `change items, comments, sprints or releases (${has.has('projects:read') ? 'it can only read; ' : ''}needs projects:write)`,
    );
  }
  if (!has.has('projects:delete'))
    out.push('delete, move or bulk-edit items (needs projects:delete)');
  if (!has.has('projects:admin')) {
    out.push(
      'create channels or projects, or change workflows, work types, fields or labels (needs projects:admin)',
    );
  } else if ((limits.projects ?? null) !== null || (limits.channels ?? null) !== null) {
    out.push(
      'create channels or projects (the token is limited to some projects or channels; that needs a token without limits)',
    );
  }
  if (!has.has('pages:read')) out.push('read pages (needs pages:read)');
  else if (!has.has('pages:write')) out.push('create or edit pages (needs pages:write)');
  if (!has.has('chat:read')) out.push('read channel messages (needs chat:read)');
  return out;
}

const nullableLabel = (v: string | null | undefined, max: number): string | null =>
  v === undefined || v === null || v === '' ? null : sanitizeLabel(v, max);

export const whoamiTool = defineTool({
  name: 'whoami',
  toolset: 'items',
  title: 'Who am I',
  description:
    "Who the token acts as: the user, the org, the token's name, expiry, scopes and limits, what it can't do, and the projects in reach. Call it when you don't know the project keys, when no tool fits a task, or after an authorization error.",
  scopes: [],
  annotations: {
    title: 'Who am I',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: OutputSchema,
  async run(_args, ctx) {
    const options = ctx.apiOptions;
    const [me, meta] = await Promise.all([
      ctx.api.getMe(options),
      ctx.api.getMeta(options).catch((err: unknown): MetaResponse | undefined => {
        ctx.logger.debug('meta unavailable', { error: err });
        return undefined;
      }),
    ]);

    const minVersion = meta?.min_mcp_version;
    const updateRequired =
      minVersion !== undefined && compareVersions(SERVER_VERSION, minVersion) < 0;

    const structured: z.infer<typeof OutputSchema> = {
      user: {
        id: me.user.id,
        name: nullableLabel(me.user.display_name, PERSON_NAME_CHARS),
        email: nullableLabel(me.user.email, 320),
      },
      org: { id: me.org.id, name: nullableLabel(me.org.name, NAME_CHARS) },
      token: {
        name: nullableLabel(me.token.name, NAME_CHARS),
        expires_at: me.token.expires_at,
      },
      scopes: [...me.token.scopes].sort(),
      limits: {
        projects: me.token.limits.projects?.map((p) => sanitizeLabel(p.key, 40)) ?? null,
        channels: me.token.limits.channels?.map((c) => sanitizeLabel(c.name, NAME_CHARS)) ?? null,
      },
      cannot: cannotDo(me.token.scopes, me.token.limits),
      projects: me.projects.map((p) => ({
        key: sanitizeLabel(p.key, 40),
        name: nullableLabel(p.name, NAME_CHARS),
        id: p.id,
      })),
      features: { projects: me.features.projects },
      rate_limits: {
        requests_per_minute: me.rate_limits.requests_per_minute,
        user_requests_per_minute: me.rate_limits.user_requests_per_minute,
        writes_per_minute: me.rate_limits.writes_per_minute,
        writes_per_day: me.rate_limits.writes_per_day,
        org_requests_per_minute: me.rate_limits.org_requests_per_minute,
      },
      server: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
        api_version: meta?.api_version ?? null,
        update_required: updateRequired,
      },
    };

    const s = structured;
    // The names of the user, the org, the token, the projects and the
    // channels were written by people: one block holds them all.
    const names = [
      `User: ${s.user.name ?? s.user.id}${s.user.email ? ` (${s.user.email})` : ''}`,
      `Org: ${s.org.name ?? s.org.id}`,
      ...(s.token.name ? [`Token: ${s.token.name}`] : []),
    ];
    if (s.projects.length > 0) {
      const shown = s.projects
        .slice(0, MAX_PROJECTS_IN_TEXT)
        .map((p) => (p.name ? `${p.key} (${p.name})` : p.key));
      names.push(`Projects in reach: ${shown.join(', ')}`);
    }
    if (s.limits.channels !== null && s.limits.channels.length > 0) {
      names.push(`Channels the token is limited to: ${s.limits.channels.join(', ')}`);
    }
    const lines = [
      `Signed in to buildIt.Social with a personal access token${s.token.expires_at ? ` (expires ${s.token.expires_at})` : ''}. Who and where, as people named them:`,
      wrapLines(names, 'names'),
      `Scopes: ${s.scopes.length > 0 ? s.scopes.join(', ') : 'none'}.`,
      `Limits: ${
        s.limits.projects === null
          ? 'all projects'
          : `only the projects ${s.limits.projects.join(', ') || '(none)'}`
      }; ${
        s.limits.channels === null
          ? 'all channels the user can see'
          : s.limits.channels.length === 0
            ? 'no channels'
            : `only the ${s.limits.channels.length} channel(s) listed above, among those the user can see`
      }.`,
    ];
    if (s.cannot.length > 0) {
      lines.push(`This token can't: ${s.cannot.join('; ')}.`);
    }
    if (!s.features.projects) {
      lines.push('Projects is not enabled for this org: project and item tools will not work.');
    }
    if (s.projects.length === 0) {
      lines.push('Projects in reach: none.');
    } else {
      const more =
        s.projects.length > MAX_PROJECTS_IN_TEXT
          ? ` (the first ${MAX_PROJECTS_IN_TEXT} listed above; the rest in the structured result)`
          : ' (listed above)';
      lines.push(`Projects in reach: ${s.projects.length}${more}.`);
    }
    const r = s.rate_limits;
    lines.push(
      `Rate limits for this token: ${r.requests_per_minute} calls and ${r.writes_per_minute} writes a minute, ${r.writes_per_day} writes a day. For your account, across all your tokens: ${r.user_requests_per_minute} calls a minute. For the whole org: ${r.org_requests_per_minute} calls a minute.`,
    );
    if (updateRequired) {
      lines.push(
        `This buildit-mcp (${SERVER_VERSION}) is older than the API supports (${minVersion} or newer). Ask the person to update it.`,
      );
    }
    return { structured, text: lines.join('\n') };
  },
});
