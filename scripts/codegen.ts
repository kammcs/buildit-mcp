/**
 * Generates src/api/generated/ from the agent API's OpenAPI document
 * (openapi/openapi.json). Used by `npm run generate` and by the test that
 * checks the committed output is up to date.
 *
 * It is a small, dependency-free converter for the JSON Schema subset the
 * contract uses (type, properties, required, items, enum, const, anyOf,
 * oneOf, $ref, records, and string, number and array bounds). Anything else
 * makes it fail loudly, so a contract change never generates something
 * silently wrong. The output is deterministic: components are emitted in
 * dependency order with ties broken by name, and everything is formatted
 * with the repository's pinned Prettier.
 *
 * Three files come out:
 *   schemas.ts     tolerant Zod schemas for parsing API responses: objects
 *                  keep unknown fields, enums accept unknown values, and no
 *                  string pattern, format or length is checked, because the
 *                  API's v1 only grows;
 *   strict.ts      exact Zod schemas (closed objects and enums, patterns,
 *                  bounds), plus each operation's query and body schema, for
 *                  the test fake: it checks what this server sends and what
 *                  the fake answers against the contract;
 *   operations.ts  every operation's method, path, parameters, scope, hints,
 *                  errors and discovery flag (no RateLimit-* headers), the
 *                  scope implications, and the error codes.
 *
 * Descriptions are not copied: the tools carry their own text for agents.
 */
import { format, resolveConfig } from 'prettier';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Schema = Record<string, Json>;

interface Parameter {
  name: string;
  in: string;
  required?: boolean;
  schema?: Schema;
  $ref?: string;
}

interface Operation {
  operationId: string;
  parameters?: Parameter[];
  requestBody?: { required?: boolean; content?: Record<string, { schema?: Schema }> };
  responses: Record<
    string,
    { content?: Record<string, { schema?: Schema }>; headers?: Record<string, Json> }
  >;
  'x-buildit-scope'?: string | null;
  'x-buildit-hints'?: Record<string, boolean>;
  'x-buildit-errors'?: string[];
  'x-buildit-plan-scopes'?: Record<string, string>;
  'x-buildit-required-scopes'?: string[];
  'x-buildit-plan-required-scopes'?: Record<string, string[]>;
}

export interface OpenApiDocument {
  openapi: string;
  info: { version: string };
  paths: Record<string, Record<string, Operation | Json>>;
  components: {
    schemas: Record<string, Schema>;
    parameters?: Record<string, Parameter>;
    headers?: Record<string, Json>;
  };
  'x-buildit-scopes'?: Record<string, { implies?: string[] }>;
  'x-buildit-errors'?: Record<string, { status: number; hint?: string }>;
}

type Mode = 'tolerant' | 'strict';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** Keywords that carry no validation, or that this generator ignores on purpose. */
const IGNORED = new Set(['description', 'examples', 'example', 'title', 'default', '$comment']);

/** Every keyword the converter understands. */
const KNOWN = new Set([
  ...IGNORED,
  'type',
  'properties',
  'required',
  'items',
  'enum',
  'const',
  'anyOf',
  'oneOf',
  '$ref',
  'additionalProperties',
  'propertyNames',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minItems',
  'maxItems',
]);

function fail(where: string, message: string): never {
  throw new Error(`codegen: ${where}: ${message}`);
}

function isSchema(value: Json | undefined): value is Schema {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function refName(ref: string, where: string): string {
  const prefix = '#/components/schemas/';
  if (!ref.startsWith(prefix)) fail(where, `unsupported $ref ${ref}`);
  return ref.slice(prefix.length);
}

/** A valid identifier for a component's schema constant. */
export function schemaIdent(name: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) fail(name, 'component name is not an identifier');
  return `${name}Schema`;
}

function lit(value: Json): string {
  return JSON.stringify(value);
}

function regexLiteral(pattern: string, where: string): string {
  // Checks the pattern compiles here, so a bad one fails generation, not runtime.
  try {
    new RegExp(pattern, 'u');
  } catch {
    try {
      new RegExp(pattern);
    } catch {
      fail(where, `pattern does not compile: ${pattern}`);
    }
    return `new RegExp(${lit(pattern)})`;
  }
  return `new RegExp(${lit(pattern)}, 'u')`;
}

