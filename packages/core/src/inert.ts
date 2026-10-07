import { parse, postprocess, preprocess } from "micromark";
import { decodeString } from "micromark-util-decode-string";

/**
 * Markdown made safe to render as a web page, without changing what it says.
 *
 * The vault is published as two sites. Both render raw HTML in markdown, and both turn a
 * link into an `href` whatever its scheme. Text nobody vouched for reaches the vault: a
 * question someone typed (a gap note), a PRD attached to a ticket, a draft a model wrote.
 * So an `<img onerror=…>` in a question ran as script on the internal site, and a
 * `[guide](javascript:…)` in a draft went live on both sites.
 *
 * The markdown is parsed the way the sites parse it (CommonMark), and only two things change:
 * raw HTML, whose `<` becomes `&lt;` (it still reads as `<`), and a link whose target isn't
 * http(s), mailto or relative, which loses its target. Everything else, code above all
 * (fenced, indented, in a list, a span across a line break), is left byte for byte.
 *
 * Escaping changes how the rest parses: an HTML block, once escaped, is a paragraph whose
 * links are live, and a backtick inside an escaped tag can pair with one that was guarding
 * a tag in code. So it runs again until a pass finds nothing. Text still unsafe after a few
 * passes, or too costly to parse, is kept whole as a code block, where nothing renders.
 */
export function inertMarkdown(markdown: string): string {
  if (tooCostly(markdown)) return isCode(markdown) ? markdown : asCode(markdown);
  let text = markdown;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const found = scan(text);
    if (!found.lessThan.size && !found.targets.length) return text;
    text = rewrite(text, found);
  }
  return asCode(markdown);
}

/**
 * What a draft must not contain, for lint: raw HTML tags, links that aren't to the web, and
 * a shape too costly to check (which would be published as a code block).
 */
export function unsafeMarkup(markdown: string): { html: string[]; links: string[]; tooCostly?: string } {
  const costly = tooCostly(markdown);
  if (costly) return { html: [], links: [], tooCostly: costly };
  const { html, links } = scan(markdown);
  return { html: [...html], links: [...links] };
}

/** Real text is inert after a pass or two; a further one only follows a deliberate chain. */
const MAX_PASSES = 4;
const MAX_LENGTH = 100_000;
const MAX_DEPTH = 20;
const MAX_CONTAINERS = 3_000;
const MAX_MARKERS = 1_000;
/** Fenced code isn't parsed for emphasis or links: a long JSON or SQL sample is normal. */
const MAX_MARKERS_IN_CODE = 2_000;
const REMOVED = "#unsafe-link-removed";
const SAFE_SCHEMES = new Set(["http", "https", "mailto"]);

interface Found {
  /** Offsets of every `<` that opens raw HTML or an autolink to a non-web target. */
  lessThan: Set<number>;
  /** Source spans of link targets that aren't to the web, in order. */
  targets: Array<{ start: number; end: number }>;
  html: Set<string>;
  links: Set<string>;
}

/**
 * One parse, read as micromark's flat event list: no recursion, however deep the nesting,
 * and the exact source span of every link target, whatever the title says.
 */
function scan(markdown: string): Found {
  const found: Found = { lessThan: new Set(), targets: [], html: new Set(), links: new Set() };
  const events = postprocess(parse().document().write(preprocess()(markdown, undefined, true)));
  for (const [kind, token] of events) {
    if (kind !== "enter") continue;
    const start = token.start.offset;
    const end = token.end.offset;
    const source = markdown.slice(start, end);
    if (token.type === "htmlFlow" || token.type === "htmlText") {
      for (let index = start; index < end; index += 1) if (markdown[index] === "<") found.lessThan.add(index);
      for (const match of source.matchAll(/<(!--|\/?[A-Za-z][\w-]*)/g)) found.html.add(`<${match[1]}`);
    } else if (token.type === "resourceDestinationString" || token.type === "definitionDestinationString") {
      // The target as the browser gets it: `java&#115;cript:` and `javascript\:` are `javascript:`.
      const scheme = unsafeScheme(decodeString(source));
      if (scheme) {
        found.targets.push({ start, end });
        found.links.add(scheme);
      }
    } else if (token.type === "autolinkProtocol") {
      // `<javascript:…>` becomes text, as written.
      const scheme = unsafeScheme(source);
      if (scheme) {
        found.lessThan.add(start - 1);
        found.links.add(scheme);
      }
    }
  }
  return found;
}

