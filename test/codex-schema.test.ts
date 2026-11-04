/**
 * The Codex protocol subset the bridge is built on: it covers every
 * method and field the bridge relies on, the check finds what an update
 * would break, the fake's validators catch bad messages, and the version
 * gate reads the app-server's user agent.
 */
import { describe, expect, it } from 'vitest';

import { DELTA_NOTIFICATIONS } from '../src/codex/protocol.js';
import { BRIDGE_SURFACE } from '../src/codex/surface.js';
import {
  checkCodexVersion,
  MIN_CODEX_VERSION,
  TESTED_CODEX_LINES,
  versionFromUserAgent,
} from '../src/codex/version.js';
import { compareVersions } from '../src/version.js';
import {
  diffSubsets,
  extractSubset,
  surfaceProblems,
  type JsonObject,
  type VendoredProtocol,
} from '../scripts/codex-protocol.js';
import { PROTOCOL, schemaErrors, unknownFields } from './support/fake-codex.js';

const clone = (): VendoredProtocol => structuredClone(PROTOCOL);

/** A full-looking document from the subset: its unions rebuilt from x-methods. */
function asGenerated(subset: VendoredProtocol): { definitions: JsonObject } {
  const union = (methods: Record<string, { params?: string }>): JsonObject => ({
    oneOf: Object.entries(methods).map(([m, r]) => ({
      properties: {
        method: { enum: [m], type: 'string' },
        ...(r.params === undefined ? {} : { params: { $ref: r.params } }),
      },
      type: 'object',
    })),
  });
  const m = subset['x-methods'];
  return {
    definitions: {
      ...structuredClone(subset.definitions),
      ClientRequest: union(m.clientRequests),
      ClientNotification: union(m.clientNotifications),
      ServerNotification: union(m.serverNotifications),
      ServerRequest: union(m.serverRequests),
    },
  };
}