function numberBounds(s: Schema, mode: Mode): string {
  if (mode === 'tolerant') return '';
  let out = '';
  if (typeof s.minimum === 'number') out += `.min(${s.minimum})`;
  if (typeof s.maximum === 'number') out += `.max(${s.maximum})`;
  if (typeof s.exclusiveMinimum === 'number') out += `.gt(${s.exclusiveMinimum})`;
  if (typeof s.exclusiveMaximum === 'number') out += `.lt(${s.exclusiveMaximum})`;
  return out;
}

function stringSchema(s: Schema, mode: Mode, where: string): string {
  if (mode === 'tolerant') return 'z.string()';
  let out: string;
  if (typeof s.pattern === 'string') {
    out = `z.string().regex(${regexLiteral(s.pattern, where)})`;
  } else if (s.format === 'date-time') {
    out = 'z.iso.datetime({ offset: true })';
  } else if (s.format === 'date') {
    out = 'z.iso.date()';
  } else if (s.format === 'uuid') {
    out = 'z.guid()';
  } else {
    out = 'z.string()';
  }
  if (typeof s.minLength === 'number') out += `.min(${s.minLength})`;
  if (typeof s.maxLength === 'number') out += `.max(${s.maxLength})`;
  return out;
}

/** The Zod source for one JSON Schema. */
export function convert(s: Schema, mode: Mode, where: string): string {
  for (const key of Object.keys(s)) {
    if (!KNOWN.has(key)) fail(where, `unsupported keyword ${key}`);
  }

  if (typeof s.$ref === 'string') return schemaIdent(refName(s.$ref, where));

  const variants = (s.anyOf ?? s.oneOf) as Json[] | undefined;
  if (variants !== undefined) {
    if (!Array.isArray(variants) || !variants.every(isSchema)) fail(where, 'bad anyOf/oneOf');
    const nullable = variants.some((v) => v.type === 'null' && Object.keys(v).length === 1);
    const rest = variants.filter((v) => !(v.type === 'null' && Object.keys(v).length === 1));
    const parts = rest.map((v, i) => convert(v, mode, `${where}|${i}`));
    let out: string;
    if (parts.length === 0) out = 'z.null()';
    else if (parts.length === 1) out = parts[0]!;
    else out = `z.union([${parts.join(', ')}])`;
    return nullable && parts.length > 0 ? `${out}.nullable()` : out;
  }

  if (s.const !== undefined) return `z.literal(${lit(s.const)})`;

  if (Array.isArray(s.enum)) {
    if (!s.enum.every((v) => typeof v === 'string')) fail(where, 'only string enums are supported');
    const values = `[${s.enum.map(lit).join(', ')}]`;
    return mode === 'strict' ? `z.enum(${values})` : `openEnum(${values})`;
  }

  if (Array.isArray(s.type)) {
    const types = s.type.filter((t): t is string => typeof t === 'string');
    const nonNull = types.filter((t) => t !== 'null');
    if (nonNull.length !== 1) fail(where, `unsupported type list ${lit(s.type)}`);
    const inner = convert({ ...s, type: nonNull[0]! }, mode, where);
    return types.includes('null') ? `${inner}.nullable()` : inner;
  }

  switch (s.type) {
    case 'string':
      return stringSchema(s, mode, where);
    case 'integer':
      return mode === 'strict' ? `z.int()${numberBounds(s, mode)}` : 'z.number()';
    case 'number':
      return `z.number()${numberBounds(s, mode)}`;
    case 'boolean':
      return 'z.boolean()';
    case 'null':
      return 'z.null()';
    case 'array': {
      if (!isSchema(s.items)) fail(where, 'array without items');
      let out = `z.array(${convert(s.items, mode, `${where}[]`)})`;
      if (mode === 'strict') {
        if (typeof s.minItems === 'number') out += `.min(${s.minItems})`;
        if (typeof s.maxItems === 'number') out += `.max(${s.maxItems})`;
      }
      return out;
    }
    case 'object':
      return objectSchema(s, mode, where);
    case undefined:
      // {} or a schema with only ignored keywords: any JSON value.
      if (Object.keys(s).every((k) => IGNORED.has(k))) return 'z.unknown()';
      return fail(where, 'schema without a type');
    default:
      return fail(where, `unsupported type ${lit(s.type ?? null)}`);
  }
}

