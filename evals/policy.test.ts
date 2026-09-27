import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ToolSpec } from "@scriptorium/core";
import {
  FileApprovalStore,
  executeApproved,
  MemoryApprovalStore,
  argsHash,
  decideApproval,
  guard,
  runUnderPolicy,
  type ApprovalChannel,
  type ApprovalRequest,
  type ApprovalStore,
  type Envelope,
} from "@scriptorium/policy";

/**
 * The policy layer (ADR-001 slice 1): one check on every tool call, and approvals that
 * belong to a named, authorized human and to the exact arguments they were shown.
 */

let tmpRoot: string;
let auditFile: string;
let runs: unknown[];
let posted: ApprovalRequest[];

const publish: ToolSpec = {
  name: "publish_doc",
  description: "Publish a doc",
  inputSchema: z.object({ slug: z.string(), markdown: z.string() }),
  run: async (input) => {
    runs.push(input);
    return "published";
  },
};
const search: ToolSpec = { ...publish, name: "search", run: async () => "results" };
const drop: ToolSpec = { ...publish, name: "delete_space", run: async () => "gone" };

const envelope: Envelope = {
  agent: "scribe",
  selfAccountIds: ["bot-1"],
  tools: {
    publish_doc: { tier: "approve", approvers: ["pm-1", "pm-2"], separateDuties: true },
    search: { tier: "allow" },
  },
};

const channel: ApprovalChannel = {
  post: async (request) => {
    posted.push(request);
  },
};

const DRAFT = { slug: "digest", markdown: "# Digest\n\nv1" };

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-policy-"));
  auditFile = path.join(tmpRoot, "audit.jsonl");
  runs = [];
  posted = [];
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function deps(store: ApprovalStore = new MemoryApprovalStore(), overrides: Partial<Parameters<typeof runUnderPolicy>[3]> = {}) {
  return { store, channel, auditFile, key: "jira:issue:DOC-1", requestedBy: "author-1", ...overrides };
}

describe("tiers", () => {
  it("runs an allow-tier tool, and never an unlisted one", async () => {
    const d = deps();
    expect((await runUnderPolicy(envelope, search, {}, d)).kind).toBe("ran");
    expect((await runUnderPolicy(envelope, drop, {}, d)).kind).toBe("denied");
  });

  it("does not run an approve-tier tool without an approval — it asks, once", async () => {
    const d = deps();
    const first = await runUnderPolicy(envelope, publish, DRAFT, d);
    const second = await runUnderPolicy(envelope, publish, DRAFT, d);
    expect(first.kind).toBe("pending");
    expect(second.kind).toBe("pending");
    expect(runs).toHaveLength(0);
    // The same action asked for twice is one card, not two.
    expect(posted).toHaveLength(1);
  });

  it("does not run when the approval request could not be shown to anyone", async () => {
    const broken: ApprovalChannel = { post: async () => { throw new Error("slack is down"); } };
    const outcome = await runUnderPolicy(envelope, publish, DRAFT, deps(undefined, { channel: broken }));
    expect(outcome.kind).toBe("unavailable");
    expect(runs).toHaveLength(0);
  });
});

