import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Vault } from "@scriptorium/core";
import { answerQuestion } from "@scriptorium/curator";

// Live-LLM evals: opt in with RUN_LLM_EVALS=1 (needs ANTHROPIC_API_KEY).
const runLive = Boolean(process.env.RUN_LLM_EVALS && process.env.ANTHROPIC_API_KEY);

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
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("curator grounded Q&A (live LLM)", () => {
  it.skipIf(!runLive)("answers from the vault with at least one citation", async () => {
    const answer = await answerQuestion(vault, "How do subscribers get notified about maintenance?");
    expect(answer.gap).toBeNull();
    expect(answer.citations.length).toBeGreaterThan(0);
    expect(answer.citations.join(" ")).toContain("scheduled-maintenance-announcements");
  });

  it.skipIf(!runLive)("refuses to invent an answer and reports a gap", async () => {
    const answer = await answerQuestion(vault, "How do I configure SSO with Okta?");
    expect(answer.gap).not.toBeNull();
    expect(answer.citations).toHaveLength(0);
  });
});
