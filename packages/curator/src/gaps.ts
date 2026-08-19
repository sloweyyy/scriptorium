import { audit, slugify, type Vault } from "@scriptorium/core";
import { updateMoc } from "./organizer";

export interface GapTicket {
  key: string;
  url: string;
}

export interface GapInput {
  question: string;
  missing: string;
  askedBy: string;
  auditFile: string;
  /**
   * Optional hand-off to Agent A's queue (in practice: open a Jira doc request).
   * Injected rather than imported so Curator keeps no ticketing dependency — and no
   * ability to author product claims, only to report that a claim is missing.
   */
  openTicket?: (gap: { question: string; missing: string; askedBy: string; relPath: string }) => Promise<GapTicket | undefined>;
}

export interface GapResult {
  relPath: string;
  ticket?: GapTicket;
}

/**
 * An unanswerable question becomes a gap note — Agent B's misses feed Agent A's queue.
 * The note is written first: if ticketing is down, the gap is still recorded.
 */
export async function fileGapNote(vault: Vault, input: GapInput): Promise<GapResult> {
  const existing = await vault.listNotes("_gaps");
  const id = `G-${String(existing.length + 1).padStart(3, "0")}`;
  const relPath = `_gaps/${id}-${slugify(input.question.slice(0, 50))}.md`;

  const body = [
    "**Question the vault could not answer:**",
    "",
    `> ${input.question}`,
    "",
    `Missing documentation: ${input.missing}`,
    "",
    "_Filed by Curator. Scribe should treat this as a documentation request._",
  ].join("\n");

  await vault.writeNote(relPath, body, {
    id,
    kind: "gap",
    status: "open",
    asked_by: input.askedBy,
    created: new Date().toISOString(),
  });

  await audit(input.auditFile, { type: "gap.filed", actor: "curator", relPath, question: input.question });

  let ticket: GapTicket | undefined;
  if (input.openTicket) {
    try {
      ticket = await input.openTicket({ question: input.question, missing: input.missing, askedBy: input.askedBy, relPath });
    } catch (error) {
      console.warn(`[curator] gap filed but ticket creation failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  if (ticket) {
    const note = await vault.readNote(relPath);
    await vault.writeNote(relPath, note.body, { ...note.frontmatter, status: "queued", jira_key: ticket.key, jira_url: ticket.url });
    await audit(input.auditFile, { type: "gap.ticketed", actor: "curator", relPath, issue: ticket.key });
  }

  await updateMoc(vault);
  return { relPath, ticket };
}
