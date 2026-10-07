import { describe, expect, it } from 'vitest';

import { CATALOG } from '../src/toolsets/catalog.js';
import {
  assertValidCatalog,
  selectTools,
  unknownToolNames,
  type ToolPolicy,
} from '../src/toolsets/registry.js';
import { DEFAULT_TOOLSETS, expandScopes, TOOLSET_NAMES } from '../src/toolsets/toolsets.js';
import { TEST_CATALOG } from './support/test-tools.js';

const ALL_SCOPES = [
  'projects:write',
  'projects:delete',
  'projects:admin',
  'pages:write',
  'chat:read',
];

const policy = (over: Partial<ToolPolicy> = {}): ToolPolicy => ({
  toolsets: [...TOOLSET_NAMES],
  readOnly: false,
  excludeTools: [],
  ...over,
});

const names = (tools: { name: string }[]): string[] => tools.map((t) => t.name);

describe('selectTools', () => {
  it('lists in toolset order, then by name, whatever the catalog order', () => {
    expect(names(selectTools(TEST_CATALOG, policy(), ALL_SCOPES))).toEqual([
      'create_item',
      'search_items',
      'whoami',
      'add_comment',
      'list_comments',
      'read_channel',
      'propose_delete_item',
    ]);
    const reversed = [...TEST_CATALOG].reverse();
    expect(names(selectTools(reversed, policy(), ALL_SCOPES))).toEqual(
      names(selectTools(TEST_CATALOG, policy(), ALL_SCOPES)),
    );
  });

  it('keeps only the enabled toolsets', () => {
    expect(
      names(selectTools(TEST_CATALOG, policy({ toolsets: DEFAULT_TOOLSETS }), ALL_SCOPES)),
    ).toEqual(['create_item', 'search_items', 'whoami', 'add_comment', 'list_comments']);
    expect(names(selectTools(TEST_CATALOG, policy({ toolsets: ['chat'] }), ALL_SCOPES))).toEqual([
      'read_channel',
    ]);
  });

  it('gates by the token scopes, with write implying read', () => {
    expect(names(selectTools(TEST_CATALOG, policy(), ['projects:read']))).toEqual([
      'search_items',
      'whoami',
      'list_comments',
    ]);
    expect(names(selectTools(TEST_CATALOG, policy(), ['projects:write']))).toEqual([
      'create_item',
      'search_items',
      'whoami',
      'add_comment',
      'list_comments',
    ]);
    expect(names(selectTools(TEST_CATALOG, policy(), ['chat:read']))).toEqual([
      'whoami',
      'read_channel',
    ]);
  });

  it('needs every scope a tool declares', () => {
    // propose_delete_item needs projects:read and projects:delete.
    expect(names(selectTools(TEST_CATALOG, policy(), ['projects:delete']))).toEqual(['whoami']);
    expect(
      names(selectTools(TEST_CATALOG, policy(), ['projects:delete', 'projects:read'])),
    ).toContain('propose_delete_item');
  });

  it('lists only scope-free tools when the scopes are unknown', () => {
    expect(names(selectTools(TEST_CATALOG, policy(), []))).toEqual(['whoami']);
  });

  it('skips the scope rule when given null (serving a call)', () => {
    expect(selectTools(TEST_CATALOG, policy(), null)).toHaveLength(TEST_CATALOG.length);
  });

  it('drops write tools in read-only mode', () => {
    expect(names(selectTools(TEST_CATALOG, policy({ readOnly: true }), ALL_SCOPES))).toEqual([
      'search_items',
      'whoami',
      'list_comments',
      'read_channel',
    ]);
  });

  it('drops excluded tools by name', () => {
    expect(
      names(
        selectTools(
          TEST_CATALOG,
          policy({ excludeTools: ['whoami', 'create_item', 'no_such_tool'] }),
          ALL_SCOPES,
        ),
      ),
    ).toEqual([
      'search_items',
      'add_comment',
      'list_comments',
      'read_channel',
      'propose_delete_item',
    ]);
  });

  it('reports unknown names in the exclude list', () => {
    expect(unknownToolNames(CATALOG, ['whoami', 'not_a_tool'])).toEqual(['not_a_tool']);
  });
});

describe('the catalog', () => {
  it('follows the rules every tool must follow', () => {
    expect(() => {
      assertValidCatalog(CATALOG);
    }).not.toThrow();
    expect(() => {
      assertValidCatalog(TEST_CATALOG);
    }).not.toThrow();
  });

  it('rejects duplicates and undeclared scopes', () => {
    const whoami = CATALOG[0]!;
    expect(() => {
      assertValidCatalog([whoami, whoami]);
    }).toThrow(/Duplicate/);
    expect(() => {
      assertValidCatalog([{ ...whoami, scopes: ['chat:read'] }]);
    }).toThrow(/not declared by toolset/);
  });

  it('has a read-only whoami in the items toolset that needs no scope', () => {
    const whoami = CATALOG.find((t) => t.name === 'whoami');
    expect(whoami).toMatchObject({ toolset: 'items', scopes: [] });
    expect(whoami?.annotations.readOnlyHint).toBe(true);
  });
});

describe('expandScopes', () => {
  it('adds implied read scopes', () => {
    expect([...expandScopes(['projects:write', 'pages:write'])].sort()).toEqual([
      'pages:read',
      'pages:write',
      'projects:read',
      'projects:write',
    ]);
    expect([...expandScopes(['projects:admin'])]).toEqual(['projects:admin']);
  });
});
