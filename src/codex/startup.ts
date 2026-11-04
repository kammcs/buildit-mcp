/**
 * Why the app-server didn't start, in words for the person's terminal.
 *
 * Until the handshake is done, the app-server's stderr holds only what it
 * says about starting (a configuration it refuses, a missing sign-in), so
 * the process keeps its first lines (bounded) until then; after the
 * handshake nothing of it is kept. When `initialize` fails, the most
 * useful of those lines is shown (cleaned, its control characters out,
 * cut) with the likely cause. It goes to the terminal only, never to the
 * logs.
 */

/** How many of the first stderr lines are kept, and how long each may be. */
export const STARTUP_LINES_MAX = 20;
export const STARTUP_LINE_CHARS = 500;

/* eslint-disable no-control-regex -- removing control characters is the point */
const CONTROL = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;
/** ANSI colour and cursor sequences (Codex colours its errors). */
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/* eslint-enable no-control-regex */

/** A stderr line as it may be shown: escapes and control characters out, trimmed, cut. */
export function cleanLine(line: string, max = 300): string {
  const flat = line.replace(ANSI, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length <= max ? flat : chars.slice(0, max - 1).join('') + '…';
}

/** The most useful line: the first that says error, else the last that says anything. */
export function usefulLine(lines: readonly string[]): string | undefined {
  const cleaned = lines.map((l) => cleanLine(l)).filter((l) => l !== '');
  return (
    cleaned.find((l) => /\berror\b|\bfailed\b|not supported|invalid/i.test(l)) ?? cleaned.at(-1)
  );
}

/** The likely cause of a start that failed, from what the app-server said. */
export function likelyCause(line: string | undefined, overrides: readonly string[]): string {
  if (line === undefined) {
    return 'It said nothing. Run "codex app-server" in this folder to see why, and check that Codex is signed in (codex login).';
  }
  if (/approval_policy|approvals_reviewer|sandbox_mode|sandbox|config|toml|setting/i.test(line)) {
    return overrides.length > 0
      ? `Likely a setting it refuses: check the -c overrides you passed (${overrides.map((o) => o.split('=')[0]).join(', ')}) and your Codex config (config.toml).`
      : 'Likely a setting it refuses: check your Codex config (config.toml).';
  }
  if (/log ?in|logged in|sign(ed)? in|auth|unauthori[sz]ed|credential/i.test(line)) {
    return 'Likely the sign-in: run "codex login" in a terminal.';
  }
  return 'Run "codex app-server" in this folder to see more.';
}
