import { fromMarkdown } from "mdast-util-from-markdown";

/**
 * Markdown made safe to render as a web page, without changing what it says.
 *
 * The vault is published as two sites. Both render raw HTML in markdown, and both turn a
 * link into an `href` whatever its scheme. Text nobody vouched for reaches the vault: a
 * question someone typed (a gap note), a PRD attached to a ticket, a draft a model wrote.
 * So an `<img onerror=…>` in a question ran as script on the internal site, and a
 * `[guide](javascript:…)` in a draft went live on both sites.
 *
 * The markdown is parsed the way the sites parse it (CommonMark), and only two kinds of node
 * change: raw HTML, whose `<` becomes `&lt;` (it still reads as `<`), and a link whose target
 * isn't http(s), mailto or relative, which loses its target. Everything else, code above
 * all (fenced, indented, in a list, a span across a line break), is left byte for byte.
 * Regex splitting got both directions wrong: a code span across a line hid live HTML, and an
 * indented fence had its example HTML escaped.
 */
export function inertMarkdown(markdown: string): string {
  const { lessThan, schemes } = unsafeSpans(markdown);
  if (!lessThan.size && !schemes.length) return markdown;
  const cuts = [...schemes].sort((a, b) => a.start - b.start);
  let out = "";
  let at = 0;
  for (let index = 0; index < markdown.length; ) {
    const cut = cuts[at];
    if (cut && cut.start === index) {
      out += "#unsafe-link-removed:";
      index = cut.end;
      at += 1;
      continue;
    }
    out += lessThan.has(index) ? "&lt;" : markdown[index];
    index += 1;
  }
  return out;
}

/** What a draft must not contain, for lint: raw HTML tags and links that aren't to the web. */
export function unsafeMarkup(markdown: string): { html: string[]; links: string[] } {
  const html = new Set<string>();
  const links = new Set<string>();
  walk(fromMarkdown(markdown) as MdNode, (node) => {
    if (node.type === "html") {
      for (const match of String(node.value ?? "").matchAll(/<(!--|\/?[A-Za-z][\w-]*)/g)) html.add(`<${match[1]}`);
      return;
    }
    const scheme = isLinkLike(node) ? unsafeScheme(node.url) : undefined;
    if (scheme) links.add(scheme);
  });
  return { html: [...html], links: [...links] };
}

const SAFE_SCHEMES = new Set(["http", "https", "mailto"]);

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MdNode[];
}

function walk(node: MdNode, visit: (node: MdNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function isLinkLike(node: MdNode): node is MdNode & { url: string } {
  return (node.type === "link" || node.type === "image" || node.type === "definition") && typeof node.url === "string";
}

/** The scheme of a URL that isn't to the web, or undefined for http(s), mailto and relative ones. */
function unsafeScheme(url: string | undefined): string | undefined {
  const scheme = url?.trim().match(/^([a-z][a-z0-9+.-]*):/i)?.[1];
  return scheme && !SAFE_SCHEMES.has(scheme.toLowerCase()) ? scheme : undefined;
}

/** Offsets of every `<` inside raw HTML, and the source span of each unsafe scheme (`javascript:`). */
function unsafeSpans(markdown: string): { lessThan: Set<number>; schemes: Array<{ start: number; end: number }> } {
  const lessThan = new Set<number>();
  const schemes: Array<{ start: number; end: number }> = [];
  walk(fromMarkdown(markdown) as MdNode, (node) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    if (node.type === "html") {
      for (let index = start; index < end; index += 1) if (markdown[index] === "<") lessThan.add(index);
      return;
    }
    const scheme = isLinkLike(node) ? unsafeScheme(node.url) : undefined;
    if (!scheme) return;
    // The target is the last `scheme:` in the node's source: after the label, in
    // `[label](scheme:…)`, `[label]: scheme:…` or `<scheme:…>`.
    const found = markdown.slice(start, end).toLowerCase().lastIndexOf(`${scheme.toLowerCase()}:`);
    if (found >= 0) schemes.push({ start: start + found, end: start + found + scheme.length + 1 });
  });
  return { lessThan, schemes };
}
