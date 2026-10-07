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
  | { kind: "revoke-lesson"; id?: string }
  | { kind: "draft" }
  | { kind: "help" }
  /** Someone said the agent's name and nothing more useful — answer, whatever the state. */
  | { kind: "wake" }
  | { kind: "feedback"; text: string }
  /** Feedback far longer than a review comment (a pasted log or document): asked to summarise, not revised from. */
  | { kind: "too-long"; length: number }
  /**
   * Reads like an approval but is not one exactly (`LGTM`, `approve L-001`, `approve the
   * intro but…`). Publishing is the one irreversible thing a comment can do, so a guess is
   * never made in either direction: not published, not rewritten — asked.
   */
  | { kind: "unclear"; suggestion: string }
  | { kind: "ignore"; reason: "own-comment" | "empty" | "other-agent" | "addressed-to-another-agent" | "no-words" };

/** What the parser needs to know about the ticket to resolve a mention. */
export interface CommandContext {
  /** True once the agent has posted a draft here — makes a mention with text feedback. */
  hasDraft: boolean;
  /**
   * Account ids of the OTHER agents on this Jira site (e.g. the Teammate). Their comments,
   * and comments addressed only to them, are not this agent's to act on — without this,
   * a question to the Teammate and the Teammate's answer each read as feedback on the
   * draft, and every answer could trigger another revise.
   */
  otherAgents?: readonly string[];
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
    // A panel is a quote with a frame: "{panel}approve{panel} is what you told me to type,
    // but…" is about the command too.
    .replace(/\{panel[^}]*\}[\s\S]*?(\{panel\}|$)/gi, "")
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

/**
 * The approval this comment is, if it is one and nothing else (the command, lowercased). It
 * publishes on the spot, so it is read as a
 * grammar, not by stripping what looks friendly: every stripper so far deleted an objection
 * along with the tone ("Approved, thanks — but don't publish until legal signs off" lost
 * everything after "thanks"; "- not before Friday" passed as a sign-off; a {panel} after
 * the approval was removed unread; "?" and 🛑 were stripped as punctuation and symbols).
 *
 * The command opens the comment (after any quote it replies to); then only courtesy may
 * follow, on its line or the next ones: thanks (to a name that isn't a hedge), praise, a cc,
 * a sign-off, a screenshot, a positive emoji. Anything else, or a question mark, or a
 * quote, panel or code block after it, makes it a question, never an approval.
 */
function plainApproval(body: string): string | undefined {
  // A quote, panel or code block after the command is read like any other line: its words
  // aren't courtesy, so it makes the comment a question.
  const reply = withoutLeadingQuotes(body);
  const lines = plainText(reply)
    .split("\n")
    .map((line) => line.replace(/(^|\s)[*_+]+|[*_+]+(?=\s|$)/g, "$1").trim())
    .filter(Boolean);
  const [first = "", ...more] = lines;
  const command = first.match(/^(approved|approve|publish|accept)\b(\s+lesson(\s+l-?\d{1,4})?\b|\s+(the\s+)?(doc|document|draft)\b)?/i);
  if (!command || !isCourtesy(first.slice(command[0].length))) return undefined;
  const courteous = more.every((line, index) =>
    isCourtesy(line) ||
    isSignOff(line) ||
    // "Thanks,\nPhuc": a name alone, last, after thanks.
    (index === more.length - 1 && index > 0 && isName(line) && isCourtesy(more[index - 1] ?? "")),
  );
  return courteous ? command[0].toLowerCase() : undefined;
}

/** Quotes a comment opens with: the reviewer replying to something, before their own words. */
function withoutLeadingQuotes(body: string): string {
  let rest = body.trimStart();
  for (;;) {
    const quote = rest.match(/^(\{quote\}[\s\S]*?\{quote\}|\{panel[^}]*\}[\s\S]*?\{panel\}|\{code[^}]*\}[\s\S]*?\{code\}|\{noformat[^}]*\}[\s\S]*?\{noformat\}|bq\.[^\n]*(\n|$))/i);
    if (!quote) return rest;
    rest = rest.slice(quote[0].length).trimStart();
  }
}

/** What may come with an approval: thanks, praise, a cc. Any other word is something said. */
const COURTESY_WORDS = new Set(
  "thanks thank you thx ty cheers kudos please pls cc great good nice well done job work team everyone all folks guys awesome amazing perfect excellent lovely brilliant looks look lgtm ship it appreciated much so a lot many congrats congratulations really very again for the this quick turnaround help effort".split(" "),
);
/** Words that hold an approval back, even capitalised where a name would be ("Thanks, Not Yet"). */
const HEDGES = new Set(
  "not no yet wait hold stop but never later pending unless until after before only cancel reject hang dont don't don’t do maybe if nope nah block blocked revert undo mind hmm actually except first".split(" "),
);
const POSITIVE_EMOJI = /[\u{1F3FB}-\u{1F3FF}]|👍|🎉|✅|☑️|✔️|🙏|😊|🙂|😀|😃|😄|😁|☺️|🚀|❤️|❤|💯|👏|🥳|✨|🙌|💪|⭐|🌟|️|‍/gu;
/** Jira's own: (y) (/) (*) (on), and the smileys. */
const POSITIVE_EMOTICONS = /\((?:y|\/|\*|on)\)|:-?\)|:-?D|;-?\)/g;
const POSITIVE_SHORTCODES = /:(?:\+1|thumbsup|thumbs_up|tada|white_check_mark|heavy_check_mark|rocket|pray|smile|slightly_smiling_face|blush|heart|clap|100|raised_hands|star|sparkles|muscle|partying_face):/g;
const NAME = /^\p{Lu}[\p{Ll}'’.-]*(\s+\p{Lu}[\p{Ll}'’.-]*){0,2}$/u;

