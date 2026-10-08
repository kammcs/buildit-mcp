import { describe, expect, it } from 'vitest';

import { applyPlanTool } from '../src/tools/plans.js';
import { scopesOf } from '../src/tools/shared.js';
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
    // propose_delete_item needs projects:read and projects:delete; chat:read implies neither.
    expect(names(selectTools(TEST_CATALOG, policy(), ['projects:read']))).not.toContain(
      'propose_delete_item',
    );
    expect(names(selectTools(TEST_CATALOG, policy(), ['chat:read']))).not.toContain(
      'propose_delete_item',
    );
    // projects:delete implies projects:write, which implies projects:read (the contract).
    expect(names(selectTools(TEST_CATALOG, policy(), ['projects:delete']))).toContain(
      'propose_delete_item',
    );
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

  it('lists a withPlans tool whenever a propose_* tool is listed, and only then', () => {
    const applyPlan = { ...applyPlanTool };
    const catalog = [...TEST_CATALOG, applyPlan];
    expect(names(selectTools(catalog, policy(), ALL_SCOPES))).toContain('apply_plan');
    // Its own toolset doesn't matter: chat and destructive here, but only the proposal counts.
    expect(names(selectTools(catalog, policy({ toolsets: ['chat'] }), ALL_SCOPES))).toEqual([
      'read_channel',
    ]);
    expect(names(selectTools(catalog, policy(), ['projects:write']))).not.toContain('apply_plan');
    expect(
      names(selectTools(catalog, policy({ excludeTools: ['propose_delete_item'] }), ALL_SCOPES)),
    ).not.toContain('apply_plan');
    expect(names(selectTools(catalog, policy({ readOnly: true }), ALL_SCOPES))).not.toContain(
      'apply_plan',
    );
    expect(
      names(selectTools(catalog, policy({ excludeTools: ['apply_plan'] }), ALL_SCOPES)),
    ).not.toContain('apply_plan');
  });

  it('hides a tool that needs a token without limits from a limited token, when known', () => {
    const creator = { ...TEST_CATALOG[4]!, name: 'create_channel', unlimitedOnly: true };
    const catalog = [...TEST_CATALOG, creator];
    expect(names(selectTools(catalog, policy(), ALL_SCOPES))).toContain('create_channel');
    expect(names(selectTools(catalog, policy(), ALL_SCOPES, false))).toContain('create_channel');
    const limited = names(selectTools(catalog, policy(), ALL_SCOPES, true));
    expect(limited).not.toContain('create_channel');
    // Other tools stay listed for a limited token.
    expect(limited).toContain('create_item');
    // Without the identity (scopes null), limits are unknown: the API decides.
    expect(names(selectTools(catalog, policy(), null, true))).toContain('create_channel');
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
    expect(() => {
      assertValidCatalog([{ ...applyPlanTool, scopes: ['projects:delete'] }]);
    }).toThrow(/takes the plan's scope/);
  });

  it('declares scopes from the contract, plan actions included', () => {
    const scopes = Object.fromEntries(CATALOG.map((t) => [t.name, t.scopes]));
    expect(scopes.propose_delete_item).toEqual(['projects:delete']);
    expect(scopes.propose_label_change).toEqual(['projects:admin']);
    expect(scopes.get_workflow).toEqual(['projects:admin']);
    expect(scopes.read_channel).toEqual(['chat:read']);
    expect(scopes.update_page).toEqual(['pages:write']);
    expect(scopes.plan_sprint).toEqual(['projects:write']);
    expect(scopes.write_release_notes).toEqual(['projects:write', 'pages:write']);
    expect(scopes.propose_archive_status).toEqual(['projects:delete', 'projects:admin']);
    expect(scopes.find_users).toEqual(['projects:read']);
    expect(scopes.apply_plan).toEqual([]);
    expect(() => scopesOf('create_plan')).toThrow(/planScopesOf/);
  });

  it('has a read-only whoami in the items toolset that needs no scope', () => {
    const whoami = CATALOG.find((t) => t.name === 'whoami');
    expect(whoami).toMatchObject({ toolset: 'items', scopes: [] });
    expect(whoami?.annotations.readOnlyHint).toBe(true);
  });
});

describe('expandScopes', () => {
  it('adds implied scopes transitively, as the contract defines them', () => {
    expect([...expandScopes(['projects:write', 'pages:write'])].sort()).toEqual([
      'pages:read',
      'pages:write',
      'projects:read',
      'projects:write',
    ]);
    expect([...expandScopes(['projects:admin'])].sort()).toEqual([
      'projects:admin',
      'projects:read',
      'projects:write',
    ]);
    expect([...expandScopes(['chat:read', 'unknown:scope'])].sort()).toEqual([
      'chat:read',
      'unknown:scope',
    ]);
  });
});
