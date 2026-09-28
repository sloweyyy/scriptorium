import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Vault, llmProvider } from "@scriptorium/core";
import { answerQuestion, parseQaAnswer } from "@scriptorium/curator";

/**
 * "Change this document" is not a question, and it is not a gap.
 *
 * Curator had two branches — answer from the vault, or declare the vault silent — and a
 * request to do work fit neither, so it fell through to the question path. Asked in Slack
 * to "rewrite the maintenance announcements doc to say announcements can be scheduled up
 * to 90 days in advance", it searched, found nothing, and filed a gap note and a Jira
 * ticket asserting the vault had failed to document that. It had not: the human had
 * invented the fact one second earlier, and it was now queued for Scribe to draft from,
 * wearing the authority of a documented hole.
 *
 * That is the injection path the whole two-agent split exists to prevent. Curator may
 * organize and retrieve; authoring goes through Scribe, on a ticket, past a named human.
 *
 * The parsing half runs everywhere. The judgement half needs a model.
 */

describe("the handoff contract", () => {
  it("routes a change request away from the gap pipeline entirely", () => {
    const answer = parseQaAnswer("NOT_MY_JOB: rewrite the maintenance doc to allow 90-day scheduling", "q");
    expect(answer.handoff).toBe("rewrite the maintenance doc to allow 90-day scheduling");
    // The load-bearing assertion: no gap, so no gap note and no ticket.
    expect(answer.gap).toBeNull();
  });

  it("still files a real gap as a gap", () => {
    const answer = parseQaAnswer("NOT_IN_KB: nothing about SCIM provisioning", "q");
    expect(answer.gap).toBe("nothing about SCIM provisioning");
    expect(answer.handoff).toBeNull();
  });

  it("never treats one message as both", () => {
    // A model that hedges by emitting both markers must not produce a gap ticket.
    const answer = parseQaAnswer("NOT_MY_JOB: edit the doc\nNOT_IN_KB: nothing about that", "q");
    expect(answer.handoff).toBe("edit the doc");
    expect(answer.gap).toBeNull();
  });

  it("falls back to the question when the marker carries no detail", () => {
    expect(parseQaAnswer("NOT_MY_JOB:", "Please publish the retry doc").handoff).toBe("Please publish the retry doc");
  });

  it("echoes the request as inert text in Slack: no live pings or disguised links", async () => {
    const { handoffLines } = await import("@scriptorium/agents");
    const lines = handoffLines("rewrite <!channel> the SLA page, see <https://evil.example|docs.beacon.example>", { jira: { baseUrl: "https://jira.example", projectKey: "DOC" } } as never);
    const echoed = lines.find((line) => line.startsWith("You're asking for:")) ?? "";
    expect(echoed).not.toMatch(/<!channel>|<https:/);
    expect(echoed).toContain("&lt;!channel&gt;");
    // The one link that is ours stays a link.
    expect(lines.join("\n")).toContain("<https://jira.example/browse/DOC|DOC>");
  });

  it("leaves an ordinary cited answer alone", () => {
    const answer = parseQaAnswer("Retries back off exponentially [[docs/webhook-retry-policy]].", "q");
    expect(answer.handoff).toBeNull();
    expect(answer.gap).toBeNull();
    expect(answer.citations).toContain("docs/webhook-retry-policy");
  });
});

const provider = llmProvider();
const runLive = Boolean(process.env.RUN_LLM_EVALS) && provider !== "none";

let vault: Vault;
let tmpRoot: string;

beforeAll(async () => {
  if (!runLive) return;
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-handoff-"));
  vault = new Vault(tmpRoot);
  await vault.ensure();
  await vault.writeNote(
    "docs/scheduled-maintenance-announcements.md",
    "# Scheduled maintenance announcements\n\nAdmins schedule a maintenance window from the admin console.\nSet a title, a start and end time, a timezone and a severity of Minor, Major or Critical.\n",
    { feature: "Scheduled maintenance announcements" },
  );
});

afterAll(async () => {
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5 });
});

describe.runIf(runLive)(`telling a change from a question (${provider})`, () => {
  it("refuses to author, and files nothing", async () => {
    const answer = await answerQuestion(
      vault,
      "Please rewrite the maintenance announcements doc to say announcements can be scheduled up to 90 days in advance.",
    );
    expect(answer.handoff, `expected a handoff, got: ${answer.text}`).toBeTruthy();
    expect(answer.gap).toBeNull();
  }, 120_000);

  it("answers a question about the same document normally", async () => {
    const answer = await answerQuestion(vault, "What severity levels can a maintenance announcement have?");
    expect(answer.handoff).toBeNull();
    expect(answer.text).toMatch(/critical/i);
    expect(answer.citations.length).toBeGreaterThan(0);
  }, 120_000);

  it("reads an instruction that only asks where something is as a question", async () => {
    // The distinction is what is asked of Curator, not the grammar. "Show me" is an
    // imperative and still a retrieval request.
    const answer = await answerQuestion(vault, "Show me what the maintenance announcements doc says about severity.");
    expect(answer.handoff, `expected an answer, got a handoff: ${answer.text}`).toBeNull();
  }, 120_000);
});
