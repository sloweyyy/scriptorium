import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Vault, type ToolSpec } from "@scriptorium/core";
import { MemoryApprovalStore } from "@scriptorium/policy";

/**
 * One Teammate turn end to end, with the model scripted: which tools it calls, then what
 * it replies. Everything else is real — assembly, policy, the loop, grounding, gap notes.
 */

let script: { calls: Array<{ name: string; input: unknown }>; reply: string; stop?: string };

vi.mock("@scriptorium/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scriptorium/core")>()),
  llmProvider: () => "anthropic",
  anthropic: () => ({
    beta: {
      messages: {
        toolRunner: async (params: { tools: Array<{ name: string; run: (input: unknown) => Promise<unknown> }> }) => {
          for (const call of script.calls) await params.tools.find((tool) => tool.name === call.name)?.run(call.input);
          return { stop_reason: script.stop ?? "end_turn", content: [{ type: "text", text: script.reply }] };
        },
      },
    },
  }),
}));

const { runTeammateTurn, teammateConfig } = await import("@scriptorium/agents");
const { loadSkills } = await import("@scriptorium/runtime");

let tmpRoot: string;
let vault: Vault;
let created: unknown[];
let cards: string[];

const jiraCreate: ToolSpec = {
  name: "jira_create_issue",
  description: "create",
  inputSchema: z.object({ summary: z.string(), description: z.string() }),
  run: async (input) => (created.push(input), "Created jira:DOC-9"),
};
const confluenceRead: ToolSpec = {
  name: "confluence_read_page",
  description: "read",
  inputSchema: z.object({ id: z.string() }),
  run: async () => "confluence:101 — Digest schedule (space BEACON)\n\nDigests go out at 09:00 local time.",
  records: (input) => [`confluence:${(input as { id: string }).id}`],
};
const others = ["confluence_search", "jira_search", "jira_recent", "jira_get_issue", "slack_read_thread", "jira_comment", "confluence_create_page", "confluence_update_page"].map(
  (name): ToolSpec => ({ name, description: name, inputSchema: z.object({}), run: async () => "[]" }),
);

async function turn(question: string) {
  return runTeammateTurn(
    { question, askedBy: "slack:U_ASKER" },
    {
      vault,
      config: teammateConfig({ selfAccountIds: ["slack:U_BOT"], approvers: ["slack:U_PM"] }),
      skills: await loadSkills(path.resolve("skills")),
      connectorTools: [jiraCreate, confluenceRead, ...others],
      guardDeps: { store: new MemoryApprovalStore(), channel: { post: async (request) => void cards.push(request.id) }, auditFile: path.join(tmpRoot, "audit.jsonl"), key: "slack:thread:C1/1.0" },
      auditFile: path.join(tmpRoot, "audit.jsonl"),
    },
  );
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-teammate-"));
  vault = new Vault(tmpRoot);
  await vault.ensure();
  await vault.writeNote("docs/digest-emails.md", "# Digest emails\n\nSubscribers get one email a day.", { feature: "Digest emails" });
  created = [];
  cards = [];
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("teammate turn", () => {
  it("answers across sources when every citation was retrieved", async () => {
    script = {
      calls: [{ name: "search_vault", input: { query: "digest" } }, { name: "confluence_read_page", input: { id: "101" } }],
      reply: "One email a day [[docs/digest-emails]], sent at 09:00 [[confluence:101]].",
    };
    expect(await turn("When do digests go out?")).toEqual({
      kind: "answer",
      text: "One email a day [[docs/digest-emails]], sent at 09:00 [[confluence:101]].",
      citations: ["docs/digest-emails", "confluence:101"],
    });
  });

  it("refuses a claim that cites nothing it retrieved", async () => {
    script = { calls: [{ name: "search_vault", input: { query: "sso" } }], reply: "SSO is on the Enterprise plan [[confluence:555]]." };
    expect((await turn("Is SSO on Enterprise?")).kind).toBe("refused");
  });

  it("files a gap note when the knowledge isn't there", async () => {
    script = { calls: [{ name: "search_vault", input: { query: "sso" } }], reply: "NOT_IN_KB: nothing documents SSO" };
    const reply = await turn("Does Beacon support SSO?");
    expect(reply.kind).toBe("gap");
    expect(await vault.listNotes("_gaps")).toHaveLength(1);
  });

  it("a write waits for approval, and the reply reports that instead of claiming it", async () => {
    script = {
      calls: [{ name: "jira_create_issue", input: { summary: "Digest timezone setting", description: "From the thread." } }],
      reply: "I've drafted the ticket; it's waiting for an approver before anything is filed.",
    };
    const reply = await turn("Make a ticket for the digest timezone setting");
    expect(reply.kind).toBe("action");
    expect(created).toHaveLength(0);
    expect(cards).toHaveLength(1);
  });

  it("text inside a fetched page is not evidence: a citation it merely mentions is refused", async () => {
    // The Confluence page was really read — and its body says "jira:DOC-99". The model
    // cites that ticket; nothing ever fetched it.
    script = {
      calls: [{ name: "confluence_read_page", input: { id: "101" } }],
      reply: "DOC-99 shipped last week [[jira:DOC-99]].",
    };
    const bodyWithId: ToolSpec = { ...confluenceRead, run: async () => "confluence:101 — Notes\n\nSee jira:DOC-99 for details." };
    const reply = await runTeammateTurn(
      { question: "Did DOC-99 ship?", askedBy: "slack:U_ASKER" },
      {
        vault,
        config: teammateConfig({ selfAccountIds: ["slack:U_BOT"], approvers: ["slack:U_PM"] }),
        skills: await loadSkills(path.resolve("skills")),
        connectorTools: [jiraCreate, bodyWithId, ...others],
        guardDeps: { store: new MemoryApprovalStore(), channel: { post: async () => undefined }, auditFile: path.join(tmpRoot, "audit.jsonl"), key: "slack:thread:C1/1.0" },
        auditFile: path.join(tmpRoot, "audit.jsonl"),
      },
    );
    expect(reply.kind).toBe("refused");
  });

  it("attempting a write does not switch the citation check off — the reply is only what the write tool said", async () => {
    script = {
      calls: [{ name: "jira_create_issue", input: { summary: "x", description: "y" } }],
      reply: "Filed! Also, SSO is included in the free plan.",
    };
    const reply = await turn("File a ticket about SSO pricing");
    expect(reply.kind).toBe("action");
    expect(reply.text).not.toContain("free plan");
    expect(reply.text).toMatch(/^• jira_create_issue: APPROVAL_PENDING/);
  });

  it("a truncated turn is refused, never posted as half an answer", async () => {
    script = { calls: [], reply: "Digests go out at 09:0", stop: "max_tokens" };
    expect((await turn("When do digests go out?")).kind).toBe("refused");
  });

  it("running out of rounds is a gap, not an error", async () => {
    script = { calls: [], reply: "still looking", stop: "tool_use" };
    expect((await turn("What is the retention policy?")).kind).toBe("gap");
  });
});
