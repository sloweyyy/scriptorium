import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Vault } from "@scriptorium/core";
import { answerQuestion, enforceGrounding, parseQaAnswer } from "@scriptorium/curator";

/**
 * No citation, no claim — as a check on the answer, not a request in the prompt.
 *
 * The prompt tells the model to cite every note it relied on. Until this check existed,
 * a reply that ignored that was posted to Slack anyway: the rule held exactly as well as
 * the model obeyed it. These run without a model.
 */

/** What the stubbed tool runner replies with, and which tools it "called" first. */
let modelReply = "";
let modelCalls: string[] = [];

vi.mock("@scriptorium/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@scriptorium/core")>();
  return {
    ...actual,
    llmProvider: () => "anthropic",
    anthropic: () => ({
      beta: {
        messages: {
          toolRunner: async (params: { tools: Array<{ name: string; run: (input: unknown) => Promise<unknown> }> }) => {
            for (const name of modelCalls) {
              const tool = params.tools.find((candidate) => candidate.name === name);
              await tool?.run(name === "vault_overview" ? {} : { query: "maintenance" });
            }
            return { content: [{ type: "text", text: modelReply }] };
          },
        },
      },
    }),
  };
});

let vault: Vault;
let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-grounding-"));
  vault = new Vault(tmpRoot);
  await vault.ensure();
  await vault.writeNote("docs/scheduled-maintenance.md", "# Scheduled maintenance\n\nSeverity is Minor, Major or Critical.", {
    feature: "Scheduled maintenance",
  });
  modelReply = "";
  modelCalls = [];
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5 });
});

describe("enforceGrounding", () => {
  /** By default the model "retrieved" the one real doc; tests that need otherwise say so. */
  const judge = (text: string, usedOverview = false, retrieved = ["docs/scheduled-maintenance: Severity is Minor, Major or Critical."]) =>
    enforceGrounding(vault, parseQaAnswer(text, "q"), { usedOverview, retrieved });

  it("refuses an answer that cites nothing", async () => {
    const answer = await judge("Severity can be Minor, Major or Critical.");
    expect(answer.ungrounded).toBe(true);
  });

  it("refuses an answer whose only citation is a note that does not exist", async () => {
    const answer = await judge("Maintenance can be scheduled 90 days ahead [[docs/maintenance-limits]].");
    expect(answer.ungrounded).toBe(true);
    expect(answer.citations).toEqual([]);
  });

  it("keeps a real citation and drops an invented one beside it", async () => {
    const answer = await judge("Severity is Minor, Major or Critical [[docs/scheduled-maintenance]] [[docs/made-up]].");
    expect(answer.ungrounded).toBeUndefined();
    expect(answer.citations).toEqual(["docs/scheduled-maintenance"]);
  });

  it("refuses a citation to a real note the model never retrieved", async () => {
    const answer = await judge("Severity is Minor, Major or Critical [[docs/scheduled-maintenance]].", false, []);
    expect(answer.ungrounded).toBe(true);
  });

  it("never counts a gap note or an inbox file as evidence", async () => {
    await vault.writeNote("_gaps/G-001-sso.md", "Question: does Beacon support SSO?", {});
    const answer = await judge("Beacon supports SSO [[_gaps/G-001-sso]].", false, ["_gaps/G-001-sso"]);
    expect(answer.ungrounded).toBe(true);
  });

  it("a gap, inbox or memory note is not evidence however its path is spelled", async () => {
    await vault.writeNote("_gaps/G-001-sso.md", "Question: does Beacon support SSO?", {});
    await vault.writeNote("_memory/M-00000001.md", "Alice's SSO notes.", { scope: "person:slack:UALICE" });
    for (const cited of ["docs/../_gaps/G-001-sso", "./_gaps/G-001-sso", "_memory/M-00000001", "docs/../_memory/M-00000001"]) {
      const answer = await enforceGrounding(vault, parseQaAnswer(`Beacon supports SSO [[${cited}]].`, "q"), { usedOverview: false, retrieved: [], records: new Set([cited]) });
      expect(answer.ungrounded, cited).toBe(true);
    }
  });

  it("accepts a Confluence or Jira citation only when a tool returned that record", async () => {
    const retrieved = ["confluence:101 — Maintenance windows (space BEACON)", '[{"key":"DOC-7"}] jira:DOC-7'];
    expect((await judge("Windows are 4h [[confluence:101]].", false, retrieved)).ungrounded).toBeUndefined();
    expect((await judge("Tracked in [[jira:DOC-7]].", false, retrieved)).ungrounded).toBeUndefined();
    // Well-formed, never retrieved: invented.
    expect((await judge("Windows are 4h [[confluence:999]].", false, retrieved)).ungrounded).toBe(true);
    // Not the id shape: never an external record.
    expect((await judge("See [[confluence:../x]].", false, ["confluence:../x"])).ungrounded).toBe(true);
  });

  it("matches a retrieved record as a whole token, never as a prefix of another", async () => {
    await vault.writeNote("docs/a.md", "# A", {});
    // docs/ab was retrieved; docs/a exists but was never read.
    expect((await judge("Claim [[docs/a]].", false, ["docs/ab: something"])).ungrounded).toBe(true);
    expect((await judge("Claim [[confluence:1]].", false, ["confluence:101 — Page"])).ungrounded).toBe(true);
    // Real mentions still count: JSON-quoted, path with .md, or followed by punctuation.
    expect((await judge("Claim [[docs/a]].", false, ['[{"relPath":"docs/a.md"}]'])).ungrounded).toBeUndefined();
    expect((await judge("Claim [[confluence:101]].", false, ["confluence:101 — Page"])).ungrounded).toBeUndefined();
  });

  it("never counts a citation that escapes the vault", async () => {
    const answer = await judge("See [[../../etc/passwd]].", false, ["../../etc/passwd"]);
    expect(answer.ungrounded).toBe(true);
  });

  it("lets an answer about the vault's own shape name no note", async () => {
    const answer = await judge("Nothing is documented about SSO yet.", true);
    expect(answer.ungrounded).toBeUndefined();
  });

  it("leaves gaps and handoffs to their own branches", async () => {
    expect((await judge("NOT_IN_KB: nothing about SSO")).ungrounded).toBeUndefined();
    expect((await judge("NOT_MY_JOB: rewrite the maintenance doc")).ungrounded).toBeUndefined();
  });
});

