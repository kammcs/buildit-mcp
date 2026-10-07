/**
 * Structured JSON logging to stderr.
 *
 * stdout belongs to the MCP protocol in stdio mode, so nothing here ever
 * writes to it. Every line is one JSON object. Tokens never reach the log:
 * callers don't pass them, and as a second line of defence every string is
 * scrubbed of bearer credentials, token-shaped strings and any secret the
 * process registered, and fields whose names look like credentials are
 * replaced wholesale.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Where each JSON line goes. Defaults to stderr. */
  sink?: (line: string) => void;
  /** Exact values to scrub from every line (for example the stdio token). */
  secrets?: readonly string[];
}

const REDACTED = '[redacted]';

/** Field names whose values are never logged. */
const SECRET_KEY = /(authorization|token|secret|password|api[-_]?key|cookie)/i;

/** Bearer credentials and buildIt personal access tokens, wherever they appear in a string. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[^\s"',;]+/gi,
  /\bbuildit_pat_[A-Za-z0-9_]+/g,
];

export function scrubString(value: string, secrets: readonly string[] = []): string {
  let out = value;
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join(REDACTED);
  }
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

function scrub(value: unknown, secrets: readonly string[], depth: number): unknown {
  if (typeof value === 'string') return scrubString(value, secrets);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 6) return '[truncated]';
  if (value instanceof Error) {
    return { name: value.name, message: scrubString(value.message, secrets) };
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, secrets, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? REDACTED : scrub(v, secrets, depth + 1);
  }
  return out;
}

const defaultSink = (line: string): void => {
  process.stderr.write(line + '\n');
};

export function createLogger(options: LoggerOptions = {}, bound: LogFields = {}): Logger {
  const minLevel = LOG_LEVELS.indexOf(options.level ?? 'info');
  const sink = options.sink ?? defaultSink;
  const secrets = options.secrets ?? [];

  const write = (level: LogLevel, msg: string, fields?: LogFields): void => {
    if (LOG_LEVELS.indexOf(level) < minLevel) return;
    const record = scrub(
      { ts: new Date().toISOString(), level, msg, ...bound, ...fields },
      secrets,
      0,
    );
    try {
      sink(JSON.stringify(record));
    } catch {
      // Logging must never break the server.
    }
  };

  return {
    debug: (msg, fields) => {
      write('debug', msg, fields);
    },
    info: (msg, fields) => {
      write('info', msg, fields);
    },
    warn: (msg, fields) => {
      write('warn', msg, fields);
    },
    error: (msg, fields) => {
      write('error', msg, fields);
    },
    child: (fields) => createLogger(options, { ...bound, ...fields }),
  };
}

/** A logger that drops everything (for tests and library use). */
export const silentLogger: Logger = createLogger({ sink: () => undefined });
