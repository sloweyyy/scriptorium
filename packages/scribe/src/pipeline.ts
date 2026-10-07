import { generateText, type ImageInput, type Vault } from "@scriptorium/core";
import { checkLessons, listLessons, renderLessonsForPrompt, type Lesson, type LessonVerdict } from "./lessons";
import { lintDoc, type LintFinding } from "./lint";
import {
  buildDistillPrompt,
  buildDraftPrompt,
  buildRevisePrompt,
  DISTILL_SYSTEM_PROMPT,
  DOC_SYSTEM_PROMPT,
} from "./prompts";

export interface DraftResult {
  markdown: string;
  appliedLessons: string[];
  lint: LintFinding[];
  /** Per approved rule: obeyed, broken, or not machine-checkable. */
  lessonVerdicts: Array<{ id: string; verdict: LessonVerdict }>;
}

/**
 * Lint plus the house rules' own checks. A broken rule is an ERROR finding, so the
 * pipeline's one automatic revise round happens before a human is asked to read it.
 */
function judge(markdown: string, lessons: readonly Lesson[]): Pick<DraftResult, "lint" | "lessonVerdicts"> {
  const lessonVerdicts = checkLessons(markdown, lessons);
  const broken = lessonVerdicts
    .filter((result) => result.verdict === "violated")
    .map((result): LintFinding => {
      const lesson = lessons.find((candidate) => candidate.id === result.id);
      return { code: "house-rule", severity: "error", message: `Breaks ${result.id}: ${lesson?.text.split("\n")[0] ?? ""}` };
    });
  return { lint: [...lintDoc(markdown), ...broken], lessonVerdicts };
}

/** PRD (+ designs) -> first draft. Caller must have passed the input contract first. */
export async function draftDoc(vault: Vault, prdRaw: string, images: ImageInput[] = [], options: { withdrawn?: ReadonlySet<string> } = {}): Promise<DraftResult> {
  const lessons = await listLessons(vault, { status: "approved", withdrawn: options.withdrawn });
  const markdown = await generateText({
    system: DOC_SYSTEM_PROMPT,
    prompt: buildDraftPrompt({ prdRaw, lessonsBlock: renderLessonsForPrompt(lessons) }),
    images,
  });
  return { markdown, appliedLessons: lessons.map((lesson) => lesson.id), ...judge(markdown, lessons) };
}

/**
 * Feedback -> revised draft.
 *
 * Takes images for the same reason `draftDoc` does: a reviewer who attaches a corrected
 * mockup and writes "match this" has said everything they intend to say. Revising from
 * the text alone silently ignored the half of the feedback that was visual.
 */
export async function reviseDoc(
  vault: Vault,
  currentDraft: string,
  feedback: string[],
  images: ImageInput[] = [],
  options: { withdrawn?: ReadonlySet<string> } = {},
): Promise<DraftResult> {
  const lessons = await listLessons(vault, { status: "approved", withdrawn: options.withdrawn });
  const markdown = await generateText({
    system: DOC_SYSTEM_PROMPT,
    prompt: buildRevisePrompt({
      currentDraft,
      feedback,
      lessonsBlock: renderLessonsForPrompt(lessons),
      hasDesigns: images.length > 0,
    }),
    images,
  });
  return { markdown, appliedLessons: lessons.map((lesson) => lesson.id), ...judge(markdown, lessons) };
}

/**
 * Returns a candidate lesson rule when the feedback generalizes, null when it is doc-specific
 * — or when the call itself could not be judged.
 *
 * `maxTokens: 300` was measured too tight for Gemini, not a deliberate budget: some
 * DOC_ONLY-shaped feedback truncated at 300 with nothing else about the input to explain
 * why, and a ticket carrying two rounds of feedback (a generalizable one plus an unrelated
 * design correction, both accumulated since the last publish and joined into one call at
 * approval time) truncated reliably. 1000 cleared every case found.
 *
 * The transport fails loud on a truncated answer on purpose — `assertUsableCandidate` in
 * the Gemini dialect exists so a half-finished DRAFT is never mistaken for a finished one.
 * But this call has a different shape: its own contract already has a "could not tell"
 * outcome, `null`, that is the deliberately safe direction — no rule proposed.
 *
 * Before this fix, a truncation here was a thrown error instead, and it surfaced two
 * publish steps too late to make sense: `proposeLesson` runs after the doc is already
 * published, so the ticket got the ⚠️ error comment for a `runPublish` call that had, in
 * fact, succeeded — with the error message leaking the transport's own wording ("raise
 * maxTokens") and telling the human to comment `draft` to retry, which would re-draft the
 * whole document rather than the lesson step, since the feedback that fed the failed call
 * is cleared before it runs and there is nothing left for a retry to distill from. A wobble
 * in judging feedback must read exactly like doc-specific feedback did already: the
 * "nothing generalizes" line, not a leaked error attached to a success.
 */
export async function distillLesson(feedback: string): Promise<string | null> {
  let reply: string;
  try {
    reply = await generateText({
      system: DISTILL_SYSTEM_PROMPT,
      prompt: buildDistillPrompt(feedback),
      maxTokens: 1000,
    });
  } catch {
    return null;
  }
  const match = reply.match(/^LESSON:\s*(.+)$/m);
  return match?.[1]?.trim() ?? null;
}
