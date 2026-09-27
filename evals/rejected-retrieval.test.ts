import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Vault } from "@scriptorium/core";
import { buildIndex, qaTools, retrievalBody, updateMoc } from "@scriptorium/curator";

/**
 * A rule a human refused must never come back through the other agent.
 *
 * Curator reads note bodies and never frontmatter, so `status` is invisible to it. That
 * was harmless only while a rejection deleted the note; once the decision became the
 * record and the note stayed, retrieval handed the model a refused rule that read exactly
 * like an approved one. Asked "what are the house style rules?", it listed the rejected
 * rule second, cited, as a rule to follow — a human's "no" reinstated by the agent that is
 * explicitly forbidden from authoring product claims.
 *
 * Both routes into an answer are pinned here, with no model involved: the BM25 snippet and
 * the full `read_note`. What the model then does with the banner is checked by the live
 * grounded-Q&A eval; what it is *given* is checked here, deterministically.
 */

let tmpRoot: string;
let vault: Vault;

const REJECTED_RULE = 'End every document with a "Related articles" section.';

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-rejected-"));
  vault = new Vault(tmpRoot);
  await vault.ensure();
  await vault.writeNote("_lessons/L-001-timezone.md", "Always specify the timezone when documenting scheduled times.\n", {
    id: "L-001",
    scope: "global",
    status: "approved",
    approved_by: "Truong Le Vinh Phuc",
  });
  await vault.writeNote("_lessons/L-003-related-articles.md", `${REJECTED_RULE}\n`, {
    id: "L-003",
    scope: "global",
    status: "rejected",
    rejected_by: "Truong Le Vinh Phuc",
  });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5 });
});

async function readNote(relPath: string): Promise<string> {
  const tool = qaTools(vault, await buildIndex(vault)).find((candidate) => candidate.name === "read_note");
  if (!tool) throw new Error("read_note is not among the tools");
  return tool.run({ path: relPath });
}

describe("rejected notes in retrieval", () => {
  it("names the refusal and its author above the rule text", () => {
    const marked = retrievalBody({ status: "rejected", rejected_by: "Alex Kim" }, REJECTED_RULE);
    expect(marked).toMatch(/^REJECTED — Alex Kim/);
    expect(marked).toMatch(/never present it as a rule to follow/i);
    // The rule itself is still there — this is a record of a decision, not a redaction.
    expect(marked).toContain(REJECTED_RULE);
  });

  it("still says refused when nobody's name was recorded", () => {
    expect(retrievalBody({ status: "rejected" }, REJECTED_RULE)).toMatch(/^REJECTED — a human reviewer/);
  });

  it("leaves approved and unjudged notes exactly as they are", () => {
    expect(retrievalBody({ status: "approved" }, REJECTED_RULE)).toBe(REJECTED_RULE);
    expect(retrievalBody({ status: "proposed" }, REJECTED_RULE)).toBe(REJECTED_RULE);
    expect(retrievalBody({}, REJECTED_RULE)).toBe(REJECTED_RULE);
  });

  it("carries the refusal into read_note", async () => {
    const body = await readNote("_lessons/L-003-related-articles");
    expect(body).toMatch(/REJECTED — Truong Le Vinh Phuc/);
    // …and does not touch a rule the same human approved.
    expect(await readNote("_lessons/L-001-timezone")).not.toMatch(/REJECTED/);
  });

  it("carries the refusal on the search hit, where the snippet window cannot cut it off", async () => {
    const index = await buildIndex(vault);
    const hit = index.search("related articles section").find((r) => r.relPath.includes("L-003"));
    expect(hit, "the rejected note is still findable — it is a record, not a deletion").toBeDefined();
    // Its own field, not body text: the snippet is a window centred on the match, and the
    // first version of this fix put the banner where that window sliced it away.
    expect(hit?.notice).toMatch(/^REJECTED — Truong Le Vinh Phuc/);
    expect(hit?.snippet).toContain("Related articles");
  });

  it("says where each rule stands in the index that lists them", async () => {
    // The index is a vault note like any other — retrieved, and with no status of its own
    // to carry. Marking the notes is not enough while the note that lists them shows an
    // approved and a refused rule as identical wikilinks.
    await updateMoc(vault);
    const moc = (await vault.readNote("index.md")).body;
    expect(moc).toMatch(/L-003-related-articles\|[^\]]*\]\] — REJECTED by a human, never apply this/);
    expect(moc).toMatch(/L-001-timezone\|[^\]]*\]\] — approved, applies to every draft/);
  });

  it("marks an unjudged rule as unjudged in the index, not as a rule", async () => {
    await vault.writeNote("_lessons/L-009-pending.md", "Mention the beta flag.\n", { id: "L-009", status: "proposed" });
    await updateMoc(vault);
    expect((await vault.readNote("index.md")).body).toMatch(/L-009-pending\|[^\]]*\]\] — proposed, not yet judged/);
  });

  it("leaves every other section of the index alone", async () => {
    await vault.writeNote("docs/beacon.md", "# Maintenance\n\nHow to schedule.\n", { feature: "Maintenance" });
    await updateMoc(vault);
    expect((await vault.readNote("index.md")).body).toContain("- [[docs/beacon|Maintenance]]\n");
  });

  it("puts no notice on hits a human never refused", async () => {
    const index = await buildIndex(vault);
    const hit = index.search("timezone scheduled times").find((r) => r.relPath.includes("L-001"));
    expect(hit).toBeDefined();
    expect(hit?.notice).toBeUndefined();
  });
});
