/**
 * whoami: who the token acts as, where, and with what reach.
 */
import { z } from 'zod';

import type { MetaResponse } from '../api/generated/schemas.js';
import { defineTool } from '../toolsets/registry.js';
import { sanitizeLabel } from '../untrusted.js';
import { compareVersions, SERVER_NAME, SERVER_VERSION } from '../version.js';

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

const nullableLabel = (v: string | null | undefined): string | null =>
  v === undefined || v === null || v === '' ? null : sanitizeLabel(v);

export const whoamiTool = defineTool({
  name: 'whoami',
  toolset: 'items',
  title: 'Who am I',
  description:
    'Shows who the buildIt.Social token acts as: the user, the org, the token name and expiry, its scopes, any limits to chosen projects or channels, and the projects in reach (keys and names). Call it first to learn which project keys exist, or when a call fails with an authorization error.',
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
        name: nullableLabel(me.user.display_name),
        email: nullableLabel(me.user.email),
      },
      org: { id: me.org.id, name: nullableLabel(me.org.name) },
      token: {
        name: nullableLabel(me.token.name),
        expires_at: me.token.expires_at,
      },
      scopes: [...me.token.scopes].sort(),
      limits: {
        projects: me.token.limits.projects?.map((p) => sanitizeLabel(p.key, 40)) ?? null,
        channels: me.token.limits.channels?.map((c) => sanitizeLabel(c.name, 100)) ?? null,
      },
      projects: me.projects.map((p) => ({
        key: sanitizeLabel(p.key, 40),
        name: nullableLabel(p.name),
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
    const who = s.user.name ?? s.user.id;
    const lines = [
      `Signed in as ${who}${s.user.email ? ` (${s.user.email})` : ''} in the org ${s.org.name ?? s.org.id}` +
        (s.token.name ? `, through the token "${s.token.name}"` : '') +
        (s.token.expires_at ? ` (expires ${s.token.expires_at})` : '') +
        '.',
      `Scopes: ${s.scopes.length > 0 ? s.scopes.join(', ') : 'none'}.`,
      `Limits: ${
        s.limits.projects === null
          ? 'all projects'
          : `only the projects ${s.limits.projects.join(', ') || '(none)'}`
      }; ${
        s.limits.channels === null
          ? 'all channels'
          : `only the channels ${s.limits.channels.join(', ') || '(none)'}`
      } the user can see.`,
    ];
    if (!s.features.projects) {
      lines.push('Projects is not enabled for this org: project and item tools will not work.');
    }
    if (s.projects.length === 0) {
      lines.push('Projects in reach: none.');
    } else {
      const shown = s.projects
        .slice(0, MAX_PROJECTS_IN_TEXT)
        .map((p) => (p.name ? `${p.key} (${p.name})` : p.key));
      const more =
        s.projects.length > MAX_PROJECTS_IN_TEXT
          ? `, and ${s.projects.length - MAX_PROJECTS_IN_TEXT} more in the structured result`
          : '';
      lines.push(`Projects in reach (${s.projects.length}): ${shown.join(', ')}${more}.`);
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
