/**
 * The one policy check every tool call passes (ADR-001, invariant 1).
 *
 * An agent is an identity plus an envelope: which tools it may call, and at which tier.
 * The tier is decided here and nowhere else — a connector reachable without going through
 * `evaluate` is a bug, not a shortcut. Unlisted tools are denied: an envelope names what an
 * agent may do, never what it may not.
 */

export type Tier = "allow" | "approve" | "deny";

export interface ToolRule {
  tier: Tier;
  /**
   * Account ids allowed to approve this tool. Empty or absent means NOBODY: a channel's
   * membership is not an approver list. `["*"]` opts in to "any human" — still never one of
   * the agent's own accounts, and never the requester when `separateDuties` is set.
   */
  approvers?: readonly string[];
  /** The human who asked for the action may not also approve it (author ≠ approver). */
  separateDuties?: boolean;
  /** How long an approval request stays decidable. Default: 7 days. */
  ttlMs?: number;
}

export interface Envelope {
  /** The agent this envelope belongs to — recorded on every request and audit line. */
  agent: string;
  /** Accounts the agent itself acts as. An approval from one of these is never an approval. */
  selfAccountIds: readonly string[];
  tools: Readonly<Record<string, ToolRule>>;
}

export interface Verdict {
  tier: Tier;
  rule?: ToolRule;
  /** Why, in words an audit reader (or the model) can act on. */
  reason: string;
}

export function evaluate(envelope: Envelope, tool: string): Verdict {
  const rule = envelope.tools[tool];
  if (!rule) return { tier: "deny", reason: `${envelope.agent} has no permission for ${tool}` };
  return { tier: rule.tier, rule, reason: `${envelope.agent} → ${tool}: ${rule.tier}` };
}

export interface Approver {
  accountId: string;
  name?: string;
}

/**
 * May this person approve this call? Pure, so every surface (Slack button, Jira comment,
 * board transition) asks the same question and gets the same answer.
 */
export function mayApprove(
  envelope: Envelope,
  rule: ToolRule,
  approver: Approver | undefined,
  requestedBy?: string,
): { ok: true } | { ok: false; reason: string } {
  // An approval nobody can attribute is not an approval: fail closed.
  if (!approver?.accountId) return { ok: false, reason: "the approver could not be identified" };
  if (envelope.selfAccountIds.includes(approver.accountId)) {
    return { ok: false, reason: "an agent cannot approve its own action" };
  }
  const anyone = rule.approvers?.includes("*") ?? false;
  if (!rule.approvers?.length) return { ok: false, reason: "no approvers are configured for this action" };
  if (!anyone && !rule.approvers.includes(approver.accountId)) {
    return { ok: false, reason: `${approver.name ?? approver.accountId} is not an approver for this action` };
  }
  if (rule.separateDuties && requestedBy && requestedBy === approver.accountId) {
    return { ok: false, reason: "the person who asked for this cannot also approve it" };
  }
  return { ok: true };
}
