/**
 * Working with the JSON Schema that `codex app-server generate-json-schema
 * --experimental` writes (`codex_app_server_protocol.schemas.json`): the
 * methods of its unions, the subset the bridge uses (vendored in
 * test/fixtures/codex/ for the fake app-server's checks), the check that
 * every method and field the bridge relies on is there, and the diff of
 * two subsets. Used by scripts/codex-schema.ts and the tests.
 */
import type { BridgeSurface } from '../src/codex/surface.js';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** One method: the definitions of its params and of its result (as `#/definitions/...` refs). */
export interface MethodRefs {
  params?: string;
  result?: string;
}

export interface MethodManifest {
  clientRequests: Record<string, MethodRefs>;
  clientNotifications: Record<string, MethodRefs>;
  serverNotifications: Record<string, MethodRefs>;
  serverRequests: Record<string, MethodRefs>;
}

/** The vendored subset: a JSON Schema document with the bridge's methods named in `x-methods`. */
export interface VendoredProtocol {
  $schema: string;
  'x-codex': { version: string; experimental: boolean; source: string; license: string };
  'x-methods': MethodManifest;
  definitions: JsonObject;
}

export const VENDORED_LICENSE =
  'Generated from OpenAI Codex (https://github.com/openai/codex), Copyright OpenAI, licensed under the Apache License, Version 2.0; reduced to the definitions the buildit-mcp Codex bridge uses, descriptions removed. See LICENSE-codex next to this file.';

const UNIONS = {
  clientRequests: 'ClientRequest',
  clientNotifications: 'ClientNotification',
  serverNotifications: 'ServerNotification',
  serverRequests: 'ServerRequest',
} as const;

