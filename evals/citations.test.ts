import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Vault, type AppConfig } from "@scriptorium/core";
import { answerBlocks, citationLinks, resolveCitations } from "@scriptorium/agents";

/**
 * A citation a reader can follow.
 *
 * Curator answers from every note it holds, and the two published sites carry a fraction of
 * them — deliberately, because most are retrieved third-party pages and republishing someone
 * else's content under our own documentation site would be passing it off as ours. The cost
 * was a citation that named a note nobody outside the container could open. Provenance a
 * reader cannot check is a claim about provenance, not provenance.
 *
 * These pin where each kind of note sends a reader, and that an unresolvable one stays plain.
 */

const EXTERNAL = "https://docs.example.com";
const INTERNAL = "https://internal.example.com";

let tmpRoot: string;
let vault: Vault;

function config(sites: { external?: string; internal?: string }): AppConfig {
  return {
    model: "claude-opus-5",
    hasModelAccess: false,
    provider: "none",
    vertexRegion: "global",
    repoRoot: tmpRoot,
    vaultDir: tmpRoot,
    auditFile: path.join(tmpRoot, "audit.jsonl"),
    port: 8080,
    scribe: {},
    curator: {},
    teammate: { channels: [], jiraProjects: [], confluenceSpaces: [] },
    slack: {},
    sites,
    webhook: {},
    docsRepo: { base: "main", internalBranch: "vault-live", commitName: "a", commitEmail: "b@c.invalid", workDir: path.join(tmpRoot, "repo") },
    jira: { label: "doc-request", issueType: "Task", inProgressStatus: "In Progress", inReviewStatus: "In Review", approvedStatus: "Done", pollMs: 60_000, stateDir: path.join(tmpRoot, "state") },
  };
}

interface Block {
  type: string;
  text?: { text: string };
  elements?: Array<{ text: string }>;
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-cite-"));
  vault = new Vault(tmpRoot);
  await vault.ensure();
  await vault.writeNote("docs/scheduled-maintenance.md", "A published doc.\n", { title: "Maintenance" });
  await vault.writeNote("prd/scheduled-maintenance.md", "The PRD.\n", { title: "Maintenance PRD" });
  await vault.writeNote("_lessons/L-001.md", "Quote windows in UTC.\n", { status: "approved" });
  await vault.writeNote("reference/about-the-platform.md", "Retrieved page.\n", {
    kind: "reference",
    source_url: "https://example.com/about",
  });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("resolving a citation to somewhere readable", () => {
  it("sends a retrieved page to the source it was retrieved from", async () => {
    const [cited] = await resolveCitations(vault, config({ external: EXTERNAL, internal: INTERNAL }), ["reference/about-the-platform"]);
    // Not our copy of it: the honest citation for something we did not write is the original.
    expect(cited?.url).toBe("https://example.com/about");
  });

  it("sends an approved doc to the public site, at the path the site actually serves", async () => {
    const [cited] = await resolveCitations(vault, config({ external: EXTERNAL, internal: INTERNAL }), ["docs/scheduled-maintenance"]);
    // The site's content root IS the vault's docs folder, so `docs/x` is served at `/x`.
    expect(cited?.url).toBe(`${EXTERNAL}/scheduled-maintenance`);
  });

  it("sends a PRD and a house rule to the internal site, one to one", async () => {
    const resolved = await resolveCitations(vault, config({ external: EXTERNAL, internal: INTERNAL }), [
      "prd/scheduled-maintenance",
      "_lessons/L-001",
    ]);
    expect(resolved[0]?.url).toBe(`${INTERNAL}/prd/scheduled-maintenance`);
    expect(resolved[1]?.url).toBe(`${INTERNAL}/_lessons/L-001`);
  });

  it("leaves a note with nowhere to go unlinked", async () => {
    await vault.writeNote("reference/no-provenance.md", "No source_url.\n", { kind: "reference" });
    const resolved = await resolveCitations(vault, config({ external: EXTERNAL, internal: INTERNAL }), ["reference/no-provenance"]);
    // Never republished by allowlist and no source to point at. A wrong link is worse.
    expect(resolved[0]?.url).toBeUndefined();
  });

  it("links nothing when no site is configured", async () => {
    const resolved = await resolveCitations(vault, config({}), ["docs/scheduled-maintenance", "prd/scheduled-maintenance"]);
    expect(resolved.every((cited) => cited.url === undefined)).toBe(true);
  });

  it("refuses a source_url that is not http(s)", async () => {
    await vault.writeNote("reference/hostile.md", "Body.\n", { kind: "reference", source_url: "javascript:alert(1)" });
    const resolved = await resolveCitations(vault, config({ internal: INTERNAL }), ["reference/hostile"]);
    // Frontmatter is data. A citation must not become a way to put a script URL in front
    // of a reader who was told it is a source.
    expect(resolved[0]?.url).toBeUndefined();
  });

  it("tolerates a citation naming a note that is gone", async () => {
    const resolved = await resolveCitations(vault, config({ internal: INTERNAL }), ["docs/deleted"]);
    expect(resolved[0]?.path).toBe("docs/deleted");
  });
});

describe("citations in the rendered answer", () => {
  it("makes the paths in the answer clickable", async () => {
    const citations = ["reference/about-the-platform", "docs/scheduled-maintenance"];
    const links = citationLinks(await resolveCitations(vault, config({ external: EXTERNAL, internal: INTERNAL }), citations));
    const blocks = answerBlocks({
      markdown: "Covered in [[reference/about-the-platform]] and [[docs/scheduled-maintenance]].",
      citations,
      links,
    }) as Block[];

    const body = blocks[0]?.text?.text ?? "";
    expect(body).toContain("<https://example.com/about|reference/about-the-platform>");
    expect(body).toContain(`<${EXTERNAL}/scheduled-maintenance|docs/scheduled-maintenance>`);
    // Cited inline and all linked, so the footer counts rather than repeating.
    expect(blocks[1]?.elements?.[0]?.text).toBe("📚 Answered from 2 notes in the vault, cited above — each one linked.");
  });

  it("says how many are openable when some are dead ends", async () => {
    await vault.writeNote("reference/no-provenance.md", "No source_url.\n", { kind: "reference" });
    const citations = ["docs/scheduled-maintenance", "reference/no-provenance"];
    const links = citationLinks(await resolveCitations(vault, config({ external: EXTERNAL }), citations));
    const blocks = answerBlocks({
      markdown: "See [[docs/scheduled-maintenance]] and [[reference/no-provenance]].",
      citations,
      links,
    }) as Block[];

    // A reader who cannot open one should learn that from the footer, not from a missing link.
    expect(blocks[1]?.elements?.[0]?.text).toBe("📚 Answered from 2 notes in the vault, cited above — 1 of them linked.");
  });

  it("does not rewrite a shorter path inside a longer one", async () => {
    // `docs/a` is a prefix of `docs/a-longer`; substituting it first would corrupt the other.
    const links = new Map([
      ["docs/a", "https://example.com/a"],
      ["docs/a-longer", "https://example.com/a-longer"],
    ]);
    const blocks = answerBlocks({
      markdown: "Both [[docs/a]] and [[docs/a-longer]].",
      citations: ["docs/a", "docs/a-longer"],
      links,
    }) as Block[];

    const body = blocks[0]?.text?.text ?? "";
    expect(body).toContain("<https://example.com/a|docs/a>");
    expect(body).toContain("<https://example.com/a-longer|docs/a-longer>");
  });
});
