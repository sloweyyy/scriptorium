import type { JiraComment } from "./types";

/**
 * What a comment on a doc-request issue means.
 *
 * The reviewer is testing unattended, so the vocabulary is small and every agent
 * comment repeats it. Anything that is not a command on a drafted issue is feedback.
 */
export type JiraCommand =
  | { kind: "approve-doc" }
  | { kind: "approve-lesson"; id?: string }
  | { kind: "reject-lesson"; id?: string }
  | { kind: "draft" }
  | { kind: "help" }
  | { kind: "feedback"; text: string }
  | { kind: "ignore"; reason: "own-comment" | "empty" };

/** Strip wiki decoration and Jira mentions so command matching sees plain words. */
export function plainText(body: string): string {
  return body
    .replace(/\[~accountid:[^\]]+\]/gi, "")
    .replace(/\{color[^}]*\}|\{color\}/gi, "")
    .replace(/\{panel[^}]*\}|\{panel\}/gi, "")
    .replace(/\{quote\}/gi, "")
    .replace(/\{code[^}]*\}|\{code\}|\{noformat\}/gi, "")
    .trim();
}

const LESSON_ID = /\b(l-?\d{1,4})\b/i;

function lessonId(text: string): string | undefined {
  const match = text.match(LESSON_ID)?.[1];
  if (!match) return undefined;
  const digits = match.replace(/\D/g, "");
  return `L-${digits.padStart(3, "0")}`;
}

export function parseCommand(comment: JiraComment, botAccountId?: string): JiraCommand {
  if (botAccountId && comment.author?.accountId === botAccountId) {
    return { kind: "ignore", reason: "own-comment" };
  }

  const text = plainText(comment.body ?? "");
  if (!text) return { kind: "ignore", reason: "empty" };

  const head = text.split("\n")[0]?.trim().toLowerCase() ?? "";

  if (/^(approve|accept)\s+lesson\b/.test(head)) return { kind: "approve-lesson", id: lessonId(head) };
  if (/^(reject|decline|discard)\s+lesson\b/.test(head)) return { kind: "reject-lesson", id: lessonId(head) };
  if (/^(approve|approved|publish)(\s+(the\s+)?(doc|document|draft))?[.!]?$/.test(head)) return { kind: "approve-doc" };
  if (/^(draft|redraft|retry|start)[.!]?$/.test(head)) return { kind: "draft" };
  if (/^(help|\?|commands)[.!]?$/.test(head)) return { kind: "help" };

  return { kind: "feedback", text };
}
