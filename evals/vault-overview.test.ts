import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Vault } from "@scriptorium/core";
import { QA_SYSTEM_PROMPT, qaTools } from "@scriptorium/curator";
import { buildIndex } from "@scriptorium/curator";

/**
 * The librarian's answer about its own shelves.
 *
 * Full-text search cannot answer "how many docs do you have?", and asking the model to
 * infer it from the index note left two bad options — guess a count, or declare the vault
 * unable to answer. It chose the second in production: a gap note was filed and a Jira
 * ticket opened, asking a human to write documentation about how much documentation there
 * is. Nothing about the fail-closed rule was wrong; the question was simply not the kind
 * of question that rule is for.
 *
 * So this is a retrieval path, and these pin what it returns — no model involved.
 */

let tmpRoot: string;
let vault: Vault;

interface Overview {
  total_notes: number;
  folders: Array<{ folder: string; purpose: string; note_count: number }>;
  notes: string[];
  truncated?: string;
}

async function overview(): Promise<Overview> {
  const tool = qaTools(vault, await buildIndex(vault)).find((candidate) => candidate.name === "vault_overview");
  if (!tool) throw new Error("vault_overview is not among the tools");
  return JSON.parse(await tool.run({})) as Overview;
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-overview-"));
  vault = new Vault(tmpRoot);
  await vault.ensure();
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5 });
});

describe("vault_overview", () => {
  it("counts the vault and says what each folder is for", async () => {
    await vault.writeNote("docs/scheduled-maintenance.md", "## Overview\n\nA doc.\n", { title: "Maintenance" });
    await vault.writeNote("docs/subscriber-management.md", "## Overview\n\nAnother doc.\n", { title: "Subscribers" });
    await vault.writeNote("prd/scheduled-maintenance.md", "A PRD.\n", { title: "Maintenance PRD" });
    await vault.writeNote("_lessons/L-001-timezone.md", "Quote windows in UTC.\n", { status: "approved" });
    await vault.writeNote("index.md", "The index.\n", { title: "Vault index" });

    const result = await overview();

    expect(result.total_notes).toBe(5);
    const docs = result.folders.find((folder) => folder.folder === "docs");
    expect(docs?.note_count).toBe(2);
    // The purpose matters as much as the count: "what do you know about?" is answered by
    // the shape of the vault, and a folder name alone does not carry that.
    expect(docs?.purpose).toContain("approved by a human");
    expect(result.folders.find((folder) => folder.folder === "_lessons")?.purpose).toContain("house style rules");
    // A note at the root is still a note, and is reported under its own heading.
    expect(result.folders.find((folder) => folder.folder === "(vault root)")?.note_count).toBe(1);
  });

  it("lists paths the way citations are written — no .md", async () => {
    await vault.writeNote("docs/a-thing.md", "Body.\n", { title: "A thing" });
    const result = await overview();
    // The model cites [[docs/a-thing]], so handing it `docs/a-thing.md` invites a citation
    // that does not match anything the parser will recognise. `index` comes from
    // `vault.ensure()` — a vault always has one.
    expect(result.notes.sort()).toEqual(["docs/a-thing", "index"]);
  });

  it("reports a vault with nothing filed as holding only its index", async () => {
    const result = await overview();
    expect(result.total_notes).toBe(1);
    expect(result.notes).toEqual(["index"]);
  });

  it("caps a large vault and says that it did", async () => {
    for (let index = 0; index < 130; index += 1) {
      await vault.writeNote(`reference/page-${index}.md`, "Body.\n", { title: `Page ${index}` });
    }
    const result = await overview();

    // 130 written plus the index `vault.ensure()` creates.
    expect(result.total_notes).toBe(131);
    expect(result.notes).toHaveLength(120);
    // Silent truncation would read as "that is the whole vault", which is a lie about scope.
    expect(result.truncated).toContain("131");
  });
});

describe("the contract's two kinds of question", () => {
  it("forbids NOT_IN_KB for questions about the vault itself", () => {
    // The rule the production failure violated, stated where both transports read it.
    expect(QA_SYSTEM_PROMPT).toContain("vault_overview");
    expect(QA_SYSTEM_PROMPT).toMatch(/NEVER answer NOT_IN_KB/);
  });

  it("still requires a citation or a refusal for product questions", () => {
    expect(QA_SYSTEM_PROMPT).toContain("A claim without a citation is not allowed");
    expect(QA_SYSTEM_PROMPT).toContain("NOT_IN_KB:");
  });
});