function isName(text: string): boolean {
  return NAME.test(text) && !text.split(/\s+/).some((word) => HEDGES.has(word.toLowerCase().replace(/[.,!]+$/, "")));
}

/** A sign-off: "— Phuc", "-- Mai Anh". Not "- not before Friday", which is a bullet. */
function isSignOff(line: string): boolean {
  const name = line.match(/^(?:—|–|--)\s*(.+)$/)?.[1]?.trim();
  return name !== undefined && isName(name);
}

/** Courtesy words, positive emoji and punctuation only: "?" isn't courtesy, nor is any other word. */
function isCourtesy(text: string): boolean {
  const rest = text
    .replace(/![^!\n]+!/g, " ") // a screenshot, as Jira writes it
    .replace(POSITIVE_EMOJI, " ")
    .replace(POSITIVE_EMOTICONS, " ")
    .replace(POSITIVE_SHORTCODES, " ")
    // Thanks to someone by name: "Thanks Phuc!", "cheers, Mai Anh".
    .replace(/\b([Tt]hanks|[Tt]hank you|[Tt]hx|[Cc]heers|[Kk]udos)\b([\s,]+)(\p{Lu}[\p{Ll}'’-]*(?:\s+\p{Lu}[\p{Ll}'’-]*)?)/gu, (match, thanks: string, _gap: string, name: string) => (isName(name) ? thanks : match));
  return rest
    .split(/\s+/)
    .map((token) => token.replace(/^[.,!…:;"'’“”]+|[.,!…:;"'’“”]+$/g, "").toLowerCase())
    .filter(Boolean)
    .every((word) => COURTESY_WORDS.has(word));
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

  const others = context?.otherAgents ?? [];
  if (comment.author?.accountId && others.includes(comment.author.accountId)) return { kind: "ignore", reason: "other-agent" };

  const body = comment.body ?? "";
  // Read the mention off the raw body — `plainText` below deletes the marker.
  const mentioned = mentionsAccount(body, botAccountId);
  if (!mentioned && others.some((other) => mentionsAccount(body, other))) return { kind: "ignore", reason: "addressed-to-another-agent" };

  // Feedback keeps the whole comment, quotes included — "{quote}step 2{quote} is wrong"
  // needs its quote to make sense. Commands are read only from the reviewer's own words.
  const text = plainText(body);
  // A mention on its own strips to nothing: that is a wake, not an empty comment.
  if (!text) return mentioned ? { kind: "wake" } : { kind: "ignore", reason: "empty" };

  const own = plainText(withoutQuotedBlocks(body));
  const head = commandHead(own);

  // An approval is the whole comment. Only the first line was read, so "Approve\n\nWait,
  // not yet: legal hasn't signed off" published. Anything said with it besides courtesy
  // makes it a question, never an approval in either direction.
  if (/^(approve|approved|publish|accept)\b/.test(head)) {
    const approval = plainApproval(body);
    if (!approval) {
      const id = lessonId(head);
      return { kind: "unclear", suggestion: id ? `approve lesson ${id}` : "approve" };
    }
    if (/\blesson\b/.test(approval)) return { kind: "approve-lesson", id: lessonId(approval) };
    if (!approval.startsWith("accept")) return { kind: "approve-doc" };
  }

  if (/^(approve|accept)\s+lesson\b/.test(head)) return { kind: "approve-lesson", id: lessonId(head) };
  if (/^(reject|decline|discard)\s+lesson\b/.test(head)) return { kind: "reject-lesson", id: lessonId(head) };
  if (/^(revoke|withdraw|retire)\s+lesson\b/.test(head)) return { kind: "revoke-lesson", id: lessonId(head) };
  if (/^(approve|approved|publish)(\s+(the\s+)?(doc|document|draft))?[.!]?$/.test(head)) return { kind: "approve-doc" };
  if (/^(draft|redraft|retry|start)[.!]?$/.test(head)) return { kind: "draft" };
  if (/^(help|\?|commands)[.!]?$/.test(head)) return { kind: "help" };

  if (APPROVAL_LIKE.test(head)) {
    const id = lessonId(head);
    return { kind: "unclear", suggestion: id ? `approve lesson ${id}` : "approve" };
  }

  if (mentioned && (!context?.hasDraft || mentionIsTheWholeMessage(text))) return { kind: "wake" };

  // Nothing to act on: punctuation, a pasted screenshot's markup (`!shot.png|thumbnail!`),
  // an attachment link. Each used to cost a full revise from an instruction with no words.
  const words = text.replace(/![^!\n]+!/g, "").replace(/\[\^[^\]]+\]/g, "");
  if (!/[\p{L}\p{N}]/u.test(words)) return { kind: "ignore", reason: "no-words" };
  // Uncapped, a 200 KB paste went to the model and into the state file for good.
  if (text.length > MAX_FEEDBACK_CHARS) return { kind: "too-long", length: text.length };

  return { kind: "feedback", text };
}

/** A review comment, however thorough, fits in this. */
export const MAX_FEEDBACK_CHARS = 8_000;
