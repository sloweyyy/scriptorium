import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Vault, type AppConfig } from "@scriptorium/core";

/**
 * The Teammate end to end: Slack mention in, reply out; approval card in, action carried
 * out. A fake Slack records what is posted; the model is scripted; everything between —
 * gate, queue, assembly from config, skills, policy, grounding, memory — is the real thing.
 */

let script: { calls: Array<{ name: string; input: unknown }>; reply: string };
vi.mock("@scriptorium/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scriptorium/core")>()),
  llmProvider: () => "anthropic",
  anthropic: () => ({
    beta: {
      messages: {
        toolRunner: async (params: { tools: Array<{ name: string; run: (input: unknown) => Promise<unknown> }> }) => {
          for (const call of script.calls) await params.tools.find((tool) => tool.name === call.name)?.run(call.input);
          return { stop_reason: "end_turn", content: [{ type: "text", text: script.reply }] };
        },
      },
    },
  }),
}));

const { createTeammate, APPROVE_ACTION } = await import("@scriptorium/agents").then(async (agents) => ({ ...agents, ...(await import("@scriptorium/connectors")) }));

interface Posted { channel: string; thread_ts?: string; text: string; blocks?: unknown[] }
let tmpRoot: string;
let vault: Vault;
let posted: Posted[];

const slack = {
  chat: {
    postMessage: async (args: Posted) => (posted.push(args), { ok: true, ts: `9.${posted.length}` }),
    update: async () => ({ ok: true }),
  },
  conversations: { replies: async () => ({ messages: [] }) },
};

function config(): AppConfig {
  return {
    hasModelAccess: true,
    provider: "anthropic",
    repoRoot: path.resolve("."),
    auditFile: path.join(tmpRoot, "audit.jsonl"),
    slack: {},
    jira: { stateDir: path.join(tmpRoot, "state") },
    teammate: { channels: ["C1"], approvers: ["UPM"], jiraProjects: [], confluenceSpaces: [], digestWeekday: 1, digestHour: 9 },
  } as unknown as AppConfig;
}

const settle = async (core: { drain: (ms: number) => Promise<boolean> }) => core.drain(2_000);

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-e2e-"));
  vault = new Vault(path.join(tmpRoot, "vault"));
  await vault.ensure();
  await vault.writeNote("docs/digest-emails.md", "# Digest emails\n\nSent at 09:00 in the subscriber's timezone.", { feature: "Digest emails" });
  posted = [];
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("teammate, end to end", () => {
  it("answers a mention in an allowed channel, cited, with the AI footer — and ignores other channels", async () => {
    const core = await createTeammate(config(), vault, slack as never, "UBOT");
    script = { calls: [{ name: "search_vault", input: { query: "digest" } }], reply: "At 09:00 local time [[docs/digest-emails]]." };
    await core.onMention({ channel: "C1", ts: "1.0", user: "U1", text: "<@UBOT> when are digests sent?" });
    await core.onMention({ channel: "C_OTHER", ts: "2.0", user: "U1", text: "<@UBOT> hello?" });
    await settle(core);

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ channel: "C1", thread_ts: "1.0" });
    expect(posted[0]?.text).toContain("docs/digest-emails");
    expect(posted[0]?.text).toContain("AI-generated — verify before acting");
    const audit = await fs.readFile(path.join(tmpRoot, "audit.jsonl"), "utf8");
    expect(audit).toContain('"type":"teammate.ignored"');
  });

  it("a memory it asks to keep waits on a card; a listed approver's click carries it out, once", async () => {
    const core = await createTeammate(config(), vault, slack as never, "UBOT");
    script = {
      calls: [{ name: "memory_save", input: { text: "Release notes go out on Thursdays.", scope: "channel:C1" } }],
      reply: "I'll remember that once an approver confirms.",
    };
    await core.onMention({ channel: "C1", ts: "3.0", user: "U1", text: "<@UBOT> remember release notes go out on Thursdays" });
    await settle(core);

    const card = posted.find((message) => JSON.stringify(message.blocks ?? []).includes(APPROVE_ACTION));
    expect(card).toBeDefined();
    expect(await vault.listNotes("_memory")).toHaveLength(0);
    const requestId = JSON.stringify(card?.blocks).match(/"value":"([0-9a-f-]{36})"/)?.[1] as string;

    const payload = (user: string) => ({ actions: [{ value: requestId }], user: { id: user, username: user }, channel: { id: "C1" }, message: { ts: "9.1", thread_ts: "3.0" } });
    expect(await core.onApprovalClick(APPROVE_ACTION, payload("U_RANDOM"))).toMatch(/^Not recorded/);
    expect(await vault.listNotes("_memory")).toHaveLength(0);

    expect(await core.onApprovalClick(APPROVE_ACTION, payload("UPM"))).toBeUndefined();
    expect(posted.at(-1)?.text).toMatch(/^Done: Remembered/);
    const [memory] = await vault.listNotes("_memory");
    expect((await vault.readNote(memory!)).frontmatter).toMatchObject({ scope: "channel:C1", status: "approved", approved_by: "UPM" });

    // A decided card cannot decide again.
    expect(await core.onApprovalClick(APPROVE_ACTION, payload("UPM"))).toMatch(/^Not recorded/);
    expect(await vault.listNotes("_memory")).toHaveLength(1);
  });
});
