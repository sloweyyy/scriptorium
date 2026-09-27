import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Vault, generateText, type GenerateOptions } from "@scriptorium/core";

/**
 * The lesson gate, where it matters: in the prompt a draft is written from.
 *
 * `listLessons` filtering by status was already tested, but nothing tested that the
 * drafting call sites USE the filter — dropping it from `draftDoc` or `reviseDoc` left
 * every eval green, which is to say an unapproved rule could start shaping published docs
 * without a red build. Each lesson here carries a unique marker; the prompt is the proof.
 */

vi.mock("@scriptorium/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scriptorium/core")>()),
  generateText: vi.fn(async () => "# Draft\n\n## Overview\n\nA draft."),
}));

const { draftDoc, reviseDoc, saveLesson, listLessons } = await import("@scriptorium/scribe");

const PRD = ["---", "feature: Digest emails", "audience: subscribers", "user_goal: get one email a day", "---", "# Digest emails"].join("\n");

let vault: Vault;
let tmpRoot: string;

async function lesson(id: string, status: string, marker: string): Promise<void> {
  await vault.writeNote(`_lessons/${id}-rule.md`, `${marker} is a house rule.`, { id, status, scope: "global" });
}

function lastPrompt(): string {
  const call = vi.mocked(generateText).mock.calls.at(-1)?.[0] as GenerateOptions | undefined;
  return `${call?.system ?? ""}\n${call?.prompt ?? ""}`;
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-lesson-gate-"));
  vault = new Vault(tmpRoot);
  await vault.ensure();
  vi.mocked(generateText).mockClear();
  await lesson("L-001", "approved", "MARKER-APPROVED");
  await lesson("L-002", "proposed", "MARKER-PROPOSED");
  await lesson("L-003", "rejected", "MARKER-REJECTED");
  // Hand-typed and misspelled: must read as awaiting a human, never as approved.
  await lesson("L-004", "aproved", "MARKER-TYPO");
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("only approved lessons shape a draft", () => {
  for (const [name, run] of [
    ["draftDoc", () => draftDoc(vault, PRD)],
    ["reviseDoc", () => reviseDoc(vault, "# Draft\n\nText.", ["shorten the intro"])],
  ] as const) {
    it(`${name}: the approved rule is in the prompt, and nothing else is`, async () => {
      const result = await run();
      const prompt = lastPrompt();
      expect(prompt).toContain("MARKER-APPROVED");
      for (const marker of ["MARKER-PROPOSED", "MARKER-REJECTED", "MARKER-TYPO"]) expect(prompt).not.toContain(marker);
      // What the ticket reports as "house rules applied" is exactly what the prompt held.
      expect(result.appliedLessons).toEqual(["L-001"]);
    });
  }

  it("a newly saved lesson waits for a human", async () => {
    const saved = await saveLesson(vault, { text: "MARKER-NEW is a house rule." });
    expect(saved.status).toBe("proposed");
    const reread = (await listLessons(vault)).find((candidate) => candidate.id === saved.id);
    expect(reread?.status).toBe("proposed");

    await draftDoc(vault, PRD);
    expect(lastPrompt()).not.toContain("MARKER-NEW");
  });
});

describe("applied is not the same as obeyed", () => {
  it("a rule with a check is judged on the draft; a broken rule is a lint error, so the revise round runs", async () => {
    await vault.writeNote("_lessons/L-010-timezone.md", "Always state the timezone for any scheduled time.", {
      id: "L-010", status: "approved", scope: "global", check_present: "\\b(UTC|timezone|local time)\\b",
    });
    vi.mocked(generateText).mockResolvedValueOnce("# Digest\n\n## Overview\n\nSent at 09:00.");
    const broken = await draftDoc(vault, PRD);
    expect(broken.lessonVerdicts).toContainEqual({ id: "L-010", verdict: "violated" });
    expect(broken.lint).toContainEqual(expect.objectContaining({ code: "house-rule", severity: "error" }));

    vi.mocked(generateText).mockResolvedValueOnce("# Digest\n\n## Overview\n\nSent at 09:00 in the subscriber's timezone.");
    const kept = await draftDoc(vault, PRD);
    expect(kept.lessonVerdicts).toContainEqual({ id: "L-010", verdict: "honored" });
    expect(kept.lint.some((finding) => finding.code === "house-rule")).toBe(false);
    // Rules with no check are reported as such, not as obeyed.
    expect(kept.lessonVerdicts).toContainEqual({ id: "L-001", verdict: "unchecked" });
  });

  it("a typo'd check never stops a draft — it is unchecked", async () => {
    const { checkLessons } = await import("@scriptorium/scribe");
    const verdicts = checkLessons("text", [{ id: "L-9", scope: "global", status: "approved", text: "x", relPath: "x", check: { pattern: "([unclosed", expect: "present" } }]);
    expect(verdicts).toEqual([{ id: "L-9", verdict: "unchecked" }]);
  });

  it("the ticket says which rules were obeyed", async () => {
    const { houseRules } = await import("@scriptorium/agents");
    expect(houseRules(["L-1", "L-2", "L-3"], [{ id: "L-1", verdict: "honored" }, { id: "L-2", verdict: "violated" }])).toBe("L-1 ✓, L-2 ✗, L-3 (unchecked)");
  });
});
