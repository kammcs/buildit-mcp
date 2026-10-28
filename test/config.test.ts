import { join, resolve } from 'node:path';

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
import { createLogger } from '../src/log.js';
import { createHttpApp } from '../src/transports/http.js';

const TOKEN = 'buildit_pat_test_config_token';
const SESSION = 'buildit_ags_test_config_token';

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

  it('refuses to bind off loopback without allowed hosts, unless told to', () => {
    expect(() => run(['--http', '--host', '0.0.0.0'], {})).toThrow(ConfigError);
    expect(() => run(['--http', '--host', 'mcp.example.com'], {})).toThrow(
      /BUILDIT_ALLOWED_HOSTS[\s\S]*BUILDIT_ALLOW_ANY_HOST=true/,
    );
    // Loopback needs nothing; a bind off loopback with allowed hosts needs nothing more.
    expect(run(['--http'], {}).http.allowAnyHost).toBeUndefined();
    expect(
      run(['--http', '--host', '0.0.0.0', '--allowed-hosts', 'mcp.example.com'], {}).http
        .allowAnyHost,
    ).toBeUndefined();
    // The explicit opt-out, by flag or environment variable, still warns.
    for (const config of [
      run(['--http', '--host', '0.0.0.0', '--allow-any-host'], {}),
      run(['--http', '--host', '0.0.0.0'], { BUILDIT_ALLOW_ANY_HOST: 'true' }),
    ]) {
      expect(config.http.allowAnyHost).toBe(true);
      expect(config.warnings.join(' ')).toMatch(/Host header is not checked/);
    }
    expect(() => run(['--http', '--host', '0.0.0.0'], { BUILDIT_ALLOW_ANY_HOST: 'false' })).toThrow(
      ConfigError,
    );
    // The HTTP app refuses such a configuration too, whoever builds it.
    const config = run(['--http', '--host', '0.0.0.0', '--allow-any-host'], {});
    expect(() =>
      createHttpApp(
        { ...config, http: { host: '0.0.0.0', port: 0 } },
        createLogger({ sink: () => undefined }),
      ),
    ).toThrow(ConfigError);
    expect(() => createHttpApp(config, createLogger({ sink: () => undefined }))).not.toThrow();
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

describe('channel mode', () => {
  const cwd = resolve('/work/demo');

  it('reads the token from the store unless BUILDIT_TOKEN is set', () => {
    const fromStore = run(['--channel'], {});
    expect(fromStore.token).toBeUndefined();
    expect(fromStore.channel).toEqual({
      folder: resolve(process.cwd()),
      tokenSource: 'store',
      apiUrlFlag: false,
    });
    const fromEnv = parseCli(['--channel', '--folder', 'sub'], { BUILDIT_TOKEN: SESSION }, cwd);
    if (fromEnv.kind !== 'run') throw new Error('expected run');
    expect(fromEnv.config.token).toBe(SESSION);
    expect(fromEnv.config.channel).toEqual({
      folder: join(cwd, 'sub'),
      tokenSource: 'env',
      apiUrlFlag: false,
    });
    expect(fromEnv.config.warnings).toEqual([]);
  });

  it('takes BUILDIT_CHANNEL and BUILDIT_FOLDER, and warns about a personal access token', () => {
    const action = parseCli(
      [],
      { BUILDIT_CHANNEL: 'true', BUILDIT_FOLDER: '/elsewhere', BUILDIT_TOKEN: TOKEN },
      cwd,
    );
    if (action.kind !== 'run') throw new Error('expected run');
    expect(action.config.channel?.folder).toBe(resolve('/elsewhere'));
    // A user-level personal access token is ignored: the folder's saved session wins.
    expect(action.config.token).toBeUndefined();
    expect(action.config.channel?.tokenSource).toBe('store');
    expect(action.config.warnings.join(' ')).toContain('ignores it');
    expect(action.config.warnings.join(' ')).not.toContain(TOKEN);
  });

  it('notes whether --api-url was given (the saved API wins otherwise)', () => {
    const withFlag = run(['--channel', '--api-url', 'https://api.example.com/v'], {});
    expect(withFlag.channel?.apiUrlFlag).toBe(true);
    const fromEnv = run(['--channel'], { BUILDIT_API_URL: 'https://api.example.com/v' });
    expect(fromEnv.channel?.apiUrlFlag).toBe(false);
    expect(fromEnv.apiUrl).toBe('https://api.example.com/v');
  });

  it('keeps a personal access token outside channel mode', () => {
    expect(run([], { BUILDIT_TOKEN: TOKEN }).token).toBe(TOKEN);
  });

  it('runs over stdio only', () => {
    expect(errorOf(() => run(['--channel', '--http'], {})).message).toContain('stdio only');
  });

  it('accepts a session token in plain stdio mode without a warning', () => {
    expect(run([], { BUILDIT_TOKEN: SESSION }).warnings).toEqual([]);
  });
});

describe('the session commands', () => {
  const cwd = resolve('/work/demo-folder');

  it('parse connect with its projects, label and folder', () => {
    expect(parseCli(['connect', '--project', 'demo', '--project', 'ops,Demo'], {}, cwd)).toEqual({
      kind: 'connect',
      options: {
        apiUrl: DEFAULT_API_URL,
        folder: cwd,
        projects: ['DEMO', 'OPS'],
        label: 'demo-folder',
        yes: false,
      },
    });
    const custom = parseCli(
      [
        'connect',
        '--project',
        'DEMO',
        '--label',
        ' Laptop ',
        '--folder',
        'x',
        '--api-url',
        'http://localhost:9/agent-api',
      ],
      {},
      cwd,
    );
    expect(custom).toMatchObject({
      kind: 'connect',
      options: { folder: join(cwd, 'x'), label: 'Laptop', apiUrl: 'http://localhost:9/agent-api' },
    });
  });

  it('refuse a connect without a project, a bad key or a bad label', () => {
    expect(errorOf(() => parseCli(['connect'], {}, cwd)).message).toContain('--project');
    expect(errorOf(() => parseCli(['connect', '--project', 'X_1'], {}, cwd)).message).toContain(
      'Not a project key',
    );
    expect(
      errorOf(() => parseCli(['connect', '--project', 'DEMO', '--label', 'x'.repeat(41)], {}, cwd))
        .message,
    ).toContain('1 to 40');
    expect(
      errorOf(() => parseCli(['connect', '--project', 'DEMO', '--label', 'a\u202Eb'], {}, cwd))
        .message,
    ).toContain('invisible');
    expect(errorOf(() => parseCli(['status', '--project', 'DEMO'], {}, cwd)).message).toContain(
      'status --help',
    );
  });

  it('name the folder when the label is left out, made to fit', () => {
    const long = resolve(`/work/${'n'.repeat(50)}`);
    const action = parseCli(['connect', '--project', 'DEMO'], {}, long);
    expect(action).toMatchObject({ options: { label: 'n'.repeat(40) } });
  });

  it('parse disconnect, status and their help', () => {
    expect(parseCli(['disconnect'], { BUILDIT_API_URL: 'https://api.example.com/x' }, cwd)).toEqual(
      {
        kind: 'disconnect',
        options: { apiUrl: 'https://api.example.com/x', folder: cwd, apiUrlFlag: false },
      },
    );
    expect(parseCli(['status', '--folder', '/other'], {}, cwd)).toMatchObject({
      kind: 'status',
      options: { folder: resolve('/other') },
    });
    expect(parseCli(['connect', '--help'], {})).toEqual({ kind: 'help', command: 'connect' });
    expect(parseCli(['connect', '--project', 'DEMO', '--yes'], {}, cwd)).toMatchObject({
      options: { yes: true },
    });
  });
});
