/**
 * The toolsets and the token scopes their tools use.
 *
 * A toolset is a group of tools that can be switched on or off together
 * (BUILDIT_TOOLSETS, --toolsets, or the X-Buildit-Toolsets header in HTTP
 * mode). Each tool also declares the exact scopes it needs; a tool is only
 * listed when the token has them.
 */

/** Token scopes defined by the agent API. */
export const SCOPES = [
  'projects:read',
  'projects:write',
  'projects:delete',
  'projects:admin',
  'pages:read',
  'pages:write',
  'chat:read',
] as const;

export type Scope = (typeof SCOPES)[number];

/**
 * Scopes that a granted scope implies. A write scope implies the read scope
 * of the same area. The API is the authority; this only keeps the tool list
 * from hiding read tools from a token that was granted the write scope.
 */
export const SCOPE_IMPLIES: Readonly<Partial<Record<Scope, readonly Scope[]>>> = {
  'projects:write': ['projects:read'],
  'pages:write': ['pages:read'],
};

/** Adds the implied scopes. Unknown scope strings are kept as they are. */
export function expandScopes(granted: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const scope of granted) {
    out.add(scope);
    for (const implied of SCOPE_IMPLIES[scope as Scope] ?? []) out.add(implied);
  }
  return out;
}

export const TOOLSET_NAMES = [
  'items',
  'comments',
  'planning',
  'pages',
  'chat',
  'admin',
  'destructive',
] as const;

export type ToolsetName = (typeof TOOLSET_NAMES)[number];

export interface ToolsetInfo {
  name: ToolsetName;
  description: string;
  /** Whether the toolset is on when nothing is configured. */
  defaultEnabled: boolean;
  /** Every scope that a tool in this toolset may need. */
  scopes: readonly Scope[];
}

/** In the order tools are listed. */
export const TOOLSETS: readonly ToolsetInfo[] = [
  {
    name: 'items',
    description:
      'Projects and their items: search, read, create, update, transition, assign, link.',
    defaultEnabled: true,
    scopes: ['projects:read', 'projects:write'],
  },
  {
    name: 'comments',
    description: 'Comments on items: list and add.',
    defaultEnabled: true,
    scopes: ['projects:read', 'projects:write'],
  },
  {
    name: 'planning',
    description: 'Sprints and releases.',
    defaultEnabled: false,
    scopes: ['projects:read', 'projects:write'],
  },
  {
    name: 'pages',
    description: 'Channel pages: list, read, create and edit.',
    defaultEnabled: false,
    scopes: ['pages:read', 'pages:write'],
  },
  {
    name: 'chat',
    description: 'Channel messages and threads (read only; never direct messages).',
    defaultEnabled: false,
    scopes: ['chat:read'],
  },
  {
    name: 'admin',
    description:
      'Workflows, work types, fields and labels; every change is previewed and confirmed.',
    defaultEnabled: false,
    scopes: ['projects:read', 'projects:admin'],
  },
  {
    name: 'destructive',
    description: 'Delete, move, bulk update and archive; every change is previewed and confirmed.',
    defaultEnabled: false,
    scopes: ['projects:read', 'projects:delete'],
  },
];

export const DEFAULT_TOOLSETS: readonly ToolsetName[] = TOOLSETS.filter(
  (t) => t.defaultEnabled,
).map((t) => t.name);

export function isToolsetName(value: string): value is ToolsetName {
  return (TOOLSET_NAMES as readonly string[]).includes(value);
}
