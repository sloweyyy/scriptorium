import { createHash } from "node:crypto";

/**
 * The Slack "Approve & publish" button, made a real approval.
 *
 * Before: any member of the notify channel could click it, the card stayed live after a
 * decision (a second click approved again), and the button carried only the issue key — so
 * a card posted for the first draft published whatever revision was current when clicked.
 * Now the button names the exact draft it was posted for, only listed Slack users may
 * approve, and the card is replaced once decided.
 */

/** Short, stable fingerprint of a draft's text — what a card was posted for. */
export function draftFingerprint(markdown: string): string {
  return createHash("sha256").update(markdown.replace(/\r\n/g, "\n").trim()).digest("hex").slice(0, 16);
}

export function approvalButtonValue(issueKey: string, markdown: string): string {
  return `${issueKey}|${draftFingerprint(markdown)}`;
}

export function parseApprovalButtonValue(value: string | undefined): { issueKey: string; draft?: string } | undefined {
  if (!value) return undefined;
  const [issueKey, draft] = value.split("|");
  if (!issueKey || !/^[A-Z][A-Z0-9_]*-\d+$/i.test(issueKey)) return undefined;
  return { issueKey: issueKey.toUpperCase(), draft: draft || undefined };
}

export type SlackApprovalCheck = { ok: true } | { ok: false; reason: string };

/**
 * Who may press it. No list configured means nobody: a channel's membership is not an
 * approver list, and the ticket's own `approve` comment remains open to its reviewers.
 */
export function mayApproveInSlack(approvers: readonly string[], userId: string | undefined): SlackApprovalCheck {
  if (!userId) return { ok: false, reason: "I couldn't tell who pressed the button." };
  if (!approvers.length) {
    return { ok: false, reason: "Approving from Slack is switched off here (no approvers are configured). Comment `approve` on the ticket instead." };
  }
  if (!approvers.includes(userId)) return { ok: false, reason: "You're not on the approver list for Slack approvals. Comment `approve` on the ticket instead." };
  return { ok: true };
}
