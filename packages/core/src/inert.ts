import { parse, postprocess, preprocess } from "micromark";
import { gfm } from "micromark-extension-gfm";
import { directive } from "micromark-extension-directive";
import { math } from "micromark-extension-math";
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
 * The markdown is parsed the way the sites parse it (CommonMark with GFM: Quartz and Starlight
 * both split a table row into cells before reading code spans), and only two things change:
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
  // Each pass parses all of it, so a long page gets fewer: none costs over MAX_PARSED.
  const passes = Math.min(MAX_PASSES, Math.floor(MAX_PARSED / Math.max(markdown.length, 1)));
  let text = markdown;
  for (let pass = 0; pass < passes; pass += 1) {
    const escaped = escapeTablePipes(text);
    const found = scan(escaped);
    if (escaped === text && !found.lessThan.size && !found.targets.length && !found.breaks.size) return text;
    text = rewrite(escaped, found);
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
/** A 1,000,000-character page gets one pass (three readings, about a second), 250,000 four. */
const MAX_PARSED = 1_000_000;
const MAX_DEPTH = 20;
/** A list nested by indentation alone: each line re-reads every level's indent (700 deep: 4 s). */
const MAX_COLUMN = 64;
/** Each is parsed three ways (see READINGS): 3,000 one-line quotes took 4 s. */
const MAX_OPENED = 1_500;
/** `:::` containers left open, each inside the last: 1,000 deep took a second a reading. */
const MAX_NESTED_ASIDES = 20;
const MAX_MARKERS = 1_000;
/** Fenced code isn't parsed for emphasis or links: a long JSON or SQL sample is normal. */
const MAX_MARKERS_IN_CODE = 2_000;
const MAX_MARKERS_IN_ALL = 50_000;
/**
 * Where a text directive may start (`:` before a letter). Each start whose `{…}` never closes
 * re-reads the rest of its paragraph: ":a{#" 10,000 times took 10 s.
 */
const MAX_DIRECTIVES = 200;
const MAX_DIRECTIVES_IN_CODE = 2_000;
const MAX_DIRECTIVES_IN_ALL = 5_000;
const REMOVED = "#unsafe-link-removed";
const SAFE_SCHEMES = new Set(["http", "https", "mailto"]);

const ZERO_WIDTH = "\u200B";

interface Found {
  /** Offsets of every `<` that opens raw HTML or an autolink to a non-web target. */
  lessThan: Set<number>;
  /** Source spans to replace: link targets that aren't to the web, a mermaid block's language. */
  targets: Array<{ start: number; end: number; text: string }>;
  /** Offsets to put a zero-width space before, so Quartz doesn't read the syntax there. */
  breaks: Set<number>;
  html: Set<string>;
  links: Set<string>;
}

/*
 * The internal site is Quartz, and its Obsidian-flavoured plugin turns some text back into
 * HTML after the markdown is parsed, on defaults (quartz/plugins/transformers/ofm.ts, v4):
 * - `==text==` becomes `<span class="text-highlight">${text}</span>` from the DECODED text,
 *   so `==&lt;script>…==`, which inert wrote itself, ran as script;
 * - `![[note|alias]]` puts the alias in `data-embed-alias="${alias}"`, and a broken link
 *   puts it in `<a>${alias}</a>`: a `"` or `<` in it is markup;
 * - an image whose URL ends `.mp4` becomes `<video src="${url}">`: a `"` in the URL is markup;
 * - before parsing, `%%…%%` is cut from the raw text (inside code too), which can join what
 *   is left into a tag, and `[[https://…|a]]` is rewritten into a markdown link nobody parsed;
 * - inside a table, a wikilink's `|` is escaped before parsing, which joins two cells;
 * - mermaid runs with `securityLevel: "loose"`: `click … href "javascript:…"` and `call`.
 * Each is neutralised here, on every page, so a note reads the same in the vault and on
 * both sites (a lesson's approval is signed over its text).
 */
const QUARTZ_HIGHLIGHT = /==([^=]+)==/g;
const QUARTZ_WIKILINK = /!?\[\[([^\[\]\|\#\\]+)?(#+[^\[\]\|\#\\]+)?(\\?\|[^\[\]\#]*)?\]\]/g;
const QUARTZ_TABLE = /^\|([^\n])+\|\n(\|)( ?:?-{3,}:? ?\|)+\n(\|([^\n])+\|\n?)+/gm;
const QUARTZ_TABLE_WIKILINK = /(!?\[\[[^\]]*?\]\]|\[\^[^\]]*?\])/g;
/** Mermaid that can act on a click: Quartz runs it with `securityLevel: "loose"`. */
const MERMAID_ACTIONS = /\b(?:click|call|href|links?)\b|javascript\s*:/i;
/** Tokens whose text Quartz doesn't read as a note's text: a URL, code, raw HTML. */
const NOT_TEXT = new Set(["resource", "definition", "codeText", "codeFenced", "codeIndented", "htmlFlow", "htmlText", "autolink", "literalAutolink", "literalAutolinkEmail", "literalAutolinkHttp", "literalAutolinkWww", "mathText", "mathFlow"]);
/**
 * The ways the sites parse. Starlight reads GFM and `:::` directives (its asides); Quartz
 * reads GFM and `$…$` math, which pairs backticks differently (`` $`$ <img …> ` `` is a code
 * span to one, math and a live tag to the other). And plain GFM, as a renderer with neither
 * does: `:x{a="$<img …>$"}` is a directive's attribute to one reading and math to the other,
 * and a live tag only to the reading with neither. Unsafe in any reading is unsafe.
 */
const READINGS: Array<Array<ReturnType<typeof gfm>>> = [[gfm()], [gfm(), directive()], [gfm(), math()]];
/** Where one text node ends and the next begins, give or take: a block, a table cell. */
const TEXT_ENDS = new Set(["paragraph", "atxHeading", "setextHeading", "tableData", "tableHeader", "tableRow"]);

/**
 * One parse, read as micromark's flat event list: no recursion, however deep the nesting,
 * and the exact source span of every link target, whatever the title says.
 */
function scan(markdown: string): Found {
  const found: Found = { lessThan: new Set(), targets: [], breaks: new Set(), html: new Set(), links: new Set() };
  for (const extensions of READINGS) read(markdown, extensions, found);
  quartzSource(markdown, found);
  return found;
}

function read(markdown: string, extensions: Array<ReturnType<typeof gfm>>, found: Found): void {
  const events = postprocess(parse({ extensions }).document().write(preprocess()(markdown, undefined, true)));
  // micromark skips a leading byte-order mark and counts from after it: every offset was one
  // short, and `[x](javascript:…)` was read from its `(`, which has no scheme.
  const shift = markdown.charCodeAt(0) === 0xfeff ? 1 : 0;
  let run = { text: "", at: [] as number[] };
  const endRun = (): void => {
    quartzText(run, found);
    run = { text: "", at: [] };
  };
  let notText = 0;
  let mermaid: { info?: { start: number; end: number }; code: string } | undefined;
  for (const [kind, token] of events) {
    const start = token.start.offset + shift;
    const end = token.end.offset + shift;
    if (TEXT_ENDS.has(token.type)) endRun();
    if (NOT_TEXT.has(token.type)) notText += kind === "enter" ? 1 : -1;
    if (token.type === "codeFenced") {
      if (kind === "enter") mermaid = { code: "" };
      else {
        if (mermaid?.info && MERMAID_ACTIONS.test(mermaid.code)) found.targets.push({ ...mermaid.info, text: "text" });
        mermaid = undefined;
      }
    }
    if (kind !== "enter") continue;
    const source = markdown.slice(start, end);
    if (token.type === "codeFencedFenceInfo" && mermaid && !mermaid.info && /^mermaid$/i.test(source.trim())) mermaid.info = { start, end };
    else if (token.type === "codeFlowValue" && mermaid?.info) mermaid.code += `${source}\n`;
    else if (token.type === "htmlFlow" || token.type === "htmlText") {
      for (let index = start; index < end; index += 1) if (markdown[index] === "<") found.lessThan.add(index);
      for (const match of source.matchAll(/<(!--|\/?[A-Za-z][\w-]*)/g)) found.html.add(`<${match[1]}`);
    } else if (token.type === "resourceDestinationString" || token.type === "definitionDestinationString") {
      // The target as the browser gets it: `java&#115;cript:` and `javascript\:` are `javascript:`.
      const url = decodeString(source);
      const scheme = unsafeScheme(url);
      // And as Quartz writes it into an attribute (`<video src="${url}">`): a quote ends it.
      const quoted = /["'<>`]/.test(url);
      if (scheme || quoted) {
        found.targets.push({ start, end, text: REMOVED });
        found.links.add(scheme ? `${scheme}:` : "a URL holding a quote or angle bracket");
      }
    } else if (token.type === "autolinkProtocol") {
      // `<javascript:…>` becomes text, as written.
      const scheme = unsafeScheme(source);
      if (scheme) {
        found.lessThan.add(start - 1);
        found.links.add(`${scheme}:`);
      }
    } else if (!notText && token.type === "data") {
      for (let index = 0; index < source.length; index += 1) {
        run.text += source[index];
        run.at.push(start + index);
      }
    } else if (!notText && (token.type === "characterEscape" || token.type === "characterReference")) {
      // One character of text, decoded, at the escape's own place.
      for (const char of decodeString(source)) {
        run.text += char;
        run.at.push(start);
      }
    } else if (!notText && token.type === "lineEnding") {
      run.text += "\n";
      run.at.push(start);
    }
  }
  endRun();
}

/** What Quartz finds in one text node's decoded text, and would write out as HTML. */
function quartzText(run: { text: string; at: number[] }, found: Found): void {
  for (const match of run.text.matchAll(QUARTZ_HIGHLIGHT)) {
    const second = run.at[match.index + 1];
    if (match[1]?.includes("<") && second !== undefined) found.breaks.add(second);
  }
  for (const match of run.text.matchAll(QUARTZ_WIKILINK)) {
    const second = run.at[match.index + (match[0].startsWith("!") ? 2 : 1)];
    if (/["<>]/.test(match[0]) && second !== undefined) found.breaks.add(second);
  }
}

/** What Quartz rewrites in the raw text before parsing it, code blocks included. */
function quartzSource(markdown: string, found: Found): void {
  if (/%%[\s\S]*?%%/.test(markdown)) {
    for (let index = markdown.indexOf("%%"); index >= 0; index = markdown.indexOf("%%", index + 1)) found.breaks.add(index + 1);
  }
  for (const match of markdown.matchAll(QUARTZ_WIKILINK)) {
    if (/^https?:\/\//i.test(match[1] ?? "")) found.breaks.add(match.index + (match[0].startsWith("!") ? 2 : 1));
  }
}

/**
 * A wikilink's `|` inside a table, escaped as Quartz escapes it before parsing (it joins the
 * cells either side): then this parse and Quartz's read the same row. Idempotent.
 */
function escapeTablePipes(markdown: string): string {
  if (!markdown.includes("[")) return markdown;
  return markdown.replace(QUARTZ_TABLE, (table) => table.replace(QUARTZ_TABLE_WIKILINK, (link) => link.replace(/((^|[^\\])(\\\\)*)\|/g, "$1\\|")));
}

/**
 * Why parsing this would hold the process for seconds, or undefined. micromark parses some
 * shapes in quadratic time, and the limits below bound each one, far past what a person
 * writes:
 * - closing a quote or a list costs in proportion to all that came before it: 8,000
 *   one-line quotes took 1.6 s, and `- - - …` 25,000 long on one line 9 s. Counted: the
 *   quotes and lists each line opens (a flat list's next item, or a quote's next line, opens
 *   none);
 * - a paragraph dense with emphasis markers or brackets (`*_*_…`, `~~a~~a…`, `[a]([a](…`)
 *   costs their number squared. Counted per paragraph, and in all.
 */
function tooCostly(markdown: string): string | undefined {
  if (markdown.length > MAX_PARSED) return `it is over ${MAX_PARSED} characters long`;
  let fence: { char: string; length: number } | undefined;
  let before: string[] = [];
  let opened = 0;
  // The colons of each `:::` container still open: a closer shorter than its opener closes nothing.
  const asides: number[] = [];
  let markers = 0;
  let brackets = 0;
  let directives = 0;
  let allMarkers = 0;
  let allBrackets = 0;
  let allDirectives = 0;
  // Lines as micromark ends them: a lone CR is a line ending too, and split on LF alone a
  // whole document of CR lines was one line, past every limit here.
  for (const line of markdown.split(/\r\n?|\n/)) {
    const containers = containerMarkers(line);
    if (containers.length > MAX_DEPTH) return `a line opens over ${MAX_DEPTH} quotes or lists`;
    if (Number.parseInt(containers.at(-1) ?? "0", 10) > MAX_COLUMN) return `a quote or list is indented over ${MAX_COLUMN} columns`;
    // Carried on from the line before: a quote whose `>` repeats in place, and a list with a
    // new item in place (what was inside its last item is closed, so all after it is new).
    let carried = 0;
    while (carried < containers.length && containers[carried] === before[carried]) {
      carried += 1;
      if (!containers[carried - 1]?.endsWith(">")) break;
    }
    opened += containers.length - carried;
    if (opened > MAX_OPENED) return `it opens over ${MAX_OPENED} quotes or lists`;
    // A `:::name` opens a directive container (Starlight's asides), and a bare `:::` at least as
    // long closes the last one. Read past any quote or list markers: inside a quote, as every
    // line of a gap note's question is, they nest just the same.
    const content = line.slice(line.match(/^(?:[ \t]*(?:>|[*+-](?=[ \t]|$)|\d{1,9}[.)](?=[ \t]|$)))*/)?.[0].length ?? 0);
    const aside = content.match(/^\s*(:{3,})\s*([\p{L}{[])?/u);
    if (aside?.[2]) asides.push(aside[1]?.length ?? 3);
    else if (aside && /^\s*:{3,}\s*$/.test(content) && (aside[1]?.length ?? 0) >= (asides.at(-1) ?? Number.POSITIVE_INFINITY)) asides.pop();
    if (asides.length > MAX_NESTED_ASIDES) return `it nests over ${MAX_NESTED_ASIDES} ::: blocks`;
    // A blank line ends every quote; a list goes on past it.
    if (line.trim()) before = containers;
    else if (before.some((marker) => marker.endsWith(">"))) before = before.slice(0, before.findIndex((marker) => marker.endsWith(">")));

    const [, run, info = ""] = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/) ?? [];
    if (fence) {
      if (run?.startsWith(fence.char) && run.length >= fence.length && !info.trim()) {
        fence = undefined;
        markers = brackets = directives = 0;
        continue;
      }
    } else if (run && !(run.startsWith("`") && info.includes("`"))) {
      fence = { char: run.charAt(0), length: run.length };
      markers = brackets = directives = 0;
      continue;
    } else if (!line.trim() || /^ {0,3}(?:[*+-]|1[.)])[ \t]+\S|^ {0,3}#{1,6}(?:[ \t]|$)/.test(line)) {
      // A new paragraph: after a blank line, or where an item or a heading interrupts one.
      // (Only a bullet or a `1.` can: a `2.` line inside a paragraph continues it.)
      markers = brackets = directives = 0;
    }
    // Emphasis and strikethrough. An `_` inside a word (snake_case) can't be emphasis, and costs nothing.
    const lineMarkers = line.match(/[*~]|(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu)?.length ?? 0;
    const lineBrackets = line.match(/[[\]]/g)?.length ?? 0;
    const lineDirectives = line.match(/:(?=\p{L})/gu)?.length ?? 0;
    markers += lineMarkers;
    brackets += lineBrackets;
    directives += lineDirectives;
    allMarkers += lineMarkers;
    allBrackets += lineBrackets;
    allDirectives += lineDirectives;
    // Counted in code too, against a higher limit: a line that opens a fence inside an HTML
    // block opens nothing, and what follows is parsed.
    const limit = fence ? MAX_MARKERS_IN_CODE : MAX_MARKERS;
    if (markers > limit) return `a paragraph has over ${limit} *, _ and ~`;
    if (brackets > limit) return `a paragraph has over ${limit} brackets`;
    if (allMarkers > MAX_MARKERS_IN_ALL) return `it has over ${MAX_MARKERS_IN_ALL} *, _ and ~`;
    if (allBrackets > 2 * MAX_MARKERS_IN_ALL) return `it has over ${2 * MAX_MARKERS_IN_ALL} brackets`;
    if (directives > (fence ? MAX_DIRECTIVES_IN_CODE : MAX_DIRECTIVES)) return `a paragraph has over ${fence ? MAX_DIRECTIVES_IN_CODE : MAX_DIRECTIVES} colons before a letter`;
    if (allDirectives > MAX_DIRECTIVES_IN_ALL) return `it has over ${MAX_DIRECTIVES_IN_ALL} colons before a letter`;
  }
  return undefined;
}

/** The quote and list markers a line opens with, each as its column and kind (`4>`, `0-`, `2.`). */
function containerMarkers(line: string): string[] {
  const prefix = line.match(/^(?:[ \t]*(?:>|[*+-](?=[ \t\r]|$)|\d{1,9}[.)](?=[ \t\r]|$)))*/)?.[0] ?? "";
  return Array.from(prefix.matchAll(/>|[*+-]|\d{1,9}([.)])/g), (match) => `${match.index}${match[1] ?? match[0]}`);
}

function rewrite(markdown: string, { lessThan, targets, breaks }: Found): string {
  const ordered = [...targets].sort((a, b) => a.start - b.start);
  let out = "";
  let at = 0;
  for (let index = 0; index < markdown.length; ) {
    // The same target, found by both readings, is replaced once.
    while (ordered[at] && (ordered[at]?.start ?? 0) < index) at += 1;
    const target = ordered[at];
    if (target && target.start === index) {
      out += target.text;
      index = target.end;
      at += 1;
      continue;
    }
    if (breaks.has(index)) out += ZERO_WIDTH;
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
  if (fence === undefined || !markdown.endsWith(`\n${fence}\n`)) return false;
  const inside = markdown.slice(fence.length + 1, -(fence.length + 2));
  return !inside.includes(fence) && quartzSafe(inside) === inside;
}

/**
 * The whole text as one fenced code block, the fence longer than any backtick run in it.
 * First what Quartz rewrites in the raw text, code included, before parsing: cutting a
 * `%%…%%` from "```%%x%%```" made a run of six that closed a fence of four, and what
 * followed rendered.
 */
function asCode(markdown: string): string {
  const inside = quartzSafe(markdown);
  let longest = 2;
  for (const run of inside.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${inside}\n${fence}\n`;
}

/** The raw text with nothing left for Quartz to rewrite before it parses: no `%%` pair, no external wikilink, table pipes escaped. */
function quartzSafe(markdown: string): string {
  const found: Found = { lessThan: new Set(), targets: [], breaks: new Set(), html: new Set(), links: new Set() };
  quartzSource(markdown, found);
  return escapeTablePipes(found.breaks.size ? rewrite(markdown, found) : markdown);
}
