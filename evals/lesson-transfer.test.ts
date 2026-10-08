import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Vault, generateText, type GenerateOptions } from "@scriptorium/core";

/**
 * Learning, end to end on the sample PRDs, with no Jira and no model: feedback on the
 * PRD-001 draft becomes a rule, a human approves it, and the next drafts follow it where it
 * applies. PRD-001 and PRD-002 are for workspace admins; PRD-005 is for integrators.
 */

vi.mock("@scriptorium/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scriptorium/core")>()),
  generateText: vi.fn(),
}));

const { DISTILL_SYSTEM_PROMPT, approveLesson, distillLesson, draftDoc, prdAudience, saveLesson } = await import("@scriptorium/scribe");

const GLOBAL_RULE = "State the time zone of every time you mention.";
const ADMIN_RULE = "Name the role that can change each setting.";

let tmpRoot: string;
let vault: Vault;

const sample = (name: string) => fs.readFile(path.join(import.meta.dirname, "..", "samples", name), "utf8");

/** What the model would answer, by call: a distillation, or a draft. */
function model(distilled: string): void {
  vi.mocked(generateText).mockImplementation(async (options: GenerateOptions) => (options.system === DISTILL_SYSTEM_PROMPT ? distilled : "# Draft\n\n## Overview\n\nA draft."));
}

/** Feedback on the PRD-001 draft, distilled and approved by a human. */
async function learnFromPrd001(feedback: string, distilled: string): Promise<string> {
  const prd = await sample("prd-001-scheduled-maintenance.md");
  model(distilled);
  const rule = await distillLesson(feedback, prdAudience(prd));
  if (!rule) throw new Error("nothing distilled");
  const lesson = await saveLesson(vault, { ...rule, author: "pm.beacon", sourceThread: "DOC-1" });
  await approveLesson(vault, lesson.id, "pm.beacon");
  return lesson.id;
}

async function draftPrompt(name: string): Promise<{ prompt: string; applied: string[] }> {
  vi.mocked(generateText).mockClear();
  const result = await draftDoc(vault, await sample(name));
  const call = vi.mocked(generateText).mock.calls.at(-1)?.[0] as GenerateOptions;
  return { prompt: call.prompt, applied: result.appliedLessons };
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-transfer-"));
  vault = new Vault(tmpRoot);
  await vault.ensure();
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5 });
});

describe("a rule learned on PRD-001", () => {
  it("for every audience, shapes the next draft of any PRD", async () => {
    const id = await learnFromPrd001("Which time zone is 02:00 in? Always say.", `LESSON: ${GLOBAL_RULE}`);
    for (const name of ["prd-002-subscriber-management.md", "prd-005-rate-limit-dashboard.md"]) {
      const { prompt, applied } = await draftPrompt(name);
      expect(prompt, name).toContain(GLOBAL_RULE);
      expect(applied, name).toEqual([id]);
    }
  });

  it("for its readers only, shapes PRD-002's draft for the same admins, and not PRD-005's for integrators", async () => {
    const id = await learnFromPrd001("Admins need to know who can schedule this.", `AUDIENCE_LESSON: ${ADMIN_RULE}`);
    const admins = await draftPrompt("prd-002-subscriber-management.md");
    expect(admins.prompt).toContain(ADMIN_RULE);
    expect(admins.applied).toEqual([id]);
    const integrators = await draftPrompt("prd-005-rate-limit-dashboard.md");
    expect(integrators.prompt).not.toContain(ADMIN_RULE);
    expect(integrators.applied).toEqual([]);
  });

  it("not yet approved, shapes nothing", async () => {
    model(`LESSON: ${GLOBAL_RULE}`);
    const rule = await distillLesson("Which time zone is 02:00 in? Always say.");
    await saveLesson(vault, { ...rule!, author: "pm.beacon", sourceThread: "DOC-1" });
    const { prompt, applied } = await draftPrompt("prd-002-subscriber-management.md");
    expect(prompt).not.toContain(GLOBAL_RULE);
    expect(applied).toEqual([]);
  });
});