/**
 * Why parsing this would hold the process for seconds, or undefined. micromark parses some
 * shapes in quadratic time: many quotes or lists (`- - - …` 25,000 long on one line took 9 s,
 * and 8,000 one-line quotes 1.6 s), and a paragraph dense with emphasis markers or brackets
 * (`*_*_…`, `[a]([a](…`). Each
 * limit is far past what a person writes; within them the worst text takes well under a
 * second a pass.
 */
function tooCostly(markdown: string): string | undefined {
  if (markdown.length > MAX_LENGTH) return `it is over ${MAX_LENGTH} characters long`;
  let fence: { char: string; length: number } | undefined;
  let containers = 0;
  let markers = 0;
  let brackets = 0;
  for (const line of markdown.split("\n")) {
    // Quote and list markers, each opening a container: a rule of dashes or a run of spaces opens none.
    const depth = line.match(/^(?:[ \t]*(?:>|[*+-](?=[ \t\r]|$)|\d{1,9}[.)](?=[ \t\r]|$)))*/)?.[0].match(/>|[*+-]|\d{1,9}[.)]/g)?.length ?? 0;
    if (depth > MAX_DEPTH) return `a line opens over ${MAX_DEPTH} quotes or lists`;
    // Closing one costs time in proportion to what came before: 8,000 one-line quotes took 1.6 s.
    containers += depth;
    if (containers > MAX_CONTAINERS) return `it has over ${MAX_CONTAINERS} quote and list markers`;
    const [, run, info = ""] = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/) ?? [];
    if (fence) {
      if (run?.startsWith(fence.char) && run.length >= fence.length && !info.trim()) {
        fence = undefined;
        markers = brackets = 0;
        continue;
      }
    } else if (run && !(run.startsWith("`") && info.includes("`"))) {
      fence = { char: run.charAt(0), length: run.length };
      markers = brackets = 0;
      continue;
    } else if (!line.trim() || /^ {0,3}(?:[*+-]|1[.)])[ \t]+\S|^ {0,3}#{1,6}(?:[ \t]|$)/.test(line)) {
      // A new paragraph: after a blank line, or where an item or a heading interrupts one.
      // (Only a bullet or a `1.` can: a `2.` line inside a paragraph continues it.)
      markers = brackets = 0;
    }
    // An `_` inside a word (snake_case) can't be emphasis, and costs nothing.
    markers += line.match(/\*|(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu)?.length ?? 0;
    brackets += line.match(/[[\]]/g)?.length ?? 0;
    // Counted in code too, against a higher limit: a line that opens a fence inside an HTML
    // block opens nothing, and what follows is parsed.
    const limit = fence ? MAX_MARKERS_IN_CODE : MAX_MARKERS;
    if (markers > limit) return `a paragraph has over ${limit} * and _`;
    if (brackets > limit) return `a paragraph has over ${limit} brackets`;
  }
  return undefined;
}

function rewrite(markdown: string, { lessThan, targets }: Found): string {
  let out = "";
  let at = 0;
  for (let index = 0; index < markdown.length; ) {
    const target = targets[at];
    if (target && target.start === index) {
      out += REMOVED;
      index = target.end;
      at += 1;
      continue;
    }
    out += lessThan.has(index) ? "&lt;" : markdown[index];
    index += 1;
  }
  return out;
}

/** The scheme of a URL that isn't to the web, or undefined for http(s), mailto and relative ones. */
function unsafeScheme(url: string): string | undefined {
  // As a browser reads it: tabs and newlines anywhere are dropped, controls and spaces at the ends.
  const cleaned = url.replace(/[\t\n\r]/g, "").replace(/^[\u0000- ]+|[\u0000- ]+$/g, "");
  const scheme = cleaned.match(/^([a-z][a-z0-9+.-]*):/i)?.[1];
  return scheme && !SAFE_SCHEMES.has(scheme.toLowerCase()) ? scheme : undefined;
}

/** Text that is already one code block, as `asCode` writes it: nothing inside can close it. */
function isCode(markdown: string): boolean {
  const fence = markdown.match(/^(`{3,})\n/)?.[1];
  return fence !== undefined && markdown.endsWith(`\n${fence}\n`) && !markdown.slice(fence.length + 1, -(fence.length + 2)).includes(fence);
}

/** The whole text as one fenced code block, the fence longer than any backtick run in it. */
function asCode(markdown: string): string {
  let longest = 2;
  for (const run of markdown.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${markdown}\n${fence}\n`;
}
