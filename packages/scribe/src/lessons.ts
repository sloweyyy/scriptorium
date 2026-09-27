import path from "node:path";
import { docSlug, type Vault } from "@scriptorium/core";

const LESSONS_DIR = "_lessons";

/**
 * `rejected` is a real state, not the absence of a file. A human judged this rule and said
 * no; that judgement is worth as much as a yes and has to survive. Deleting the note threw
 * it away twice over — the internal branch is the only durable copy of `_lessons/`, and
 * publish has no delete channel, so the rejected rule stayed on the site as `proposed` and
 * came back into the vault on the next boot. The freed `L-00N` also went straight back into
 * circulation (see `nextLessonId`), so the next proposal wore a number a human had already
 * ruled on.
 */
export type LessonStatus = "proposed" | "approved" | "rejected" | "revoked";

/**
 * A lesson is what "learning" means here: a reviewed, versioned markdown rule with
 * provenance — auditable and revocable, unlike fine-tuning or opaque memory.
 */
export interface Lesson {
  id: string;
  scope: string;
  status: LessonStatus;
  text: string;
  relPath: string;
  author?: string;
  sourceThread?: string;
  /**
   * An optional deterministic test of the rule, so "applied" can mean "obeyed", not only
   * "was in the prompt". `present`: the draft must match; `absent`: it must not. Regex,
   * case-insensitive. A rule without one is reported `unchecked` — honestly.
   */
  check?: { pattern: string; expect: "present" | "absent" };
}

/**
 * Has a human already ruled on this exact rule?
 *
 * Only meaningful now that a rejection leaves the note behind: before, the rejected text
 * was gone, so the distiller re-proposing it was undetectable. Matching is on normalised
 * text — case, spacing and trailing punctuation vary between two runs of the same
 * distillation over the same feedback, and none of that makes it a different rule.
 *
 * Deliberately exact-after-normalisation, not fuzzy. A paraphrase IS a new proposal and a
 * human should see it; the only thing worth suppressing is the same sentence twice.
 */
function normalizeRule(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/[^\w ]+/g, "").trim();
}

export async function findLessonByText(vault: Vault, text: string): Promise<Lesson | undefined> {
  const wanted = normalizeRule(text);
  if (!wanted) return undefined;
  return (await listLessons(vault)).find((candidate) => normalizeRule(candidate.text) === wanted);
}

/**
 * Anything not explicitly approved or rejected is still awaiting a human — including an
 * unreadable or hand-typed value. Defaulting an unknown status to `proposed` is the safe
 * direction: `proposed` never shapes a draft.
 */
function readStatus(raw: unknown): LessonStatus {
  return raw === "approved" ? "approved" : raw === "rejected" ? "rejected" : raw === "revoked" ? "revoked" : "proposed";
}

export async function listLessons(vault: Vault, options: { status?: LessonStatus } = {}): Promise<Lesson[]> {
  const lessons: Lesson[] = [];
  for (const relPath of await vault.listNotes(LESSONS_DIR)) {
    const note = await vault.readNote(relPath);
    const id = note.frontmatter.id;
    if (typeof id !== "string") continue;
    const lesson: Lesson = {
      id,
      scope: String(note.frontmatter.scope ?? "global"),
      status: readStatus(note.frontmatter.status),
      text: note.body,
      relPath,
      author: typeof note.frontmatter.author === "string" ? note.frontmatter.author : undefined,
      sourceThread: typeof note.frontmatter.source_thread === "string" ? note.frontmatter.source_thread : undefined,
      check: readCheck(note.frontmatter),
    };
    if (!options.status || lesson.status === options.status) lessons.push(lesson);
  }
  return lessons.sort((a, b) => a.id.localeCompare(b.id));
}

export function renderLessonsForPrompt(lessons: Lesson[]): string {
  if (!lessons.length) return "";
  return [
    "House rules learned from prior PM/support feedback. Follow every one of them:",
    ...lessons.map((lesson) => `- [${lesson.id}] ${lesson.text.split("\n")[0]}`),
  ].join("\n");
}

export async function nextLessonId(vault: Vault): Promise<string> {
  // Numbering scans FILENAMES, not just parseable lessons: a hand-seeded file without an
  // `id` field is invisible to listLessons but still occupies its number on disk, and
  // handing that number out again produced two different rules both called L-001 — at
  // which point "approve lesson L-001" approves whichever file wins the lookup.
  let max = 0;
  for (const relPath of await vault.listNotes(LESSONS_DIR)) {
    const fromName = path.basename(relPath).match(/^L-(\d+)/i);
    if (fromName?.[1]) max = Math.max(max, Number(fromName[1]));
  }
  for (const lesson of await listLessons(vault)) {
    max = Math.max(max, Number(lesson.id.replace(/\D/g, "")) || 0);
  }
  return `L-${String(max + 1).padStart(3, "0")}`;
}

export interface NewLesson {
  text: string;
  scope?: string;
  status?: LessonStatus;
  author?: string;
  sourceThread?: string;
}

export async function saveLesson(vault: Vault, input: NewLesson): Promise<Lesson> {
  const id = await nextLessonId(vault);
  const relPath = `${LESSONS_DIR}/${id}-${docSlug(input.text, 8, 40)}.md`;
  const status: LessonStatus = input.status ?? "proposed";
  await vault.writeNote(relPath, input.text, {
    id,
    scope: input.scope ?? "global",
    status,
    author: input.author,
    source_thread: input.sourceThread,
    created: new Date().toISOString(),
  });
  return { id, scope: input.scope ?? "global", status, text: input.text, relPath, author: input.author, sourceThread: input.sourceThread };
}

