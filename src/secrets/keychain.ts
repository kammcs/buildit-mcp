/**
 * Where a folder's session token is kept between runs.
 *
 * `buildit-mcp connect` saves the token it receives, and `--channel` mode
 * reads it back, so restarting Claude Code in the same folder resumes the
 * same session (and its threads). The entry's key is the SHA-256 of the
 * folder's real path (case-folded on Windows and macOS, whose file systems
 * usually ignore case) and the API's origin, so each folder and deployment
 * has its own session.
 *
 * The store is the operating system's keychain through `@napi-rs/keyring`
 * (an optional dependency): Windows Credential Manager, the macOS Keychain,
 * or the Secret Service on Linux. When it can't be loaded or used (no
 * prebuilt binary, a headless Linux without a Secret Service, WSL), the token
 * goes to a JSON file readable only by the user (mode 0600) instead, with a
 * warning. BUILDIT_TOKEN_STORE=file picks the file directly.
 *
 * Nothing here logs or prints a token.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** The keychain service under which every entry is saved. */
export const KEYRING_SERVICE = 'buildit-mcp';

/** What a keychain entry is: the part of `@napi-rs/keyring`'s AsyncEntry used here. */
export interface KeyringEntry {
  getPassword(): Promise<string | null>;
  setPassword(password: string): Promise<void>;
  deletePassword(): Promise<boolean>;
}

/** Makes the entry for one account of KEYRING_SERVICE. */
export type KeyringFactory = (service: string, account: string) => KeyringEntry;

export interface TokenStore {
  /** Where tokens go now: the OS keychain, or the fallback file. */
  readonly kind: 'keyring' | 'file';
  /** For people: the keychain's name, or the file's path. */
  readonly location: string;
  get(key: string): Promise<string | undefined>;
  set(key: string, token: string): Promise<void>;
  /** Removes the entry; true when there was one. */
  delete(key: string): Promise<boolean>;
}

/** The folder as the key sees it: its real path, case-folded where file systems ignore case. */
export function folderIdentity(
  folder: string,
  platform: NodeJS.Platform = process.platform,
): string {
  let real: string;
  try {
    real = realpathSync.native(resolve(folder));
  } catch {
    // A folder that doesn't exist (yet) still has a stable key.
    real = resolve(folder);
  }
  const trimmed = real.length > 1 ? real.replace(/[\\/]+$/, '') || real : real;
  const folded = platform === 'win32' || platform === 'darwin' ? trimmed.toLowerCase() : trimmed;
  return folded.normalize('NFC');
}

/** The API's origin (scheme, host and port), which the key includes. */
export function apiOrigin(apiUrl: string): string {
  return new URL(apiUrl).origin;
}

/** The store key of a folder's session with one deployment: hex SHA-256 of both. */
export function sessionKey(
  folder: string,
  apiUrl: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return createHash('sha256')
    .update(`${folderIdentity(folder, platform)}\n${apiOrigin(apiUrl)}`)
    .digest('hex');
}

/** The keychain's name on this platform, for messages. */
export function keyringName(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return 'Windows Credential Manager';
  if (platform === 'darwin') return 'the macOS Keychain';
  return 'the Secret Service (GNOME Keyring, KWallet)';
}

/** The fallback file's default path on this platform. */
export function defaultTokenFile(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    const base = env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(base, 'buildit-mcp', 'sessions.json');
  }
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'buildit-mcp', 'sessions.json');
  }
  const base = env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(base, 'buildit-mcp', 'sessions.json');
}

interface TokenFileShape {
  v: 1;
  tokens: Record<string, string>;
}

/** Tokens in one JSON file, written with mode 0600 in a 0700 folder. */
export class FileTokenStore implements TokenStore {
  readonly kind = 'file' as const;

  constructor(readonly location: string) {}