function objectSchema(s: Schema, mode: Mode, where: string): string {
  if (s.additionalProperties !== undefined && s.additionalProperties !== false) {
    if (s.properties !== undefined && Object.keys(s.properties as Schema).length > 0) {
      fail(where, 'objects with both properties and additionalProperties are not supported');
    }
    if (!isSchema(s.additionalProperties)) fail(where, 'additionalProperties must be a schema');
    const key = isSchema(s.propertyNames)
      ? convert({ type: 'string', ...s.propertyNames }, mode, `${where}{key}`)
      : 'z.string()';
    return `z.record(${key}, ${convert(s.additionalProperties, mode, `${where}{}`)})`;
  }
  const props = (s.properties ?? {}) as Record<string, Json>;
  const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
  const fields = Object.keys(props).map((name) => {
    const prop = props[name];
    if (!isSchema(prop)) fail(`${where}.${name}`, 'property is not a schema');
    let out = convert(prop, mode, `${where}.${name}`);
    if (!required.has(name)) out += '.optional()';
    return `${lit(name)}: ${out}`;
  });
  const ctor = mode === 'strict' ? 'z.strictObject' : 'z.looseObject';
  return `${ctor}({${fields.join(', ')}})`;
}

function collectRefs(value: Json | undefined, out: Set<string>, where: string): void {
  if (Array.isArray(value)) {
    for (const v of value) collectRefs(v, out, where);
  } else if (isSchema(value)) {
    if (typeof value.$ref === 'string') out.add(refName(value.$ref, where));
    for (const v of Object.values(value)) collectRefs(v, out, where);
  }
}

/** Component names in dependency order, ties broken by name. */
export function orderComponents(schemas: Record<string, Schema>): string[] {
  const names = Object.keys(schemas).sort();
  const deps = new Map<string, Set<string>>();
  for (const name of names) {
    const refs = new Set<string>();
    collectRefs(schemas[name], refs, name);
    for (const ref of refs) if (!(ref in schemas)) fail(name, `$ref to a missing component ${ref}`);
    refs.delete(name);
    deps.set(name, refs);
  }
  const done = new Set<string>();
  const order: string[] = [];
  while (order.length < names.length) {
    const ready = names.filter(
      (n) => !done.has(n) && [...(deps.get(n) ?? [])].every((d) => done.has(d)),
    );
    if (ready.length === 0) {
      const left = names.filter((n) => !done.has(n));
      fail('components', `circular references among ${left.join(', ')}`);
    }
    for (const n of ready) {
      done.add(n);
      order.push(n);
    }
  }
  return order;
}

interface OperationInfo {
  id: string;
  method: string;
  path: string;
  scope: string | null;
  hints: Record<string, boolean>;
  errors: string[];
  /** Every scope the operation needs (all of them). */
  requiredScopes: string[];
  /** Every scope each plan action needs (all of them). */
  planScopes: Record<string, string[]>;
  pathParams: string[];
  query: { name: string; array: boolean; required: boolean; schema: Schema }[];
  request: string | null;
  requestRequired: boolean;
  response: string;
  statuses: number[];
  /**
   * Discovery (get_meta, get_me): takes no rate-limit unit, so its success
   * responses carry no RateLimit-* headers while the contract's others do.
   */
  discovery: boolean;
}

function resolveParameter(doc: OpenApiDocument, p: Parameter, where: string): Parameter {
  if (p.$ref === undefined) return p;
  const prefix = '#/components/parameters/';
  if (!p.$ref.startsWith(prefix)) fail(where, `unsupported parameter $ref ${p.$ref}`);
  const resolved = doc.components.parameters?.[p.$ref.slice(prefix.length)];
  if (!resolved) fail(where, `missing parameter ${p.$ref}`);
  return resolved;
}

function jsonSchemaOf(
  content: Record<string, { schema?: Schema }> | undefined,
  where: string,
): Schema | undefined {
  if (content === undefined) return undefined;
  const json = content['application/json'];
  if (!json?.schema) fail(where, 'content without an application/json schema');
  return json.schema;
}

