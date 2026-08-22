import { extractWikilinks, type ToolSpec, type Vault } from "@scriptorium/core";
import { z } from "zod";
import type { VaultIndex } from "./search";

/**
 * Curator's grounded-Q&A contract — the whole of it, in one file.
 *
 * Everything that decides *what Curator does* lives here: the rules it answers under, the
 * two tools it may use, how much of a note it may read, and how an answer is turned back
 * into citations and gaps. What lives elsewhere is only *how a given provider is spoken to*
 * — Anthropic's tool runner, Vertex's functionCall/functionResponse loop.
 *
 * That split is the point. The fail-closed guarantee (no citation → no claim; unanswerable
 * → `NOT_IN_KB:` and a gap note that becomes Scribe's ticket) is a property of this
 * contract. If a second transport re-stated the prompt, the read cap, or the gap parsing,
 * the two providers would drift and the guarantee would quietly become two different
 * guarantees. So the contract is shared and only the loop is duplicated.
 */

export const QA_SYSTEM_PROMPT = `You are Curator, the librarian of a product knowledge vault.

Rules:
- Answer ONLY from vault notes you retrieved with your tools in this conversation — never from general knowledge.
- Search first; read the most promising notes; follow [[wikilinks]] inside them when they look relevant.
- Cite every note you relied on, inline or at the end, as [[<vault-relative path without .md>]]. A claim without a citation is not allowed.
- If the vault does not answer the question, your entire reply must be a single line starting with exactly "NOT_IN_KB:" followed by a one-line description of the missing documentation. No preamble, no citations, no guessing.
- Give up early, not exhaustively: once two or three searches with genuinely different keywords have come back with nothing relevant, the vault does not cover the question. Answer NOT_IN_KB then — do not keep sweeping synonyms.
- Keep answers short and factual.`;

/** A note is quoted to the model, not streamed to it: enough for context, bounded per read. */
const READ_NOTE_CHAR_LIMIT = 8_000;

/** Answers are short and cited; both transports get the same budget so both truncate alike. */
export const QA_MAX_TOKENS = 4_096;

export interface QaAnswer {
  text: string;
  citations: string[];
  /** Set when the vault could not answer — the one-line description of what's missing. */
  gap: string | null;
}

/**
 * Erases a typed tool to the transport-neutral `ToolSpec`, validating its arguments on the
 * way in. Both providers hand us untrusted JSON; parsing here means neither loop has to.
 */
function tool<S extends z.ZodObject>(spec: {
  name: string;
  description: string;
  inputSchema: S;
  run: (input: z.output<S>) => Promise<string> | string;
}): ToolSpec {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    run: async (raw) => spec.run(spec.inputSchema.parse(raw)),
  };
}

/** The two tools Curator may use — no writes, by design: it retrieves, it never authors. */
export function qaTools(vault: Vault, index: VaultIndex): ToolSpec[] {
  return [
    tool({
      name: "search_vault",
      description:
        "Full-text search over the knowledge vault. Returns note paths, titles, and matching snippets. Call this before answering anything.",
      inputSchema: z.object({ query: z.string().describe("Search terms — keywords, not a full sentence.") }),
      run: ({ query }) => JSON.stringify(index.search(query)),
    }),
    tool({
      name: "read_note",
      description: "Read one note's full content by its vault-relative path exactly as returned by search_vault.",
      inputSchema: z.object({ path: z.string().describe("Vault-relative path, with or without the .md suffix.") }),
      run: async ({ path: relPath }) => {
        try {
          const note = await vault.readNote(relPath.endsWith(".md") ? relPath : `${relPath}.md`);
          return note.body.slice(0, READ_NOTE_CHAR_LIMIT);
        } catch {
          // A wrong path is a retrieval mistake the model can recover from, not a crash.
          return "ERROR: note not found";
        }
      },
    }),
  ];
}

/**
 * The only place an answer becomes structure. `gap` is what the Slack Curator turns into a
 * gap note and a Jira ticket, so the `NOT_IN_KB:` line is load-bearing across surfaces —
 * it must be recognised identically no matter which model produced it.
 */
export function parseQaAnswer(text: string, question: string): QaAnswer {
  const trimmed = text.trim();
  const gapMatch = trimmed.match(/^NOT_IN_KB:\s*(.*)$/m);
  return {
    text: trimmed,
    citations: extractWikilinks(trimmed),
    gap: gapMatch ? (gapMatch[1]?.trim() || question) : null,
  };
}
