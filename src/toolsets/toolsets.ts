/**
 * The toolsets and the token scopes their tools use.
 *
 * A toolset is a group of tools that can be switched on or off together
 * (BUILDIT_TOOLSETS, --toolsets, or the X-Buildit-Toolsets header in HTTP
 * mode). Each tool also declares the exact scopes it needs; a tool is only
 * listed when the token has them.
 */

import { SCOPE_IMPLIES, SCOPES, type Scope } from '../api/generated/operations.js';

/** Token scopes defined by the agent API (from the contract). */
export { SCOPE_IMPLIES, SCOPES, type Scope };

/**
 * Adds the implied scopes, transitively, as the contract defines them
 * (projects:delete implies projects:write, which implies projects:read).
 * Unknown scope strings are kept as they are. The API is the authority; this
 * only keeps the tool list from hiding tools a granted scope allows.
 */
export function expandScopes(granted: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const pending = [...granted];
  for (let scope = pending.pop(); scope !== undefined; scope = pending.pop()) {
    if (out.has(scope)) continue;
    out.add(scope);
    if (Object.hasOwn(SCOPE_IMPLIES, scope)) pending.push(...SCOPE_IMPLIES[scope as Scope]);
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
    description: 'Sprints and releases, and release notes pages.',
    defaultEnabled: false,
    // Release notes are written as a page.
    scopes: ['projects:read', 'projects:write', 'pages:write'],
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
    // Archiving a status also changes the workflow.
    scopes: ['projects:read', 'projects:delete', 'projects:admin'],
  },
];

export const DEFAULT_TOOLSETS: readonly ToolsetName[] = TOOLSETS.filter(
  (t) => t.defaultEnabled,
).map((t) => t.name);

export function isToolsetName(value: string): value is ToolsetName {
  return (TOOLSET_NAMES as readonly string[]).includes(value);
}
