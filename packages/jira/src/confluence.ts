/**
 * Reading a PRD out of Confluence.
 *
 * PMs keep PRDs in Confluence, not as `.md` attachments — asking them to export one is
 * asking them to change how they work before the agent will talk to them. The ticket
 * usually already points at the page: Jira and Confluence on the same site create a
 * remote issue link the moment a page is linked, and failing that the URL sits in the
 * description. Both are readable with the credentials the agent already holds, because
 * one Atlassian API token authenticates to `/wiki` on the same site.
 *
 * This file is the two deterministic halves of that: recognising a Confluence page URL,
 * and turning the page's storage-format XHTML into the markdown the pipeline speaks.
 * The conversion is for the model to read, not for humans to admire — it preserves
 * structure (headings, lists, tables, code) and drops decoration, and it is pinned by
 * evals precisely because "mostly right HTML scraping" is where silent garbage enters
 * a pipeline.
 */

/** `/wiki/spaces/KEY/pages/123456/Title`, `/wiki/pages/viewpage.action?pageId=123456`. */
export function confluencePageIdFromUrl(url: string): string | undefined {
  const spaces = url.match(/\/wiki\/spaces\/[^/]+\/pages\/(\d+)/);
  if (spaces?.[1]) return spaces[1];
  const pageId = url.match(/[?&]pageId=(\d+)/);
  if (pageId?.[1]) return pageId[1];
  return undefined;
}

/** Every Confluence page URL found in a blob of text, in order, de-duplicated by page id. */
export function confluencePageIdsIn(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s|\]")>]+/g)) {
    const id = confluencePageIdFromUrl(match[0]);
    if (id) seen.add(id);
  }
  return [...seen];
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "—",
  hellip: "…",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match);
}

/** Inline conversion: emphasis, code and links inside one block of storage XHTML. */
function inline(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<(?:strong|b)>([\s\S]*?)<\/(?:strong|b)>/gi, "**$1**")
      .replace(/<(?:em|i)>([\s\S]*?)<\/(?:em|i)>/gi, "_$1_")
      .replace(/<code>([\s\S]*?)<\/code>/gi, "`$1`")
      .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
      // Confluence's own link element: keep the readable part, drop the plumbing.
      .replace(/<ac:link[^>]*>[\s\S]*?<ac:plain-text-link-body>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/ac:plain-text-link-body>[\s\S]*?<\/ac:link>/gi, "$1")
      .replace(/<ac:link[^>]*>([\s\S]*?)<\/ac:link>/gi, "$1")
      // Anything still standing is decoration this converter does not speak.
      .replace(/<[^>]+>/g, ""),
  ).trim();
}

/** One `<tr>` into a markdown table row; header and body cells alike. */
function tableRow(rowHtml: string): string {
  const cells = [...rowHtml.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cell) =>
    inline(cell[1] ?? "").replace(/\n+/g, " "),
  );
  return `| ${cells.join(" | ")} |`;
}

/**
 * Find one balanced `<ul>…</ul>` / `<ol>…</ol>` starting at `start`. A lazy regex stops
 * at the *first* closing tag, which for a nested list is the inner one's — so nesting is
 * walked by counting opens and closes instead.
 */
function balancedList(html: string, start: number): { end: number; inner: string; ordered: boolean } | undefined {
  const open = html.slice(start).match(/^<(ul|ol)[^>]*>/i);
  if (!open?.[1]) return undefined;
  const tag = open[1].toLowerCase();
  const scanner = new RegExp(`<${tag}[^>]*>|</${tag}>`, "gi");
  scanner.lastIndex = start;
  let depth = 0;
  for (let match = scanner.exec(html); match; match = scanner.exec(html)) {
    depth += match[0][1] === "/" ? -1 : 1;
    if (depth === 0) {
      return {
        end: scanner.lastIndex,
        inner: html.slice(start + open[0].length, match.index),
        ordered: tag === "ol",
      };
    }
  }
  return undefined;
}

/** Split a list's inner HTML into its DIRECT `<li>` bodies, leaving nested lists intact inside them. */
function listItems(inner: string): string[] {
  const items: string[] = [];
  const scanner = /<li[^>]*>|<\/li>/gi;
  let depth = 0;
  let openedAt = -1;
  for (let match = scanner.exec(inner); match; match = scanner.exec(inner)) {
    if (match[0][1] !== "/") {
      depth += 1;
      if (depth === 1) openedAt = scanner.lastIndex;
    } else {
      if (depth === 1 && openedAt >= 0) items.push(inner.slice(openedAt, match.index));
      depth = Math.max(0, depth - 1);
    }
  }
  return items;
}

