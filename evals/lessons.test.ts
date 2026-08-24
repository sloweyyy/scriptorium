import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Vault } from "@scriptorium/core";
import { approveLesson, findLessonByText, listLessons, nextLessonId, rejectLesson, saveLesson } from "@scriptorium/scribe";

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

/**
 * Rejection.
 *
 * A rejected rule used to be deleted, which lost the human's decision three ways: the
 * internal branch is the only durable copy of `_lessons/` and publish has no delete
 * channel, so the rule stayed on the site as `proposed`; hydration read it straight back
 * into the vault on the next boot; and the freed number went back into circulation. All
 * three are downstream of treating "no" as an absence instead of an answer.
 */
describe("rejecting a lesson", () => {
  it("records the decision on the note instead of deleting it", async () => {
    const saved = await saveLesson(vault, { text: "Always mention the beta flag.", author: "PM", sourceThread: "DOC-9" });

    const rejected = await rejectLesson(vault, saved.id, "Alex Kim");
    expect(rejected?.status).toBe("rejected");

    const note = await vault.readNote(saved.relPath);
    expect(note.frontmatter.status).toBe("rejected");
    expect(note.frontmatter.rejected_by).toBe("Alex Kim");
    // The rule itself survives verbatim — the record is of a judgement, not a deletion.
    expect(note.body.trim()).toBe("Always mention the beta flag.");
  });

  it("never shapes a draft again", async () => {
    const saved = await saveLesson(vault, { text: "Always mention the beta flag.", author: "PM", sourceThread: "DOC-9" });
    await approveLesson(vault, saved.id, "PM");
    expect(await listLessons(vault, { status: "approved" })).toHaveLength(1);

    await rejectLesson(vault, saved.id, "Alex Kim");
    // Drafting reads `status: approved` only; a rejected note is inert whether it sits in
    // the vault, on the internal branch, or comes back through hydration.
    expect(await listLessons(vault, { status: "approved" })).toHaveLength(0);
    expect(await listLessons(vault, { status: "rejected" })).toHaveLength(1);
    // And it is not silently counted as still awaiting a human.
    expect(await listLessons(vault, { status: "proposed" })).toHaveLength(0);
  });

  it("holds its number, so the next proposal cannot wear a judged id", async () => {
    const saved = await saveLesson(vault, { text: "Always mention the beta flag.", author: "PM", sourceThread: "DOC-9" });
    expect(saved.id).toBe("L-001");

    await rejectLesson(vault, saved.id, "Alex Kim");

    const next = await saveLesson(vault, { text: "Link the API reference.", author: "PM", sourceThread: "DOC-10" });
    expect(next.id).toBe("L-002");
  });

  it("reports a lesson that is not there rather than inventing one", async () => {
    expect(await rejectLesson(vault, "L-404", "Alex Kim")).toBeUndefined();
  });
});

/**
 * Not asking twice.
 *
 * The distiller runs over feedback, not over the lesson store, so the same feedback
 * distils to the same sentence every time — and re-proposing a rule a human already
 * refused is asking them to make the same decision again. Only detectable at all now that
 * rejection leaves the note behind; while it deleted, the refused text was simply gone.
 */
describe("a rule a human already ruled on", () => {
  it("is recognised again through the wording noise two distillations differ by", async () => {
    const saved = await saveLesson(vault, { text: "End every document with a Related articles section.", author: "PM", sourceThread: "t" });
    await rejectLesson(vault, saved.id, "Alex Kim");

    const again = await findLessonByText(vault, "  end every  document with a related articles section  ");
    expect(again?.id).toBe(saved.id);
    expect(again?.status).toBe("rejected");
  });

  it("is found whatever the human decided, so the reply can say which", async () => {
    const approved = await saveLesson(vault, { text: "Always specify the timezone.", author: "PM", sourceThread: "t" });
    await approveLesson(vault, approved.id, "PM");
    const proposed = await saveLesson(vault, { text: "Link the API reference.", author: "PM", sourceThread: "t" });

    expect((await findLessonByText(vault, "Always specify the timezone."))?.status).toBe("approved");
    expect((await findLessonByText(vault, "Link the API reference."))?.id).toBe(proposed.id);
  });

  it("does not swallow a genuinely different rule", async () => {
    await saveLesson(vault, { text: "Always specify the timezone.", author: "PM", sourceThread: "t" });
    // A paraphrase IS a new proposal — a human should see it and decide. Matching is exact
    // after normalisation, never fuzzy, precisely so this stays true.
    expect(await findLessonByText(vault, "Always state the time zone for scheduled events.")).toBeUndefined();
    expect(await findLessonByText(vault, "")).toBeUndefined();
  });
});
