import { audit, slugify, type Vault } from "@scriptorium/core";
import { updateMoc } from "./organizer";

export interface GapInput {
  question: string;
  missing: string;
  askedBy: string;
  auditFile: string;
}

/**
 * An unanswerable question becomes a gap note — Agent B's misses feed Agent A's queue.
 */
export async function fileGapNote(vault: Vault, input: GapInput): Promise<string> {
  const existing = await vault.listNotes("_gaps");
  const id = `G-${String(existing.length + 1).padStart(3, "0")}`;
  const relPath = `_gaps/${id}-${slugify(input.question.slice(0, 50))}.md`;

  await vault.writeNote(
    relPath,
    [
      "**Question the vault could not answer:**",
      "",
      `> ${input.question}`,
      "",
      `Missing documentation: ${input.missing}`,
      "",
      "_Filed by Curator. Scribe should treat this as a documentation request._",
    ].join("\n"),
    { id, kind: "gap", status: "open", asked_by: input.askedBy, created: new Date().toISOString() },
  );

  await audit(input.auditFile, { type: "gap.filed", actor: "curator", relPath, question: input.question });
  await updateMoc(vault);
  return relPath;
}
