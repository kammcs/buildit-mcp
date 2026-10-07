/**
 * The contract (openapi/openapi.json) and the code generated from it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { generate, type OpenApiDocument } from '../scripts/codegen.js';
import {
  ERROR_HINTS,
  OPERATIONS,
  PLAN_SCOPES,
  SCOPES,
  type OperationId,
} from '../src/api/generated/operations.js';
import * as tolerant from '../src/api/generated/schemas.js';
import { REQUEST_SCHEMAS, RESPONSE_SCHEMAS } from '../src/api/generated/strict.js';
import { operationPath } from '../src/api/operations.js';
import { CATALOG } from '../src/toolsets/catalog.js';

const root = new URL('..', import.meta.url);
const doc = JSON.parse(
  readFileSync(new URL('openapi/openapi.json', root), 'utf8'),
) as OpenApiDocument & {
  paths: Record<
    string,
    Record<
      string,
      {
        requestBody?: { content?: Record<string, { example?: unknown }> };
        responses: Record<string, { content?: Record<string, { example?: unknown }> }>;
      }
    >
  >;
};

describe('the generated code', () => {
  it('is up to date with openapi/openapi.json (run `npm run generate`)', async () => {
    const files = await generate(doc, fileURLToPath(new URL('.prettierrc.json', root)));
    expect(files.size).toBe(3);
    for (const [path, content] of files) {
      const current = readFileSync(new URL(path, root), 'utf8').replace(/\r\n/g, '\n');
      expect(current, `${path} is out of date`).toBe(content);
    }
  });

  it('carries every operation, with its scope', () => {
    const ids = Object.keys(OPERATIONS);
    expect(ids).toContain('search_items');
    expect(ids).toContain('add_comment');
    expect(OPERATIONS.search_items).toMatchObject({
      method: 'GET',
      path: '/v1/items',
      scope: 'projects:read',
    });
    expect(OPERATIONS.remove_link.hints.destructive).toBe(true);
    // Discovery takes no rate-limit unit and carries no RateLimit-* headers.
    expect(
      Object.entries(OPERATIONS)
        .filter(([, op]) => op.discovery)
        .map(([id]) => id)
        .sort(),
    ).toEqual(['get_me', 'get_meta']);
    expect(operationPath('remove_link', { key: 'DEMO-1', id: 'a/b' })).toBe(
      '/v1/items/DEMO-1/links/a%2Fb',
    );
  });
});

describe("the contract's examples", () => {
  const cases: [OperationId, string, unknown, unknown][] = [];
  for (const id of Object.keys(OPERATIONS) as OperationId[]) {
    const op = OPERATIONS[id];
    const raw = doc.paths[op.path]?.[op.method.toLowerCase()];
    const request = raw?.requestBody?.content?.['application/json']?.example;
    let response: unknown;
    for (const status of op.statuses) {
      response ??= raw?.responses[String(status)]?.content?.['application/json']?.example;
    }
    cases.push([id, op.path, request, response]);
  }

  it.each(cases)('%s (%s) parses with the exact and tolerant schemas', (id, _path, req, res) => {
    const requestSchema = REQUEST_SCHEMAS[id];
    if (req !== undefined && requestSchema !== null) {
      expect(requestSchema.safeParse(req).error?.issues).toBeUndefined();
    }
    if (res !== undefined) {
      expect(RESPONSE_SCHEMAS[id].safeParse(res).error?.issues).toBeUndefined();
      expect(OPERATIONS[id].response.safeParse(res).success).toBe(true);
    }
  });
});

describe('tolerant parsing', () => {
  it('keeps unknown fields and accepts unknown enum values (the API only grows)', () => {
    const item = {
      id: 'x',
      key: 'DEMO-1',
      number: 1,
      project: { id: 'p', key: 'DEMO', name: 'Demo', color: 'new field' },
      type: { id: 't', name: 'Story', level: 'feature' },
      status: { id: 's', name: 'To do', category: 'blocked' },
      title: 'A title',
      priority: 'critical',
      assignee: null,
      reporter: null,
      parent: null,
      initiative: null,
      labels: [],
      estimate: null,
      start_date: null,
      due_date: null,
      sprint: null,
      fix_release: null,
      rank: 'a',
      version: 1,
      description_version: 1,
      created_at: 'now',
      updated_at: 'now',
      started_at: null,
      completed_at: null,
      canceled_at: null,
      brand_new: { nested: true },
    };
    const parsed = tolerant.ItemSummarySchema.parse(item);
    expect(parsed).toMatchObject({ priority: 'critical', brand_new: { nested: true } });
    expect(parsed.status.category).toBe('blocked');
  });

  it('still refuses a response that lacks a required field', () => {
    expect(tolerant.CommentSchema.safeParse({ id: 'x' }).success).toBe(false);
  });
});

describe('tool scopes', () => {
  it('come from the contract', () => {
    for (const tool of CATALOG) {
      for (const scope of tool.scopes) expect(SCOPES).toContain(scope);
    }
    const scopes = Object.fromEntries(CATALOG.map((t) => [t.name, t.scopes]));
    expect(scopes.search_items).toEqual(['projects:read']);
    expect(scopes.create_item).toEqual(['projects:write']);
    expect(scopes.add_comment).toEqual(['projects:write']);
    expect(scopes.find_users).toEqual(['projects:read']);
    expect(scopes.whoami).toEqual([]);
  });

  it('come with the plan scopes, error hints and the members route', () => {
    expect(PLAN_SCOPES).toMatchObject({
      delete_item: ['projects:delete'],
      bulk_update: ['projects:delete'],
      archive_status: ['projects:delete', 'projects:admin'],
      workflow_change: ['projects:admin'],
      label_change: ['projects:admin'],
    });
    expect(OPERATIONS.generate_release_notes.requiredScopes).toEqual([
      'projects:write',
      'pages:write',
    ]);
    // Without x-buildit-required-scopes, the single scope is the requirement.
    expect(OPERATIONS.search_items.requiredScopes).toEqual(['projects:read']);
    expect(OPERATIONS.get_me.requiredScopes).toEqual([]);
    expect(ERROR_HINTS.plan_stale).toMatch(/preview/);
    expect(OPERATIONS.list_project_members).toMatchObject({
      method: 'GET',
      path: '/v1/projects/{key}/members',
      scope: 'projects:read',
    });
  });
});
