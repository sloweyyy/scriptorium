import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Vault } from "@scriptorium/core";
import { fileGapNote } from "@scriptorium/curator";

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
