import fs from "node:fs/promises";
import path from "node:path";
import { firstHeading, sourceHash, type Vault } from "@scriptorium/core";
import { geminiEmbed } from "@scriptorium/core";
import { buildIndex, isPrivateNote, rejectionNotice, type SearchHit, type VaultIndex } from "./search";

/**
 * Hybrid retrieval: BM25 and embedding similarity, fused by rank.
 *
 * BM25 finds what shares the question's words; it misses "add thousands of people from a
 * spreadsheet" → "CSV subscriber import" (the golden set's measured paraphrase gap).
 * Embeddings find meaning; they are fuzzy on exact identifiers. Reciprocal-rank fusion
 * keeps both without tuning weights: a note ranked well by either rises.
 *
 * Optional (`RETRIEVAL_EMBEDDINGS`), and it degrades to BM25 on any embedding failure —
 * retrieval must never be LESS available because the smarter half is down.
 */

export interface Embedder {
  name: string;
  embedDocuments(texts: readonly string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

interface Doc {
  relPath: string;
  title: string;
  body: string;
  /** A refused lesson keeps its banner whichever half of the search found it. */
  notice?: string;
  vector?: number[];
}

/** RRF constant: the standard 60 — rank matters, raw scores (incomparable across methods) do not. */
const RRF_K = 60;

export function reciprocalRankFusion(rankings: ReadonlyArray<readonly string[]>, k = RRF_K): string[] {
  const scores = new Map<string, number>();
  for (const ranking of rankings) ranking.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)));
  return [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id);
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    dot += (a[i] as number) * (b[i] as number);
    na += (a[i] as number) ** 2;
    nb += (b[i] as number) ** 2;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * Wrap a BM25 index with embeddings. Vectors are cached by content hash (in `cacheFile`, if
 * given), so an unchanged note is never re-embedded — cost scales with what CHANGED.
 */
export async function withEmbeddings(vault: Vault, base: VaultIndex, embedder: Embedder, cacheFile?: string): Promise<VaultIndex> {
  const docs: Doc[] = [];
  for (const relPath of await vault.listNotes()) {
    if (isPrivateNote(relPath)) continue;
    const note = await vault.readNote(relPath);
    const title = firstHeading(note.body) ?? (typeof note.frontmatter.feature === "string" ? note.frontmatter.feature : relPath);
    docs.push({ relPath, title, body: note.body, notice: rejectionNotice(note.frontmatter) });
  }

  const cache: Record<string, number[]> = cacheFile ? JSON.parse(await fs.readFile(cacheFile, "utf8").catch(() => "{}")) : {};
  const keyOf = (doc: Doc) => `${embedder.name}:${sourceHash(`${doc.title}\n${doc.body}`)}`;
  const missing = docs.filter((doc) => !cache[keyOf(doc)]);
  try {
    if (missing.length) {
      const vectors = await embedder.embedDocuments(missing.map((doc) => `${doc.title}\n\n${doc.body}`));
      missing.forEach((doc, index) => (cache[keyOf(doc)] = vectors[index] as number[]));
      if (cacheFile) {
        await fs.mkdir(path.dirname(cacheFile), { recursive: true });
        await fs.writeFile(cacheFile, JSON.stringify(cache));
      }
    }
  } catch (error) {
    console.warn(`[curator] embeddings unavailable, BM25 only: ${error instanceof Error ? error.message : error}`);
    return base;
  }
  for (const doc of docs) doc.vector = cache[keyOf(doc)];

  return {
    ...base,
    async searchAsync(query: string, limit = 6): Promise<SearchHit[]> {
      const lexical = base.search(query, 20);
      let semantic: string[] = [];
      try {
        const q = await embedder.embedQuery(query);
        semantic = docs
          .filter((doc) => doc.vector)
          .map((doc) => ({ id: doc.relPath, score: cosine(q, doc.vector as number[]) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 20)
          .map((entry) => entry.id);
      } catch {
        return lexical.slice(0, limit);
      }
      const fused = reciprocalRankFusion([lexical.map((hit) => hit.relPath), semantic]).slice(0, limit);
      const byPath = new Map(lexical.map((hit) => [hit.relPath, hit]));
      return fused.map((relPath) => {
        const hit = byPath.get(relPath);
        if (hit) return hit;
        const doc = docs.find((candidate) => candidate.relPath === relPath) as Doc;
        return { relPath, title: doc.title, score: 0, snippet: doc.body.replace(/\s+/g, " ").slice(0, 240), ...(doc.notice ? { notice: doc.notice } : {}) };
      });
    },
  };
}

export function geminiEmbedder(): Embedder {
  return {
    name: process.env.GEMINI_EMBEDDING_MODEL?.trim() || "gemini-embedding-001",
    embedDocuments: (texts) => geminiEmbed(texts, "RETRIEVAL_DOCUMENT"),
    embedQuery: async (text) => (await geminiEmbed([text], "RETRIEVAL_QUERY"))[0] as number[],
  };
}

/**
 * The index every surface uses. BM25 always; fused with embeddings when
 * `RETRIEVAL_EMBEDDINGS=gemini` — cached under `STATE_DIR`, so a boot re-embeds only what changed.
 */
export async function buildRetrievalIndex(vault: Vault, embedder?: Embedder): Promise<VaultIndex> {
  const base = await buildIndex(vault);
  const chosen = embedder ?? (process.env.RETRIEVAL_EMBEDDINGS === "gemini" ? geminiEmbedder() : undefined);
  if (!chosen) return base;
  const cacheFile = path.join(process.env.STATE_DIR || ".scriptorium-state", "embeddings.json");
  return withEmbeddings(vault, base, chosen, cacheFile);
}