function list(inner: string, ordered: boolean, depth = 0): string {
  return listItems(inner)
    .map((item, index) => {
      let body = item;
      const nested: string[] = [];
      // Pull nested lists out before inlining, or their bullets flatten into the text.
      for (let at = body.search(/<(?:ul|ol)[^>]*>/i); at >= 0; at = body.search(/<(?:ul|ol)[^>]*>/i)) {
        const sub = balancedList(body, at);
        if (!sub) break;
        nested.push(list(sub.inner, sub.ordered, depth + 1));
        body = body.slice(0, at) + body.slice(sub.end);
      }
      const marker = ordered ? `${index + 1}.` : "-";
      const line = `${"  ".repeat(depth)}${marker} ${inline(body).replace(/\n+/g, " ")}`;
      return [line, ...nested].join("\n");
    })
    .join("\n");
}

/**
 * Storage-format XHTML → markdown, block by block.
 *
 * Code macros come first because their CDATA payload must never be entity-decoded or
 * tag-stripped — a PRD's example payload is exactly the text to preserve verbatim.
 */
export function confluenceStorageToMarkdown(storage: string): string {
  const blocks: string[] = [];
  let html = storage.replace(/\r\n/g, "\n");

  const protect = (text: string): string => {
    blocks.push(text);
    return `\u0000${blocks.length - 1}\u0000`;
  };

  html = html
    .replace(
      /<ac:structured-macro[^>]*ac:name="(?:code|noformat)"[^>]*>[\s\S]*?<ac:plain-text-body>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/ac:plain-text-body>[\s\S]*?<\/ac:structured-macro>/gi,
      (_match, code: string) => protect(["```", code.replace(/\n+$/, ""), "```"].join("\n")),
    )
    // Info/note/warning panels: keep the content, mark it as a quote.
    .replace(
      /<ac:structured-macro[^>]*ac:name="(?:info|note|warning|tip|panel)"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi,
      (_match, body: string) => protect(`> ${inline(body).replace(/\n+/g, "\n> ")}`),
    )
    // Any other macro, innermost first: its rich-text body is content (an `expand`, a page
    // properties `details` table), everything else about it (parameters, an issue embed)
    // is chrome. A match never spans another macro's start, so a self-closing `toc` can't
    // pair with a later macro's closing tag: that pairing deleted a PRD's whole Requirements
    // section, and deleting whole macros dropped "Must NOT email users on import." too.
    .replace(/[\s\S]*/, (whole) => {
      const innermost = /<ac:structured-macro\b[^>]*>((?:(?!<ac:structured-macro\b)[\s\S])*?)<\/ac:structured-macro>/gi;
      let text = whole;
      for (let previous = ""; previous !== text; ) {
        previous = text;
        text = text.replace(innermost, (_match, inner: string) => inner.match(/<ac:rich-text-body>([\s\S]*?)<\/ac:rich-text-body>/i)?.[1] ?? "");
      }
      return text;
    })
    .replace(/<ac:image[\s\S]*?(?:\/>|<\/ac:image>)/gi, "")
    .replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_match, table: string) => {
      const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) => tableRow(row[1] ?? ""));
      if (!rows.length) return "";
      const width = (rows[0]?.match(/\|/g)?.length ?? 1) - 1;
      const divider = `|${" --- |".repeat(Math.max(width, 1))}`;
      return protect([rows[0], divider, ...rows.slice(1)].join("\n"));
    })
    .replace(/[\s\S]*/, (whole) => {
      // Lists are lifted by the balanced scanner, not a lazy regex — see balancedList.
      let out = "";
      let cursor = 0;
      for (let at = whole.search(/<(?:ul|ol)[^>]*>/i); at >= 0; ) {
        const absolute = cursor + at;
        const sub = balancedList(whole, absolute);
        if (!sub) break;
        out += whole.slice(cursor, absolute) + protect(list(sub.inner, sub.ordered));
        cursor = sub.end;
        at = whole.slice(cursor).search(/<(?:ul|ol)[^>]*>/i);
      }
      return out + whole.slice(cursor);
    })
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level: string, text: string) =>
      protect(`${"#".repeat(Number(level))} ${inline(text)}`),
    )
    .replace(/<hr\s*\/?>/gi, () => protect("---"))
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_match, body: string) =>
      protect(`> ${inline(body).replace(/\n+/g, "\n> ")}`),
    )
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_match, body: string) => {
      const text = inline(body);
      return text ? protect(text) : "";
    });

  const flattened = inline(html);
  const restored = (flattened.length ? flattened : html)
    .replace(/\u0000(\d+)\u0000/g, (_match, index: string) => `\n\n${blocks[Number(index)] ?? ""}\n\n`)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return restored;
}