function isObject(v: Json | undefined): v is JsonObject {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** `<name>` or `v2/<name>` as a ref. */
export function refOf(name: string): string {
  return name.startsWith('#/') ? name : `#/definitions/${name}`;
}

/** The node a `#/definitions/...` ref points at in a document. */
export function deref(doc: { definitions: JsonObject }, ref: string): JsonObject | undefined {
  if (!ref.startsWith('#/definitions/')) return undefined;
  let node: Json | undefined = doc.definitions;
  for (const part of ref.slice('#/definitions/'.length).split('/')) {
    if (!isObject(node)) return undefined;
    node = node[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return isObject(node) ? node : undefined;
}

/** The methods of a union definition (ClientRequest, ServerNotification...), with their params refs. */
export function unionMethods(
  doc: { definitions: JsonObject },
  union: string,
): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  const node = deref(doc, refOf(union));
  const branches = node?.oneOf;
  if (!Array.isArray(branches)) return out;
  for (const b of branches) {
    if (!isObject(b) || !isObject(b.properties)) continue;
    const method = b.properties.method;
    const values = isObject(method) ? method.enum : undefined;
    if (!Array.isArray(values) || typeof values[0] !== 'string') continue;
    const params = b.properties.params;
    out.set(
      values[0],
      isObject(params) && typeof params.$ref === 'string' ? params.$ref : undefined,
    );
  }
  return out;
}

/** The manifest of the surface's methods in a full generated document; missing methods listed. */
export function manifestOf(
  doc: { definitions: JsonObject },
  surface: BridgeSurface,
): { manifest: MethodManifest; missing: string[] } {
  const missing: string[] = [];
  const manifest: MethodManifest = {
    clientRequests: {},
    clientNotifications: {},
    serverNotifications: {},
    serverRequests: {},
  };
  const pick = (
    kind: keyof MethodManifest,
    names: readonly string[],
    result?: (m: string) => string | undefined,
  ): void => {
    const methods = unionMethods(doc, UNIONS[kind]);
    for (const m of names) {
      if (!methods.has(m)) {
        missing.push(`${UNIONS[kind]} ${m}`);
        continue;
      }
      const params = methods.get(m);
      const r = result?.(m);
      if (r !== undefined && deref(doc, refOf(r)) === undefined) missing.push(`definition ${r}`);
      manifest[kind][m] = {
        ...(params === undefined ? {} : { params }),
        ...(r === undefined ? {} : { result: refOf(r) }),
      };
    }
  };
  pick(
    'clientRequests',
    Object.keys(surface.clientRequests),
    (m) => surface.clientRequests[m]?.result,
  );
  pick('clientNotifications', surface.clientNotifications);
  pick('serverNotifications', [...Object.keys(surface.serverNotifications), ...surface.optedOut]);
  pick(
    'serverRequests',
    Object.keys(surface.serverRequests),
    (m) => surface.serverRequests[m]?.result,
  );
  return { manifest, missing };
}

/** Every ref reachable from the roots (the roots included). */
export function closure(doc: { definitions: JsonObject }, roots: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const ref = stack.pop()!;
    if (seen.has(ref)) continue;
    const node = deref(doc, ref);
    if (node === undefined) continue;
    seen.add(ref);
    const walk = (v: Json): void => {
      if (Array.isArray(v)) {
        for (const x of v) walk(x);
      } else if (isObject(v)) {
        for (const [k, x] of Object.entries(v)) {
          if (k === '$ref' && typeof x === 'string') stack.push(x);
          else walk(x);
        }
      }
    };
    walk(node);
  }
  return seen;
}

/** A copy without documentation strings (`description` keywords), keys sorted. */
function stripped(v: Json): Json {
  if (Array.isArray(v)) return v.map(stripped);
  if (!isObject(v)) return v;
  const out: JsonObject = {};
  for (const k of Object.keys(v).sort()) {
    const x = v[k]!;
    // A property named "description" is an object; the keyword is a string.
    if (k === 'description' && typeof x === 'string') continue;
    out[k] = stripped(x);
  }
  return out;
}

function roots(manifest: MethodManifest, surface: BridgeSurface): string[] {
  const out: string[] = [];
  for (const kind of Object.keys(manifest) as (keyof MethodManifest)[]) {
    for (const refs of Object.values(manifest[kind])) {
      if (refs.params !== undefined) out.push(refs.params);
      if (refs.result !== undefined) out.push(refs.result);
    }
  }
  for (const t of surface.types) out.push(refOf(t.ref));
  // Request ids, for the envelope checks.
  out.push('#/definitions/RequestId', '#/definitions/v2/RequestId');
  return out;
}

/** The vendored subset of a full generated document. */
export function extractSubset(
  doc: { definitions: JsonObject },
  surface: BridgeSurface,
  codexVersion: string,
): { subset: VendoredProtocol; missing: string[] } {
  const { manifest, missing } = manifestOf(doc, surface);
  const definitions: JsonObject = {};
  for (const ref of [...closure(doc, roots(manifest, surface))].sort()) {
    const node = deref(doc, ref)!;
    const parts = ref.slice('#/definitions/'.length).split('/');
    let into = definitions;
    for (const p of parts.slice(0, -1)) {
      const next = into[p];
      if (isObject(next)) {
        into = next;
      } else {
        const created: JsonObject = {};
        into[p] = created;
        into = created;
      }
    }
    into[parts.at(-1)!] = stripped(node);
  }
  return {
    subset: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      'x-codex': {
        version: codexVersion,
        experimental: true,
        source: 'codex app-server generate-json-schema --experimental',
        license: VENDORED_LICENSE,
      },
      'x-methods': manifest,
      definitions,
    },
    missing,
  };
}

/** The node of a property along a dotted path, looking through $ref, allOf, anyOf and oneOf. */
export function propertyAt(
  doc: { definitions: JsonObject },
  node: JsonObject | undefined,
  path: readonly string[],
): JsonObject | undefined {
  let current = node;
  for (const name of path) {
    if (current === undefined) return undefined;
    current = findProperty(doc, current, name, new Set());
  }
  return current;
}

function findProperty(
  doc: { definitions: JsonObject },
  node: JsonObject,
  name: string,
  seen: Set<JsonObject>,
): JsonObject | undefined {
  if (seen.has(node)) return undefined;
  seen.add(node);
  if (typeof node.$ref === 'string') {
    const target = deref(doc, node.$ref);
    return target === undefined ? undefined : findProperty(doc, target, name, seen);
  }
  const props = node.properties;
  if (isObject(props) && isObject(props[name])) return props[name];
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    const list = node[key];
    if (!Array.isArray(list)) continue;
    for (const sub of list) {
      if (!isObject(sub)) continue;
      const found = findProperty(doc, sub, name, seen);
      if (found !== undefined) return found;
    }
  }
  if (isObject(node.items)) return findProperty(doc, node.items, name, seen);
  return undefined;
}