export function readOperations(doc: OpenApiDocument): OperationInfo[] {
  const ops: OperationInfo[] = [];
  const rateLimited = Object.keys(doc.components.headers ?? {}).some((h) => /^RateLimit-/i.test(h));
  for (const path of Object.keys(doc.paths).sort()) {
    const item = doc.paths[path]!;
    for (const method of HTTP_METHODS) {
      const raw = item[method];
      if (raw === undefined) continue;
      const op = raw as unknown as Operation;
      const where = `${method.toUpperCase()} ${path}`;
      if (!/^[a-z][a-z0-9_]*$/.test(op.operationId)) fail(where, 'bad operationId');
      const params = (op.parameters ?? []).map((p) => resolveParameter(doc, p, where));
      const pathParams = params.filter((p) => p.in === 'path').map((p) => p.name);
      const query = params
        .filter((p) => p.in === 'query')
        .map((p) => {
          if (!p.schema) fail(where, `query parameter ${p.name} without a schema`);
          return {
            name: p.name,
            array: p.schema.type === 'array',
            required: p.required === true,
            schema: p.schema,
          };
        });
      const body = jsonSchemaOf(op.requestBody?.content, `${where} request`);
      let request: string | null = null;
      if (body !== undefined) {
        if (typeof body.$ref !== 'string') fail(where, 'inline request bodies are not supported');
        request = refName(body.$ref, where);
      }
      const success = Object.keys(op.responses)
        .filter((s) => /^2\d\d$/.test(s))
        .sort();
      let response: string | undefined;
      for (const status of success) {
        const schema = jsonSchemaOf(op.responses[status]?.content, `${where} ${status}`);
        if (schema === undefined) continue;
        if (typeof schema.$ref !== 'string')
          fail(where, 'inline response bodies are not supported');
        const name = refName(schema.$ref, where);
        if (response !== undefined && response !== name) {
          fail(where, 'success responses with different schemas are not supported');
        }
        response = name;
      }
      if (response === undefined) fail(where, 'no JSON success response');
      // A contract that declares no RateLimit-* headers can't tell discovery apart.
      const discovery =
        rateLimited &&
        success.every(
          (status) =>
            !Object.keys(op.responses[status]?.headers ?? {}).some((h) => /^RateLimit-/i.test(h)),
        );
      ops.push({
        id: op.operationId,
        method: method.toUpperCase(),
        path,
        scope: op['x-buildit-scope'] ?? null,
        hints: op['x-buildit-hints'] ?? {},
        errors: op['x-buildit-errors'] ?? [],
        // Without the newer lists, the single scope is the whole requirement.
        requiredScopes:
          op['x-buildit-required-scopes'] ??
          (op['x-buildit-scope'] && op['x-buildit-scope'] !== 'plan_action'
            ? [op['x-buildit-scope']]
            : []),
        planScopes:
          op['x-buildit-plan-required-scopes'] ??
          Object.fromEntries(
            Object.entries(op['x-buildit-plan-scopes'] ?? {}).map(([a, scope]) => [a, [scope]]),
          ),
        pathParams,
        query,
        request,
        requestRequired: op.requestBody?.required === true,
        response,
        statuses: success.map(Number),
        discovery,
      });
    }
  }
  return ops.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The strict schema of one query parameter, as read from a URL (numbers arrive as text). */
function queryParamSchema(p: OperationInfo['query'][number], where: string): string {
  const scalar = (s: Schema): string => {
    if (s.type === 'integer') return `z.coerce.number().int()${numberBounds(s, 'strict')}`;
    if (s.type === 'number') return `z.coerce.number()${numberBounds(s, 'strict')}`;
    return convert(s, 'strict', where);
  };
  let out: string;
  if (p.array) {
    if (!isSchema(p.schema.items)) fail(where, 'array parameter without items');
    out = `z.array(${scalar(p.schema.items)})`;
    if (typeof p.schema.minItems === 'number') out += `.min(${p.schema.minItems})`;
    if (typeof p.schema.maxItems === 'number') out += `.max(${p.schema.maxItems})`;
  } else {
    out = scalar(p.schema);
  }
  return p.required ? out : `${out}.optional()`;
}

function pascal(id: string): string {
  return id
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

function header(doc: OpenApiDocument, what: string): string {
  return `/**
 * ${what}
 *
 * GENERATED by scripts/generate.ts from openapi/openapi.json (agent API
 * ${doc.info.version}). Do not edit: change the contract, then run
 * \`npm run generate\`.
 */
`;
}

function schemasFile(doc: OpenApiDocument, order: string[], mode: Mode): string {
  const lines: string[] = [];
  if (mode === 'tolerant') {
    lines.push(
      header(
        doc,
        "Tolerant schemas for the agent API's responses: unknown fields are kept, unknown enum values pass, and string formats aren't checked, because the API's v1 only grows.",
      ),
    );
    lines.push(`import { z } from 'zod';\n`);
    lines.push(`/** A string enum that also accepts values added to the API later. */
function openEnum<const T extends readonly [string, ...string[]]>(_values: T): z.ZodType<T[number] | (string & {})> {
  return z.string();
}
`);
  } else {
    lines.push(
      header(
        doc,
        'Exact schemas for the agent API: closed objects and enums, patterns and bounds. The test fake uses them to check requests and its own responses against the contract; the server parses responses with the tolerant schemas.ts.',
      ),
    );
    lines.push(`import { z } from 'zod';\n`);
  }
  for (const name of order) {
    const schema = doc.components.schemas[name]!;
    const ident = schemaIdent(name);
    lines.push(`export const ${ident} = ${convert(schema, mode, name)};`);
    lines.push(`export type ${name} = z.infer<typeof ${ident}>;\n`);
  }
  if (mode === 'strict') {
    const ops = readOperations(doc);
    lines.push(
      "/** Each operation's query parameters, as read from a URL (repeated parameters as arrays). */",
    );
    lines.push('export const QUERY_SCHEMAS = {');
    for (const op of ops) {
      const fields = op.query.map(
        (p) => `${lit(p.name)}: ${queryParamSchema(p, `${op.id}?${p.name}`)}`,
      );
      lines.push(`${op.id}: z.strictObject({${fields.join(', ')}}),`);
    }
    lines.push('} as const;\n');
    lines.push("/** Each operation's request body schema, or null when it takes none. */");
    lines.push('export const REQUEST_SCHEMAS = {');
    for (const op of ops) {
      lines.push(`${op.id}: ${op.request === null ? 'null' : schemaIdent(op.request)},`);
    }
    lines.push('} as const;\n');
    lines.push("/** Each operation's success response schema. */");
    lines.push('export const RESPONSE_SCHEMAS = {');
    for (const op of ops) lines.push(`${op.id}: ${schemaIdent(op.response)},`);
    lines.push('} as const;\n');
    for (const op of ops) {
      if (op.request !== null) {
        lines.push(
          `export type ${pascal(op.id)}Body = z.input<typeof ${schemaIdent(op.request)}>;`,
        );
      }
      lines.push(`export type ${pascal(op.id)}Query = z.input<typeof QUERY_SCHEMAS.${op.id}>;`);
    }
    lines.push('');
    lines.push("/** Each operation's query and body types, for typed calls. */");
    lines.push('export interface OperationIO {');
    for (const op of ops) {
      const body = op.request === null ? 'undefined' : `${pascal(op.id)}Body`;
      lines.push(`${op.id}: { query: ${pascal(op.id)}Query; body: ${body} };`);
    }
    lines.push('}');
  }
  return lines.join('\n');
}

function operationsFile(doc: OpenApiDocument): string {
  const ops = readOperations(doc);
  const lines: string[] = [
    header(
      doc,
      "The agent API's operations, scopes and error codes, as the contract declares them.",
    ),
  ];
  lines.push("import * as S from './schemas.js';\n");
  lines.push(
    `/** The contract's API version. */\nexport const API_VERSION = ${lit(doc.info.version)};\n`,
  );

  const scopes = doc['x-buildit-scopes'] ?? {};
  const scopeNames = Object.keys(scopes);
  lines.push(`/** Token scopes, in the contract's order. */`);
  lines.push(`export const SCOPES = ${lit(scopeNames)} as const;`);
  lines.push('export type Scope = (typeof SCOPES)[number];\n');
  lines.push('/** What each scope directly implies (implications are transitive). */');
  lines.push('export const SCOPE_IMPLIES: Readonly<Record<Scope, readonly Scope[]>> = {');
  for (const name of scopeNames) lines.push(`${lit(name)}: ${lit(scopes[name]?.implies ?? [])},`);
  lines.push('};\n');

  const errors = doc['x-buildit-errors'] ?? {};
  lines.push("/** The API's error codes and their HTTP statuses. v1 may add codes. */");
  lines.push('export const ERROR_STATUS = {');
  for (const code of Object.keys(errors)) lines.push(`${lit(code)}: ${errors[code]!.status},`);
  lines.push('} as const;');
  lines.push('export type ErrorCode = keyof typeof ERROR_STATUS;\n');
  lines.push(
    "/** Each error code's stable next step, as the contract words it. The API sends it as the error's hint; this copy serves when an older API doesn't. */",
  );
  lines.push('export const ERROR_HINTS: Readonly<Partial<Record<ErrorCode, string>>> = {');
  for (const code of Object.keys(errors)) {
    const hint = errors[code]!.hint;
    if (hint !== undefined) lines.push(`${lit(code)}: ${lit(hint)},`);
  }
  lines.push('};\n');

  const planScopes: Record<string, string[]> = {};
  for (const op of ops) {
    for (const scope of op.requiredScopes) {
      if (!scopeNames.includes(scope)) fail(op.id, `unknown required scope ${scope}`);
    }
    for (const [action, scopes] of Object.entries(op.planScopes)) {
      const known = planScopes[action];
      if (known !== undefined && JSON.stringify(known) !== JSON.stringify(scopes)) {
        fail(op.id, `plan action ${action} has two sets of scopes`);
      }
      for (const scope of scopes) {
        if (!scopeNames.includes(scope))
          fail(op.id, `plan action ${action}: unknown scope ${scope}`);
      }
      planScopes[action] = scopes;
    }
  }
  lines.push(
    "/** Every scope each plan action needs, all of them (the operations whose scope is 'plan_action' check them). */",
  );
  lines.push('export const PLAN_SCOPES = {');
  for (const [action, scopes] of Object.entries(planScopes)) {
    lines.push(`${lit(action)}: ${lit(scopes)},`);
  }
  lines.push('} as const satisfies Record<string, readonly Scope[]>;');
  lines.push('export type PlanActionName = keyof typeof PLAN_SCOPES;\n');

  lines.push('/** Every operation of the contract, by operationId. */');
  lines.push('export const OPERATIONS = {');
  for (const op of ops) {
    lines.push(`${op.id}: {`);
    lines.push(`method: ${lit(op.method)},`);
    lines.push(`path: ${lit(op.path)},`);
    lines.push(`pathParams: ${lit(op.pathParams)},`);
    lines.push(`arrayQueryParams: ${lit(op.query.filter((q) => q.array).map((q) => q.name))},`);
    lines.push(`scope: ${lit(op.scope)},`);
    lines.push(`requiredScopes: ${lit(op.requiredScopes)},`);
    lines.push(`hints: ${lit(op.hints)},`);
    lines.push(`errors: ${lit(op.errors)},`);
    lines.push(`hasBody: ${lit(op.request !== null)},`);
    lines.push(`statuses: ${lit(op.statuses)},`);
    lines.push(`discovery: ${lit(op.discovery)},`);
    lines.push(`response: S.${schemaIdent(op.response)},`);
    lines.push('},');
  }
  lines.push('} as const;\n');
  lines.push('export type OperationId = keyof typeof OPERATIONS;');
  return lines.join('\n');
}

export const GENERATED_DIR = 'src/api/generated';

/** The generated files, by path relative to the repository root. */
export async function generate(
  doc: OpenApiDocument,
  prettierConfigFile: string,
): Promise<Map<string, string>> {
  if (!doc.openapi.startsWith('3.1')) fail('document', `expected OpenAPI 3.1, got ${doc.openapi}`);
  const order = orderComponents(doc.components.schemas);
  const config = (await resolveConfig(prettierConfigFile)) ?? {};
  const out = new Map<string, string>();
  const files: [string, string][] = [
    ['schemas.ts', schemasFile(doc, order, 'tolerant')],
    ['strict.ts', schemasFile(doc, order, 'strict')],
    ['operations.ts', operationsFile(doc)],
  ];
  for (const [name, source] of files) {
    out.set(
      `${GENERATED_DIR}/${name}`,
      await format(source, { ...config, parser: 'typescript', filepath: name }),
    );
  }
  return out;
}
