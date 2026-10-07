import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Vault, audit, eraseFromAudit, verifyAudit, type AppConfig } from "@scriptorium/core";
import { FileApprovalStore, type ApprovalRequest } from "@scriptorium/policy";
import { eraseSubject, readControl, subjectIds, writeControl } from "@scriptorium/agents";

/**
 * Erasing a person on request: what they said and what was kept about them goes; the chain,
 * everyone else's lines and who approved a write stay.
 */
let root: string;
let auditFile: string;
let vault: Vault;
const KEY = "k".repeat(64);

function config(): AppConfig {
  return {
    auditFile,
    signingKey: KEY,
    jira: { stateDir: path.join(root, "state") },
    teammate: { people: [["slack:UALICE", "jira:5b10alice", "github:alice-dev"]] },
  } as unknown as AppConfig;
}

const lines = async () => (await fs.readFile(auditFile, "utf8")).split("\n").filter(Boolean);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-erase-"));
  auditFile = path.join(root, "state", "audit.jsonl");
  vault = new Vault(path.join(root, "vault"));
  await vault.ensure();
  await audit(auditFile, { type: "teammate.answer", actor: "teammate", askedBy: "UALICE", question: "is my performance review in Confluence?", channel: "C1" });
  await audit(auditFile, { type: "teammate.answer", actor: "teammate", askedBy: "UBOB", question: "when is the digest sent?", channel: "C1" });
  await audit(auditFile, { type: "teammate.feedback", actor: "teammate", channel: "C1", message: "9.1", by: "UALICE", reaction: "-1" });
  await audit(auditFile, { type: "jira.comment", actor: "teammate", author: "5b10alice", issueKey: "DOC-1" });
  // Alice approved Bob's write: that stays.
  await audit(auditFile, { type: "policy.ran", actor: "teammate", tool: "jira_create_issue", tier: "approve", approval: "A1", approvedBy: "UALICE" });
  await audit(auditFile, { type: "llm.usage", actor: "teammate", scope: "C1", input: 100, output: 20 });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
});

describe("privacy erase: the audit log", () => {
  it("replaces every line about them with a tombstone, leaves everyone else's byte-identical, and the chain holds", async () => {
    const before = await lines();
    const erased = eraseFromAudit(before.join("\n"), subjectIds("UALICE", config().teammate.people));
    expect(erased).toMatchObject({ redacted: 3, approvals: 1 });
    const after = erased.text.split("\n");
    expect(after).toHaveLength(before.length);
    // Bob's question, Alice's approval of a write, and the usage line are untouched.
    for (const index of [1, 4, 5]) expect(after[index]).toBe(before[index]);
    expect(erased.text).not.toMatch(/performance review|UALICE.*question|5b10alice/);
    expect(after[4]).toContain('"approvedBy":"UALICE"');
    expect(JSON.parse(after[0] as string)).toMatchObject({ type: "teammate.answer", actor: "teammate", redacted: true });

    // Without its privacy.erased record, an erased line is unaccounted for.
    expect(verifyAudit(erased.text)).toMatchObject({ ok: false, reason: expect.stringContaining("no privacy.erased record") });
    await fs.writeFile(auditFile, `${erased.text}\n`);
    await audit(auditFile, { type: "privacy.erased", by: "ops", lines: erased.redacted });
    expect(verifyAudit(await fs.readFile(auditFile, "utf8"))).toMatchObject({ ok: true, redacted: 3 });
    // New lines still chain onto the tombstoned log.
    await audit(auditFile, { type: "teammate.answer", askedBy: "UBOB" });
    expect(verifyAudit(await fs.readFile(auditFile, "utf8")).ok).toBe(true);
  });

  it("still finds an edit to any other line, and a tombstone that doesn't follow the line before it", async () => {
    const erased = eraseFromAudit((await lines()).join("\n"), ["UALICE"]);
    const record = (text: string) => `${text}\n${JSON.stringify({ ts: "t", type: "privacy.erased", lines: 99 })}`;
    const edited = erased.text.replace("when is the digest sent?", "when is the digest sent?!");
    expect(verifyAudit(record(edited)).ok).toBe(false);
    const rows = erased.text.split("\n");
    const tomb = JSON.parse(rows[0] as string) as Record<string, unknown>;
    rows[0] = JSON.stringify({ ...tomb, prev: "0".repeat(64) });
    expect(verifyAudit(record(rows.join("\n")))).toMatchObject({ ok: false, line: 1 });
  });

  it("a tombstone edited after the erasure is found: its record names every tombstone it wrote", async () => {
    const { appendAuditLine } = await import("@scriptorium/core");
    const erased = eraseFromAudit((await lines()).join("\n"), subjectIds("UALICE", config().teammate.people));
    const logged = appendAuditLine(erased.text, { type: "privacy.erased", by: "ops", lines: erased.redacted, tombstones: erased.tombstones });
    expect(verifyAudit(logged)).toMatchObject({ ok: true, redacted: 3 });
    // Change who the kept fields say did it, on a tombstone: nothing else moves.
    const rows = logged.split("\n");
    const index = rows.findIndex((row) => row.includes('"redacted":true'));
    rows[index] = (rows[index] as string).replace('"actor":"teammate"', '"actor":"someone-else"');
    expect(verifyAudit(rows.join("\n"))).toMatchObject({ ok: false, line: index + 1, reason: expect.stringContaining("edited after it was erased") });
  });

  it("erasing the operator who ran an erasure keeps that erasure's record, so the log still verifies", async () => {
    const { appendAuditLine } = await import("@scriptorium/core");
    const erased = eraseFromAudit((await lines()).join("\n"), ["UALICE"]);
    const logged = appendAuditLine(erased.text, { type: "privacy.erased", by: "UOPS", lines: erased.redacted, tombstones: erased.tombstones });
    const again = eraseFromAudit(logged, ["UOPS"]);
    expect(again.redacted).toBe(0);
    expect(verifyAudit(appendAuditLine(again.text, { type: "privacy.erased", by: "UOTHER", lines: 0, tombstones: [] })).ok).toBe(true);
  });
});

