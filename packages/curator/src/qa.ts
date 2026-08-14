import { anthropic, extractWikilinks, modelId, type Vault } from "@scriptorium/core";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { buildIndex } from "./search";

const QA_SYSTEM_PROMPT = `You are Curator, the librarian of a product knowledge vault.

Rules:
- Answer ONLY from vault notes you retrieved with your tools in this conversation — never from general knowledge.
- Search first; read the most promising notes; follow [[wikilinks]] inside them when they look relevant.
- Cite every note you relied on, inline or at the end, as [[<vault-relative path without .md>]]. A claim without a citation is not allowed.
- If the vault does not answer the question, reply with a single line starting with exactly "NOT_IN_KB:" followed by a one-line description of the missing documentation. Do not guess.
- Keep answers short and factual.`;

export interface QaAnswer {
  text: string;
  citations: string[];
  /** Set when the vault could not answer — the one-line description of what's missing. */
  gap: string | null;
}

export async function answerQuestion(vault: Vault, question: string): Promise<QaAnswer> {
  const index = await buildIndex(vault);

  const searchVault = betaZodTool({
    name: "search_vault",
    description:
      "Full-text search over the knowledge vault. Returns note paths, titles, and matching snippets. Call this before answering anything.",
    inputSchema: z.object({ query: z.string().describe("Search terms — keywords, not a full sentence.") }),
    run: ({ query }) => JSON.stringify(index.search(query)),
  });

  const readNote = betaZodTool({
    name: "read_note",
    description: "Read one note's full content by its vault-relative path exactly as returned by search_vault.",
    inputSchema: z.object({ path: z.string() }),
    run: async ({ path: relPath }) => {
      try {
        const note = await vault.readNote(relPath.endsWith(".md") ? relPath : `${relPath}.md`);
        return note.body.slice(0, 8_000);
      } catch {
        return "ERROR: note not found";
      }
    },
  });

  const finalMessage = await anthropic().beta.messages.toolRunner({
    model: modelId(),
    max_tokens: 4_096,
    system: QA_SYSTEM_PROMPT,
    tools: [searchVault, readNote],
    messages: [{ role: "user", content: question }],
  });

  const text = finalMessage.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  const gapMatch = text.match(/^NOT_IN_KB:\s*(.*)$/m);
  return {
    text,
    citations: extractWikilinks(text),
    gap: gapMatch ? (gapMatch[1]?.trim() || question) : null,
  };
}
