import { firstHeading, type Vault } from "@scriptorium/core";
import MiniSearch from "minisearch";

export interface SearchHit {
  relPath: string;
  title: string;
  score: number;
  snippet: string;
}

export interface VaultIndex {
  search(query: string, limit?: number): SearchHit[];
  size: number;
}

interface IndexedNote {
  id: string;
  title: string;
  body: string;
}

function makeSnippet(body: string, query: string): string {
  const terms = query.toLowerCase().split(/\W+/).filter((term) => term.length >= 3);
  const haystack = body.toLowerCase();
  let position = -1;
  for (const term of terms) {
    position = haystack.indexOf(term);
    if (position >= 0) break;
  }
  const start = Math.max(0, (position < 0 ? 0 : position) - 80);
  return body.slice(start, start + 240).replace(/\s+/g, " ").trim();
}

/** BM25 over the whole vault. Curator navigates from hits by reading notes and following wikilinks. */
export async function buildIndex(vault: Vault): Promise<VaultIndex> {
  const mini = new MiniSearch<IndexedNote>({
    fields: ["title", "body"],
    storeFields: ["title", "body"],
    searchOptions: { boost: { title: 2 }, prefix: true, fuzzy: 0.2 },
  });

  let size = 0;
  for (const relPath of await vault.listNotes()) {
    const note = await vault.readNote(relPath);
    const title =
      firstHeading(note.body) ??
      (typeof note.frontmatter.feature === "string" ? note.frontmatter.feature : relPath);
    mini.add({ id: relPath, title, body: note.body });
    size += 1;
  }

  return {
    size,
    search(query, limit = 6) {
      return mini.search(query).slice(0, limit).map((result) => ({
        relPath: String(result.id),
        title: String(result["title"] ?? result.id),
        score: result.score,
        snippet: makeSnippet(String(result["body"] ?? ""), query),
      }));
    },
  };
}