/** The oneOf branch whose `type` property is the variant. */
function variantOf(
  doc: { definitions: JsonObject },
  node: JsonObject,
  variant: string,
): JsonObject | undefined {
  const target = typeof node.$ref === 'string' ? deref(doc, node.$ref) : node;
  for (const key of ['oneOf', 'anyOf']) {
    const list = target?.[key];
    if (!Array.isArray(list)) continue;
    for (const b of list) {
      if (!isObject(b)) continue;
      const type = isObject(b.properties) ? b.properties.type : undefined;
      const values = isObject(type) ? type.enum : undefined;
      if (Array.isArray(values) && values.includes(variant)) return b;
    }
  }
  return undefined;
}

/** Every enum value a node allows (through $ref, anyOf and oneOf). */
function enumValues(
  doc: { definitions: JsonObject },
  node: JsonObject,
  seen = new Set<JsonObject>(),
): Json[] {
  if (seen.has(node)) return [];
  seen.add(node);
  if (typeof node.$ref === 'string') {
    const t = deref(doc, node.$ref);
    return t === undefined ? [] : enumValues(doc, t, seen);
  }
  const out: Json[] = Array.isArray(node.enum) ? [...node.enum] : [];
  for (const key of ['anyOf', 'oneOf']) {
    const list = node[key];
    if (Array.isArray(list))
      for (const s of list) if (isObject(s)) out.push(...enumValues(doc, s, seen));
  }
  return out;
}

/**
 * What the bridge relies on and the document lacks: methods, fields of
 * params and results, type variants and enum values. Empty: compatible.
 */