describe('the vendored protocol subset', () => {
  it('is from a tested Codex line, at or above the minimum', () => {
    const v = PROTOCOL['x-codex'].version;
    expect(compareVersions(v, MIN_CODEX_VERSION)).toBeGreaterThanOrEqual(0);
    expect(TESTED_CODEX_LINES).toContain(v.split('.').slice(0, 2).join('.'));
    expect(PROTOCOL['x-codex'].license).toContain('Apache License, Version 2.0');
  });

  it('has every method, field, variant and value the bridge relies on', () => {
    expect(surfaceProblems(PROTOCOL, PROTOCOL['x-methods'], BRIDGE_SURFACE)).toEqual([]);
    for (const m of DELTA_NOTIFICATIONS) {
      expect(PROTOCOL['x-methods'].serverNotifications[m]).toBeDefined();
    }
  });

  it('is what extracting it from a generated document gives (no more, no less)', () => {
    const { subset, missing } = extractSubset(
      asGenerated(PROTOCOL),
      BRIDGE_SURFACE,
      PROTOCOL['x-codex'].version,
    );
    expect(missing).toEqual([]);
    expect(subset['x-methods']).toEqual(PROTOCOL['x-methods']);
    expect(subset.definitions).toEqual(PROTOCOL.definitions);
    expect(diffSubsets(PROTOCOL, subset)).toEqual({ breaking: [], changes: [] });
  });

  it('keeps no documentation strings', () => {
    const text = JSON.stringify(PROTOCOL.definitions);
    expect(text).not.toMatch(/"description":"/);
  });
});

describe('the compatibility check', () => {
  it('finds a method the bridge uses gone, and a request gaining a required field', () => {
    const next = clone();
    delete next['x-methods'].clientRequests['turn/steer'];
    const params = (next.definitions.v2 as JsonObject).TurnStartParams as JsonObject;
    params.required = [...(params.required as string[]), 'model'];
    const { breaking } = diffSubsets(PROTOCOL, next);
    expect(breaking).toContain('turn/steer: gone');
    expect(
      breaking.some((b) => b.startsWith('v2/TurnStartParams') && b.includes('now required: model')),
    ).toBe(true);
  });

  it('lists added fields and values for review, without failing', () => {
    const next = clone();
    const v2 = next.definitions.v2 as JsonObject;
    const turn = v2.Turn as JsonObject;
    (turn.properties as JsonObject).brandNew = { type: 'string' };
    const status = v2.TurnStatus as JsonObject;
    status.enum = [...(status.enum as string[]), 'paused'];
    const { breaking, changes } = diffSubsets(PROTOCOL, next);
    expect(breaking).toEqual([]);
    expect(changes).toContain('v2/Turn: fields added: brandNew');
    expect(changes).toContain('v2/TurnStatus: values added: paused');
  });

  it('finds a field or a value the bridge reads gone', () => {
    const next = clone();
    const v2 = next.definitions.v2 as JsonObject;
    delete ((v2.TurnSteerResponse as JsonObject).properties as JsonObject).turnId;
    const flag = v2.ThreadActiveFlag as JsonObject;
    flag.enum = ['waitingOnApproval'];
    const problems = surfaceProblems(next, next['x-methods'], BRIDGE_SURFACE);
    expect(problems).toContain('turn/steer: result has no field turnId');
    expect(problems).toContain('v2/ThreadActiveFlag: no value waitingOnUserInput');
  });
});

describe("the fake app-server's checks", () => {
  const turnStart = PROTOCOL['x-methods'].clientRequests['turn/start']!.params!;

  it('accepts what the bridge sends, and rejects malformed params', () => {
    const good = { threadId: 't', input: [{ type: 'text', text: 'hi', text_elements: [] }] };
    expect(schemaErrors(turnStart, good)).toEqual([]);
    expect(unknownFields(turnStart, good)).toEqual([]);
    expect(schemaErrors(turnStart, { threadId: 't' })).not.toEqual([]);
    expect(schemaErrors(turnStart, { threadId: 't', input: [{ type: 'text' }] })).not.toEqual([]);
  });

  it('flags fields Codex does not know, nested ones too', () => {
    expect(unknownFields(turnStart, { threadId: 't', input: [], bogus: 1 })).toEqual([
      '/bogus is not a field Codex knows',
    ]);
    const init = PROTOCOL['x-methods'].clientRequests.initialize!.params!;
    expect(
      unknownFields(init, {
        clientInfo: { name: 'x', title: null, version: '1', extra: true },
        capabilities: { experimentalApi: true },
      }),
    ).toEqual(['/clientInfo/extra is not a field Codex knows']);
  });

  it("rejects an answer to an approval that isn't a decision Codex knows", () => {
    const ref =
      PROTOCOL['x-methods'].serverRequests['item/commandExecution/requestApproval']!.result!;
    expect(schemaErrors(ref, { decision: 'decline' })).toEqual([]);
    expect(schemaErrors(ref, { decision: 'approve' })).not.toEqual([]);
  });
});

describe('the Codex version gate', () => {
  it("reads the version from the app-server's user agent", () => {
    expect(
      versionFromUserAgent(
        'buildit_mcp/0.166.0 (Windows 10.0.26300; x86_64) xterm-256color (buildit_mcp; 0.16.0)',
      ),
    ).toBe('0.166.0');
    expect(versionFromUserAgent('codex/0.170.0-alpha.2 (Mac OS 15)')).toBe('0.170.0-alpha.2');
    expect(versionFromUserAgent('no version here')).toBeUndefined();
  });

  it('refuses older versions, and calls newer lines untested', () => {
    expect(checkCodexVersion('0.165.9').kind).toBe('too_old');
    expect(checkCodexVersion('0.166.0').kind).toBe('tested');
    expect(checkCodexVersion('0.166.4').kind).toBe('tested');
    expect(checkCodexVersion('0.167.0').kind).toBe('untested');
    expect(checkCodexVersion('1.0.0').kind).toBe('untested');
    expect(checkCodexVersion(undefined).kind).toBe('unknown');
  });
});
