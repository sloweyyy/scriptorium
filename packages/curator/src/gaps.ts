import { createHash } from "node:crypto";
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
  /**
   * `key` is the question's normalized form (`questionKey`), the same for every asking of it:
   * the opener marks the ticket with it and looks for it first, so a retry after a lost
   * response finds the ticket it already opened instead of filing a second.
   */
  openTicket?: (gap: { question: string; missing: string; askedBy: string; relPath: string; key: string }) => Promise<GapTicket | undefined>;
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
/**
 * The same question, however it was punctuated or capitalised. Letters and digits of any
 * script count: keeping only a-z0-9 turned every Japanese, Russian or Arabic question into
 * the empty key, so none was deduplicated, and all of them shared one Jira label and so one
 * ticket. A question with no letters at all is keyed by its own text, never by "".
 */
export function questionKey(question: string): string {
  const words = question.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (words || !question.trim()) return words;
  return `q-${createHash("sha256").update(question.normalize("NFKC").trim()).digest("hex").slice(0, 16)}`;
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

let gapIds: Promise<unknown> = Promise.resolve();
/** Gap ids are handed out one at a time across all questions, each with its note written. */
function withGapIds<T>(take: () => Promise<T>): Promise<T> {
  const next = gapIds.then(take);
  gapIds = next.catch(() => undefined);
  return next;
}

/** One filing at a time per question, in this process: two askings at once would both miss the other's note. */
const filing = new Map<string, Promise<unknown>>();

export async function fileGapNote(vault: Vault, input: GapInput): Promise<GapResult> {
  const key = questionKey(input.question);
  if (!key) return fileGapNoteNow(vault, input, key);
  const previous = filing.get(key) ?? Promise.resolve();
  const next = previous.then(() => fileGapNoteNow(vault, input, key));
  const settled = next.catch(() => undefined);
  filing.set(key, settled);
  try {
    return await next;
  } finally {
    // The last in line clears the entry, so the map holds only questions being filed now.
    if (filing.get(key) === settled) filing.delete(key);
  }
}

async function openTicketFor(vault: Vault, input: GapInput, relPath: string, key: string): Promise<GapTicket | undefined> {
  if (!input.openTicket) return undefined;
  let ticket: GapTicket | undefined;
  try {
    ticket = await input.openTicket({ question: input.question, missing: input.missing, askedBy: input.askedBy, relPath, key });
  } catch (error) {
    console.warn(`[curator] gap filed but ticket creation failed: ${error instanceof Error ? error.message : error}`);
  }
  if (ticket) {
    const note = await vault.readNote(relPath);
    await vault.writeNote(relPath, note.body, { ...note.frontmatter, status: "queued", jira_key: ticket.key, jira_url: ticket.url });
    await audit(input.auditFile, { type: "gap.ticketed", actor: "curator", relPath, issue: ticket.key });
  }
  return ticket;
}

async function fileGapNoteNow(vault: Vault, input: GapInput, key: string): Promise<GapResult> {
  const existing = key ? await openGapFor(vault, key) : undefined;
  if (existing) {
    // Record that it was asked again — demand is signal for whoever writes the page — and
    // point at the gap (and ticket) that already exists.
    const askers = Array.isArray(existing.frontmatter.also_asked_by) ? (existing.frontmatter.also_asked_by as string[]) : [];
    if (existing.frontmatter.asked_by !== input.askedBy && !askers.includes(input.askedBy)) {
      await vault.writeNote(existing.relPath, existing.body, { ...existing.frontmatter, also_asked_by: [...askers, input.askedBy] });
    }
    await audit(input.auditFile, { type: "gap.repeated", actor: "curator", relPath: existing.relPath, question: input.question });
    // A gap whose ticket never got linked (ticketing was down, or its response was lost) is
    // ticketed now. The opener finds a ticket it already opened, so this never files a second.
    const ticket =
      typeof existing.frontmatter.jira_key === "string" && typeof existing.frontmatter.jira_url === "string"
        ? { key: existing.frontmatter.jira_key, url: existing.frontmatter.jira_url }
        : await openTicketFor(vault, input, existing.relPath, key);
    return { relPath: existing.relPath, ticket, duplicate: true };
  }

  const body = [
    "**Question the vault could not answer:**",
    "",
    // Every line quoted: quoting only the first let "Q?\n# Beacon supports SSO" become a
    // heading of the note, and the index's title for it.
    ...input.question.split(/\r?\n/).map((line) => `> ${line}`),
    "",
    `Missing documentation: ${input.missing.replace(/\s+/g, " ").trim()}`,
    "",
    "_Filed by Curator. Scribe should treat this as a documentation request._",
  ].join("\n");

  // The id is taken and its note written in one step for the whole process: two different
  // questions filed at once each read the same highest id, and both became the same G-00N.
  const relPath = await withGapIds(async () => {
    const taken = await nextGapId(vault);
    const notePath = `_gaps/${taken}-${docSlug(input.question, 8, 50)}.md`;
    await vault.writeNote(notePath, body, {
      id: taken,
      kind: "gap",
      status: "open",
      question_key: key,
      asked_by: input.askedBy,
      created: new Date().toISOString(),
    });
    return notePath;
  });

  await audit(input.auditFile, { type: "gap.filed", actor: "curator", relPath, question: input.question });

  const ticket = await openTicketFor(vault, input, relPath, key);

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
