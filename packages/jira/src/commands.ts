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
  /** The agent's display name: thanking it by name ("thanks Scribe!") is courtesy. */
  botName?: string;
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
    // Jira's (y) and :+1: open an approval as 👍 does.
    .replace(LEADING_COURTESY, "")
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
 * follow, on its line or the next ones: thanks, praise, a cc, a sign-off, a screenshot, a
 * positive emoji. A name (signing off, or thanked) is the author's own: any capitalised word
 * was taken for one, and "— Postponed" and "Thanks,\nHolding" published. Anything else, or
 * a question mark, or a quote, panel or code block after it, makes it a question.
 */
function plainApproval(body: string, names: Names, botAccountId?: string): string | undefined {
  // A quote, panel or code block after the command is read like any other line: its words
  // aren't courtesy, so it makes the comment a question.
  const reply = withoutLeadingQuotes(body);
  // Addressed to someone else ("[~legal] approve please", "Approve\n[~legal] please"): their
  // approval asked for, not this one given. A mention is stripped below, and the rest read as
  // an approval that published. Anyone but the agent may be mentioned only on a cc line.
  for (const raw of reply.split("\n")) {
    const others = [...raw.matchAll(/\[~accountid:([^\]]+)\]/gi)].some((mention) => mention[1] !== botAccountId);
    if (others && !/^[\s*_]*cc\b/i.test(raw)) return undefined;
  }
  const lines = plainText(reply)
    .split("\n")
    .map((line) => line.replace(/(^|\s)[*_+]+|[*_+]+(?=\s|$)/g, "$1").trim())
    .filter(Boolean);
  const [line = "", ...more] = lines;
  // A positive emoji or emoticon may open it ("👍 Approved", "(y) approve").
  const first = line.replace(LEADING_COURTESY, "");
  const command = first.match(/^(approved|approve|publish|accept)\b(\s+lesson(\s+l-?\d{1,4})?\b|\s+(the\s+)?(doc|document|draft)\b)?/i);
  if (!command || !isCourtesy(first.slice(command[0].length), names)) return undefined;
  // "Approve please, team" asks the team for their approval: please, said to a group.
  const said = [first.slice(command[0].length), ...more].join(" ");
  if (/\b(please|pls)\b/i.test(said) && /\b(team|everyone|all|folks|guys|y'?all)\b/i.test(said)) return undefined;
  // A line may also be a sign-off, screenshots, or the author's name signing a thanks: last,
  // capitalised, after a line that thanks ("Thanks,\nPhuc"). "Approve\nmai" is "tomorrow".
  const courteous = more.every(
    (line, index) =>
      isCourtesy(line, names) ||
      isSignOff(line, names) ||
      SCREENSHOTS.test(line) ||
      (index === more.length - 1 && /^\p{Lu}/u.test(line) && /\b(thanks|thank you|thx|cheers)\b/i.test(index === 0 ? first : (more[index - 1] ?? "")) && isName(line, names.author)),
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
  "thanks thank you thx ty cheers kudos please pls cc great good nice well done job work team everyone all folks guys awesome amazing perfect excellent lovely brilliant looks lgtm ship it appreciated much so a lot many congrats congratulations really very again for the this quick turnaround help effort".split(" "),
);
/**
 * A line of screenshots as Jira writes them: "!shot.png!", "!Screenshot 2026-10-08 at
 * 10.15.32.png|thumbnail!". The whole line: text between two "!" inside a sentence is
 * something said ("Approve! But fix the typo in hero.png!").
 */
const SCREENSHOTS = /^(?:![^\s!][^!\n|]*?\.(?:png|jpe?g|gif|webp|svg|bmp)(?:\|[^\s!]*)?!\s*)+$/i;
const POSITIVE_EMOJI = /[\u{1F3FB}-\u{1F3FF}]|👍|🎉|✅|☑️|✔️|🙏|😊|🙂|😀|😃|😄|😁|☺️|🚀|❤️|❤|💯|👏|🥳|✨|🙌|💪|⭐|🌟|️|‍/gu;
/** Jira's own: (y) (/) (*) (on), and the smileys. */
const POSITIVE_EMOTICONS = /\((?:y|\/|\*|on)\)|:-?\)|:-?D|;-?\)/g;
const POSITIVE_SHORTCODES = /:(?:\+1|thumbsup|thumbs_up|tada|white_check_mark|heavy_check_mark|rocket|pray|smile|slightly_smiling_face|blush|heart|clap|100|raised_hands|star|sparkles|muscle|partying_face):/g;
const NAME = /^\p{L}[\p{L}'’.-]*(\s+\p{L}[\p{L}'’.-]*){0,3}$/u;

/** The names an approval may carry: its author's, signing off; the agent's, thanked. */
interface Names {
  author?: string;
  bot?: string;
}

/** A name's words as compared: lowercased, accents and stray punctuation off ("Phúc," is "phuc"). */
function nameWords(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[\s,\-–—]+/)
    .map((word) => word.replace(/^[.'’]+|[.,!'’]+$/g, ""))
    .filter(Boolean);
}
/** What may open an approval before its first word: a positive emoji, emoticon or shortcode. */
const LEADING_COURTESY = new RegExp(`^(?:\\s|${POSITIVE_EMOJI.source}|${POSITIVE_EMOTICONS.source}|${POSITIVE_SHORTCODES.source})+`, "u");

/**
 * The comment's author's own name, or part of it: "Phuc" from "Phuc Truong". Word by word,
 * hyphens too: "— Not-yet" and "— Waiting On Legal" aren't anybody's name.
 */
function isName(text: string, ...people: Array<string | undefined>): boolean {
  const own = new Set(people.flatMap((person) => nameWords(person ?? "")));
  const words = nameWords(text);
  return NAME.test(text.replace(/[.,!]+$/, "")) && words.length > 0 && words.every((word) => own.has(word));
}

/** A sign-off: "— Phuc", "-- Mai Anh". Not "- not before Friday", which is a bullet. */
function isSignOff(line: string, names: Names): boolean {
  const name = line.match(/^(?:—|–|--)\s*(.+)$/)?.[1]?.trim();
  return name !== undefined && isName(name, names.author);
}

/** Courtesy words, positive emoji and punctuation only: "?" isn't courtesy, nor is any other word. */
function isCourtesy(text: string, names: Names): boolean {
  const rest = text
    .replace(POSITIVE_EMOJI, " ")
    .replace(POSITIVE_EMOTICONS, " ")
    .replace(POSITIVE_SHORTCODES, " ")
    // Thanks to someone by name: the agent, or the author ("thanks Scribe!", "thanks phuc").
    .replace(/\b(thanks|thank you|thx|cheers|kudos)\b([\s,]+)([\p{L}][\p{L}'’.-]*(?:\s+[\p{L}][\p{L}'’.-]*){0,2})/giu, (match, thanks: string, _gap: string, words: string) => {
      const parts = words.split(/\s+/);
      for (let count = parts.length; count > 0; count -= 1) {
        if (isName(parts.slice(0, count).join(" "), names.author, names.bot)) return [thanks, ...parts.slice(count)].join(" ");
      }
      return match;
    });
  return rest
    .split(/\s+/)
    .map((token) => token.replace(/^[.,!…:;"'’“”\-–—]+|[.,!…:;"'’“”\-–—]+$/g, "").toLowerCase())
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
    const approval = plainApproval(body, { author: comment.author?.displayName, bot: context?.botName }, botAccountId);
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
