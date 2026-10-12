/**
 * Typed calls to the agent API's operations, by operationId.
 *
 * The method, the path, the parameters and the response schema come from the
 * generated contract (src/api/generated/), so a tool names an operation and
 * its arguments and never spells out a URL. Everything goes through
 * ApiClient.requestParsed, which keeps auth, request ids, retries, timeouts
 * and error mapping in one place.
 */
import type { z } from 'zod';

import { ToolInputError } from '../errors.js';
import type { ApiClient, ApiRequestOptions, QueryValue } from './client.js';
import { OPERATIONS, type OperationId } from './generated/operations.js';
import type { OperationIO } from './generated/strict.js';

export type OperationResponse<Id extends OperationId> = z.infer<
  (typeof OPERATIONS)[Id]['response']
>;

type PathParams<Id extends OperationId> = (typeof OPERATIONS)[Id]['pathParams'][number];

export interface OperationArgs<Id extends OperationId> {
  /** Values for the path's {placeholders}; each is URL-encoded. */
  path?: Record<PathParams<Id>, string>;
  /** Query parameters; arrays become repeated parameters. Undefined values are left out. */
  query?: OperationIO[Id]['query'];
  body?: OperationIO[Id]['body'];
}

/** A path segment that would climb or stay in place once the URL is resolved. */
const DOT_SEGMENT = /^\.{1,2}$/;

/**
 * Fills in the path's placeholders. A value is URL-encoded, so it stays one
 * segment; a value that is "." or "..", or has such a segment between
 * slashes, is refused (ToolInputError) because the URL would resolve it
 * into another route.
 */
export function operationPath(id: OperationId, values: Record<string, string> = {}): string {
  return OPERATIONS[id].path.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`${id}: missing path parameter ${name}`);
    if (value.split(/[/\\]/).some((segment) => DOT_SEGMENT.test(segment))) {
      throw new ToolInputError(
        `${name} can't be "." or "..", or contain such a part between slashes. Use the name or id as listed.`,
      );
    }
    return encodeURIComponent(value);
  });
}

/** Calls one operation and parses its response with the generated (tolerant) schema. */
export async function callOperation<Id extends OperationId>(
  api: ApiClient,
  id: Id,
  args: OperationArgs<Id>,
  options: Omit<ApiRequestOptions, 'query' | 'body'>,
): Promise<OperationResponse<Id>> {
  const op = OPERATIONS[id];
  const path = operationPath(id, args.path);
  const query = args.query as Record<string, QueryValue | readonly string[]> | undefined;
  const body = args.body as unknown;
  const schema = op.response as unknown as z.ZodType<OperationResponse<Id>>;
  return api.requestParsed(op.method, path, schema, {
    ...options,
    // Logged instead of the filled-in path, which can carry names.
    operation: id,
    pathTemplate: op.path,
    ...(query === undefined ? {} : { query }),
    // A POST without a body still sends an empty object, which the contract expects.
    ...(body === undefined ? (op.hasBody ? { body: {} } : {}) : { body }),
  });
}
