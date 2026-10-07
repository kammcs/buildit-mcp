/**
 * Stand-in tools for testing the registry and the transports, spread over
 * several toolsets and scopes. They call nothing.
 */
import { z } from 'zod';

import { defineTool, type ToolDefinition } from '../../src/toolsets/registry.js';
import type { Scope, ToolsetName } from '../../src/toolsets/toolsets.js';
import { whoamiTool } from '../../src/tools/whoami.js';

function stub(
  name: string,
  toolset: ToolsetName,
  scopes: Scope[],
  readOnly: boolean,
  destructive = false,
): ToolDefinition {
  return defineTool({
    name,
    toolset,
    title: name,
    description: `Test tool ${name}.`,
    scopes,
    annotations: { readOnlyHint: readOnly, destructiveHint: destructive },
    inputSchema: z.object({}),
    outputSchema: z.object({ ok: z.boolean() }),
    run: () => Promise.resolve({ structured: { ok: true }, text: 'ok' }),
  });
}

export const TEST_CATALOG: readonly ToolDefinition[] = [
  stub('propose_delete_item', 'destructive', ['projects:read', 'projects:delete'], false, true),
  stub('read_channel', 'chat', ['chat:read'], true),
  stub('add_comment', 'comments', ['projects:write'], false),
  stub('list_comments', 'comments', ['projects:read'], true),
  stub('create_item', 'items', ['projects:write'], false),
  stub('search_items', 'items', ['projects:read'], true),
  whoamiTool,
];
