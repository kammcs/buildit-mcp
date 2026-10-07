/**
 * Every tool this server can offer. Add new tools here (see CLAUDE.md).
 * Order doesn't matter: the registry sorts the list it serves.
 */
import { whoamiTool } from '../tools/whoami.js';
import type { ToolDefinition } from './registry.js';

export const CATALOG: readonly ToolDefinition[] = [whoamiTool];
