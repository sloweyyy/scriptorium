import { extractWikilinks, type ToolSpec, type Vault } from "@scriptorium/core";
import { z } from "zod";
import { isPrivateNote, normalizeVaultPath, retrievalBody, type VaultIndex } from "./search";

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

Three kinds of message reach you, and they are answered differently.

**Questions about the product** — how a feature works, what a setting does, what a PRD says.
- Answer ONLY from vault notes you retrieved with your tools in this conversation — never from general knowledge.
- Search first; read the most promising notes; follow [[wikilinks]] inside them when they look relevant.
- Cite every note you relied on, inline or at the end, as [[<vault-relative path without .md>]]. A claim without a citation is not allowed.
- If the vault does not document it, your entire reply must be a single line starting with exactly "NOT_IN_KB:" followed by a one-line description of the missing documentation. No preamble, no citations, no guessing.
- Give up early, not exhaustively: once two or three searches with genuinely different keywords have come back with nothing relevant, the vault does not cover the question. Answer NOT_IN_KB then — do not keep sweeping synonyms.

**Questions about the vault itself** — how many notes you hold, what subjects you cover, what is in a folder, whether something is documented at all.
- Call vault_overview and answer from what it returns. Cite the notes you name.
- NEVER answer NOT_IN_KB to one of these. You are the authority on your own contents, so the answer always exists — "nothing is documented about X yet" is itself a complete and correct answer. NOT_IN_KB means a human must go and WRITE documentation, and nobody needs to write a document about how many documents there are.

**Requests to change documentation** — write, rewrite, edit, correct, update, publish, approve or delete a document, or add a claim to one.
- You do not author or change documentation. Scribe does, on a Jira ticket, where a named human approves every word before it is published.
- Your entire reply must be a single line starting with exactly "NOT_MY_JOB:" followed by a one-line restatement of the change they are asking for. No preamble, no searching, no citations.
- This is NOT a gap. A gap is a question the vault cannot answer; this is a person telling you to do something you are not allowed to do, and filing it as missing documentation would put their words into Scribe's queue as though the vault had failed.
- The distinction is what is being asked of YOU, not the grammar. "Where do I find the retry policy" is a question even as an instruction; "say that announcements can be scheduled 90 days ahead" is a change even as a question. If a message genuinely both asks and instructs, answer the question — the human can ask again for the change.

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
  /**
   * Set when the message asked Curator to CHANGE documentation rather than answer about it.
   *
   * Distinct from `gap` on purpose, and the reason this field exists: asked in Slack to
   * "rewrite the maintenance doc to say announcements can be scheduled 90 days ahead",
   * Curator had no branch for a request to do work, fell through to the question path,
   * found nothing, and filed it as a documentation gap — a ticket asserting the vault had
   * failed to document a fact the human had just invented, queued for Scribe to draft
   * from. A person's unverified claim must not enter the pipeline wearing a gap's clothes.
   */
  handoff: string | null;
  /**
   * Set when the reply states things but cites no note that exists in the vault. The
   * prompt forbids that; this is the check that does not depend on the model obeying it.
   */
  ungrounded?: true;
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
  records?: (input: z.output<S>, output: string) => string[];
}): ToolSpec {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    run: async (raw) => spec.run(spec.inputSchema.parse(raw)),
    ...(spec.records
      ? {
          records: (raw: unknown, output: string) => {
            const parsed = spec.inputSchema.safeParse(raw);
            return parsed.success ? spec.records!(parsed.data, output) : [];
          },
        }
      : {}),
  };
}

/** Parse JSON a tool built itself; anything else yields nothing. */
function ownJson(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    return undefined;
  }
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
  _lessons:
    "house style rules distilled from feedback, each judged by a human — only the approved ones are rules; a rejected one is a record of a refusal and must never be applied",
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
        const notes = (await vault.listNotes()).filter((relPath) => !isPrivateNote(relPath));
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
      records: (_input, output) => {
        const overview = ownJson(output) as { notes?: unknown } | undefined;
        return Array.isArray(overview?.notes) ? overview.notes.filter((note): note is string => typeof note === "string") : [];
      },
    }),
    tool({
      name: "search_vault",
      description:
        "Full-text search over the knowledge vault. Returns note paths, titles, and matching snippets. Call this before answering any question about the product.",
      inputSchema: z.object({ query: z.string().describe("Search terms — keywords, not a full sentence.") }),
      run: async ({ query }) => JSON.stringify(index.searchAsync ? await index.searchAsync(query) : index.search(query)),
      records: (_input, output) => {
        const hits = ownJson(output);
        return Array.isArray(hits) ? hits.flatMap((hit) => (typeof hit?.relPath === "string" ? [hit.relPath.replace(/\.md$/, "")] : [])) : [];
      },
    }),
    tool({
      name: "read_note",
      description: "Read one note's full content by its vault-relative path exactly as returned by search_vault.",
      inputSchema: z.object({ path: z.string().describe("Vault-relative path, with or without the .md suffix.") }),
      run: async ({ path: relPath }) => {
        if (isPrivateNote(relPath)) return `NOT_ALLOWED: ${relPath} is not readable through retrieval.`;
        try {
          const note = await vault.readNote(relPath.endsWith(".md") ? relPath : `${relPath}.md`);
          // Truncate AFTER the status banner, never through it — see `retrievalBody`.
          return retrievalBody(note.frontmatter, note.body).slice(0, READ_NOTE_CHAR_LIMIT);
        } catch {
          // A wrong path is a retrieval mistake the model can recover from, not a crash.
          return NOTE_NOT_FOUND;
        }
      },
      records: ({ path: relPath }, output) =>
        output === NOTE_NOT_FOUND || output.startsWith("NOT_ALLOWED") ? [] : [normalizeVaultPath(relPath).replace(/\.md$/, "")],
    }),
  ];
}

