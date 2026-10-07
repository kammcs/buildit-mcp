/**
 * An in-process fake of the buildIt.Social agent API, for tests and the
 * local smoke scripts. It knows only the endpoints this version uses
 * (GET /v1/meta and GET /v1/me) and holds made-up data; it never talks to a
 * real server.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeIdentity {
  user: { id: string; display_name?: string; email?: string };
  org: { id: string; name?: string };
  token?: { id?: string; name?: string; expires_at?: string };
  scopes: string[];
  limits?: { projects: string[] | null; channels: string[] | null };
  projects?: { id?: string; key: string; name?: string }[];
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface ScriptedResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Wait this long before answering (for timeout tests). */
  delayMs?: number;
}

/** Test tokens. Made up; they only work against this fake. */
export const TOKENS = {
  full: 'buildit_pat_test_full_access',
  read: 'buildit_pat_test_read_only',
  none: 'buildit_pat_test_no_scopes',
  unknown: 'buildit_pat_test_not_issued',
} as const;

export function sampleIdentity(
  scopes: string[],
  overrides: Partial<FakeIdentity> = {},
): FakeIdentity {
  return {
    user: { id: 'u-0001', display_name: 'Test User', email: 'test.user@example.com' },
    org: { id: 'o-0001', name: 'Example Org' },
    token: { id: 't-0001', name: 'Test token', expires_at: '2030-01-01T00:00:00Z' },
    scopes,
    limits: { projects: null, channels: null },
    projects: [
      { id: 'p-0001', key: 'DEMO', name: 'Demo project' },
      { id: 'p-0002', key: 'OPS', name: 'Operations' },
    ],
    ...overrides,
  };
}

export const DEFAULT_IDENTITIES: Record<string, FakeIdentity> = {
  [TOKENS.full]: sampleIdentity([
    'projects:write',
    'projects:delete',
    'projects:admin',
    'pages:write',
    'chat:read',
  ]),
  [TOKENS.read]: sampleIdentity(['projects:read']),
  [TOKENS.none]: sampleIdentity([]),
};

function errorBody(code: string, message: string, details?: unknown): unknown {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

export class FakeApi {
  readonly requests: RecordedRequest[] = [];
  identities: Record<string, FakeIdentity>;
  meta: Record<string, unknown> = { api_version: '1.0.0', min_mcp_version: '0.1.0' };
  private readonly queues = new Map<string, ScriptedResponse[]>();
  private server: Server | undefined;
  private baseUrl = '';

  constructor(identities: Record<string, FakeIdentity> = DEFAULT_IDENTITIES) {
    this.identities = { ...identities };
  }

  /** The base URL to use as BUILDIT_API_URL. */
  get url(): string {
    return this.baseUrl;
  }

  /** Answer the next request to `path` with `response` instead of the normal behaviour. */
  enqueue(path: string, ...responses: ScriptedResponse[]): void {
    const queue = this.queues.get(path) ?? [];
    queue.push(...responses);
    this.queues.set(path, queue);
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}/functions/v1/agent-api`;
    return this;
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      server.closeAllConnections();
    });
  }

  private send(res: ServerResponse, response: ScriptedResponse): void {
    const body = response.body === undefined ? '' : JSON.stringify(response.body);
    res.writeHead(response.status, {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...response.headers,
    });
    res.end(body);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake');
    const prefix = '/functions/v1/agent-api';
    const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
    this.requests.push({
      method: req.method ?? 'GET',
      path,
      query: url.search,
      headers: { ...req.headers },
    });

    const scripted = this.queues.get(path)?.shift();
    if (scripted) {
      if (scripted.delayMs) await new Promise((r) => setTimeout(r, scripted.delayMs));
      if (!res.destroyed) this.send(res, scripted);
      return;
    }

    if (req.method === 'GET' && path === '/v1/meta') {
      this.send(res, { status: 200, body: this.meta });
      return;
    }

    const auth = req.headers.authorization ?? '';
    const token = /^Bearer (.+)$/.exec(auth)?.[1];
    const identity = token === undefined ? undefined : this.identities[token];
    if (!identity) {
      this.send(res, {
        status: 401,
        body: errorBody('unauthorized', 'The token is missing, invalid, expired or revoked.'),
      });
      return;
    }

    if (req.method === 'GET' && path === '/v1/me') {
      this.send(res, { status: 200, body: identity });
      return;
    }

    this.send(res, {
      status: 404,
      body: errorBody('not_found', `No route for ${req.method} ${path}.`),
    });
  }
}