describe("answerQuestion applies it", () => {
  it("marks an uncited reply ungrounded, whatever the model said", async () => {
    modelCalls = ["search_vault"];
    modelReply = "Maintenance windows can be up to 90 days long.";
    const answer = await answerQuestion(vault, "How long can maintenance last?");
    expect(answer.ungrounded).toBe(true);
    expect(answer.gap).toBeNull();
  });

  it("passes a cited reply through", async () => {
    modelCalls = ["search_vault"];
    modelReply = "Minor, Major or Critical [[docs/scheduled-maintenance]].";
    const answer = await answerQuestion(vault, "What severities exist?");
    expect(answer.ungrounded).toBeUndefined();
    expect(answer.citations).toEqual(["docs/scheduled-maintenance"]);
  });

  it("accepts an overview answer only when vault_overview actually ran", async () => {
    modelReply = "Nothing is documented about SSO yet.";
    modelCalls = ["vault_overview"];
    expect((await answerQuestion(vault, "Do you cover SSO?")).ungrounded).toBeUndefined();
    modelCalls = [];
    expect((await answerQuestion(vault, "Do you cover SSO?")).ungrounded).toBe(true);
  });
});

describe("refusals are not evidence", () => {
  it("a tool's NOT_ALLOWED echo of an id never grounds a citation to it", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-refusal-"));
    const v = new Vault(dir);
    const answer = await enforceGrounding(v, parseQaAnswer("DOC-99 shipped [[jira:DOC-99]]", "q"), {
      usedOverview: false,
      retrieved: ['NOT_ALLOWED: "jira:DOC-99" is not an issue key.'],
    });
    expect(answer.ungrounded).toBe(true);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
});