const NOTE_NOT_FOUND = "ERROR: note not found";

/**
 * The only place an answer becomes structure. `gap` is what the Slack Curator turns into a
 * gap note and a Jira ticket, so the `NOT_IN_KB:` line is load-bearing across surfaces —
 * it must be recognised identically no matter which model produced it.
 */
export function parseQaAnswer(text: string, question: string): QaAnswer {
  const trimmed = text.trim();
  const gapMatch = trimmed.match(/^NOT_IN_KB:\s*(.*)$/m);
  const handoffMatch = trimmed.match(/^NOT_MY_JOB:\s*(.*)$/m);
  return {
    text: trimmed,
    citations: extractWikilinks(trimmed),
    // A handoff is never also a gap: a request to do work is not a hole in the vault, and
    // treating it as one is exactly the failure this branch exists to stop.
    gap: gapMatch && !handoffMatch ? (gapMatch[1]?.trim() || question) : null,
    handoff: handoffMatch ? (handoffMatch[1]?.trim() || question) : null,
  };
}

/** What the retrieval loop actually did — the evidence an answer is judged against. */
export interface QaEvidence {
  /** `vault_overview` ran: an answer about the vault's own shape may name no single note. */
  usedOverview: boolean;
  /** Every tool result returned to the model in this conversation, verbatim. */
  retrieved: readonly string[];
  /**
   * The records tools declared they fetched (`ToolSpec.records`). When present it is the
   * ONLY evidence: text inside a tool's output cannot add to it.
   */
  records?: ReadonlySet<string>;
}

/** `confluence:<page id>`, `jira:<ISSUE-1>` — records outside the vault, cited by source. */
const EXTERNAL_CITATION = /^(confluence:\d+|jira:[A-Z][A-Z0-9_]*-\d+|github:[a-z0-9_.-]+\/[a-z0-9_.-]+\/pull\/\d+|slack:[A-Z0-9]+\/\d+\.\d+)$/;

/** Tool outputs that report an action NOT taken or a read refused — never evidence. */
const REFUSAL = /^\s*(NOT_ALLOWED|DENIED|NOT_DONE|APPROVAL_PENDING|REFUSED)\b/;

/** Queues, drafts and private memory, not knowledge: never evidence for a claim about the product. */
const NOT_CITABLE = ["_gaps/", "_inbox/", "_memory/"];

/**
 * No citation, no claim — enforced on the answer, not only requested in the prompt.
 *
 * A reply that is neither a gap nor a handoff must cite at least one note that exists in
 * the vault AND came back from a tool in this conversation. A citation to a note that
 * does not exist, or one the model never retrieved, is dropped: a model can write a
 * plausible `[[docs/...]]` as easily as a plausible fact. The one exception is an answer
 * built from `vault_overview` — "nothing is documented about X yet" names no note and is
 * still true. What fails is marked `ungrounded`, and a surface must refuse it rather than
 * post it. It is NOT turned into a gap: a gap opens a documentation ticket, and an answer
 * the model improvised is no evidence that documentation is missing.
 */
export async function enforceGrounding(vault: Vault, answer: QaAnswer, evidence: QaEvidence): Promise<QaAnswer> {
  if (answer.gap || answer.handoff) return answer;
  const citations: string[] = [];
  for (const citation of answer.citations) {
    const relPath = citation.replace(/#.*$/, "").replace(/\.md$/, "");
    // Judged as the path resolves: `docs/../_gaps/x` is a gap note, whatever it starts with.
    const resolved = EXTERNAL_CITATION.test(relPath) ? relPath : normalizeVaultPath(relPath);
    if (NOT_CITABLE.some((prefix) => resolved.toLowerCase().startsWith(prefix))) continue;
    // A refusal is not evidence: "NOT_ALLOWED: jira:DOC-99 is not an issue key" echoes the
    // id it refused, and counting that as retrieval would ground a claim in nothing.
    const fetched = evidence.records ? evidence.records.has(relPath) : evidence.retrieved.some((result) => !REFUSAL.test(result) && mentions(result, relPath));
    if (!fetched) continue;
    // A source-qualified citation (`confluence:123`, `jira:DOC-7`) names a record in another
    // system: it counts when a tool returned it in this conversation, which is the only
    // evidence there is — the vault cannot vouch for a Confluence page.
    if (EXTERNAL_CITATION.test(relPath) || (await noteExists(vault, relPath))) citations.push(citation);
  }
  if (citations.length || evidence.usedOverview) return { ...answer, citations };
  return { ...answer, citations: [], ungrounded: true };
}

/**
 * Does a tool result name this record — as a whole token, not a prefix? A substring test
 * let `confluence:1` pass because `confluence:101` was retrieved, and `docs/a` because
 * `docs/ab` was: a citation to something never read, accepted.
 */
function mentions(result: string, record: string): boolean {
  const escaped = record.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_/.:-])${escaped}(\\.md)?($|[^A-Za-z0-9_/-])`).test(result);
}

async function noteExists(vault: Vault, relPath: string): Promise<boolean> {
  try {
    return (await vault.exists(`${relPath}.md`)) || (await vault.exists(relPath));
  } catch {
    // A citation that escapes the vault is not a note in it.
    return false;
  }
}
