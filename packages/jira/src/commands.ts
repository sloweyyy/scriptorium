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
  /** Someone said the agent's name and nothing more useful — answer, whatever the state. */
  | { kind: "wake" }
  | { kind: "feedback"; text: string }
  | { kind: "ignore"; reason: "own-comment" | "empty" };

/** What the parser needs to know about the ticket to resolve a mention. */
export interface CommandContext {
  /** True once the agent has posted a draft here — makes a mention with text feedback. */
  hasDraft: boolean;
}

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

/**
 * Does this body mention the agent?
 *
 * Must run on the RAW body: Jira stores a mention as `[~accountid:<id>]` and `plainText`
 * strips exactly that, so detection after the strip is impossible.
 */
export function mentionsAccount(body: string, accountId?: string): boolean {
  if (!accountId) return false;
  const escaped = accountId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\[~accountid:${escaped}\\]`, "i").test(body);
}

/**
 * Filler that a bare mention comes wrapped in. Kept deliberately tiny: anything longer
 * than a vocative is a request, and answering a request with a greeting is the regression
 * this list exists to avoid.
 */
const MENTION_FILLER = /^(hi|hello|hey|yo|scribe|there|please|thanks)$/i;

/** True when removing the mention leaves nothing a human would call a request. */
function mentionIsTheWholeMessage(text: string): boolean {
  return text
    .split(/[\s,.!?;:—-]+/)
    .filter(Boolean)
    .every((word) => MENTION_FILLER.test(word));
}

const LESSON_ID = /\b(l-?\d{1,4})\b/i;

function lessonId(text: string): string | undefined {
  const match = text.match(LESSON_ID)?.[1];
  if (!match) return undefined;
  const digits = match.replace(/\D/g, "");
  return `L-${digits.padStart(3, "0")}`;
}

/**
 * Precedence, in this order and for these reasons:
 *
 * 1. **own comment** — the agent quotes its own vocabulary back at itself; the accountId
 *    guard is the only reliable way not to answer itself (and not to wake itself).
 * 2. **explicit command** — a human who typed `approve` means approve, mention or not.
 * 3. **conditional wake** — a mention is a wake only when it is the whole substantive
 *    message, or when there is no draft yet (then there is nothing else it could mean).
 * 4. **feedback** — everything else, including `@Scribe make the intro shorter` on a
 *    drafted ticket: that is the common case, and greeting it back is a regression.
 */
export function parseCommand(comment: JiraComment, botAccountId?: string, context?: CommandContext): JiraCommand {
  if (botAccountId && comment.author?.accountId === botAccountId) {
    return { kind: "ignore", reason: "own-comment" };
  }

  const body = comment.body ?? "";
  // Read the mention off the raw body — `plainText` below deletes the marker.
  const mentioned = mentionsAccount(body, botAccountId);

  const text = plainText(body);
  // A mention on its own strips to nothing: that is a wake, not an empty comment.
  if (!text) return mentioned ? { kind: "wake" } : { kind: "ignore", reason: "empty" };

  const head = text.split("\n")[0]?.trim().toLowerCase() ?? "";

  if (/^(approve|accept)\s+lesson\b/.test(head)) return { kind: "approve-lesson", id: lessonId(head) };
  if (/^(reject|decline|discard)\s+lesson\b/.test(head)) return { kind: "reject-lesson", id: lessonId(head) };
  if (/^(approve|approved|publish)(\s+(the\s+)?(doc|document|draft))?[.!]?$/.test(head)) return { kind: "approve-doc" };
  if (/^(draft|redraft|retry|start)[.!]?$/.test(head)) return { kind: "draft" };
  if (/^(help|\?|commands)[.!]?$/.test(head)) return { kind: "help" };

  if (mentioned && (!context?.hasDraft || mentionIsTheWholeMessage(text))) return { kind: "wake" };

  return { kind: "feedback", text };
}
