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
 *
 * One exception: a tool marked `withPlans` (apply_plan) is listed whenever
 * any propose_* tool is, whatever its own toolset, since its scope is the
 * proposed change's. Read-only mode and the exclude list still apply to it.
 *
 * Resources and prompts follow rules 1 and 4 (they change nothing).
 */
import type { ToolAnnotations } from '@modelcontextprotocol/server';
import type { z } from 'zod';

import type { ApiClient, ApiRequestOptions } from '../api/client.js';
import type { OperationId } from '../api/generated/operations.js';
import { callOperation, type OperationArgs, type OperationResponse } from '../api/operations.js';
import type { Logger } from '../log.js';
import { expandScopes, TOOLSETS, type Scope, type ToolsetName } from './toolsets.js';

/** The MCP client's name and version, as it reported them. */
export interface ClientInfo {
  name: string;
  version?: string | undefined;
}

/** What a tool handler gets besides its arguments. */
export interface ToolContext {
  /** The API client for this caller's token. */
  api: ApiClient;
  logger: Logger;
  signal?: AbortSignal;
  /** Options for direct ApiClient calls: the tool's name, the client, the signal. */
  apiOptions: ApiRequestOptions;
  /** Calls one API operation on behalf of this tool. */
  call<Id extends OperationId>(id: Id, args?: OperationArgs<Id>): Promise<OperationResponse<Id>>;
}

/** The context for one call of `tool`. */
export function createToolContext(init: {
  api: ApiClient;
  logger: Logger;
  tool: string;
  signal?: AbortSignal | undefined;
  client?: ClientInfo | undefined;
}): ToolContext {
  const apiOptions: ApiRequestOptions = {
    tool: init.tool,
    ...(init.client ? { client: init.client } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
  };
  return {
    api: init.api,
    logger: init.logger,
    ...(init.signal ? { signal: init.signal } : {}),
    apiOptions,
    call: (id, args = {}) => callOperation(init.api, id, args, apiOptions),
  };
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
  /** Listed whenever a propose_* tool is listed, instead of by its toolset and scopes. */
  withPlans?: boolean;
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
  const allowed = (tool: ToolDefinition): boolean =>
    (!policy.readOnly || tool.annotations.readOnlyHint) && !excluded.has(tool.name);
  const listed = catalog
    .filter((tool) => tool.withPlans !== true)
    .filter((tool) => toolsets.has(tool.toolset))
    .filter(allowed)
    .filter((tool) => scopes === null || tool.scopes.every((s) => scopes.has(s)));
  const proposes = listed.some((tool) => tool.name.startsWith(PROPOSE_PREFIX));
  const companions = proposes
    ? catalog.filter((tool) => tool.withPlans === true).filter(allowed)
    : [];
  return [...listed, ...companions].sort(compareTools);
}

/** Tools that propose a plan start with this; apply_plan comes with them. */
export const PROPOSE_PREFIX = 'propose_';

/** What a resource or prompt needs to be offered: its toolset and its scopes. */
export interface Gated {
  name: string;
  toolset: ToolsetName;
  scopes: readonly Scope[];
}

/** The resources or prompts a caller may see: by toolset and, when known, scopes. */
export function selectGated<T extends Gated>(
  defs: readonly T[],
  toolsets: readonly ToolsetName[],
  grantedScopes: Iterable<string> | null,
): T[] {
  const enabled = new Set(toolsets);
  const scopes = grantedScopes === null ? null : expandScopes(grantedScopes);
  return defs
    .filter((d) => enabled.has(d.toolset))
    .filter((d) => scopes === null || d.scopes.every((s) => scopes.has(s)));
}

/** A resource template whose reads go through the API, as the person. */
export interface ResourceDefinition extends Gated {
  title: string;
  /** Static text only. */
  description: string;
  /** An RFC 6570 template, such as buildit://items/{key}. */
  uriTemplate: string;
  mimeType: string;
  /** The resource's text for the template's variables. Throw ApiError to fail. */
  read(vars: Record<string, string>, ctx: ToolContext): Promise<string>;
}

/** A prompt: static text with the person's arguments filled in. */
export interface PromptDefinition<A extends z.ZodObject = z.ZodObject> extends Gated {
  title: string;
  /** Static text only. */
  description: string;
  argsSchema: A;
  build(args: z.infer<A>): string;
}

export function definePrompt<A extends z.ZodObject>(
  definition: PromptDefinition<A>,
): PromptDefinition<A> {
  return definition;
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
    if (tool.withPlans === true && tool.scopes.length > 0) {
      throw new Error(`${tool.name}: a tool listed with plans takes the plan's scope, not its own`);
    }
  }
}
