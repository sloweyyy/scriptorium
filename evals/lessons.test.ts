import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Vault } from "@scriptorium/core";
import { listLessons, nextLessonId, saveLesson } from "@scriptorium/scribe";

/**
 * Lesson identity.
 *
 * Production grew two different rules both called L-001, at which point
 * `approve lesson L-001` approves whichever file wins the lookup — a human's approval
 * attached to a rule they may never have read. Two causes, both pinned here: numbering
 * ignored files it could not parse (the hand-seeded example has no `id` field but its
 * filename still occupies L-001), and a proposal lost with its container reset the
 * counter (durability is handled at the push layer; the numbering must still never
 * reuse an id that exists on disk in any form).
 */

let tmpRoot: string;
let vault: Vault;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-lessons-"));
  vault = new Vault(tmpRoot);
  await vault.ensure();
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("lesson ids", () => {
  it("never reissues a number a file already occupies, parseable or not", async () => {
    // The seeded example: filename says L-001, frontmatter has no `id`, so listLessons
    // cannot see it — but handing out L-001 again collides on disk and in approvals.
    await vault.writeNote("_lessons/L-001-example.md", "State time windows in UTC.\n", {
      title: "L-001 — Example lesson",
      status: "approved",
    });

    expect(await nextLessonId(vault)).toBe("L-002");
    const saved = await saveLesson(vault, { text: "Warn about irreversible actions.", author: "Reviewer", sourceThread: "t" });
    expect(saved.id).toBe("L-002");
  });

  it("numbers past the highest of frontmatter and filename ids", async () => {
    await saveLesson(vault, { text: "First rule.", author: "Reviewer", sourceThread: "t" });
    await vault.writeNote("_lessons/L-007-hand-made.md", "Manually filed rule.\n", { id: "L-007", status: "approved" });
    expect(await nextLessonId(vault)).toBe("L-008");
  });

  it("still starts at L-001 in an empty store", async () => {
    expect(await nextLessonId(vault)).toBe("L-001");
  });

  it("keeps unparseable files out of drafting but not out of numbering", async () => {
    await vault.writeNote("_lessons/L-001-example.md", "Some rule.\n", { status: "approved" });
    // No `id` field: it cannot be applied (drafting needs identity for the footer)…
    expect(await listLessons(vault, { status: "approved" })).toHaveLength(0);
    // …but its number is taken.
    expect(await nextLessonId(vault)).toBe("L-002");
  });
});
