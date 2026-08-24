import { generateText, type ImageInput, type Vault } from "@scriptorium/core";
import { listLessons, renderLessonsForPrompt } from "./lessons";
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
}

/** PRD (+ designs) -> first draft. Caller must have passed the input contract first. */
export async function draftDoc(vault: Vault, prdRaw: string, images: ImageInput[] = []): Promise<DraftResult> {
  const lessons = await listLessons(vault, { status: "approved" });
  const markdown = await generateText({
    system: DOC_SYSTEM_PROMPT,
    prompt: buildDraftPrompt({ prdRaw, lessonsBlock: renderLessonsForPrompt(lessons) }),
    images,
  });
  return { markdown, appliedLessons: lessons.map((lesson) => lesson.id), lint: lintDoc(markdown) };
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
): Promise<DraftResult> {
  const lessons = await listLessons(vault, { status: "approved" });
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
  return { markdown, appliedLessons: lessons.map((lesson) => lesson.id), lint: lintDoc(markdown) };
}

/** Returns a candidate lesson rule when the feedback generalizes, null when it is doc-specific. */
export async function distillLesson(feedback: string): Promise<string | null> {
  const reply = await generateText({
    system: DISTILL_SYSTEM_PROMPT,
    prompt: buildDistillPrompt(feedback),
    maxTokens: 300,
  });
  const match = reply.match(/^LESSON:\s*(.+)$/m);
  return match?.[1]?.trim() ?? null;
}