describe("privacy erase: the whole deployment", () => {
  it("dry run changes nothing and reports the plan", async () => {
    const before = await fs.readFile(auditFile, "utf8");
    const plan = await eraseSubject(config(), vault, "UALICE", { by: "ops", dryRun: true });
    expect(plan).toMatchObject({ ids: ["5b10alice", "UALICE", "alice-dev"], auditLines: 3, approvalsKept: 1 });
    expect(await fs.readFile(auditFile, "utf8")).toBe(before);
  });

  it("deletes memories about them, cancels their pending requests, ends their delegations, and records it", async () => {
    await vault.writeNote("_memory/M-00000001.md", "Alice prefers Friday demos.", { id: "M-00000001", scope: "person:slack:UALICE", status: "approved" });
    await vault.writeNote("_memory/M-00000002.md", "The team demos on Fridays.", { id: "M-00000002", scope: "channel:C1", status: "approved", approved_by: "UALICE" });
    await vault.writeNote("docs/guide.md", "Written with help from UALICE.", { kind: "doc" });
    const store = new FileApprovalStore(path.join(root, "state", "approvals.json"));
    const request = (id: string, status: ApprovalRequest["status"], requestedBy: string): ApprovalRequest => ({
      id, agent: "teammate", tool: "jira_create_issue", argsHash: "h", summary: "s", key: "k", requestedBy, requestedAt: "2026-09-28T00:00:00Z", expiresAt: "2026-10-05T00:00:00Z", status,
    });
    await store.save(request("R1", "pending", "slack:UALICE"));
    await store.save(request("R2", "consumed", "slack:UALICE"));
    await store.save(request("R3", "pending", "slack:UBOB"));
    const controlFile = path.join(root, "state", "control.json");
    await writeControl(controlFile, { paused: false, readOnly: false, denyTools: [], delegations: [{ from: "UPM", to: "UALICE", until: "2026-12-01T00:00:00Z" }, { from: "UPM", to: "UBOB", until: "2026-12-01T00:00:00Z" }] }, KEY);

    const plan = await eraseSubject(config(), vault, "slack:UALICE", { by: "ops" });
    expect(plan).toMatchObject({ memories: ["_memory/M-00000001.md"], pendingCancelled: ["R1"], requestsPseudonymized: 2, delegations: 1, mentions: ["_memory/M-00000002.md", "docs/guide.md"] });
    expect(await vault.exists("_memory/M-00000001.md")).toBe(false);
    expect(await vault.exists("_memory/M-00000002.md")).toBe(true); // only approved by her: an approval record
    const requests = Object.fromEntries((await store.all()).map((entry) => [entry.id, entry]));
    expect(requests.R1).toMatchObject({ status: "expired", requestedBy: plan.pseudonym });
    expect(requests.R2).toMatchObject({ status: "consumed", requestedBy: plan.pseudonym });
    expect(requests.R3).toMatchObject({ status: "pending", requestedBy: "slack:UBOB" });
    // Still signed, still honoured, and only Bob's delegation left.
    const control = await readControl(controlFile, KEY);
    expect(control.paused).toBe(false);
    expect(control.delegations).toEqual([{ from: "UPM", to: "UBOB", until: "2026-12-01T00:00:00Z" }]);

    const text = await fs.readFile(auditFile, "utf8");
    expect(verifyAudit(text)).toMatchObject({ ok: true, redacted: 3 });
    const record = JSON.parse(text.trim().split("\n").at(-1) as string);
    expect(record).toMatchObject({ type: "privacy.erased", by: "ops", lines: 3, memories: 1, requests: 2, delegations: 1 });
    expect(JSON.stringify(record)).not.toContain("UALICE");
  });

  it("stops without writing if the log grows while it runs", async () => {
    const config_ = config();
    const growing = { ...config_, jira: { stateDir: path.join(root, "state") } } as AppConfig;
    // Append between the plan's read and the write: simulate by racing an append on the first readdir of the vault.
    const original = vault.listNotes.bind(vault);
    let raced = false;
    vault.listNotes = async (dir?: string) => {
      if (!raced) {
        raced = true;
        await audit(auditFile, { type: "teammate.answer", askedBy: "UBOB" });
      }
      return original(dir);
    };
    const before = (await lines()).length;
    await expect(eraseSubject(growing, vault, "UALICE", { by: "ops" })).rejects.toThrow(/changed while erasing/);
    const after = await lines();
    expect(after).toHaveLength(before + 1);
    expect(after.join("\n")).toContain("performance review");
  });
});
