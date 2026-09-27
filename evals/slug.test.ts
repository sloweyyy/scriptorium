import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { docSlug, slugify, Vault } from "@scriptorium/core";
import { fileGapNote, organizeInboxFile } from "@scriptorium/curator";
import { saveLesson } from "@scriptorium/scribe";

const GAP_SUMMARY =
  "Doc request: Users can export their dashboard view as a PDF file so they can share it with stakeholders who do not have a Beacon account";

describe("doc slugs", () => {
  it("keeps a short feature name exactly as slugify would", () => {
    // Every doc published before the cap existed has a short feature name; its URL must not move.
    for (const feature of ["Scheduled maintenance", "Subscriber management", "Rate-limit dashboard"]) {
      expect(docSlug(feature)).toBe(slugify(feature));
    }
  });

  it("drops the gap-ticket prefix and caps a sentence on a word boundary", () => {
    const slug = docSlug(GAP_SUMMARY);
    expect(slug).toBe("users-can-export-their-dashboard-view-as-a");
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug).not.toMatch(/^doc-request/);
    // Never cut mid-word: every segment is a whole word from the source.
    const words = slugify(GAP_SUMMARY).split("-");
    for (const part of slug.split("-")) expect(words).toContain(part);
  });

  it("never returns an empty slug", () => {
    expect(docSlug("Doc request:")).toBe("untitled");
    expect(docSlug("!!!")).toBe("untitled");
    expect(docSlug("a".repeat(200)).length).toBe(60);
  });
});

describe("pinned slug survives the organizer", () => {
  let vault: Vault;
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-slug-"));
    vault = new Vault(tmpRoot);
    await vault.ensure();
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5 });
  });

  it("files a sentence-named PRD under the doc's capped slug, not a re-slugified feature", async () => {
    // Scribe seeds the PRD with `slug` pinned and records `sourcePrd: prd/<slug>`. If the
    // organizer re-derived the slug from `feature`, that link would point at nothing.
    const slug = docSlug(GAP_SUMMARY);
    await vault.writeNote(`_inbox/${slug}.md`, "# Dashboard PDF export\n\n## Requirements\n1. Export as PDF.", {
      kind: "prd",
      feature: GAP_SUMMARY,
      slug,
      audience: "workspace admins",
      user_goal: "share a dashboard",
    });

    const result = await organizeInboxFile(vault, `_inbox/${slug}.md`);
    expect(result.to).toBe(`prd/${slug}.md`);
  });
});

describe("gap and lesson filenames", () => {
  let vault: Vault;
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-slug-"));
    vault = new Vault(tmpRoot);
    await vault.ensure();
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5 });
  });

  it("names a gap note and a lesson with whole words, never a fragment", async () => {
    // These paths appear in Jira tickets and lesson-approval comments; `…-with-stakeh`
    // reads as a typo to whoever the note is handed to.
    const question = "Can subscribers export their incident history as a spreadsheet with stakeholders?";
    const rule = "Always name the exact menu path before describing a setting.";
    const gap = await fileGapNote(vault, {
      question,
      missing: "export of incident history",
      askedBy: "U123",
      auditFile: path.join(tmpRoot, "audit.jsonl"),
    });
    const lesson = await saveLesson(vault, { text: rule });

    for (const [relPath, text] of [[gap.relPath, question], [lesson.relPath, rule]] as const) {
      const name = path.basename(relPath, ".md").replace(/^[A-Z]+-\d+-/, "");
      const source = slugify(text).split("-");
      for (const part of name.split("-")) expect(source).toContain(part);
    }
  });
});
