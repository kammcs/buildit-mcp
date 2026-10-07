/**
 * Resources, so a person can attach an item or a page to a conversation by
 * hand: buildit://items/{key} and buildit://pages/{id}.
 *
 * A read goes through the API as the person, like the matching tool
 * (get_item, get_page), and returns the same text: facts, then the
 * people-written parts in <untrusted_content> blocks.
 */
import { ToolInputError } from './errors.js';
import { getItemTool } from './tools/items-read.js';
import { readPage } from './tools/pages.js';
import { scopesOf } from './tools/shared.js';
import type { ResourceDefinition } from './toolsets/registry.js';

const ITEM_KEY_RE = /^#?[A-Za-z][A-Za-z0-9]{1,5}-[1-9][0-9]{0,8}$/;
const UUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

export const itemResource: ResourceDefinition = {
  name: 'item',
  toolset: 'items',
  scopes: scopesOf('get_item'),
  title: 'buildIt.Social item',
  description:
    'One item by key, such as buildit://items/DEMO-12: its fields, description, children, links and latest comments, as get_item gives them. People-written parts are marked as untrusted content.',
  uriTemplate: 'buildit://items/{key}',
  mimeType: 'text/markdown',
  async read(vars, ctx) {
    const key = decodeURIComponent(vars.key ?? '');
    if (!ITEM_KEY_RE.test(key) && !UUID_RE.test(key)) {
      throw new ToolInputError('An item key such as DEMO-12.');
    }
    return (await getItemTool.run({ item: key }, ctx)).text;
  },
};

export const pageResource: ResourceDefinition = {
  name: 'page',
  toolset: 'pages',
  scopes: scopesOf('get_page'),
  title: 'buildIt.Social page',
  description:
    'One channel page by id, such as buildit://pages/<uuid>: its Markdown and version, as get_page gives them (long pages: the first part, and how to read on). The body is marked as untrusted content.',
  uriTemplate: 'buildit://pages/{id}',
  mimeType: 'text/markdown',
  async read(vars, ctx) {
    const id = decodeURIComponent(vars.id ?? '');
    if (!UUID_RE.test(id)) throw new ToolInputError('A page id (a uuid).');
    return (await readPage(ctx, id)).text;
  },
};

export const RESOURCES: readonly ResourceDefinition[] = [itemResource, pageResource];