  private async read(): Promise<TokenFileShape> {
    let raw: string;
    try {
      raw = await readFile(this.location, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { v: 1, tokens: {} };
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<TokenFileShape>;
      const tokens: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed.tokens ?? {})) {
        if (typeof v === 'string') tokens[k] = v;
      }
      return { v: 1, tokens };
    } catch {
      throw new Error(
        `The session file ${this.location} is not valid JSON; delete it and connect again.`,
      );
    }
  }

  private async write(data: TokenFileShape): Promise<void> {
    await mkdir(dirname(this.location), { recursive: true, mode: 0o700 });
    const temp = `${this.location}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    try {
      await rename(temp, this.location);
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
    // Where the file existed with looser bits, rename keeps the new file's.
    await chmod(this.location, 0o600).catch(() => undefined);
  }

  async get(key: string): Promise<string | undefined> {
    return (await this.read()).tokens[key];
  }

  async set(key: string, token: string): Promise<void> {
    const data = await this.read();
    data.tokens[key] = token;
    await this.write(data);
  }

  async delete(key: string): Promise<boolean> {
    const data = await this.read();
    if (!(key in data.tokens)) return false;
    data.tokens = Object.fromEntries(Object.entries(data.tokens).filter(([k]) => k !== key));
    await this.write(data);
    return true;
  }
}

/**
 * The OS keychain, falling back to the file whenever the keychain fails
 * (once it has failed, the file is used for the rest of the process). A
 * token that went to the file while the keychain was unavailable is still
 * found there later, and removed with the keychain's entry.
 */
export class KeyringTokenStore implements TokenStore {
  private failed = false;

  constructor(
    private readonly entry: KeyringFactory,
    private readonly file: FileTokenStore,
    private readonly warn: (message: string) => void,
    private readonly name: string = keyringName(),
  ) {}

  get kind(): 'keyring' | 'file' {
    return this.failed ? 'file' : 'keyring';
  }

  get location(): string {
    return this.failed ? this.file.location : this.name;
  }

  private fallBack(err: unknown): void {
    if (this.failed) return;
    this.failed = true;
    const reason = err instanceof Error ? err.message : String(err);
    this.warn(
      `The OS keychain (${this.name}) could not be used (${reason.slice(0, 200)}); the session token is kept in ${this.file.location} instead, readable only by your user account.`,
    );
  }

  async get(key: string): Promise<string | undefined> {
    if (!this.failed) {
      try {
        const token = await this.entry(KEYRING_SERVICE, key).getPassword();
        if (token !== null && token !== '') return token;
      } catch (err) {
        this.fallBack(err);
      }
    }
    return this.file.get(key);
  }

  async set(key: string, token: string): Promise<void> {
    if (!this.failed) {
      try {
        await this.entry(KEYRING_SERVICE, key).setPassword(token);
        // An older copy in the file would otherwise outlive this one.
        await this.file.delete(key).catch(() => false);
        return;
      } catch (err) {
        this.fallBack(err);
      }
    }
    await this.file.set(key, token);
  }

  async delete(key: string): Promise<boolean> {
    let deleted = false;
    if (!this.failed) {
      try {
        deleted = await this.entry(KEYRING_SERVICE, key).deletePassword();
      } catch (err) {
        this.fallBack(err);
      }
    }
    const fromFile = await this.file.delete(key).catch(() => false);
    return deleted || fromFile;
  }
}

/** Loads `@napi-rs/keyring`, or undefined when it isn't installed or has no binary here. */
export async function loadKeyring(): Promise<KeyringFactory | undefined> {
  try {
    const mod = (await import('@napi-rs/keyring')) as {
      AsyncEntry: new (service: string, account: string) => KeyringEntry;
    };
    return (service, account) => new mod.AsyncEntry(service, account);
  } catch {
    return undefined;
  }
}

export interface OpenTokenStoreOptions {
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  /** Told once when the file is used instead of the keychain. */
  warn: (message: string) => void;
  /** For tests: the keychain to use (undefined: none available). */
  keyring?: () => Promise<KeyringFactory | undefined>;
  /** For tests: the fallback file. */
  file?: string;
}

/** The token store for this machine: the keychain when it loads, else the file. */
export async function openTokenStore(options: OpenTokenStoreOptions): Promise<TokenStore> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const file = new FileTokenStore(options.file ?? defaultTokenFile(env, platform));
  if (env.BUILDIT_TOKEN_STORE?.trim().toLowerCase() === 'file') return file;
  const factory = await (options.keyring ?? loadKeyring)();
  if (factory === undefined) {
    options.warn(
      `The OS keychain is not available here (the optional @napi-rs/keyring package did not load); the session token is kept in ${file.location}, readable only by your user account.`,
    );
    return file;
  }
  return new KeyringTokenStore(factory, file, options.warn, keyringName(platform));
}
