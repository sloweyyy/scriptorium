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
  /**
   * Reads like an approval but is not one exactly (`LGTM`, `approve L-001`, `approve the
   * intro but…`). Publishing is the one irreversible thing a comment can do, so a guess is
   * never made in either direction: not published, not rewritten — asked.
   */
  | { kind: "unclear"; suggestion: string }
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
    // `{{...}}` is inline monospace. Every agent comment prints the vocabulary in code
    // styling, so a reviewer who copies what they were shown types the command wrapped in
    // it — and an unstripped `{{` made `approve lesson L-006` parse as feedback, which
    // re-drafted a finished ticket instead of approving the rule. Strip the marker, keep
    // the word: the styling is decoration, never part of the command.
    .replace(/\{\{|\}\}/g, "")
    .trim();
}

/**
 * Remove quoted and preformatted blocks — content AND markers.
 *
 * A reviewer quoting the agent's own vocabulary back (`{quote}approve{quote} not yet, the
 * intro is wrong`) is talking ABOUT the command, not issuing it; with the markers stripped
 * and the content kept, that comment published the doc. A command only counts when typed
 * in the reviewer's own words. `{{...}}` inline styling is different and stays readable:
 * it is how every agent comment prints the vocabulary, so it is how reviewers copy it.
 */
export function withoutQuotedBlocks(body: string): string {
  return body
    .replace(/\{quote\}[\s\S]*?(\{quote\}|$)/gi, "")
    .replace(/\{code[^}]*\}[\s\S]*?(\{code\}|$)/gi, "")
    .replace(/\{noformat[^}]*\}[\s\S]*?(\{noformat\}|$)/gi, "")
    .replace(/^\s*bq\.\s.*$/gim, "");
}

/**
 * The first line as a command candidate: bold/italic markers, emoji and a trailing
 * courtesy ("Approved, thanks!") are tone, not part of the command.
 */
function commandHead(text: string): string {
  return (text.split("\n")[0] ?? "")
    .toLowerCase()
    .replace(/\p{Extended_Pictographic}|\uFE0F/gu, "")
    .replace(/(^|\s)[*_+]+|[*_+]+(?=\s|$)/g, "$1")
    .replace(/[\s,;:—-]+(thanks|thank you|thx|ty|please|pls)\b.*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Starts the way an approval does. Not a match — a reason to ask instead of acting. */
const APPROVAL_LIKE = /^(approve|approved|approving|publish|lgtm|ship it|looks good)\b/;

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

  // Feedback keeps the whole comment, quotes included — "{quote}step 2{quote} is wrong"
  // needs its quote to make sense. Commands are read only from the reviewer's own words.
  const text = plainText(body);
  // A mention on its own strips to nothing: that is a wake, not an empty comment.
  if (!text) return mentioned ? { kind: "wake" } : { kind: "ignore", reason: "empty" };

  const head = commandHead(plainText(withoutQuotedBlocks(body)));

  if (/^(approve|accept)\s+lesson\b/.test(head)) return { kind: "approve-lesson", id: lessonId(head) };
  if (/^(reject|decline|discard)\s+lesson\b/.test(head)) return { kind: "reject-lesson", id: lessonId(head) };
  if (/^(approve|approved|publish)(\s+(the\s+)?(doc|document|draft))?[.!]?$/.test(head)) return { kind: "approve-doc" };
  if (/^(draft|redraft|retry|start)[.!]?$/.test(head)) return { kind: "draft" };
  if (/^(help|\?|commands)[.!]?$/.test(head)) return { kind: "help" };

  if (APPROVAL_LIKE.test(head)) {
    const id = lessonId(head);
    return { kind: "unclear", suggestion: id ? `approve lesson ${id}` : "approve" };
  }

  if (mentioned && (!context?.hasDraft || mentionIsTheWholeMessage(text))) return { kind: "wake" };

  return { kind: "feedback", text };
}
