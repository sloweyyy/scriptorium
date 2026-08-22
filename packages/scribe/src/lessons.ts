import path from "node:path";
import { slugify, type Vault } from "@scriptorium/core";

const LESSONS_DIR = "_lessons";

export type LessonStatus = "proposed" | "approved";

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
      status: note.frontmatter.status === "approved" ? "approved" : "proposed",
      text: note.body,
      relPath,
      author: typeof note.frontmatter.author === "string" ? note.frontmatter.author : undefined,
      sourceThread: typeof note.frontmatter.source_thread === "string" ? note.frontmatter.source_thread : undefined,
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
  const relPath = `${LESSONS_DIR}/${id}-${slugify(input.text.slice(0, 40))}.md`;
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