export function surfaceProblems(
  doc: { definitions: JsonObject },
  manifest: MethodManifest,
  surface: BridgeSurface,
): string[] {
  const problems: string[] = [];
  const check = (
    kind: keyof MethodManifest,
    method: string,
    use: { sends?: readonly string[]; reads?: readonly string[] },
    sendsIn: 'params' | 'result',
  ): void => {
    const refs = manifest[kind][method];
    if (refs === undefined) {
      problems.push(`${method}: not in ${UNIONS[kind]}`);
      return;
    }
    const readsIn = sendsIn === 'params' ? 'result' : 'params';
    for (const [fields, where] of [
      [use.sends ?? [], sendsIn],
      [use.reads ?? [], readsIn],
    ] as const) {
      if (fields.length === 0) continue;
      const ref = refs[where];
      const node = ref === undefined ? undefined : deref(doc, ref);
      if (node === undefined) {
        problems.push(`${method}: no ${where} definition`);
        continue;
      }
      for (const f of fields) {
        if (propertyAt(doc, node, f.split('.')) === undefined) {
          problems.push(`${method}: ${where} has no field ${f}`);
        }
      }
    }
  };
  for (const [m, use] of Object.entries(surface.clientRequests))
    check('clientRequests', m, use, 'params');
  for (const m of surface.clientNotifications) {
    if (manifest.clientNotifications[m] === undefined)
      problems.push(`${m}: not in ClientNotification`);
  }
  for (const [m, use] of Object.entries(surface.serverNotifications)) {
    check('serverNotifications', m, use, 'result');
  }
  for (const m of surface.optedOut) {
    if (manifest.serverNotifications[m] === undefined)
      problems.push(`${m}: not in ServerNotification`);
  }
  for (const [m, use] of Object.entries(surface.serverRequests))
    check('serverRequests', m, use, 'result');
  for (const t of surface.types) {
    let node = deref(doc, refOf(t.ref));
    if (node === undefined) {
      problems.push(`${t.ref}: no such definition`);
      continue;
    }
    if (t.variant !== undefined) {
      node = variantOf(doc, node, t.variant);
      if (node === undefined) {
        problems.push(`${t.ref}: no variant ${t.variant}`);
        continue;
      }
    }
    for (const f of t.fields ?? []) {
      if (propertyAt(doc, node, f.split('.')) === undefined) {
        problems.push(`${t.ref}${t.variant === undefined ? '' : `#${t.variant}`}: no field ${f}`);
      }
    }
    if (t.values !== undefined) {
      const values = enumValues(doc, node);
      for (const v of t.values) if (!values.includes(v)) problems.push(`${t.ref}: no value ${v}`);
    }
  }
  return problems;
}

/** The definitions of a subset, flattened by ref. */
function flatDefinitions(subset: VendoredProtocol): Map<string, JsonObject> {
  const out = new Map<string, JsonObject>();
  const walk = (prefix: string, defs: JsonObject): void => {
    for (const [k, v] of Object.entries(defs)) {
      if (!isObject(v)) continue;
      // A namespace (v2) holds definitions only; a definition has schema keywords.
      const isNamespace = k === 'v2' || k === 'v1';
      if (isNamespace) walk(`${prefix}${k}/`, v);
      else out.set(`#/definitions/${prefix}${k}`, v);
    }
  };
  walk('', subset.definitions);
  return out;
}

function keysOf(v: Json | undefined): string[] {
  return isObject(v) ? Object.keys(v) : [];
}

function requiredOf(v: JsonObject): string[] {
  return Array.isArray(v.required)
    ? v.required.filter((x): x is string => typeof x === 'string')
    : [];
}

/**
 * How `next` differs from `prev`: changes to review, and breaking ones
 * (a definition gone, a request's params gaining a required field).
 */
export function diffSubsets(
  prev: VendoredProtocol,
  next: VendoredProtocol,
): { breaking: string[]; changes: string[] } {
  const breaking: string[] = [];
  const changes: string[] = [];
  const a = flatDefinitions(prev);
  const b = flatDefinitions(next);
  const sentParams = new Set(
    [
      ...Object.values(prev['x-methods'].clientRequests).map((r) => r.params),
      ...Object.values(prev['x-methods'].serverRequests).map((r) => r.result),
    ].filter((r): r is string => r !== undefined),
  );
  for (const kind of Object.keys(prev['x-methods']) as (keyof MethodManifest)[]) {
    for (const m of Object.keys(prev['x-methods'][kind])) {
      if (next['x-methods'][kind][m] === undefined) breaking.push(`${m}: gone`);
    }
  }
  for (const [ref, def] of a) {
    const other = b.get(ref);
    const name = ref.slice('#/definitions/'.length);
    if (other === undefined) {
      changes.push(`${name}: no longer used or gone`);
      continue;
    }
    if (JSON.stringify(def) === JSON.stringify(other)) continue;
    const pa = keysOf(def.properties);
    const pb = keysOf(other.properties);
    const added = pb.filter((p) => !pa.includes(p));
    const removed = pa.filter((p) => !pb.includes(p));
    const reqA = requiredOf(def);
    const reqB = requiredOf(other);
    const newlyRequired = reqB.filter((r) => !reqA.includes(r));
    const parts: string[] = [];
    if (added.length > 0) parts.push(`fields added: ${added.join(', ')}`);
    if (removed.length > 0) parts.push(`fields removed: ${removed.join(', ')}`);
    if (newlyRequired.length > 0) parts.push(`now required: ${newlyRequired.join(', ')}`);
    const ea = enumValues(prev, def).map(String);
    const eb = enumValues(next, other).map(String);
    const enumAdded = eb.filter((e) => !ea.includes(e));
    const enumRemoved = ea.filter((e) => !eb.includes(e));
    if (enumAdded.length > 0) parts.push(`values added: ${enumAdded.join(', ')}`);
    if (enumRemoved.length > 0) parts.push(`values removed: ${enumRemoved.join(', ')}`);
    const line = `${name}: ${parts.length > 0 ? parts.join('; ') : 'changed'}`;
    if (sentParams.has(ref) && newlyRequired.length > 0) breaking.push(line);
    else changes.push(line);
  }
  for (const ref of b.keys()) {
    if (!a.has(ref)) changes.push(`${ref.slice('#/definitions/'.length)}: new in the subset`);
  }
  return { breaking, changes };
}
