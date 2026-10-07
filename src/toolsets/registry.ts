/**
 * Tool definitions and the rules for which tools a caller sees.
 *
 * A tool is listed when all of these hold:
 *   1. its toolset is enabled (config, or the X-Buildit-Toolsets header);
 *   2. read-only mode is off, or the tool is read-only;
 *   3. its name is not in the exclude list;
 *   4. the token has every scope the tool declares (from GET /v1/me).
 *
 * Rules 1 to 3 are the operator's policy and also apply to calls. Rule 4 only
 * shapes the list, so an agent never sees tools its token can't use; the API
 * still checks scopes on every call.
 */
import type { ToolAnnotations } from '@modelcontextprotocol/server';
import type { z } from 'zod';

import type { ApiClient } from '../api/client.js';
import type { Logger } from '../log.js';
import { expandScopes, TOOLSETS, type Scope, type ToolsetName } from './toolsets.js';

/** What a tool handler gets besides its arguments. */
export interface ToolContext {
  /** The API client for this caller's token. */
  api: ApiClient;
  logger: Logger;
  signal?: AbortSignal;
}

/** A tool's successful outcome: structured data matching its outputSchema, and a short text summary. */
export interface ToolOutput<T> {
  structured: T;
  text: string;
}

export interface ToolHints extends ToolAnnotations {
  /** Required so every tool states it explicitly; read-only mode keeps only these. */
  readOnlyHint: boolean;
}

export interface ToolDefinition<
  I extends z.ZodObject = z.ZodObject,
  O extends z.ZodObject = z.ZodObject,
> {
  /** snake_case, stable once released. */
  name: string;
  toolset: ToolsetName;
  title: string;
  /** Static text only; never built from server data. */
  description: string;
  /** Every scope the tool needs. Empty for tools any valid token may use. */
  scopes: readonly Scope[];
  annotations: ToolHints;
  inputSchema: I;
  outputSchema: O;
  /** Throw ApiError (or anything else) to fail; the server turns it into an error result. */
  run(args: z.infer<I>, ctx: ToolContext): Promise<ToolOutput<z.infer<O>>>;
}

/** Identity helper that keeps the argument and output types tied to the schemas. */
export function defineTool<I extends z.ZodObject, O extends z.ZodObject>(
  definition: ToolDefinition<I, O>,
): ToolDefinition<I, O> {
  return definition;
}

export interface ToolPolicy {
  toolsets: readonly ToolsetName[];
  readOnly: boolean;
  excludeTools: readonly string[];
}

const TOOLSET_ORDER = new Map(TOOLSETS.map((t, i) => [t.name, i]));

function compareTools(a: ToolDefinition, b: ToolDefinition): number {
  const byToolset = (TOOLSET_ORDER.get(a.toolset) ?? 99) - (TOOLSET_ORDER.get(b.toolset) ?? 99);
  if (byToolset !== 0) return byToolset;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * The tools a caller may see, in a fixed order (toolset order, then name).
 *
 * @param grantedScopes the token's scopes from /v1/me, or `null` to skip the
 *   scope rule (used when serving a call: the API checks scopes itself).
 */
export function selectTools(
  catalog: readonly ToolDefinition[],
  policy: ToolPolicy,
  grantedScopes: Iterable<string> | null,
): ToolDefinition[] {
  const toolsets = new Set(policy.toolsets);
  const excluded = new Set(policy.excludeTools);
  const scopes = grantedScopes === null ? null : expandScopes(grantedScopes);
  return catalog
    .filter((tool) => toolsets.has(tool.toolset))
    .filter((tool) => !policy.readOnly || tool.annotations.readOnlyHint)
    .filter((tool) => !excluded.has(tool.name))
    .filter((tool) => scopes === null || tool.scopes.every((s) => scopes.has(s)))
    .sort(compareTools);
}

/** Names in `names` that no tool in the catalog has (for a startup warning). */
export function unknownToolNames(
  catalog: readonly ToolDefinition[],
  names: readonly string[],
): string[] {
  const known = new Set(catalog.map((t) => t.name));
  return names.filter((n) => !known.has(n));
}

/** Throws if the catalog breaks the rules every tool must follow (checked by the tests). */
export function assertValidCatalog(catalog: readonly ToolDefinition[]): void {
  const seen = new Set<string>();
  for (const tool of catalog) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool.name)) throw new Error(`Bad tool name: ${tool.name}`);
    if (seen.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
    seen.add(tool.name);
    const toolset = TOOLSETS.find((t) => t.name === tool.toolset);
    if (!toolset) throw new Error(`${tool.name}: unknown toolset ${tool.toolset}`);
    for (const scope of tool.scopes) {
      if (!toolset.scopes.includes(scope)) {
        throw new Error(`${tool.name}: scope ${scope} is not declared by toolset ${tool.toolset}`);
      }
    }
    if (tool.annotations.readOnlyHint && tool.annotations.destructiveHint) {
      throw new Error(`${tool.name}: a read-only tool can't be destructive`);
    }
  }
}
