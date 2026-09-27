import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Vault } from "@scriptorium/core";
import { MemoryApprovalStore, decideApproval, executeApproved, runUnderPolicy, type Envelope } from "@scriptorium/policy";
import { listMemories, memoryTools, renderMemories, scopesFor } from "@scriptorium/runtime";
import { listLessons } from "@scriptorium/scribe";

/**
 * Team memory: the agent may ask, only a human decides, and a memory reaches only the
 * channel or person it belongs to — never a published doc.
 */

let tmpRoot: string;
let vault: Vault;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-memory-"));
  vault = new Vault(tmpRoot);
  await vault.ensure();
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const envelope: Envelope = { agent: "Teammate", selfAccountIds: ["slack:UBOT"], tools: { memory_save: { tier: "approve", approvers: ["slack:UPM"] } } };

describe("team memory", () => {
  it("is never written without a human's approval — and records who approved it", async () => {
    const [save] = memoryTools(vault);
    expect(await save!.run({ text: "Release notes go out on Thursdays.", scope: "channel:C1" })).toMatch(/^NOT_DONE/);
    expect(await vault.listNotes("_memory")).toHaveLength(0);

    const store = new MemoryApprovalStore();
    const deps = { store, channel: { post: async () => undefined }, auditFile: "/dev/null", key: "slack:thread:C1/1.0" };
    const asked = await runUnderPolicy(envelope, save!, { text: "Release notes go out on Thursdays.", scope: "channel:C1" }, deps);
    expect(asked.kind).toBe("pending");
    expect(await vault.listNotes("_memory")).toHaveLength(0);

    if (asked.kind !== "pending") throw new Error("expected pending");
    await decideApproval(store, envelope, asked.request.id, "approved", { accountId: "slack:UPM", name: "Priya" });
    expect((await executeApproved(envelope, [save!], asked.request.id, deps)).kind).toBe("ran");
    const [memory] = await listMemories(vault, ["channel:C1"]);
    expect(memory).toMatchObject({ scope: "channel:C1", text: "Release notes go out on Thursdays.", approvedBy: "Priya" });
  });

  it("reaches only its own channel and person", async () => {
    const write = (id: string, scope: string, status = "approved") => vault.writeNote(`_memory/${id}.md`, `${id} text`, { id, scope, status });
    await write("M-1", "global");
    await write("M-2", "channel:C1");
    await write("M-3", "channel:C2");
    await write("M-4", "person:slack:U1");
    await write("M-5", "person:slack:U2");
    await write("M-6", "channel:C1", "revoked");
    const seen = (await listMemories(vault, scopesFor({ channel: "C1", askedBy: "slack:U1" }))).map((memory) => memory.id);
    expect(seen).toEqual(["M-1", "M-2", "M-4"]);
    expect(renderMemories([])).toBe("");
  });

  it("never becomes a Scribe house rule, so it can never reach a published doc", async () => {
    await vault.writeNote("_memory/M-1.md", "Priya prefers short answers.", { id: "M-1", scope: "person:slack:U1", status: "approved" });
    expect(await listLessons(vault)).toEqual([]);
  });

  it("refuses a scope that isn't one", async () => {
    const [save] = memoryTools(vault);
    expect(await save!.run({ text: "x is y.", scope: "everyone-everywhere" }, { approval: { id: "a", approvedBy: "p" } })).toMatch(/not a memory scope/);
  });
});

describe("memories are private to their scope", () => {
  it("no retrieval tool returns a memory — not search, not read_note, not the overview", async () => {
    const { buildIndex, qaTools } = await import("@scriptorium/curator");
    await vault.writeNote("_memory/M-1.md", "Priya's salary expectations are private.", { id: "M-1", scope: "person:slack:UPRIYA", status: "approved" });
    await vault.writeNote("docs/digest.md", "# Digest\n\nOne email a day.", {});
    const tools = Object.fromEntries(qaTools(vault, await buildIndex(vault)).map((tool) => [tool.name, tool]));
    expect(await tools.search_vault!.run({ query: "salary private" })).not.toContain("_memory");
    expect(await tools.read_note!.run({ path: "_memory/M-1" })).toMatch(/^NOT_ALLOWED/);
    expect(await tools.read_note!.run({ path: "./_memory/M-1.md" })).toMatch(/^NOT_ALLOWED/);
    expect(await tools.vault_overview!.run({})).not.toContain("_memory");
  });
});

describe("memories lapse", () => {
  it("an approved memory stops applying at its expiry, and its expiry is covered by the signature", async () => {
    const [save] = memoryTools(vault);
    await save!.run({ text: "Release notes go out on Thursdays.", scope: "channel:C1" }, { approval: { id: "a1", approvedBy: "Priya" } });
    const [relPath] = await vault.listNotes("_memory");
    const note = await vault.readNote(relPath!);
    expect(typeof note.frontmatter.expires_at).toBe("string");
    expect(await listMemories(vault, ["channel:C1"])).toHaveLength(1);
    const later = new Date(Date.parse(note.frontmatter.expires_at as string) + 1_000);
    expect(await listMemories(vault, ["channel:C1"], later)).toHaveLength(0);
  });

  it("with a signing key, pushing a memory's expiry back breaks its signature", async () => {
    const previous = process.env.SCRIPTORIUM_SIGNING_KEY;
    process.env.SCRIPTORIUM_SIGNING_KEY = "k";
    try {
      const [save] = memoryTools(vault);
      await save!.run({ text: "Priya prefers short answers.", scope: "person:slack:U1" }, { approval: { id: "a2", approvedBy: "Priya" } });
      const [relPath] = await vault.listNotes("_memory");
      const note = await vault.readNote(relPath!);
      expect(await listMemories(vault, ["person:slack:U1"])).toHaveLength(1);
      await vault.writeNote(relPath!, note.body, { ...note.frontmatter, expires_at: "2099-01-01T00:00:00.000Z" });
      expect(await listMemories(vault, ["person:slack:U1"])).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.SCRIPTORIUM_SIGNING_KEY;
      else process.env.SCRIPTORIUM_SIGNING_KEY = previous;
    }
  });
});
