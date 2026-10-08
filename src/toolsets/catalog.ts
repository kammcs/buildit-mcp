/**
 * Every tool, resource and prompt this server can offer. Add new ones here
 * (see CLAUDE.md). Order doesn't matter: the registry sorts the list it
 * serves.
 */
import { PROMPTS } from '../prompts.js';
import { RESOURCES } from '../resources.js';
import { listChannelsTool, readChannelTool, readThreadTool } from '../tools/chat.js';
import { addCommentTool, listCommentsTool } from '../tools/comments.js';
import { getItemTool, searchItemsTool } from '../tools/items-read.js';
import {
  assignItemTool,
  createItemTool,
  linkItemsTool,
  rankItemTool,
  transitionItemTool,
  unlinkItemsTool,
  updateItemTool,
} from '../tools/items-write.js';
import { createPageTool, getPageTool, listPagesTool, updatePageTool } from '../tools/pages.js';
import {
  listReleasesTool,
  listSprintsTool,
  planReleaseTool,
  planSprintTool,
  writeReleaseNotesTool,
} from '../tools/planning.js';
import {
  applyPlanTool,
  getWorkflowTool,
  listWorkTypesTool,
  proposeArchiveStatusTool,
  proposeBulkUpdateTool,
  proposeDeleteItemTool,
  proposeFieldChangeTool,
  proposeLabelChangeTool,
  proposeMoveItemTool,
  proposeWorkflowChangeTool,
  proposeWorkTypeChangeTool,
} from '../tools/plans.js';
import { describeProjectTool, findUsersTool, listProjectsTool } from '../tools/projects.js';
import { createChannelTool, createProjectTool } from '../tools/setup.js';
import { whoamiTool } from '../tools/whoami.js';
import type { PromptDefinition, ResourceDefinition, ToolDefinition } from './registry.js';

export const CATALOG: readonly ToolDefinition[] = [
  // items
  whoamiTool,
  listProjectsTool,
  describeProjectTool,
  findUsersTool,
  searchItemsTool,
  getItemTool,
  createItemTool,
  updateItemTool,
  assignItemTool,
  transitionItemTool,
  linkItemsTool,
  unlinkItemsTool,
  rankItemTool,
  // comments
  listCommentsTool,
  addCommentTool,
  // planning
  listSprintsTool,
  planSprintTool,
  listReleasesTool,
  planReleaseTool,
  writeReleaseNotesTool,
  // pages
  listPagesTool,
  getPageTool,
  createPageTool,
  updatePageTool,
  // chat
  listChannelsTool,
  readChannelTool,
  readThreadTool,
  // admin
  createChannelTool,
  createProjectTool,
  getWorkflowTool,
  listWorkTypesTool,
  proposeWorkflowChangeTool,
  proposeWorkTypeChangeTool,
  proposeFieldChangeTool,
  proposeLabelChangeTool,
  // destructive
  proposeDeleteItemTool,
  proposeMoveItemTool,
  proposeBulkUpdateTool,
  proposeArchiveStatusTool,
  // listed with any propose_* tool
  applyPlanTool,
] as readonly ToolDefinition[];

/** Resource templates (buildit://items/{key}, buildit://pages/{id}). */
export const RESOURCE_CATALOG: readonly ResourceDefinition[] = RESOURCES;

/** Prompts (plan_epic, triage, standup). */
export const PROMPT_CATALOG: readonly PromptDefinition[] = PROMPTS;
