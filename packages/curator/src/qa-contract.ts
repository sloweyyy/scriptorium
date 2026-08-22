import { extractWikilinks, type ToolSpec, type Vault } from "@scriptorium/core";
import { z } from "zod";
import type { VaultIndex } from "./search";

/**
 * Curator's grounded-Q&A contract — the whole of it, in one file.
 *
 * Everything that decides *what Curator does* lives here: the rules it answers under, the
 * tools it may use, how much of a note it may read, and how an answer is turned back into
 * citations and gaps. What lives elsewhere is only *how a given provider is spoken to*
 * — Anthropic's tool runner, Vertex's functionCall/functionResponse loop.
 *
 * That split is the point. The fail-closed guarantee (no citation → no claim; unanswerable
 * → `NOT_IN_KB:` and a gap note that becomes Scribe's ticket) is a property of this
 * contract. If a second transport re-stated the prompt, the read cap, or the gap parsing,
 * the two providers would drift and the guarantee would quietly become two different
 * guarantees. So the contract is shared and only the loop is duplicated.
 */

export const QA_SYSTEM_PROMPT = `You are Curator, the librarian of a product knowledge vault.

Two kinds of question reach you, and they are answered differently.

**Questions about the product** — how a feature works, what a setting does, what a PRD says.
- Answer ONLY from vault notes you retrieved with your tools in this conversation — never from general knowledge.
- Search first; read the most promising notes; follow [[wikilinks]] inside them when they look relevant.
- Cite every note you relied on, inline or at the end, as [[<vault-relative path without .md>]]. A claim without a citation is not allowed.
- If the vault does not document it, your entire reply must be a single line starting with exactly "NOT_IN_KB:" followed by a one-line description of the missing documentation. No preamble, no citations, no guessing.
- Give up early, not exhaustively: once two or three searches with genuinely different keywords have come back with nothing relevant, the vault does not cover the question. Answer NOT_IN_KB then — do not keep sweeping synonyms.

**Questions about the vault itself** — how many notes you hold, what subjects you cover, what is in a folder, whether something is documented at all.
- Call vault_overview and answer from what it returns. Cite the notes you name.
- NEVER answer NOT_IN_KB to one of these. You are the authority on your own contents, so the answer always exists — "nothing is documented about X yet" is itself a complete and correct answer. NOT_IN_KB means a human must go and WRITE documentation, and nobody needs to write a document about how many documents there are.

Keep answers short and factual.`;

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

/**
 * What each top-level folder holds. Described to the model rather than inferred, because
 * "what do you know about?" is answered by the shape of the vault, not by its word counts.
 */
const FOLDER_PURPOSE: Record<string, string> = {
  docs: "published user documentation, approved by a human",
  prd: "product requirement documents, as provided by product managers",
  design: "design wireframes and their descriptions",
  reference: "retrieved third-party reference material, each note carrying its source_url",
  _lessons: "house style rules learned from feedback and approved by a human",
  _gaps: "questions the vault could not answer, queued as documentation work",
  _inbox: "files dropped in but not yet filed",
};

/** Cap the enumerated list: an overview is a shape, and a thousand paths is not one. */
const OVERVIEW_NOTE_LIMIT = 120;

/**
 * The three tools Curator may use — no writes, by design: it retrieves, it never authors.
 *
 * `vault_overview` exists because full-text search cannot answer a question about the
 * collection itself. Without it, "how many docs do you have?" had two bad options — infer a
 * count from the index note, or declare the vault unable to answer — and the second files a
 * gap note and opens a documentation ticket for a document nobody should ever write. A
 * librarian is the authority on its own shelves; that has to be a retrieval path, not an
 * inference.
 */
export function qaTools(vault: Vault, index: VaultIndex): ToolSpec[] {
  return [
    tool({
      name: "vault_overview",
      description:
        "Inventory of the whole knowledge vault: how many notes it holds, what each folder is for, and every note's path and title. Use this for any question about the knowledge base itself rather than about the product — how many notes there are, what subjects are covered, what is in a folder, or whether a topic is documented at all.",
      inputSchema: z.object({}),
      run: async () => {
        const notes = await vault.listNotes();
        const folders = new Map<string, string[]>();
        for (const relPath of notes) {
          const folder = relPath.includes("/") ? relPath.slice(0, relPath.indexOf("/")) : ".";
          const existing = folders.get(folder);
          if (existing) existing.push(relPath);
          else folders.set(folder, [relPath]);
        }

        return JSON.stringify({
          total_notes: notes.length,
          folders: [...folders.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([folder, paths]) => ({
              folder: folder === "." ? "(vault root)" : folder,
              purpose: FOLDER_PURPOSE[folder] ?? "uncategorised",
              note_count: paths.length,
            })),
          notes: notes.slice(0, OVERVIEW_NOTE_LIMIT).map((relPath) => relPath.replace(/\.md$/, "")),
          ...(notes.length > OVERVIEW_NOTE_LIMIT
            ? { truncated: `only the first ${OVERVIEW_NOTE_LIMIT} of ${notes.length} note paths are listed` }
            : {}),
        });
      },
    }),
    tool({
      name: "search_vault",
      description:
        "Full-text search over the knowledge vault. Returns note paths, titles, and matching snippets. Call this before answering any question about the product.",
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
