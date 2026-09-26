import { audit, type ToolSpec } from "@scriptorium/core";
import { consumeApproval, requestApproval, type ApprovalRequest, type ApprovalStore } from "./approvals";
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

  const approval = await consumeApproval(deps.store, { agent: envelope.agent, tool: tool.name, args: input });
  if (approval) {
    const result = await tool.run(input);
    await audit(deps.auditFile, { type: "policy.ran", ...base, tier: "approve", approval: approval.id, approvedBy: approval.decidedBy?.accountId });
    return { kind: "ran", result, approval };
  }

  const { request, created } = await requestApproval(deps.store, {
    agent: envelope.agent,
    tool: tool.name,
    args: input,
    summary: deps.summarize?.(tool.name, input) ?? `${tool.name} ${JSON.stringify(input)}`,
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
