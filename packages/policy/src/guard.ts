import { audit, type ToolSpec } from "@scriptorium/core";
import { consumeApproval, requestApproval, restoreApproval, type ApprovalRequest, type ApprovalStore } from "./approvals";
import { evaluate, type Envelope } from "./policy";

/**
 * Where an approval request is shown to a human — a Slack card, a Jira comment. It must
 * throw when it could not post: a request nobody can see cannot be approved, and the tool
 * must not run on the assumption that someone will (ADR-001, invariant 2).
 */
export interface ApprovalChannel {
  post(request: ApprovalRequest): Promise<void>;
}

export interface GuardDeps {
  store: ApprovalStore;
  channel: ApprovalChannel;
  auditFile: string;
  /** Correlation key of the conversation the call happens in — where the card goes. */
  key: string;
  /** The human whose message caused this call, for separation of duties. */
  requestedBy?: string;
  /** One line describing the call for the card. Defaults to the tool name and args. */
  summarize?: (tool: string, input: unknown) => string;
  /** When carrying out a specific approval: spend that request, not any with equal args. */
  approvalId?: string;
}

/**
 * What an approver reads on the card: one line per argument, each capped. Raw JSON buried a
 * page body's first line under escapes, and a long one pushed the card past Slack's block
 * limit — a card that cannot be posted cannot be approved. The cap never changes what runs:
 * the approval is bound to the full arguments by hash, and the card shows that hash.
 */
export function summarizeArgs(input: unknown, perField = 400, total = 2_400): string {
  const entries = input && typeof input === "object" && !Array.isArray(input) ? Object.entries(input as Record<string, unknown>) : [["input", input] as const];
  const lines = entries.map(([key, value]) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    const oneLine = (text ?? "").replace(/\s+/g, " ").trim();
    return `• ${key}: ${oneLine.length > perField ? `${oneLine.slice(0, perField)}… (+${oneLine.length - perField} chars)` : oneLine}`;
  });
  const joined = lines.join("\n");
  return joined.length > total ? `${joined.slice(0, total)}…` : joined;
}

export type Outcome =
  | { kind: "ran"; result: string; approval?: ApprovalRequest }
  | { kind: "denied"; reason: string }
  | { kind: "pending"; request: ApprovalRequest }
  | { kind: "unavailable"; reason: string };

/**
 * Run a tool under policy. The one function every connector call goes through.
 *
 * - `deny`    → never runs.
 * - `allow`   → runs.
 * - `approve` → runs only by spending an approval for these exact arguments; otherwise
 *               files (or reuses) a request, posts it, and does not run.
 */
export async function runUnderPolicy(envelope: Envelope, tool: ToolSpec, input: unknown, deps: GuardDeps): Promise<Outcome> {
  const verdict = evaluate(envelope, tool.name);
  const base = { actor: envelope.agent, tool: tool.name, key: deps.key };

  if (verdict.tier === "deny") {
    await audit(deps.auditFile, { type: "policy.denied", ...base, reason: verdict.reason });
    return { kind: "denied", reason: verdict.reason };
  }

  if (verdict.tier === "allow") {
    const result = await tool.run(input);
    await audit(deps.auditFile, { type: "policy.ran", ...base, tier: "allow" });
    return { kind: "ran", result };
  }

  const approval = await consumeApproval(deps.store, { agent: envelope.agent, tool: tool.name, args: input, requestId: deps.approvalId });
  if (approval) {
    let result: string;
    try {
      result = await tool.run(input, { approval: { id: approval.id, approvedBy: approval.decidedBy?.name ?? approval.decidedBy?.accountId } });
    } catch (error) {
      await restoreApproval(deps.store, approval.id);
      await audit(deps.auditFile, { type: "policy.run.failed", ...base, approval: approval.id, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    await audit(deps.auditFile, { type: "policy.ran", ...base, tier: "approve", approval: approval.id, approvedBy: approval.decidedBy?.accountId });
    return { kind: "ran", result, approval };
  }

  const { request, created } = await requestApproval(deps.store, {
    agent: envelope.agent,
    tool: tool.name,
    args: input,
    summary: deps.summarize?.(tool.name, input) ?? summarizeArgs(input),
    key: deps.key,
    requestedBy: deps.requestedBy,
    rule: verdict.rule ?? { tier: "approve" },
  });
  // Already on the card it was first posted to: asking again is not a second card.
  if (!created) return { kind: "pending", request };
  try {
    await deps.channel.post(request);
  } catch (error) {
    const reason = `could not post the approval request: ${error instanceof Error ? error.message : String(error)}`;
    await audit(deps.auditFile, { type: "policy.approval.unavailable", ...base, approval: request.id, reason });
    return { kind: "unavailable", reason };
  }
  await audit(deps.auditFile, { type: "policy.approval.requested", ...base, approval: request.id });
  return { kind: "pending", request };
}

/**
 * The same check, as a `ToolSpec` a model loop can hold. The model sees a plain-language
 * outcome; it can never reach the underlying `run` any other way.
 */
export function guard(envelope: Envelope, tool: ToolSpec, deps: GuardDeps): ToolSpec {
  return {
    ...tool,
    run: async (input) => {
      const outcome = await runUnderPolicy(envelope, tool, input, deps);
      switch (outcome.kind) {
        case "ran":
          return outcome.result;
        case "denied":
          return `DENIED: ${outcome.reason}. Do not retry; tell the user you are not permitted to do this.`;
        case "pending":
          return `APPROVAL_PENDING: a human must approve this (request ${outcome.request.id}). It has NOT been done. Tell the user it is waiting for approval.`;
        case "unavailable":
          return `NOT_DONE: ${outcome.reason}. It has NOT been done.`;
      }
    },
  };
}

/**
 * Carry out an approved request, now. The agent that asked finished its turn when it got
 * APPROVAL_PENDING; the approval arrives later, from a human, on a card. This runs the same
 * tool with the stored arguments, through `runUnderPolicy`, so it spends that approval,
 * exactly once, and is audited like any other call. Anything but a live approved request
 * for a tool this envelope still holds is a no-op with a reason.
 */
export async function executeApproved(
  envelope: Envelope,
  tools: readonly ToolSpec[],
  requestId: string,
  deps: GuardDeps,
): Promise<Outcome | { kind: "not-runnable"; reason: string }> {
  const request = (await deps.store.all()).find((candidate) => candidate.id === requestId);
  if (!request || request.status !== "approved") return { kind: "not-runnable", reason: `request ${requestId} is not an approved, unspent request` };
  if (request.agent !== envelope.agent) return { kind: "not-runnable", reason: `request ${requestId} belongs to ${request.agent}` };
  const tool = tools.find((candidate) => candidate.name === request.tool);
  if (!tool) return { kind: "not-runnable", reason: `no tool ${request.tool} on this host` };
  const outcome = await runUnderPolicy(envelope, tool, request.args, { ...deps, key: request.key, requestedBy: request.requestedBy, approvalId: request.id });
  // Carrying out an approval must never turn into asking for a new one.
  if (outcome.kind === "pending") return { kind: "not-runnable", reason: `request ${requestId} could not be spent` };
  return outcome;
}
