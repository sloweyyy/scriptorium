import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Vault } from "@scriptorium/core";
import { buildIndex, type VaultIndex } from "@scriptorium/curator";

/**
 * Retrieval quality, measured. A fictional Beacon vault and tagged questions:
 * - lexical:    the question shares the note's words
 * - paraphrase: it doesn't (BM25's known weak spot, and the case for hybrid retrieval)
 * - multi-hop:  the answer needs two notes
 *
 * recall@5 and MRR per tag must not fall below the committed baseline. Improve retrieval,
 * then raise the baseline in the same commit; a change that lowers it is a red build.
 */

interface Case { q: string; expect: string[]; tag: "lexical" | "paraphrase" | "multi-hop" }
type Metrics = Record<string, { recallAt5: number; mrr: number; n: number }>;

let root: string;
let index: VaultIndex;
const cases = JSON.parse(await fs.readFile(path.resolve("evals/golden/retrieval.json"), "utf8")) as Case[];
const baseline = JSON.parse(await fs.readFile(path.resolve("evals/baselines/retrieval.json"), "utf8")) as Metrics;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-golden-"));
  await fs.cp(path.resolve("evals/fixtures/golden-vault"), root, { recursive: true });
  index = await buildIndex(new Vault(root));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
});

function measure(): Metrics {
  const byTag: Record<string, { recall: number[]; rr: number[] }> = {};
  for (const item of cases) {
    const ranked = index.search(item.q, 10).map((hit) => hit.relPath.replace(/\.md$/, ""));
    const top5 = ranked.slice(0, 5);
    const recall = item.expect.filter((want) => top5.includes(want)).length / item.expect.length;
    const firstHit = ranked.findIndex((got) => item.expect.includes(got));
    const bucket = (byTag[item.tag] ??= { recall: [], rr: [] });
    bucket.recall.push(recall);
    bucket.rr.push(firstHit >= 0 ? 1 / (firstHit + 1) : 0);
  }
  const mean = (values: number[]) => Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 1000;
  return Object.fromEntries(Object.entries(byTag).map(([tag, { recall, rr }]) => [tag, { recallAt5: mean(recall), mrr: mean(rr), n: recall.length }]));
}

describe("retrieval golden set", () => {
  it("does not fall below the committed baseline on any tag", () => {
    const now = measure();
    // Printed so a commit that improves retrieval knows what to raise the baseline to.
    console.log(`[retrieval] ${JSON.stringify(now)}`);
    for (const [tag, floor] of Object.entries(baseline)) {
      expect(now[tag]?.recallAt5, `${tag} recall@5`).toBeGreaterThanOrEqual(floor.recallAt5);
      expect(now[tag]?.mrr, `${tag} MRR`).toBeGreaterThanOrEqual(floor.mrr);
    }
  });

  it("every golden answer exists in the fixture vault", async () => {
    for (const item of cases) for (const want of item.expect) await fs.access(path.join(root, `${want}.md`));
  });
});
