/**
 * Where the person's Codex configuration sends approvals.
 *
 * The bridge shows Codex's approvals as cards only when Codex asks its
 * client. With `approval_policy = "never"` Codex never asks (it runs or
 * refuses on its own); with `approvals_reviewer = "auto_review"` (or the
 * guardian subagent) its own reviewer decides; a granular policy can turn
 * some kinds off. The bridge reads the policy at startup (config/read, for
 * the folder) and from each thread it starts or resumes (what applies
 * there), warns in its log, and writes a small note next to the lock files
 * that `buildit-mcp status` reads. The note holds those two settings and
 * the time only.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** What Codex said of its approvals. */
export interface ApprovalPolicy {
  /** `approval_policy`: a string, a granular object, or null (Codex's default). */
  approvalPolicy: unknown;
  /** `approvals_reviewer`: `user`, `auto_review`, `guardian_subagent`, or null. */
  approvalsReviewer: unknown;
  /** Where it was read: the folder's config at startup, or a thread's. */
  source: 'config' | 'thread';
}

const REVIEWERS_ELSEWHERE: ReadonlySet<string> = new Set(['auto_review', 'guardian_subagent']);

/**
 * Why approvals won't (all) reach the app as cards, in words for a log or
 * `status`; undefined when they do.
 */
export function policyWarning(
  policy: Pick<ApprovalPolicy, 'approvalPolicy' | 'approvalsReviewer'>,
): string | undefined {
  const reasons: string[] = [];
  const p = policy.approvalPolicy;
  if (p === 'never') {
    reasons.push('approval_policy is "never", so Codex never asks and no approval card shows');
  } else if (p !== null && typeof p === 'object') {
    const granular = (p as { granular?: unknown }).granular;
    const flags =
      granular !== null && typeof granular === 'object'
        ? Object.entries(granular as Record<string, unknown>).filter(([, v]) => v === false)
        : [];
    if (flags.length > 0) {
      reasons.push(
        `the granular approval_policy turns off ${flags.map(([k]) => k).join(', ')}, so those never show as cards`,
      );
    }
  }
  const r = policy.approvalsReviewer;
  if (typeof r === 'string' && REVIEWERS_ELSEWHERE.has(r)) {
    reasons.push(
      `approvals_reviewer is "${r}", so Codex's own reviewer decides and no approval card shows`,
    );
  }
  return reasons.length === 0 ? undefined : reasons.join('; ');
}

/** Where the note of a folder's session is: next to its lock files. */
export function policyNotePath(lockDir: string, key: string): string {
  return join(lockDir, `${key}.codex-policy.json`);
}

/** The note `status` reads. */
export interface PolicyNote {
  v: 1;
  approval_policy: unknown;
  approvals_reviewer: unknown;
  warning: string | null;
  checked_at: string;
}

/** Writes the note (0600, through a temporary file); a failure is only returned. */
export function writePolicyNote(path: string, policy: ApprovalPolicy, now = Date.now()): boolean {
  const note: PolicyNote = {
    v: 1,
    approval_policy: policy.approvalPolicy ?? null,
    approvals_reviewer: policy.approvalsReviewer ?? null,
    warning: policyWarning(policy) ?? null,
    checked_at: new Date(now).toISOString(),
  };
  const temp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temp, JSON.stringify(note), { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
    return true;
  } catch {
    return false;
  }
}

/** Reads the note; undefined when there is none or it can't be read. */
export function readPolicyNote(path: string): PolicyNote | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<PolicyNote>;
    if (raw.v !== 1 || typeof raw.checked_at !== 'string') return undefined;
    return {
      v: 1,
      approval_policy: raw.approval_policy ?? null,
      approvals_reviewer: raw.approvals_reviewer ?? null,
      warning: typeof raw.warning === 'string' ? raw.warning : null,
      checked_at: raw.checked_at,
    };
  } catch {
    return undefined;
  }
}
