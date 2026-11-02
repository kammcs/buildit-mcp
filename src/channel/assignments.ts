/**
 * Assignment requests, as the channel reads them: the requests this
 * process has made (so withdraw_assignment can name one by an item's key),
 * and the content of the notification about how one ended.
 *
 * - `card.closed` with `data.assignment` (event=assignment_resolved): how
 *   the owner answered this session's Assign card (applied: the items
 *   assigned, skipped and left unticked; cancelled, expired, withdrawn,
 *   closed). It arrives before the assigned items' own events.
 * - `work_item.assigned` with `data.assignment_request` is an ordinary
 *   assignment (item-events.ts writes it), marked as coming from the card.
 *
 * Every line is this server's own wording, built from structured fields
 * (item keys, sanitized; outcome and reason codes from fixed lists);
 * nothing a session or a person wrote is ever in it. The reasons the
 * session gave on the card are left out: the session wrote them itself.
 */
import { sanitizeLabel } from '../untrusted.js';

/** A request this process made, as withdraw_assignment finds it. */
export interface KnownAssignment {
  id: string;
  /** The items' keys, upper case, in the card's order. */
  keys: string[];
  /** The items' ids, lower case. */
  ids: string[];
  status: string;
}

const ASSIGNMENTS_MAX = 100;

/** The assignment requests made in this process (bounded, oldest forgotten first). */
export class Assignments {
  private readonly byId = new Map<string, KnownAssignment>();

  /** Records (or refreshes) a request. */
  remember(a: KnownAssignment): void {
    this.byId.delete(a.id);
    this.byId.set(a.id, a);
    if (this.byId.size > ASSIGNMENTS_MAX) {
      const oldest = this.byId.keys().next().value;
      if (oldest !== undefined) this.byId.delete(oldest);
    }
  }

  get(id: string): KnownAssignment | undefined {
    return this.byId.get(id.toLowerCase());
  }

  /** Sets a known request's status (an outcome that arrived). */
  settle(id: string, status: string): void {
    const known = this.byId.get(id.toLowerCase());
    if (known !== undefined) known.status = status;
  }

  /** The requests still waiting for the person, newest first. */
  open(): KnownAssignment[] {
    return [...this.byId.values()].reverse().filter((a) => a.status === 'open');
  }

  /** The newest open request that lists an item (by key or id). */
  openForItem(ref: string): KnownAssignment | undefined {
    const want = ref.replace(/^#/, '');
    return this.open().find(
      (a) => a.keys.includes(want.toUpperCase()) || a.ids.includes(want.toLowerCase()),
    );
  }
}

/** Why a ticked item couldn't be assigned, in words (SessionAssignmentOutcome's skipped reason). */
export function skipWords(reason: string): string {
  switch (reason) {
    case 'agent_unavailable':
      return 'the agent was turned off or deleted';
    case 'deleted':
      return 'the item was deleted';
    case 'closed':
      return 'it is done or canceled';
    case 'already_yours':
      return 'it was assigned to you meanwhile: work on it';
    case 'not_in_channel':
      return "the person can't assign in its project's channel";
    case 'session_ended':
      return 'this session ended';
    case 'session_projects':
      return "its project isn't one this session was connected for";
    case 'projects_off':
      return 'Projects is off for the org';
    case 'archived':
      return 'its project or channel is archived';
    case 'needs_unmet':
      return 'this session lacks one of its Needs';
    case 'other_session':
      return 'another session of this agent works in its thread';
    default:
      return sanitizeLabel(reason, 40) || 'no reason given';
  }
}

/** Why a card closed unanswered, in words (SessionAssignmentOutcome's reason). */
function closedWords(reason: string | undefined): string {
  switch (reason) {
    case 'session_ended':
      return 'this session ended first';
    case 'unassigned':
      return 'you were taken off the item whose thread it was in';
    case 'deleted':
      return 'its message was deleted';
    case 'removed':
      return 'the card was taken off its message';
    case 'interrupted':
    case undefined:
      return 'it was interrupted';
    default:
      return sanitizeLabel(reason, 40) || 'it was interrupted';
  }
}

/** assignment_resolved, from card.closed's data.assignment (keys and codes sanitized already). */
export interface ResolvedAssignment {
  id: string;
  outcome: string;
  reason: string | undefined;
  assigned: string[];
  skipped: { key: string; reason: string }[];
  unticked: string[];
}

const keyList = (keys: readonly string[]): string => keys.join(', ');

/** The content of event=assignment_resolved. `owner` is sanitized already. */
export function assignmentResolvedContent(owner: string, a: ResolvedAssignment): string {
  const nothing = 'Nothing was assigned.';
  switch (a.outcome) {
    case 'applied': {
      const total = a.assigned.length + a.skipped.length + a.unticked.length;
      const lines = [
        a.assigned.length === 0
          ? `${owner} answered your Assign card, but none of the ${total} items was assigned to you.`
          : `${owner} assigned you ${a.assigned.length} of the ${total} items on your Assign card: ${keyList(a.assigned)}. Each arrives next as its own event=item_assigned: work on them there as usual, in their threads.`,
      ];
      if (a.skipped.length > 0) {
        lines.push(
          `Ticked but not assigned: ${a.skipped.map((s) => `${s.key} (${skipWords(s.reason)})`).join('; ')}.`,
        );
      }
      if (a.unticked.length > 0) {
        lines.push(
          `Left unticked, so not assigned: ${keyList(a.unticked)}. Don't ask for them again unless ${owner} asks.`,
        );
      }
      return lines.join('\n');
    }
    case 'cancelled':
      return `${owner} cancelled your Assign card. ${nothing} Don't ask for these items again unless ${owner} asks.`;
    case 'expired':
      return `Nobody answered your Assign card within 24 hours. ${nothing} Ask ${owner} before you ask again.`;
    case 'withdrawn':
      return `Your Assign card was withdrawn. ${nothing}`;
    case 'closed':
      return `Your Assign card closed unanswered (${closedWords(a.reason)}). ${nothing}`;
    default:
      return `Your Assign card ended (${sanitizeLabel(a.outcome, 40)}). Check with ${owner} before you rely on it.`;
  }
}
