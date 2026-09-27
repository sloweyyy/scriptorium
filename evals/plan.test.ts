import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ToolRunContext, ToolSpec } from "@scriptorium/core";
import { MemoryApprovalStore, PLAN_TOOL, checkPlan, decideApproval, executeApproved, planTool, runUnderPolicy, type ApprovalRequest, type Envelope } from "@scriptorium/policy";
import { MemoryEffectLedger, once, opKey } from "@scriptorium/runtime";

/**
 * One approval for a multi-step plan: bound to the exact ordered steps, never wider than
 * what approving each step would have been, each step exactly-once, a refusal stops it.
 */

const write = { tier: "approve" as const, approvers: ["slack:UPM"], separateDuties: true };
const envelope: Envelope = {
  agent: "Teammate",
  selfAccountIds: ["slack:UBOT"],
  tools: { jira_create_issue: write, jira_labels: write, memory_save: { ...write, separateDuties: false }, [PLAN_TOOL]: write },
};

let created: string[];
let failNext: boolean;
const ledger = new MemoryEffectLedger();
const createIssue: ToolSpec = {
  name: "jira_create_issue",
  description: "",
  inputSchema: z.object({ summary: z.string().min(1) }),
  run: async (input: unknown, context?: ToolRunContext) => {
    const { summary } = input as { summary: string };
    if (summary === "refuse me") return "NOT_ALLOWED: HR is outside the Jira projects this agent may use.";
    const { result } = await once(ledger, opKey("create", summary, context?.approval?.id), async () => {
      if (failNext) {
        failNext = false;
        throw new Error("Jira 503");
      }
      created.push(summary);
      return `DOC-${created.length}`;
    });
    return `Created jira:${result}`;
  },
};
const labels: ToolSpec = { name: "jira_labels", description: "", inputSchema: z.object({ key: z.string() }), run: async () => "Labels changed." };
const memory: ToolSpec = { name: "memory_save", description: "", inputSchema: z.object({ text: z.string() }), run: async () => "Remembered." };
const tools = [createIssue, labels, memory];
const plan = planTool(envelope, tools);

let auditFile: string;
beforeEach(async () => {
  created = [];
  failNext = false;
  auditFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-plan-")), "audit.jsonl");
});
afterEach(async () => fs.rm(path.dirname(auditFile), { recursive: true, force: true }));

const steps = (...summaries: string[]) => ({ title: "Meeting follow-ups", steps: summaries.map((summary) => ({ tool: "jira_create_issue", args: { summary } })) });

describe("a plan's card", () => {
  it("shows every step's every argument — a comment body in step 3 is not hidden behind step 1", async () => {
    const { summarizePlan } = await import("@scriptorium/policy");
    const summary = summarizePlan({
      title: "t",
      steps: [
        { tool: "jira_create_issue", args: { summary: "A", description: "x".repeat(600) } },
        { tool: "jira_labels", args: { key: "DOC-1" } },
        { tool: "jira_comment", args: { key: "DOC-1", body: "HIDDEN-PAYLOAD <https://evil.example|docs>" } },
      ],
    });
    expect(summary).toContain("Step 3 · jira_comment");
    expect(summary).toContain("HIDDEN-PAYLOAD <https://evil.example|docs>");
  });

  it("a plan too long for one card is refused, never cut", () => {
    const long = { title: "t", steps: Array.from({ length: 10 }, (_, i) => ({ tool: "jira_create_issue", args: { summary: `${"&".repeat(300)} ${i}` } })) };
    expect(checkPlan(envelope, tools, long)).toMatch(/too long to show on one approval card/);
  });
});

describe("a plan", () => {
  it("is refused before a card when a step needs a different approval, doesn't exist, nests, or has bad arguments", () => {
    expect(checkPlan(envelope, tools, steps("A", "B"))).toBeUndefined();
    expect(checkPlan(envelope, tools, { title: "x", steps: [{ tool: "jira_create_issue", args: { summary: "A" } }, { tool: "memory_save", args: { text: "y" } }] })).toMatch(/needs its own approval/);
    expect(checkPlan(envelope, tools, { title: "x", steps: [{ tool: "jira_create_issue", args: { summary: "A" } }, { tool: "delete_space", args: {} }] })).toMatch(/isn't available/);
    expect(checkPlan(envelope, tools, { title: "x", steps: [{ tool: PLAN_TOOL, args: {} }, { tool: "jira_labels", args: { key: "DOC-1" } }] })).toMatch(/don't nest/);
    expect(checkPlan(envelope, tools, { title: "x", steps: [{ tool: "jira_create_issue", args: {} }, { tool: "jira_labels", args: { key: "DOC-1" } }] })).toMatch(/arguments/);
    expect(checkPlan(envelope, tools, steps("only one"))).toMatch(/2 to 10 steps/);
  });

  it("runs only after approval, exactly the approved steps, each once — and resumes after a failure", async () => {
    const store = new MemoryApprovalStore();
    const cards: ApprovalRequest[] = [];
    const deps = { store, channel: { post: async (request: ApprovalRequest) => void cards.push(request) }, auditFile, key: "slack:thread:C1/1.0", requestedBy: "slack:U1" };
    expect((await runUnderPolicy(envelope, plan, steps("A", "B", "C"), deps)).kind).toBe("pending");
    expect(created).toEqual([]);
    const request = cards[0]!;
    // The card a person approves from lists every step, not the plan cut as one field.
    expect(request.summary).toContain("Step 3 · jira_create_issue");
    expect(request.summary).toContain("• summary: C");
    expect((await decideApproval(store, envelope, request.id, "approved", { accountId: "slack:UPM" })).ok).toBe(true);

    // Step 2 fails once: the approval is given back; step 1 is not done twice on the retry.
    let calls = 0;
    const flaky = planTool(envelope, [{ ...createIssue, run: async (input, context) => (++calls === 2 && (failNext = true), createIssue.run(input, context)) }, labels, memory]);
    // Step 1 landed before step 2 failed: the error says so, for "nothing was changed" would be false.
    await expect(executeApproved(envelope, [flaky], request.id, deps)).rejects.toThrow("PARTIAL: 1 of 3 steps done before step 2 failed.");
    const outcome = await executeApproved(envelope, [flaky], request.id, deps);
    expect(outcome.kind).toBe("ran");
    expect(created).toEqual(["A", "B", "C"]);
    expect((outcome as { result: string }).result.split("\n")).toEqual(["Plan “Meeting follow-ups”: all 3 steps done.", "1. Created jira:DOC-1", "2. Created jira:DOC-2", "3. Created jira:DOC-3"]);
  });

  it("stops at a refusal, and says what was and wasn't done", async () => {
    const partial = await plan.run(steps("A", "refuse me", "C"), { approval: { id: "ap-1" } });
    expect(partial.split("\n")[0]).toBe("PARTIAL: plan “Meeting follow-ups”: 1 of 3 steps done; step 2 was refused (HR is outside the Jira projects this agent may use.), so nothing after it was run.");
    expect(created).toEqual(["A"]);
    expect(await plan.run(steps("refuse me", "A"), { approval: { id: "ap-2" } })).toMatch(/^NOT_ALLOWED: plan “Meeting follow-ups” stopped at step 1/);
  });
});