describe("approvals", () => {
  async function pending(store: ApprovalStore = new MemoryApprovalStore()) {
    const outcome = await runUnderPolicy(envelope, publish, DRAFT, deps(store));
    if (outcome.kind !== "pending") throw new Error("expected a pending request");
    return { store, request: outcome.request };
  }

  it("runs exactly once per approval from an allowed human", async () => {
    const { store, request } = await pending();
    const decided = await decideApproval(store, envelope, request.id, "approved", { accountId: "pm-1", name: "Pat" });
    expect(decided.ok).toBe(true);

    expect((await runUnderPolicy(envelope, publish, DRAFT, deps(store))).kind).toBe("ran");
    // Spent: a second call needs a second approval.
    expect((await runUnderPolicy(envelope, publish, DRAFT, deps(store))).kind).toBe("pending");
    expect(runs).toHaveLength(1);

    const lines = (await fs.readFile(auditFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.find((line) => line.type === "policy.ran")).toMatchObject({ approvedBy: "pm-1", approval: request.id });
  });

  it("an approval never covers different arguments — a revised draft needs its own", async () => {
    const { store, request } = await pending();
    await decideApproval(store, envelope, request.id, "approved", { accountId: "pm-1" });
    const revised = { ...DRAFT, markdown: "# Digest\n\nv2 — revised after the approval" };
    expect((await runUnderPolicy(envelope, publish, revised, deps(store))).kind).toBe("pending");
    expect(runs).toHaveLength(0);
  });

  it("refuses approvers who are not on the list, the agent itself, the requester, or nobody", async () => {
    const { store, request } = await pending();
    for (const approver of [{ accountId: "stranger" }, { accountId: "bot-1" }, undefined]) {
      expect((await decideApproval(store, envelope, request.id, "approved", approver)).ok).toBe(false);
    }
    // With no approver list, "any human" still excludes the agent and the requester.
    const loose: Envelope = { ...envelope, tools: { publish_doc: { tier: "approve", separateDuties: true } } };
    expect((await decideApproval(store, loose, request.id, "approved", { accountId: "bot-1" })).ok).toBe(false);
    expect((await decideApproval(store, loose, request.id, "approved", { accountId: "author-1" })).ok).toBe(false);
    expect((await runUnderPolicy(envelope, publish, DRAFT, deps(store))).kind).toBe("pending");
  });

  it("a rejected or expired request cannot be revived", async () => {
    const { store, request } = await pending();
    await decideApproval(store, envelope, request.id, "rejected", { accountId: "pm-1" });
    expect((await decideApproval(store, envelope, request.id, "approved", { accountId: "pm-2" })).ok).toBe(false);

    const next = await pending();
    const later = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect((await decideApproval(next.store, envelope, next.request.id, "approved", { accountId: "pm-1" }, later)).ok).toBe(false);
  });

  it("survives a restart when stored on disk", async () => {
    const file = path.join(tmpRoot, "approvals.json");
    const { request } = await pending(new FileApprovalStore(file));
    const reopened = new FileApprovalStore(file);
    expect((await decideApproval(reopened, envelope, request.id, "approved", { accountId: "pm-2" })).ok).toBe(true);
    expect((await runUnderPolicy(envelope, publish, DRAFT, deps(new FileApprovalStore(file)))).kind).toBe("ran");
  });

  it("hashes arguments independently of key order", () => {
    expect(argsHash({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(argsHash({ b: [1, { d: 3, c: 2 }], a: 1 }));
    expect(argsHash({ a: 1 })).not.toBe(argsHash({ a: 2 }));
  });
});

describe("guard, as a model sees it", () => {
  it("tells the model the action has not happened, and never reaches run()", async () => {
    const guarded = guard(envelope, publish, deps());
    expect(await guarded.run(DRAFT)).toMatch(/^APPROVAL_PENDING: .*NOT been done/);
    expect(await guard(envelope, drop, deps()).run({})).toMatch(/^DENIED:/);
    expect(runs).toHaveLength(0);
  });
});

describe("carrying out an approval", () => {
  it("runs the stored arguments once when approved, and nothing before or after", async () => {
    const store = new MemoryApprovalStore();
    const outcome = await runUnderPolicy(envelope, publish, DRAFT, deps(store));
    if (outcome.kind !== "pending") throw new Error("expected pending");
    expect((await executeApproved(envelope, [publish], outcome.request.id, deps(store))).kind).toBe("not-runnable");

    await decideApproval(store, envelope, outcome.request.id, "approved", { accountId: "pm-1" });
    expect((await executeApproved(envelope, [publish], outcome.request.id, deps(store))).kind).toBe("ran");
    expect(runs).toEqual([DRAFT]);
    expect((await executeApproved(envelope, [publish], outcome.request.id, deps(store))).kind).toBe("not-runnable");
    expect(runs).toHaveLength(1);
  });

  it("will not carry out another agent's approval", async () => {
    const store = new MemoryApprovalStore();
    const outcome = await runUnderPolicy(envelope, publish, DRAFT, deps(store));
    if (outcome.kind !== "pending") throw new Error("expected pending");
    await decideApproval(store, envelope, outcome.request.id, "approved", { accountId: "pm-1" });
    const other: Envelope = { ...envelope, agent: "curator" };
    expect((await executeApproved(other, [publish], outcome.request.id, deps(store))).kind).toBe("not-runnable");
  });
});

describe("what the approver reads", () => {
  it("one readable, capped line per argument — the full arguments still bind the approval", async () => {
    const { summarizeArgs } = await import("@scriptorium/policy");
    const body = `# Digest\n\n${"x".repeat(5_000)}`;
    const summary = summarizeArgs({ space: "BEACON", title: "Digest emails", markdown: body });
    expect(summary).toContain("• space: BEACON");
    expect(summary).toContain("• title: Digest emails");
    expect(summary).toMatch(/• markdown: # Digest x+… \(\+\d+ chars\)/);
    expect(summary.length).toBeLessThan(2_500);
    // Truncation is display only: a different body is a different action.
    expect(argsHash({ markdown: body })).not.toBe(argsHash({ markdown: `${body}y` }));
  });
});

describe("concurrency", () => {
  it("two approvers clicking at once decide once, and the tool runs once", async () => {
    const store = new FileApprovalStore(path.join(tmpRoot, "race.json"));
    const pending = await runUnderPolicy(envelope, publish, DRAFT, deps(store));
    if (pending.kind !== "pending") throw new Error("expected pending");
    const click = async (who: string) => {
      const decided = await decideApproval(store, envelope, pending.request.id, "approved", { accountId: who });
      if (decided.ok) await executeApproved(envelope, [publish], pending.request.id, deps(store));
      return decided.ok;
    };
    const results = await Promise.all([click("pm-1"), click("pm-2")]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(runs).toHaveLength(1);
  });

  it("concurrent saves to the file store lose nothing", async () => {
    const store = new FileApprovalStore(path.join(tmpRoot, "many.json"));
    const base = { agent: "scribe", tool: "publish_doc", argsHash: "h", summary: "", key: "k", requestedAt: "", expiresAt: "2099-01-01", status: "pending" as const };
    await Promise.all([1, 2, 3, 4, 5].map((n) => store.save({ ...base, id: `r${n}` })));
    expect(await store.all()).toHaveLength(5);
  });
});
