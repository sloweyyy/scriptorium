/**
 * Markdown → Slack mrkdwn, and the blocks Curator answers in.
 *
 * Slack does not speak the markdown the model writes. It has its own dialect — `*bold*`
 * with one asterisk, `<url|label>` for links, no headings at all — so a model answer
 * pasted straight into `text` arrives with its syntax showing: a question about the vault
 * came back reading "there are **6** documents", asterisks and all. Every claim in that
 * answer was correct and the whole thing looked broken.
 *
 * Two rules shape this file. Convert only what Slack actually renders differently, and
 * never convert inside code — a fenced block or a backtick span is quoted text, and
 * rewriting a `**` that a user asked to see verbatim is worse than leaving one unrendered.
 */

/** Wikilinks are vault syntax. In Slack they are noise, so they become quoted paths. */
const WIKILINK = /\[\[([^\]]+)\]\]/g;

/**
 * A trailing sources line, however the model chose to phrase it. Citations are rendered
 * from the parsed list into their own block, so leaving the model's version in duplicates
 * them — and the model's version is the one carrying raw `[[wikilink]]` syntax.
 */
const TRAILING_SOURCES = /\n+\s*_?(?:\*\*)?sources?(?:\*\*)?:?_?\s*[^\n]*$/i;

/** Split on fenced blocks, keeping the fences, so conversion can skip their contents. */
function splitFences(markdown: string): Array<{ code: boolean; text: string }> {
  const parts: Array<{ code: boolean; text: string }> = [];
  const fence = /```[\s\S]*?(?:```|$)/g;
  let last = 0;
  for (const match of markdown.matchAll(fence)) {
    if (match.index > last) parts.push({ code: false, text: markdown.slice(last, match.index) });
    parts.push({ code: true, text: match[0] });
    last = match.index + match[0].length;
  }
  if (last < markdown.length) parts.push({ code: false, text: markdown.slice(last) });
  return parts;
}

/** Same idea one level down: leave `code spans` alone within a non-code run. */
function outsideCodeSpans(text: string, convert: (chunk: string) => string): string {
  return text
    .split(/(`[^`\n]*`)/)
    .map((chunk) => (chunk.startsWith("`") && chunk.endsWith("`") && chunk.length > 1 ? chunk : convert(chunk)))
    .join("");
}

function convertRun(text: string): string {
  return (
    text
      // Links first: their bracket syntax overlaps with everything below.
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>")
      // Headings have no equivalent — bold is the closest thing Slack renders.
      .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
      // Bold before italic, and `__x__` before `_x_`, or the shorter rule eats the longer.
      .replace(/\*\*\*([^*\n]+)\*\*\*/g, "*_$1_*")
      .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
      .replace(/__([^_\n]+)__/g, "*$1*")
      // Markdown's `- ` and `* ` bullets both render as literal characters in Slack.
      .replace(/^(\s*)[-*]\s+/gm, "$1• ")
      // Slack strikethrough is single-tilde.
      .replace(/~~([^~\n]+)~~/g, "~$1~")
  );
}

/** The whole conversion: fences preserved, code spans preserved, everything else Slack's. */
export function toSlackMrkdwn(markdown: string): string {
  return splitFences(markdown.replace(TRAILING_SOURCES, ""))
    .map((part) => (part.code ? part.text : outsideCodeSpans(part.text, convertRun)))
    .join("")
    .replace(WIKILINK, "`$1`")
    .trim();
}

/** Slack rejects an mrkdwn text object over this, so a long answer is cut, not dropped. */
const MRKDWN_LIMIT = 3_000;

function clamp(text: string, limit = MRKDWN_LIMIT): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 2)}…`;
}

export interface AnswerBlocksInput {
  /** The model's answer, in markdown. */
  markdown: string;
  /** Vault-relative note paths the answer relied on. */
  citations: string[];
}

/**
 * Answer as a section, sources as a context block.
 *
 * The distinction is the point: a context block renders small and muted, which is what
 * provenance should look like — always present, never competing with the answer. Running
 * both together as one italic line made the citations read like part of the claim.
 */
export function answerBlocks({ markdown, citations }: AnswerBlocksInput): unknown[] {
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: clamp(toSlackMrkdwn(markdown)) } },
  ];

  // No citation is not a formatting case — it is the fail-closed rule having been broken,
  // so it is stated rather than left as a silently absent footer.
  const sources = citations.length
    ? `📚 ${citations.map((citation) => `\`${citation}\``).join("  ")}`
    : "⚠️ No source cited — treat this answer as unverified.";

  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: clamp(sources) }] });
  return blocks;
}

/** One line of muted status text — what a progress bubble is made of. */
export function contextBlocks(text: string): unknown[] {
  return [{ type: "context", elements: [{ type: "mrkdwn", text: clamp(text) }] }];
}

export interface ProgressLineInput {
  searches: number;
  reads: number;
  elapsedMs: number;
}

/** `⏳ Searching the vault… 2 searches · 1 note read · 6s` */
export function progressLine({ searches, reads, elapsedMs }: ProgressLineInput): string {
  const seconds = Math.max(1, Math.round(elapsedMs / 1000));
  const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const parts = [
    searches ? `${searches} search${searches === 1 ? "" : "es"}` : undefined,
    reads ? `${reads} note${reads === 1 ? "" : "s"} read` : undefined,
    elapsed,
  ].filter((part): part is string => Boolean(part));
  // The verb changes with what it is actually doing, so a stalled bubble is legible: still
  // "searching" after 20s means the vault has nothing, not that the answer is nearly ready.
  const verb = reads ? "Reading the vault" : "Searching the vault";
  return `⏳ ${verb}… ${parts.join(" · ")}`;
}