/** Lessons are gated too — a human decides what the system is allowed to learn. */
export async function approveLesson(vault: Vault, id: string, approvedBy: string): Promise<Lesson | undefined> {
  const lesson = (await listLessons(vault)).find((candidate) => candidate.id === id);
  if (!lesson) return undefined;
  const note = await vault.readNote(lesson.relPath);
  await vault.writeNote(lesson.relPath, note.body, {
    ...note.frontmatter,
    status: "approved",
    approved_by: approvedBy,
    approved_at: new Date().toISOString(),
  });
  return { ...lesson, status: "approved" };
}

/**
 * The other half of the gate. Symmetric with `approveLesson` on purpose: a no is recorded
 * the same way a yes is, in the same file, with the same provenance.
 */
export async function rejectLesson(vault: Vault, id: string, rejectedBy: string): Promise<Lesson | undefined> {
  const lesson = (await listLessons(vault)).find((candidate) => candidate.id === id);
  if (!lesson) return undefined;
  const note = await vault.readNote(lesson.relPath);
  await vault.writeNote(lesson.relPath, note.body, {
    ...note.frontmatter,
    status: "rejected",
    rejected_by: rejectedBy,
    rejected_at: new Date().toISOString(),
  });
  return { ...lesson, status: "rejected" };
}

/**
 * May this decision be taken on this lesson, from this place? Pure, so every surface asks
 * the same question.
 *
 * - A lesson is decided where it was proposed. `approve lesson L-004` typed on any other
 *   ticket used to work, so anyone who could comment anywhere could turn a proposal into a
 *   house rule for every future draft.
 * - A human's "no" is not overturned by a comment. Rejected stays rejected, and revisiting it
 *   is a new proposal. Approved → rejected is allowed: withdrawing a rule is always safe.
 */
export function lessonDecisionCheck(
  lesson: Lesson,
  decision: "approve" | "reject" | "revoke",
  whereDecided: string,
): { ok: true } | { ok: false; reason: string } {
  // Withdrawing a rule in force is always safe, so it can be done from wherever the rule
  // is noticed misbehaving — but only a rule in force can be withdrawn.
  if (decision === "revoke") {
    return lesson.status === "approved" ? { ok: true } : { ok: false, reason: `Lesson ${lesson.id} is ${lesson.status}, not in force, so there is nothing to revoke.` };
  }
  if (lesson.status === "revoked") return { ok: false, reason: `Lesson ${lesson.id} was revoked. If it should apply again, give the feedback again and it will be proposed fresh.` };
  if (lesson.sourceThread && lesson.sourceThread !== whereDecided) {
    return { ok: false, reason: `Lesson ${lesson.id} was proposed on ${lesson.sourceThread}. Decide it there.` };
  }
  if (decision === "approve" && lesson.status === "rejected") {
    return { ok: false, reason: `Lesson ${lesson.id} was rejected by a human, and a comment won't overturn that. If it should apply after all, give the feedback again and it will be proposed fresh.` };
  }
  if (decision === "approve" && lesson.status === "approved") return { ok: false, reason: `Lesson ${lesson.id} is already approved.` };
  if (decision === "reject" && lesson.status === "rejected") return { ok: false, reason: `Lesson ${lesson.id} is already rejected.` };
  return { ok: true };
}

/**
 * Withdraw a rule that is in force. The note stays, marked `revoked` with who and when —
 * the record of what the system once followed is part of the audit, and deleting the file
 * would erase it.
 */
export async function revokeLesson(vault: Vault, id: string, revokedBy: string): Promise<Lesson | undefined> {
  const lesson = (await listLessons(vault)).find((candidate) => candidate.id === id);
  if (!lesson) return undefined;
  const note = await vault.readNote(lesson.relPath);
  await vault.writeNote(lesson.relPath, note.body, { ...note.frontmatter, status: "revoked", revoked_by: revokedBy, revoked_at: new Date().toISOString() });
  return { ...lesson, status: "revoked" };
}

function readCheck(frontmatter: Record<string, unknown>): Lesson["check"] {
  const present = frontmatter.check_present;
  const absent = frontmatter.check_absent;
  if (typeof present === "string" && present) return { pattern: present, expect: "present" };
  if (typeof absent === "string" && absent) return { pattern: absent, expect: "absent" };
  return undefined;
}

export type LessonVerdict = "honored" | "violated" | "unchecked";

/**
 * Did the draft obey each house rule? A check that is not a valid regex is `unchecked`,
 * never a crash: a typo in a lesson file must not stop every draft.
 */
export function checkLessons(markdown: string, lessons: readonly Lesson[]): Array<{ id: string; verdict: LessonVerdict }> {
  return lessons.map((lesson) => {
    if (!lesson.check) return { id: lesson.id, verdict: "unchecked" as const };
    let matched: boolean;
    try {
      matched = new RegExp(lesson.check.pattern, "i").test(markdown);
    } catch {
      return { id: lesson.id, verdict: "unchecked" as const };
    }
    const honored = lesson.check.expect === "present" ? matched : !matched;
    return { id: lesson.id, verdict: honored ? ("honored" as const) : ("violated" as const) };
  });
}
