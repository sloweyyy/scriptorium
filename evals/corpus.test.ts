import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Vault } from "@scriptorium/core";
import { seedCorpus, seedCorpusIfEmpty } from "@scriptorium/curator";

/**
 * Seeding the reference corpus.
 *
 * `vault/reference/` is derived and uncommitted, regenerated from `corpus/` where each page
 * carries the `source_url` it was retrieved from. The deployed agent had neither: the source
 * upload excluded the derived vault *and* the corpus it derives from, so the running Curator
 * held only the notes the agents themselves had written — and answered NOT_IN_KB to every
 * question about the product the corpus documents. A knowledge base grounded in real
 * material, deployed without the material.
 *
 * So it seeds on boot, and these pin the two properties that makes safe: provenance survives
 * the copy, and a restart is not a re-file.
 */

let tmpRoot: string;
let corpusDir: string;
let vault: Vault;

async function page(name: string, frontmatter: string, body: string): Promise<void> {
  await fs.writeFile(path.join(corpusDir, name), `---\n${frontmatter}\n---\n\n${body}\n`);
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-corpus-"));
  corpusDir = path.join(tmpRoot, "corpus");
  await fs.mkdir(corpusDir, { recursive: true });
  vault = new Vault(path.join(tmpRoot, "vault"));
  await vault.ensure();

  await page("about-the-platform.md", 'title: About the platform\nsource_url: https://example.com/about', "What the platform is.");
  await page("acceptable-use.md", 'title: Acceptable use\nsource_url: https://example.com/aup', "The policy text.");
  await fs.writeFile(path.join(corpusDir, "README.md"), "# Not a corpus page\n");
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5 });
});

describe("seeding the reference corpus", () => {
  it("files every page under reference/ and keeps its source_url", async () => {
    const result = await seedCorpus(vault, corpusDir);

    expect(result.found).toBe(2);
    expect(result.filed).toBe(2);
    // README is documentation about the corpus, not a page of it.
    expect(await vault.listNotes("reference")).toHaveLength(2);

    const note = await vault.readNote("reference/about-the-platform.md");
    // Provenance is the whole point: an answer from this material must be traceable to the
    // page it came from, and a reference note is never authored by an agent.
    expect(note.frontmatter.source_url).toBe("https://example.com/about");
    expect(note.frontmatter.kind).toBe("reference");
  });

  it("names a malformed page and files the rest", async () => {
    await fs.writeFile(path.join(corpusDir, "broken.md"), "---\n: not: valid: yaml\n  - [\n---\n\nBody.\n");
    const result = await seedCorpus(vault, corpusDir);

    // One bad page must not cost the other sixty-odd.
    expect(result.filed).toBe(2);
    expect(result.skipped).toContain("broken.md");
  });

  it("leaves the pages in _inbox when asked, so the watcher does the filing", async () => {
    await seedCorpus(vault, corpusDir, { inboxOnly: true });
    expect(await vault.listNotes("_inbox")).toHaveLength(2);
    expect(await vault.listNotes("reference")).toHaveLength(0);
  });
});

describe("seeding on boot", () => {
  it("seeds a vault that has no reference material", async () => {
    const result = await seedCorpusIfEmpty(vault, corpusDir);
    expect(result?.filed).toBe(2);
  });

  it("does nothing on the next restart", async () => {
    await seedCorpusIfEmpty(vault, corpusDir);
    // Re-filing on every restart would rewrite the whole tree and churn the index for
    // nothing, and the log would claim work that did not happen.
    expect(await seedCorpusIfEmpty(vault, corpusDir)).toBeNull();
    expect(await vault.listNotes("reference")).toHaveLength(2);
  });

  it("does nothing when no corpus shipped", async () => {
    // A deployment without the corpus must still start. Missing demo material is a smaller
    // problem than a process that refuses to boot.
    expect(await seedCorpusIfEmpty(vault, path.join(tmpRoot, "absent"))).toBeNull();
  });
});
