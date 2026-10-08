import { describe, expect, it } from "vitest";
import { defineMdastPlugin, htmlToHast, markdownToHtml } from "satteri";
import { inertMarkdown } from "@scriptorium/core";

/**
 * The public site is Starlight on Astro 7, which renders markdown with satteri, a native
 * parser, not remark. Inert reads markdown with micromark, so whatever they parse
 * differently is a way past it. Here inert's output is rendered by the site's own parser,
 * with its features as Astro sets them, and nothing in the HTML may be live.
 */
const HOSTILE = [
  "What is the SSO SLA? <img src=x onerror=alert(1)> [our policy](javascript:alert(1))",
  "Is SSO supported? `\n` <img src=x onerror=alert(document.cookie)> `",
  "[p](javascript:alert(1)) <javascript:alert(2)>\n\n[d]: javascript:evil()\n\n[x][d]",
  '[x](javascript:alert(1) "javascript:")',
  "[x](java&#115;cript:alert(1))",
  "[x](javascript&colon;alert(1))",
  "[x](javascript\\:alert(1))",
  "[x](<java\tscript:alert(1)>)",
  "<div>\n[x](javascript:alert(1))\n</div>",
  '<a title="`">`<a title="`">`<img src=x onerror=alert(1)>`',
  "| a | b |\n|---|---|\n| `x | <img src=x onerror=alert(1)> ` | y |",
  "$`$ <img src=x onerror=alert(1)> `",
  '![v](https://x.example/a"onerror="alert(1).mp4)',
  "﻿See [x](javascript:alert(1)).",
  "> \t<img src=x onerror=alert(1)>",
  "x\r<img src=x onerror=alert(1)>",
  "<details open ontoggle=alert(1)>",
  "<!-- --><img src=x onerror=alert(1)>",
  "<?php echo 1 ?><img src=x onerror=alert(1)>",
  "[a](<javascript:alert(1)>)",
  "![a](javascript:alert(1))",
  "* <img src=x onerror=alert(1)>",
  "1. <svg onload=alert(1)>",
  "<sCrIpT>alert(1)</ScRiPt>",
  '<a href="javascript:alert(1)">x</a>',
  "[^1]\n\n[^1]: <img src=x onerror=alert(1)>",
  "~~<img src=x onerror=alert(1)>~~",
  "- [ ] <img src=x onerror=alert(1)>",
  // Forms a regex reading of the HTML missed: a slash before the handler, a ">" in a quoted
  // value, an entity-encoded scheme.
  "<img/onerror=alert(1) src=x>",
  '<img alt=">" src=x onerror=alert(1)>',
  '<a href="&#106;avascript:alert(1)">x</a>',
  // Starlight's asides are `:::` containers.
  ":::note\n<img src=x onerror=alert(1)>\n:::",
  ":::note\ntext\n:::\n<img src=x onerror=alert(1)>",
  ":::note[<img src=x onerror=alert(1)>]\nbody\n:::",
  ":::note\n```\n:::\n<img src=x onerror=alert(1)>\n```",
  // Too costly to parse: published as one code block.
  `${"[a]".repeat(501)}\n<img src=x onerror=alert(1)>`,
];

const DANGEROUS = new Set(["script", "iframe", "object", "embed", "svg", "math", "style", "link", "meta", "base", "form", "frame", "frameset", "template", "noscript"]);
const URL_PROPERTIES = new Set(["href", "src", "action", "formaction", "xlinkhref", "poster", "srcset", "data"]);

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/**
 * The first element in the HTML that would run something, or undefined. Parsed as a browser
 * would, not matched with a regex: "<img/onerror=…>", a ">" in a quoted value and an
 * entity-encoded "&#106;avascript:" all got past a regex.
 */
function liveMarkup(html: string): string | undefined {
  const pending: HastNode[] = [htmlToHast(html, { fragment: true }) as HastNode];
  while (pending.length) {
    const node = pending.pop() as HastNode;
    pending.push(...(node.children ?? []));
    if (node.type !== "element") continue;
    const name = (node.tagName ?? "").toLowerCase();
    if (DANGEROUS.has(name)) return `<${name}>`;
    for (const [property, value] of Object.entries(node.properties ?? {})) {
      const key = property.toLowerCase();
      if (key.startsWith("on")) return `<${name} ${property}>`;
      const url = String(Array.isArray(value) ? value.join(" ") : value).replace(/[\s\u0000-\u001f]/g, "").toLowerCase();
      if (URL_PROPERTIES.has(key) && /^(javascript|vbscript|data):/.test(url)) return `<${name} ${property}=${url}>`;
    }
  }
  return undefined;
}

/** Starlight renders an aside's contents in place; unrendered, a container is dropped whole. */
const asides = defineMdastPlugin({
  name: "asides",
  containerDirective(node, ctx) {
    ctx.replaceNode(node, { type: "blockquote", children: node.children } as never);
  },
});

async function render(markdown: string): Promise<string> {
  // As Astro 7 calls it for Starlight: GFM, smart punctuation, and directives (its asides).
  return (await markdownToHtml(markdown, { features: { gfm: true, smartPunctuation: true, directive: true }, mdastPlugins: [asides] })).html;
}

describe("the public site's own parser", () => {
  it("renders nothing live from a page once it is inert", async () => {
    for (const text of HOSTILE) {
      expect(liveMarkup(await render(inertMarkdown(text))), text).toBeUndefined();
    }
  });

  it("sees live markup where there is some: written as it came, most of these run", async () => {
    let live = 0;
    for (const text of HOSTILE) if (liveMarkup(await render(text))) live += 1;
    expect(live).toBeGreaterThan(HOSTILE.length / 2);
  });
});
