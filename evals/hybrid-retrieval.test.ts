import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Vault } from "@scriptorium/core";
import { buildIndex, cosine, geminiEmbedder, reciprocalRankFusion, withEmbeddings, type Embedder } from "@scriptorium/curator";

/**
 * Hybrid retrieval, deterministically: a tiny concept embedder stands in for the model so
 * the FUSION is what is tested — BM25 misses a paraphrase, embeddings find it, RRF keeps
 * both. The live golden-set run (bottom) measures the real embedder.
 */

const CONCEPTS: Record<string, number> = { spreadsheet: 0, csv: 0, import: 1, thousands: 1, bulk: 1, people: 2, subscribers: 2, downtime: 3, maintenance: 3 };
function conceptEmbedder(calls: { documents: number } = { documents: 0 }): Embedder {
  const embed = (text: string) => {
    const vector = [0, 0, 0, 0];
    for (const word of text.toLowerCase().split(/[^a-z]+/)) {
      const dim = CONCEPTS[word];
      if (dim !== undefined) vector[dim] = (vector[dim] ?? 0) + 1;
    }
    return vector;
  };
  return {
    name: "concepts",
    embedDocuments: async (texts) => (calls.documents += texts.length, texts.map(embed)),
    embedQuery: async (text) => embed(text),
  };
}

let tmpRoot: string;
let vault: Vault;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-hybrid-"));
  vault = new Vault(tmpRoot);
  await vault.ensure();
  await vault.writeNote("docs/subscriber-import.md", "# Subscriber import\n\nImport subscribers in bulk from a CSV file.", {});
  await vault.writeNote("docs/scheduled-maintenance.md", "# Scheduled maintenance\n\nAnnounce planned downtime.", {});
  await vault.writeNote("_memory/M-1.md", "Priya's spreadsheet of people.", { id: "M-1", status: "approved", scope: "person:slack:U1" });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5 });
});

describe("hybrid retrieval", () => {
  it("finds the paraphrase BM25 misses, without losing what BM25 finds", async () => {
    const base = await buildIndex(vault);
    const question = "add thousands of people from a spreadsheet";
    expect(base.search(question).map((hit) => hit.relPath)).not.toContain("docs/subscriber-import.md");
    const hybrid = await withEmbeddings(vault, base, conceptEmbedder());
    const hits = (await hybrid.searchAsync!(question)).map((hit) => hit.relPath);
    expect(hits[0]).toBe("docs/subscriber-import.md");
    expect((await hybrid.searchAsync!("scheduled maintenance"))[0]?.relPath).toBe("docs/scheduled-maintenance.md");
  });

  it("never returns a private memory, from either half", async () => {
    const hybrid = await withEmbeddings(vault, await buildIndex(vault), conceptEmbedder());
    expect((await hybrid.searchAsync!("people spreadsheet")).map((hit) => hit.relPath)).not.toContain("_memory/M-1.md");
  });

  it("embeds each note once: unchanged notes come from the cache", async () => {
    const cacheFile = path.join(tmpRoot, "state", "embeddings.json");
    const calls = { documents: 0 };
    await withEmbeddings(vault, await buildIndex(vault), conceptEmbedder(calls), cacheFile);
    const firstBuild = calls.documents;
    expect(firstBuild).toBeGreaterThan(0);
    await withEmbeddings(vault, await buildIndex(vault), conceptEmbedder(calls), cacheFile);
    expect(calls.documents).toBe(firstBuild);
    await vault.writeNote("docs/scheduled-maintenance.md", "# Scheduled maintenance\n\nChanged.", {});
    await withEmbeddings(vault, await buildIndex(vault), conceptEmbedder(calls), cacheFile);
    expect(calls.documents).toBe(firstBuild + 1);
  });

  it("falls back to BM25 when embeddings are down — retrieval is never less available", async () => {
    const broken: Embedder = { name: "down", embedDocuments: async () => { throw new Error("503"); }, embedQuery: async () => { throw new Error("503"); } };
    const index = await withEmbeddings(vault, await buildIndex(vault), broken);
    expect(index.searchAsync).toBeUndefined();
    expect(index.search("maintenance")[0]?.relPath).toBe("docs/scheduled-maintenance.md");
  });

  it("fuses by rank, not score", () => {
    expect(reciprocalRankFusion([["a", "b", "c"], ["c", "a"]])).toEqual(["a", "c", "b"]);
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

/**
 * Live: the golden set with the real embedder. Must not fall below the BM25 floor on any
 * tag, and is expected to lift paraphrase.
 *   RUN_LLM_EVALS=1 npx vitest run evals/hybrid-retrieval.test.ts
 */
const live = Boolean(process.env.RUN_LLM_EVALS) && Boolean(process.env.VERTEX_PROJECT_ID);
describe.runIf(live)("hybrid golden set (live embeddings)", () => {
  it("meets or beats the BM25 baseline on every tag", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-hybrid-golden-"));
    await fs.cp(path.resolve("evals/fixtures/golden-vault"), root, { recursive: true });
    const golden = new Vault(root);
    const index = await withEmbeddings(golden, await buildIndex(golden), geminiEmbedder());
    const cases = JSON.parse(await fs.readFile("evals/golden/retrieval.json", "utf8")) as Array<{ q: string; expect: string[]; tag: string }>;
    const baseline = JSON.parse(await fs.readFile("evals/baselines/retrieval.json", "utf8")) as Record<string, { recallAt5: number; mrr: number }>;
    const byTag: Record<string, { recall: number[]; rr: number[] }> = {};
    for (const item of cases) {
      const ranked = (await index.searchAsync!(item.q, 10)).map((hit) => hit.relPath.replace(/\.md$/, ""));
      const bucket = (byTag[item.tag] ??= { recall: [], rr: [] });
      bucket.recall.push(item.expect.filter((want) => ranked.slice(0, 5).includes(want)).length / item.expect.length);
      const first = ranked.findIndex((got) => item.expect.includes(got));
      bucket.rr.push(first >= 0 ? 1 / (first + 1) : 0);
    }
    const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
    const metrics = Object.fromEntries(Object.entries(byTag).map(([tag, { recall, rr }]) => [tag, { recallAt5: mean(recall), mrr: mean(rr) }]));
    await fs.writeFile(path.join(os.tmpdir(), "scriptorium-hybrid-metrics.json"), JSON.stringify(metrics));
    for (const [tag, floor] of Object.entries(baseline)) expect(metrics[tag]?.recallAt5, `${tag} recall@5`).toBeGreaterThanOrEqual(floor.recallAt5);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  }, 300_000);
});
