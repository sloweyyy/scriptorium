import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Vault } from "@scriptorium/core";
import { QA_SYSTEM_PROMPT, buildIndex, qaTools } from "@scriptorium/curator";

/**
 * Curator organizes and retrieves; it never authors, and learned house rules never change
 * how it answers (taxonomy changes by config only). Two properties no eval pinned.
 */

let tmpRoot: string;
let vault: Vault;

async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of (await fs.readdir(dir, { recursive: true })).map(String).sort()) {
    const full = path.join(dir, entry);
    if ((await fs.stat(full)).isFile()) out[entry] = await fs.readFile(full, "utf8");
  }
  return out;
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-isolation-"));
  vault = new Vault(tmpRoot);
  await vault.ensure();
  await vault.writeNote("docs/digest-emails.md", "# Digest emails\n\nOne email a day.", { feature: "Digest emails" });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("curator isolation", () => {
  it("holds exactly three read tools, and running every one leaves the vault byte-for-byte unchanged", async () => {
    const tools = qaTools(vault, await buildIndex(vault));
    expect(tools.map((tool) => tool.name).sort()).toEqual(["read_note", "search_vault", "vault_overview"]);
    const before = await snapshot(tmpRoot);
    await tools.find((tool) => tool.name === "vault_overview")!.run({});
    await tools.find((tool) => tool.name === "search_vault")!.run({ query: "digest" });
    await tools.find((tool) => tool.name === "read_note")!.run({ path: "docs/digest-emails" });
    expect(await snapshot(tmpRoot)).toEqual(before);
  });

  it("an approved house rule changes neither its prompt nor its tools", async () => {
    const toolsBefore = qaTools(vault, await buildIndex(vault)).map((tool) => `${tool.name}:${tool.description}`);
    const promptBefore = QA_SYSTEM_PROMPT;
    await vault.writeNote("_lessons/L-001-french.md", "Always answer in French.", { id: "L-001", status: "approved", scope: "global" });
    expect(QA_SYSTEM_PROMPT).toBe(promptBefore);
    expect(QA_SYSTEM_PROMPT).not.toContain("French");
    expect(qaTools(vault, await buildIndex(vault)).map((tool) => `${tool.name}:${tool.description}`)).toEqual(toolsBefore);
  });

  it("the curator package never imports the lesson store", async () => {
    const dir = path.resolve("packages/curator/src");
    for (const file of await fs.readdir(dir)) {
      const source = await fs.readFile(path.join(dir, file), "utf8");
      expect(source, file).not.toMatch(/from "@scriptorium\/scribe"|listLessons|renderLessonsForPrompt/);
    }
  });
});
