export const DOC_SYSTEM_PROMPT = `You are Scribe, a technical writer producing user-facing product documentation.

Rules:
- Ground every statement in the PRD and the design images provided. If the source does not answer something, write only what is known — never invent behavior, limits, defaults, or UI that is not in the source.
- Write for the audience named in the PRD; match depth and vocabulary to them.
- Output plain Markdown only (no code fences around the document) with exactly this structure:

# <Feature name>
## Overview
(what it is and why this audience cares — 2 to 4 sentences)
## Prerequisites
(bullet list; write "None." if there are none)
## Steps
(numbered, one action per step, referencing the UI elements visible in the designs)
## FAQ
(2 to 4 questions this audience would actually ask, answered strictly from the PRD)

- Keep it tight: no filler, no marketing language, no repeated content, no closing summary.`;

export interface DraftPromptInput {
  prdRaw: string;
  lessonsBlock: string;
}

export function buildDraftPrompt({ prdRaw, lessonsBlock }: DraftPromptInput): string {
  const parts: string[] = [];
  if (lessonsBlock) parts.push(lessonsBlock, "");
  parts.push(
    "Here is the PRD (YAML frontmatter + body). Design wireframes, if any, are attached as images.",
    "---",
    prdRaw.trim(),
    "---",
    "Write the user documentation now.",
  );
  return parts.join("\n");
}

export interface RevisePromptInput {
  currentDraft: string;
  feedback: string[];
  lessonsBlock: string;
  /** Design images travel alongside this prompt; say so, or the model cannot know to look. */
  hasDesigns?: boolean;
}

export function buildRevisePrompt({ currentDraft, feedback, lessonsBlock, hasDesigns }: RevisePromptInput): string {
  const parts: string[] = [];
  if (lessonsBlock) parts.push(lessonsBlock, "");
  parts.push(
    "Here is the current draft:",
    "---",
    currentDraft.trim(),
    "---",
  );
  if (hasDesigns) {
    // Narrowly scoped on purpose. An earlier wording — "follow the images over anything
    // the draft says" — let an unrelated wireframe redefine the subject: a webhook-retry
    // document came back rewritten as a status-page document, because the attached mockup
    // happened to show a status page. Designs settle DETAILS. The draft owns the subject.
    parts.push(
      "The attached images are the current design wireframes on this ticket. Use them only",
      "to settle details the feedback points at — labels, field order, what a screen shows.",
      "They never change what this document is about: keep the same feature, title and scope",
      "as the draft above. If an image shows something unrelated to that feature, ignore it.",
      "",
    );
  }
  parts.push(
    "Reviewer feedback to address (apply all of it, change nothing else):",
    ...feedback.map((item, index) => `${index + 1}. ${item}`),
    "",
    "Return the full revised document in the same structure.",
  );
  return parts.join("\n");
}

export const DISTILL_SYSTEM_PROMPT = `You review one piece of feedback given on a documentation draft and decide whether it generalizes beyond that one document.

Reply with exactly one line:
- "DOC_ONLY" if the feedback is specific to this document (a typo, a wrong fact, a missing step).
- "LESSON: <one-sentence imperative rule>" if the feedback expresses a preference that should apply to every future document (style, structure, terminology, what to include or avoid).

The rule must be self-contained and actionable without seeing the original feedback.`;

export function buildDistillPrompt(feedback: string): string {
  return `Feedback given on a draft:\n"""\n${feedback.trim()}\n"""`;
}
