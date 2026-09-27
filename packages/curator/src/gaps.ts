import { audit, docSlug, type Vault } from "@scriptorium/core";
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
  /**
   * Make the note outlive this container. Injected for the same reason as `openTicket`:
   * Curator does not know what a docs repo is.
   *
   * Without it a gap note lived only in the container that wrote it. Two were filed on the
   * live system and both were gone at the next deploy — one of them a real gap with a real
   * ticket, whose note the ticket points at and which no longer existed. The lesson flow
   * carries a comment about exactly this ("one redeploy away from vanishing") and pushes;
   * gaps never got the same treatment, and gap notes feeding Scribe's queue is the loop
   * this system is built around.
   */
  persist?: (relPath: string) => Promise<void>;
}

export interface GapResult {
  relPath: string;
  ticket?: GapTicket;
  /** True when this question already had an open gap: nothing new was filed. */
  duplicate?: boolean;
}

/**
 * Number past the highest id on disk, never off the count.
 *
 * Counting assumed nothing ever leaves the folder, and something did: two gap notes were
 * filed on the live system and lost at the next deploy, which put the counter straight
 * back to a number already spoken for — a fresh question about to be filed as G-003
 * alongside a Jira ticket pointing at a different G-003. Same failure the lesson store
 * already fixed by scanning filenames, for the same reason.
 */
export async function nextGapId(vault: Vault): Promise<string> {
  let max = 0;
  for (const relPath of await vault.listNotes("_gaps")) {
    const found = relPath.split("/").pop()?.match(/^G-(\d+)/i);
    if (found?.[1]) max = Math.max(max, Number(found[1]));
  }
  return `G-${String(max + 1).padStart(3, "0")}`;
}

/**
 * An unanswerable question becomes a gap note — Agent B's misses feed Agent A's queue.
 * The note is written first: if ticketing is down, the gap is still recorded.
 */
/** The same question, however it was punctuated or capitalised. */
export function questionKey(question: string): string {
  return question.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * An open gap for this exact question, if there is one. Asking the same unanswerable
 * question twice (two people, or one person rephrasing only the punctuation) used to file
 * two notes and open two Jira tickets for one missing page.
 */
async function openGapFor(vault: Vault, key: string): Promise<{ relPath: string; frontmatter: Record<string, unknown>; body: string } | undefined> {
  for (const relPath of await vault.listNotes("_gaps")) {
    const note = await vault.readNote(relPath);
    const status = note.frontmatter.status;
    if (status !== "open" && status !== "queued") continue;
    const recorded = typeof note.frontmatter.question_key === "string" ? note.frontmatter.question_key : questionKey(note.body.match(/^>\s*(.+)$/m)?.[1] ?? "");
    if (recorded && recorded === key) return { relPath, frontmatter: note.frontmatter, body: note.body };
  }
  return undefined;
}

export async function fileGapNote(vault: Vault, input: GapInput): Promise<GapResult> {
  const key = questionKey(input.question);
  const existing = key ? await openGapFor(vault, key) : undefined;
  if (existing) {
    // Record that it was asked again — demand is signal for whoever writes the page — and
    // point at the gap (and ticket) that already exists.
    const askers = Array.isArray(existing.frontmatter.also_asked_by) ? (existing.frontmatter.also_asked_by as string[]) : [];
    if (existing.frontmatter.asked_by !== input.askedBy && !askers.includes(input.askedBy)) {
      await vault.writeNote(existing.relPath, existing.body, { ...existing.frontmatter, also_asked_by: [...askers, input.askedBy] });
    }
    await audit(input.auditFile, { type: "gap.repeated", actor: "curator", relPath: existing.relPath, question: input.question });
    const ticket =
      typeof existing.frontmatter.jira_key === "string" && typeof existing.frontmatter.jira_url === "string"
        ? { key: existing.frontmatter.jira_key, url: existing.frontmatter.jira_url }
        : undefined;
    return { relPath: existing.relPath, ticket, duplicate: true };
  }

  const id = await nextGapId(vault);
  const relPath = `_gaps/${id}-${docSlug(input.question, 8, 50)}.md`;

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
    question_key: key,
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

  // Last, so one push carries the note, its ticket link and the refreshed index together.
  if (input.persist) {
    try {
      await input.persist(relPath);
    } catch (error) {
      // The gap is filed and the ticket is open; losing durability must not lose those.
      console.warn(`[curator] gap filed but could not be persisted: ${error instanceof Error ? error.message : error}`);
    }
  }
  return { relPath, ticket };
}
