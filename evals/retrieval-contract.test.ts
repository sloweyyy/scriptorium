import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Vault } from "@scriptorium/core";
import { buildIndex, withEmbeddings, type Embedder, type SearchHit, type VaultIndex } from "@scriptorium/curator";

/**
 * What every retriever behind `search_vault` promises, whichever it is: BM25 alone, or BM25
 * fused with embeddings. A retriever swapped in later runs this same contract.
 */

const CONCEPTS: Record<string, number> = { spreadsheet: 0, csv: 0, import: 1, thousands: 1, people: 2, subscribers: 2, downtime: 3, maintenance: 3 };
const conceptEmbedder: Embedder = {
  name: "concepts",
  embedDocuments: async (texts) => texts.map(embed),
  embedQuery: async (text) => embed(text),
};
function embed(text: string): number[] {
  const vector = [0, 0, 0, 0];
  for (const word of text.toLowerCase().split(/[^a-z]+/)) {
    const dim = CONCEPTS[word];
    if (dim !== undefined) vector[dim] = (vector[dim] ?? 0) + 1;
  }
  return vector;
}

const RETRIEVERS: Array<[string, (vault: Vault) => Promise<VaultIndex>]> = [
  ["BM25", (vault) => buildIndex(vault)],
  ["hybrid", async (vault) => withEmbeddings(vault, await buildIndex(vault), conceptEmbedder)],
];

/** As the Q&A tool asks: the async search where there is one. */
async function find(index: VaultIndex, query: string, limit?: number): Promise<SearchHit[]> {
  return index.searchAsync ? index.searchAsync(query, limit) : index.search(query, limit);
}

let tmpRoot: string;
let vault: Vault;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-retrieval-contract-"));
  vault = new Vault(tmpRoot);
  await vault.ensure();
  for (let i = 0; i < 8; i += 1) await vault.writeNote(`docs/maintenance-${i}.md`, `# Maintenance window ${i}\n\nAnnounce planned downtime for maintenance ${i}.`, {});
  await vault.writeNote("_lessons/L-003-csv.md", "Always import subscribers from a CSV file.", { id: "L-003", status: "rejected", rejected_by: "Alex Kim" });
  await vault.writeNote("_memory/M-1.md", "Priya keeps a spreadsheet of people to import.", { id: "M-1", status: "approved", scope: "person:slack:U1" });
  await vault.writeNote("_gaps/G-1.md", "Someone asked how to import a spreadsheet of thousands.", {});
  await vault.writeNote("_inbox/unreleased.md", "# Unreleased\n\nImport thousands of people from a spreadsheet, launching next quarter.", {});
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5 });
});

for (const [name, build] of RETRIEVERS) {
  describe(`the retrieval contract: ${name}`, () => {
    it("returns hits a citation can name, at most as many as asked for", async () => {
      const hits = await find(await build(vault), "maintenance downtime", 3);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.length).toBeLessThanOrEqual(3);
      for (const hit of hits) {
        expect(hit.relPath).toMatch(/^docs\/maintenance-\d\.md$/);
        expect(typeof hit.title).toBe("string");
        expect(typeof hit.score).toBe("number");
        expect(hit.snippet.length).toBeLessThanOrEqual(240);
      }
    });

    it("never returns a private note, even asked in its own words", async () => {
      const index = await build(vault);
      for (const query of ["Priya keeps a spreadsheet of people to import", "Someone asked how to import a spreadsheet of thousands", "Unreleased import thousands of people launching next quarter"]) {
        for (const hit of await find(index, query, 20)) expect(hit.relPath, query).not.toMatch(/^_(memory|gaps|inbox)\//);
      }
    });

    it("a rule a human refused carries its notice, however it was found", async () => {
      const index = await build(vault);
      // In its own words, and (where there are embeddings) in none of them.
      for (const query of ["import subscribers from a CSV", ...(name === "hybrid" ? ["spreadsheet of thousands"] : [])]) {
        const refused = (await find(index, query, 10)).find((hit) => hit.relPath === "_lessons/L-003-csv.md");
        expect(refused, query).toBeDefined();
        expect(refused?.notice, query).toMatch(/^REJECTED — Alex Kim/);
      }
    });
  });
}
