import { firstHeading, type Vault } from "@scriptorium/core";
import MiniSearch from "minisearch";

export interface SearchHit {
  relPath: string;
  title: string;
  score: number;
  snippet: string;
  /** Present only on a note a human refused — see `rejectionNotice`. */
  notice?: string;
}

export interface VaultIndex {
  search(query: string, limit?: number): SearchHit[];
  /** Present on a hybrid index (see `withEmbeddings`); preferred over `search` when it is. */
  searchAsync?(query: string, limit?: number): Promise<SearchHit[]>;
  size: number;
}

interface IndexedNote {
  id: string;
  title: string;
  body: string;
  notice: string;
}

/**
 * Curator reads bodies, never frontmatter — so a note's status is invisible to it, and a
 * rule a human explicitly refused reads exactly like one they approved.
 *
 * That was harmless only while rejection deleted the note. Now that a rejected rule stays
 * (its whole point: the decision is the record), retrieval hands the model the rule text
 * with nothing attached to say it was refused. Asked "what are the house style rules?" the
 * live vault answered with the rejected rule listed second, cited, as a rule to follow.
 *
 * So both routes into an answer carry the refusal. `read_note` gets it prepended to the
 * body; a search hit gets it as its own field, NOT as body text — the snippet is a 240-char
 * window centred on the match, so a banner sitting at the top of the body is exactly what
 * that window cuts off. The eval that pins this caught the first version of this fix doing
 * precisely that. Curator must never be the surface that quietly reinstates something a
 * human said no to.
 */
export function rejectionNotice(frontmatter: Record<string, unknown>): string | undefined {
  if (frontmatter["status"] !== "rejected") return undefined;
  const who = typeof frontmatter["rejected_by"] === "string" ? frontmatter["rejected_by"] : "a human reviewer";
  return (
    `REJECTED — ${who} reviewed this rule and refused it. This note is the record of that ` +
    `decision, not guidance. Never present it as a rule to follow, and never apply it to any document.`
  );
}

/** `read_note`'s view: the notice first, then the note, so a full read cannot miss it. */
export function retrievalBody(frontmatter: Record<string, unknown>, body: string): string {
  const notice = rejectionNotice(frontmatter);
  return notice ? `${notice}\n\n${body}` : body;
}

/**
 * Question words carry no signal but plenty of weight: without this, "how do I
 * authenticate to the API?" ranks the longest documents that happen to contain
 * "how", "do" and "the" above the one page named Authentication.
 */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do", "does", "for", "from", "how", "i",
  "in", "is", "it", "its", "me", "my", "of", "on", "or", "our", "that", "the", "their", "there", "these",
  "this", "to", "was", "we", "what", "when", "where", "which", "who", "why", "will", "with", "you", "your",
]);

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
/**
 * Notes no retrieval tool may return: `_memory/` holds per-person and per-channel memories
 * that are loaded only into their own scope's prompt. Indexed, any question from any
 * channel — or any MCP client — could read another person's memory by searching for it.
 */
export const PRIVATE_FOLDERS = ["_memory/"] as const;

export function isPrivateNote(relPath: string): boolean {
  const normalized = relPath.replace(/^\.?\/+/, "");
  return PRIVATE_FOLDERS.some((folder) => normalized.startsWith(folder));
}

export async function buildIndex(vault: Vault): Promise<VaultIndex> {
  const mini = new MiniSearch<IndexedNote>({
    fields: ["title", "body"],
    storeFields: ["title", "body", "notice"],
    processTerm: (term) => {
      const normalized = term.toLowerCase();
      return STOPWORDS.has(normalized) ? null : normalized;
    },
    searchOptions: { boost: { title: 3 }, prefix: true, fuzzy: 0.2 },
  });

  let size = 0;
  for (const relPath of await vault.listNotes()) {
    if (isPrivateNote(relPath)) continue;
    const note = await vault.readNote(relPath);
    const title =
      firstHeading(note.body) ??
      (typeof note.frontmatter.feature === "string" ? note.frontmatter.feature : relPath);
    mini.add({ id: relPath, title, body: note.body, notice: rejectionNotice(note.frontmatter) ?? "" });
    size += 1;
  }

  return {
    size,
    search(query, limit = 6) {
      return mini.search(query).slice(0, limit).map((result) => {
        const notice = String(result["notice"] ?? "");
        const hit: SearchHit = {
          relPath: String(result.id),
          title: String(result["title"] ?? result.id),
          score: result.score,
          snippet: makeSnippet(String(result["body"] ?? ""), query),
        };
        return notice ? { ...hit, notice } : hit;
      });
    },
  };
}
