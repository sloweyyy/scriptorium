import { describe, expect, it } from "vitest";
import { markdownToHtml } from "satteri";
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
];

const DANGEROUS = new Set(["script", "iframe", "object", "embed", "svg", "math", "style", "link", "meta", "base", "form", "frame", "frameset", "template", "noscript"]);

/** The first real tag in the HTML that would run something, or undefined. Escaped text isn't a tag. */
function liveMarkup(html: string): string | undefined {
  for (const tag of html.matchAll(/<([a-zA-Z][\w-]*)([^>]*)>/g)) {
    const [whole, name = "", attributes = ""] = tag;
    if (DANGEROUS.has(name.toLowerCase())) return whole;
    if (/(^|\s)on[a-z]+\s*=/i.test(attributes)) return whole;
    for (const value of attributes.matchAll(/(?:href|src|action|formaction|xlink:href|poster|srcset)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      const url = (value[2] ?? value[3] ?? value[4] ?? "").replace(/[\s\u0000-\u001f]/g, "").toLowerCase();
      if (/^(javascript|vbscript|data):/.test(url)) return whole;
    }
  }
  return undefined;
}

async function render(markdown: string): Promise<string> {
  // As Astro 7 calls it for Starlight: GFM and smart punctuation on.
  return (await markdownToHtml(markdown, { features: { gfm: true, smartPunctuation: true } })).html;
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
