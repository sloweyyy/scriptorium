import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Vault } from "@scriptorium/core";
import { fileGapNote, nextGapId } from "@scriptorium/curator";

let vault: Vault;
let tmpRoot: string;
let auditFile: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-gaps-"));
  vault = new Vault(path.join(tmpRoot, "vault"));
  auditFile = path.join(tmpRoot, "audit.jsonl");
  await vault.ensure();
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("cross-surface loop", () => {
  it("turns an unanswered Slack question into a ticket on Agent A's board", async () => {
    const result = await fileGapNote(vault, {
      question: "How do I export the audit log?",
      missing: "No documentation covers audit log export.",
      askedBy: "U123",
      auditFile,
      openTicket: async (gap) => {
        expect(gap.relPath).toMatch(/^_gaps\/G-\d{3}-/);
        return { key: "DOC-42", url: "https://example.atlassian.net/browse/DOC-42" };
      },
    });

    expect(result.ticket?.key).toBe("DOC-42");
    const note = await vault.readNote(result.relPath);
    expect(note.frontmatter.jira_key).toBe("DOC-42");
    expect(note.frontmatter.status).toBe("queued");

    const log = await fs.readFile(auditFile, "utf8");
    expect(log).toContain('"type":"gap.filed"');
    expect(log).toContain('"type":"gap.ticketed"');
  });

  it("still records the gap when ticketing is down", async () => {
    const result = await fileGapNote(vault, {
      question: "What are the retention limits?",
      missing: "Retention limits are undocumented.",
      askedBy: "U456",
      auditFile,
      openTicket: async () => {
        throw new Error("jira unreachable");
      },
    });

    expect(result.ticket).toBeUndefined();
    const note = await vault.readNote(result.relPath);
    expect(note.frontmatter.status).toBe("open");
    expect(note.body).toContain("What are the retention limits?");

    const moc = await vault.readNote("index.md");
    expect(moc.body).toContain(result.relPath.replace(/\.md$/, ""));
  });
});

/**
 * Durability and identity — the two things a gap note needs to still mean something
 * tomorrow. Both were found by watching the live system rather than reading the code:
 * two gaps filed through Slack, both gone at the next deploy, one of them a real gap whose
 * Jira ticket still pointed at a note that no longer existed.
 */
describe("a gap note that outlives its container", () => {
  it("hands the finished note to the caller to make durable", async () => {
    const persisted: string[] = [];
    const result = await fileGapNote(vault, {
      question: "Does Beacon support SCIM provisioning?",
      missing: "nothing about SCIM",
      askedBy: "U1",
      auditFile,
      openTicket: async () => ({ key: "DOC-28", url: "https://example.invalid/browse/DOC-28" }),
      persist: async (relPath) => {
        // Called last, so what gets pushed already carries the ticket link.
        const note = await vault.readNote(relPath);
        expect(note.frontmatter.jira_key).toBe("DOC-28");
        persisted.push(relPath);
      },
    });
    expect(persisted).toEqual([result.relPath]);
  });

  it("still files the gap when it cannot be made durable", async () => {
    const result = await fileGapNote(vault, {
      question: "Does Beacon support SCIM provisioning?",
      missing: "nothing about SCIM",
      askedBy: "U1",
      auditFile,
      persist: async () => { throw new Error("remote unreachable"); },
    });
    // The note and its ticket are the product; durability is best-effort around them.
    expect(await vault.exists(result.relPath)).toBe(true);
  });

  it("numbers past the highest id on disk, not off the count", async () => {
    // Exactly the live shape: G-003 and G-004 were filed and then lost, which put a
    // count-based counter back onto a number a Jira ticket already pointed at.
    await vault.writeNote("_gaps/G-001-first.md", "one", { id: "G-001", kind: "gap" });
    await vault.writeNote("_gaps/G-007-much-later.md", "seven", { id: "G-007", kind: "gap" });

    expect(await nextGapId(vault)).toBe("G-008");
    const filed = await fileGapNote(vault, { question: "A brand new question?", missing: "nothing", askedBy: "U1", auditFile });
    expect(filed.relPath).toContain("G-008");
  });

  it("starts at G-001 in an empty vault", async () => {
    expect(await nextGapId(vault)).toBe("G-001");
  });
});

describe("the same gap, asked twice", () => {
  it("files one note and one ticket, and records who else asked", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const { Vault } = await import("@scriptorium/core");
    const { fileGapNote } = await import("@scriptorium/curator");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-gapdup-"));
    const vault = new Vault(root);
    await vault.ensure();
    const tickets: string[] = [];
    const openTicket = async () => (tickets.push("DOC-9"), { key: "DOC-9", url: "https://x/DOC-9" });
    const auditFile = path.join(root, "audit.jsonl");

    const first = await fileGapNote(vault, { question: "Does Beacon support SSO?", missing: "SSO", askedBy: "U1", auditFile, openTicket });
    const again = await fileGapNote(vault, { question: "does beacon support SSO", missing: "SSO", askedBy: "U2", auditFile, openTicket });
    expect(again).toMatchObject({ relPath: first.relPath, duplicate: true, ticket: { key: "DOC-9" } });
    expect(await vault.listNotes("_gaps")).toHaveLength(1);
    expect(tickets).toHaveLength(1);
    expect((await vault.readNote(first.relPath)).frontmatter.also_asked_by).toEqual(["U2"]);

    // A different question is a different gap.
    await fileGapNote(vault, { question: "Can I export incidents as CSV?", missing: "export", askedBy: "U1", auditFile, openTicket });
    expect(await vault.listNotes("_gaps")).toHaveLength(2);
    await fs.rm(root, { recursive: true, force: true });
  });
});
