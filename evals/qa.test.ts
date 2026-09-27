import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Vault, llmProvider } from "@scriptorium/core";
import { answerQuestion } from "@scriptorium/curator";

/**
 * The single definition of Curator's Q&A contract, run against whichever provider is
 * configured — Claude by default, Gemini under LLM_PROVIDER=gemini. The assertions are
 * deliberately provider-blind: cite-or-refuse is a property of the pipeline, so a
 * transport that cannot satisfy these is not a supported transport.
 *
 *   RUN_LLM_EVALS=1 npx vitest run evals/qa.test.ts
 *   RUN_LLM_EVALS=1 LLM_PROVIDER=gemini GEMINI_MODEL=gemini-3.5-flash npx vitest run evals/qa.test.ts
 *
 * Gated on any configured provider rather than on ANTHROPIC_API_KEY: keying the gate to one
 * provider's credential makes the other provider's run silently skip and still report green.
 */
const provider = llmProvider();
const runLive = Boolean(process.env.RUN_LLM_EVALS) && provider !== "none";

let vault: Vault;
let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-qa-"));
  vault = new Vault(tmpRoot);
  await vault.ensure();
  await vault.writeNote(
    "docs/scheduled-maintenance-announcements.md",
    [
      "# Scheduled maintenance announcements",
      "",
      "## Overview",
      "Workspace admins can announce planned maintenance ahead of time.",
      "",
      "## Steps",
      "1. Open Announcements and choose New maintenance.",
      "2. Keep the Notify subscribers toggle on to email subscribers on publish and 1 hour before start.",
    ].join("\n"),
    { kind: "doc", feature: "Scheduled maintenance announcements", status: "published" },
  );
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5 });
});

/** A citation is only worth anything if the note behind it exists. */
async function assertCitationsResolve(citations: string[]): Promise<void> {
  for (const citation of citations) {
    const relPath = citation.endsWith(".md") ? citation : `${citation}.md`;
    await expect(fs.access(vault.abs(relPath)), `cited note does not exist: ${citation}`).resolves.toBeUndefined();
  }
}

describe(`curator grounded Q&A (live LLM, provider: ${provider})`, () => {
  it.skipIf(!runLive)("answers from the vault with at least one citation", async () => {
    const answer = await answerQuestion(vault, "How do subscribers get notified about maintenance?");
    expect(answer.gap).toBeNull();
    expect(answer.citations.length).toBeGreaterThan(0);
    expect(answer.citations.join(" ")).toContain("scheduled-maintenance-announcements");
    await assertCitationsResolve(answer.citations);
  });

  it.skipIf(!runLive)("refuses to invent an answer and reports a gap", async () => {
    const answer = await answerQuestion(vault, "How do I configure SSO with Okta?");
    expect(answer.gap).not.toBeNull();
    // The gap line is what the Slack Curator turns into a gap note and a Jira ticket, so
    // it has to be the whole answer — a hedged paragraph around it is not a refusal.
    expect(answer.text.startsWith("NOT_IN_KB:")).toBe(true);
    expect(answer.citations).toHaveLength(0);
  });
});
