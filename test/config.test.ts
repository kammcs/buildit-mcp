import { describe, expect, it } from 'vitest';

import {
  ConfigError,
  DEFAULT_API_URL,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT,
  parseCli,
  parseToolsets,
  type Config,
  type Env,
} from '../src/config.js';

const TOKEN = 'buildit_pat_test_config_token';

function run(argv: string[], env: Env): Config {
  const action = parseCli(argv, env);
  if (action.kind !== 'run') throw new Error(`expected run, got ${action.kind}`);
  return action.config;
}

function errorOf(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error('expected a ConfigError');
}

describe('parseCli', () => {
  it('uses the defaults in stdio mode', () => {
    const config = run([], { BUILDIT_TOKEN: TOKEN });
    expect(config).toMatchObject({
      mode: 'stdio',
      apiUrl: DEFAULT_API_URL,
      token: TOKEN,
      toolsets: ['items', 'comments'],
      readOnly: false,
      excludeTools: [],
      logLevel: 'info',
      http: { host: DEFAULT_HTTP_HOST, port: DEFAULT_HTTP_PORT },
      warnings: [],
    });
  });

  it('reads every environment variable', () => {
    const config = run([], {
      BUILDIT_TOKEN: TOKEN,
      BUILDIT_API_URL: 'https://buildit.example.com/functions/v1/agent-api/',
      BUILDIT_TOOLSETS: 'Comments, items,pages',
      BUILDIT_READ_ONLY: 'yes',
      BUILDIT_EXCLUDE_TOOLS: 'whoami, add_comment',
      BUILDIT_LOG_LEVEL: 'debug',
    });
    expect(config.apiUrl).toBe('https://buildit.example.com/functions/v1/agent-api');
    expect(config.toolsets).toEqual(['items', 'comments', 'pages']);
    expect(config.readOnly).toBe(true);
    expect(config.excludeTools).toEqual(['whoami', 'add_comment']);
    expect(config.logLevel).toBe('debug');
  });

  it('lets flags win over the environment', () => {
    const config = run(
      ['--toolsets', 'chat', '--read-only', '--api-url', 'http://localhost:54321/agent-api'],
      { BUILDIT_TOKEN: TOKEN, BUILDIT_TOOLSETS: 'items', BUILDIT_READ_ONLY: 'false' },
    );
    expect(config.toolsets).toEqual(['chat']);
    expect(config.readOnly).toBe(true);
    expect(config.apiUrl).toBe('http://localhost:54321/agent-api');
  });

  it('expands "all" and keeps a fixed toolset order', () => {
    expect(parseToolsets('all')).toEqual([
      'items',
      'comments',
      'planning',
      'pages',
      'chat',
      'admin',
      'destructive',
    ]);
    expect(parseToolsets('destructive,items')).toEqual(['items', 'destructive']);
    expect(parseToolsets(' ')).toEqual(['items', 'comments']);
  });

  it('rejects unknown toolsets with the list of known ones', () => {
    const err = errorOf(() => run([], { BUILDIT_TOKEN: TOKEN, BUILDIT_TOOLSETS: 'items,wiki' }));
    expect(err.message).toContain('wiki');
    expect(err.message).toContain('Known toolsets: items, comments');
  });

  it('rejects malformed booleans, tool names, ports and log levels', () => {
    expect(() => run([], { BUILDIT_TOKEN: TOKEN, BUILDIT_READ_ONLY: 'maybe' })).toThrow(
      /BUILDIT_READ_ONLY must be true or false/,
    );
    expect(() => run([], { BUILDIT_TOKEN: TOKEN, BUILDIT_EXCLUDE_TOOLS: 'Bad-Name' })).toThrow(
      /invalid tool name/,
    );
    expect(() => run(['--http', '--port', '70000'], {})).toThrow(/at most 65535/);
    expect(() => run(['--http', '--port', 'eighty'], {})).toThrow(/must be a number/);
    expect(() => run([], { BUILDIT_TOKEN: TOKEN, BUILDIT_LOG_LEVEL: 'loud' })).toThrow(/log level/);
  });

  it('requires https for the API, except on localhost', () => {
    expect(() =>
      run([], { BUILDIT_TOKEN: TOKEN, BUILDIT_API_URL: 'http://api.example.com/agent-api' }),
    ).toThrow(/https/);
    expect(() =>
      run([], { BUILDIT_TOKEN: TOKEN, BUILDIT_API_URL: 'https://user:pw@api.example.com' }),
    ).toThrow(/credentials/);
    expect(() => run([], { BUILDIT_TOKEN: TOKEN, BUILDIT_API_URL: 'not a url' })).toThrow(
      /not a valid URL/,
    );
    expect(run([], { BUILDIT_TOKEN: TOKEN, BUILDIT_API_URL: 'http://127.0.0.1:9/x' }).apiUrl).toBe(
      'http://127.0.0.1:9/x',
    );
  });

  it('requires a token in stdio mode, and never echoes it', () => {
    expect(() => run([], {})).toThrow(/BUILDIT_TOKEN is not set/);
    const err = errorOf(() => run([], { BUILDIT_TOKEN: 'buildit_pat_has space' }));
    expect(err.message).toMatch(/whitespace/);
    expect(err.message).not.toContain('has space');
  });

  it('warns about a token without the buildIt prefix, without echoing it', () => {
    const config = run([], { BUILDIT_TOKEN: 'some-other-token' });
    expect(config.warnings.join(' ')).toMatch(/buildit_pat_/);
    expect(config.warnings.join(' ')).not.toContain('some-other-token');
  });

  it('refuses a token passed as a flag', () => {
    const err = errorOf(() => run(['--token=buildit_pat_secret_value'], {}));
    expect(err.message).toMatch(/environment variable/);
    expect(err.message).not.toContain('secret_value');
  });

  it('does not echo the token in unknown-flag errors', () => {
    const err = errorOf(() => run([`--${TOKEN}`], { BUILDIT_TOKEN: TOKEN }));
    expect(err.message).not.toContain(TOKEN);
  });

  it('configures HTTP mode without a token and ignores BUILDIT_TOKEN there', () => {
    const config = run(['--http', '--port', '0'], { BUILDIT_TOKEN: TOKEN });
    expect(config.mode).toBe('http');
    expect(config.token).toBeUndefined();
    expect(config.http.port).toBe(0);
    expect(config.warnings.join(' ')).toMatch(/ignored in HTTP mode/);
  });

  it('normalises allowed hosts and origins', () => {
    const config = run(['--http', '--host', '0.0.0.0'], {
      BUILDIT_ALLOWED_HOSTS: 'mcp.example.com:443, MCP.example.com, [::1]:8765',
      BUILDIT_ALLOWED_ORIGINS: 'https://app.example.com:8443,moz-extension://*',
    });
    expect(config.http.allowedHosts).toEqual(['mcp.example.com', '[::1]']);
    expect(config.http.allowedOrigins).toEqual(['app.example.com', 'moz-extension://*']);
    expect(config.warnings).toEqual([]);
  });

  it('warns when binding off loopback without allowed hosts', () => {
    const config = run(['--http', '--host', '0.0.0.0'], {});
    expect(config.warnings.join(' ')).toMatch(/BUILDIT_ALLOWED_HOSTS/);
  });

  it('rejects wildcard web origins and bad hostnames', () => {
    expect(() => run(['--http'], { BUILDIT_ALLOWED_ORIGINS: 'https://*' })).toThrow(
      /every web page/,
    );
    expect(() => run(['--http'], { BUILDIT_ALLOWED_HOSTS: 'bad host' })).toThrow(
      /not a valid hostname/,
    );
  });

  it('handles --help and --version', () => {
    expect(parseCli(['--help'], {})).toEqual({ kind: 'help' });
    expect(parseCli(['-v'], {})).toEqual({ kind: 'version' });
  });
});
