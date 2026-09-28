import type { QaAnswer } from "./qa-contract";

/**
 * Grading an answer against the answer golden set (`evals/golden/answers.json`).
 *
 * Deterministic on purpose: no model judges another model. An answerable case passes when
 * the answer cites every note it must and states every fact it must; an unanswerable one
 * passes only as a clean `NOT_IN_KB:` with nothing cited. A false-premise case is answerable,
 * and its fact is the correction ("one level deep", not "here's how to nest three").
 */
export type AnswerTag = "answerable" | "multi-hop" | "false-premise" | "unanswerable";

export interface AnswerCase {
  q: string;
  tag: AnswerTag;
  /** Notes the answer must cite, as vault paths without `.md`. */
  cite?: string[];
  /** Case-insensitive patterns the answer's text must match. */
  facts?: string[];
}

export interface AnswerGrade {
  pass: boolean;
  /** Why it failed; empty when it passed. */
  reasons: string[];
}

export type AnswerScores = Record<string, { pass: number; n: number }>;

const bare = (citation: string) => citation.replace(/\.md$/, "").replace(/^\/+/, "");

export function gradeAnswer(item: AnswerCase, answer: Pick<QaAnswer, "text" | "citations" | "gap">): AnswerGrade {
  const reasons: string[] = [];
  if (item.tag === "unanswerable") {
    if (!answer.gap) reasons.push("answered instead of reporting a gap");
    if (!answer.text.startsWith("NOT_IN_KB:")) reasons.push("the refusal isn't a bare NOT_IN_KB line");
    if (answer.citations.length) reasons.push(`cited ${answer.citations.join(", ")} for something the vault doesn't say`);
    return { pass: reasons.length === 0, reasons };
  }
  if (answer.gap) reasons.push(`reported a gap: ${answer.gap}`);
  const cited = new Set(answer.citations.map(bare));
  for (const want of item.cite ?? []) if (!cited.has(want)) reasons.push(`didn't cite ${want}`);
  for (const fact of item.facts ?? []) if (!new RegExp(fact, "i").test(answer.text)) reasons.push(`doesn't state /${fact}/`);
  return { pass: reasons.length === 0, reasons };
}

/** Pass rate per tag, rounded to three places. */
export function scoreAnswers(graded: ReadonlyArray<{ tag: AnswerTag; pass: boolean }>): AnswerScores {
  const byTag: Record<string, boolean[]> = {};
  for (const { tag, pass } of graded) (byTag[tag] ??= []).push(pass);
  return Object.fromEntries(
    Object.entries(byTag).map(([tag, results]) => [tag, { pass: Math.round((results.filter(Boolean).length / results.length) * 1000) / 1000, n: results.length }]),
  );
}

/**
 * Where scores fell below a model's committed baseline. Refusing what the vault doesn't say
 * has no baseline: it is the contract, so anything under 1 is a regression for every model.
 */
export function answerRegressions(now: AnswerScores, baseline: AnswerScores | undefined): string[] {
  const floors: AnswerScores = { ...baseline, unanswerable: { pass: 1, n: now.unanswerable?.n ?? 0 } };
  return Object.entries(floors)
    .filter(([tag, floor]) => (now[tag]?.pass ?? 0) < floor.pass)
    .map(([tag, floor]) => `${tag}: ${now[tag]?.pass ?? 0} < ${floor.pass}`);
}
