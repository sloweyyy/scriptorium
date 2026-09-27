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

let script: { calls: Array<{ name: string; input: unknown }>; reply: string; throwOnce?: boolean };
vi.mock("@scriptorium/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scriptorium/core")>()),
  llmProvider: () => "anthropic",
  anthropic: () => ({
    beta: {
      messages: {
        toolRunner: async (params: { tools: Array<{ name: string; run: (input: unknown) => Promise<unknown> }> }) => {
          if (script.throwOnce) {
            script.throwOnce = false;
            throw new Error("model overloaded");
          }
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

/** Posted messages, as they read NOW: an update replaces the text of the message it targets. */
const slack = {
  chat: {
    postMessage: async (args: Posted) => {
      posted.push({ ...args });
      return { ok: true, ts: `9.${posted.length}` };
    },
    update: async (args: { ts: string; text: string; blocks?: unknown[] }) => {
      const index = Number(args.ts.split(".")[1]) - 1;
      if (posted[index]) posted[index] = { ...posted[index]!, text: args.text, blocks: args.blocks };
      return { ok: true };
    },
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
    sites: { external: "https://docs.example" },
    jira: { stateDir: path.join(tmpRoot, "state"), projectKey: "DOC" },
    teammate: { channels: ["C1"], approvers: ["UPM"], jiraProjects: [], confluenceSpaces: [], githubRepos: [], allowDms: false, digestWeekday: 1, digestHour: 9 },
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
    // The sources are rendered, not just implied: a link to the doc on its site.
    expect(JSON.stringify(posted[0]?.blocks)).toContain("https://docs.example/digest-emails");
    // The "looking into it" acknowledgement became the answer; none is left behind.
    expect(posted.some((message) => message.text.includes("Looking into it"))).toBe(false);
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
    expect(posted.at(-1)?.text).toMatch(/^<@U1> ✅ Done, approved by <@UPM>: Remembered/);
    const [memory] = await vault.listNotes("_memory");
    expect((await vault.readNote(memory!)).frontmatter).toMatchObject({ scope: "channel:C1", status: "approved", approved_by: "UPM" });

    // A decided card cannot decide again.
    expect(await core.onApprovalClick(APPROVE_ACTION, payload("UPM"))).toMatch(/^Not recorded/);
    expect(await vault.listNotes("_memory")).toHaveLength(1);
  });

  it("a turn that fails is answered with a notice, and the next mention in the batch still gets its answer", async () => {
    const core = await createTeammate(config(), vault, slack as never, "UBOT");
    script = { calls: [{ name: "search_vault", input: { query: "digest" } }], reply: "At 09:00 [[docs/digest-emails]].", throwOnce: true };
    await core.onMention({ channel: "C1", ts: "5.0", user: "U1", text: "<@UBOT> first?" });
    await core.onMention({ channel: "C1", ts: "5.0", thread_ts: "5.0", user: "U2", text: "<@UBOT> when are digests sent?", client_msg_id: "m2" });
    await settle(core);
    expect(posted[0]?.text).toContain("couldn't finish that");
    expect(posted.at(-1)?.text).toContain("docs/digest-emails");
  });
});

describe("automatic PR checks", () => {
  it("a PR from an allowed repo is checked, its comment waits on a card in the PR channel, and nothing reaches GitHub", async () => {
    const prConfig = () => ({ ...config(), teammate: { ...config().teammate, githubRepos: ["org/app"], prChannel: "CPR" } }) as AppConfig;
    const core = await createTeammate(prConfig(), vault, slack as never, "UBOT");
    script = { calls: [], reply: "No Jira key is linked to this PR, so I can't check acceptance criteria." };
    await core.onPullRequest({ repo: "org/app", number: 12, author: "dev", deliveryId: "d-1" });
    await core.onPullRequest({ repo: "org/secret", number: 1, author: "dev", deliveryId: "d-2" });
    await settle(core);
    const summaries = posted.filter((message) => message.channel === "CPR");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.text).toContain("github:org/app/pull/12");
    const audit = await fs.readFile(path.join(tmpRoot, "audit.jsonl"), "utf8");
    expect(audit).toContain("PR checks are not configured for this repo");
  });
});

describe("direct messages", () => {
  it("answers a DM only when DMs are allowed, and never a bot's or an edit", async () => {
    script = { calls: [{ name: "search_vault", input: { query: "digest" } }], reply: "At 09:00 [[docs/digest-emails]]." };
    const off = await createTeammate(config(), vault, slack as never, "UBOT");
    await off.onDirectMessage({ channel: "D1", channel_type: "im", ts: "1.0", user: "U1", text: "when are digests sent?" });
    await off.onDirectMessage({ channel: "D1", channel_type: "im", ts: "1.1", user: "U1", text: "hello?" });
    await settle(off);
    // DMs off: one pointer to where it does answer, never an answer, never a second pointer.
    expect(posted).toHaveLength(1);
    expect(posted[0]?.text).toContain("mention me in <#C1>");
    posted.length = 0;

    const on = await createTeammate({ ...config(), teammate: { ...config().teammate, allowDms: true } } as AppConfig, vault, slack as never, "UBOT");
    await on.onDirectMessage({ channel: "D1", channel_type: "im", ts: "2.0", user: "U1", text: "when are digests sent?" });
    await on.onDirectMessage({ channel: "D1", channel_type: "im", ts: "3.0", user: "U1", text: "edited", subtype: "message_changed" });
    await on.onDirectMessage({ channel: "D1", channel_type: "im", ts: "4.0", bot_id: "B9", text: "bot says hi" });
    await settle(on);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ channel: "D1" });
    expect(posted[0]?.text).toContain("docs/digest-emails");
  });
});

describe("the Teammate on Jira", () => {
  function fakeJira() {
    const comments: Array<{ id: string; body: string; op?: string }> = [];
    const client = {
      addComment: async (_key: string, body: string, options: { op?: string } = {}) => {
        const stored = { id: String(comments.length + 1), body, op: options.op };
        comments.push(stored);
        return { id: stored.id, body, created: "now" };
      },
      findCommentByOp: async (_key: string, op: string) => comments.find((comment) => comment.op === op),
    };
    return { comments, jira: { client: client as never, accountId: "tm-1" } };
  }

  it("answers a mention of its own account on the ticket, once, as itself — and nothing else", async () => {
    const { comments, jira } = fakeJira();
    const core = await createTeammate(config(), vault, slack as never, "UBOT", jira);
    script = { calls: [{ name: "search_vault", input: { query: "digest" } }], reply: "At 09:00 [[docs/digest-emails]]." };
    const mention = { issueKey: "DOC-7", commentId: "c1", body: "[~accountid:tm-1] when do digests go out?", authorId: "human-1" };
    await core.onJiraComment(mention);
    await core.onJiraComment(mention); // a webhook redelivery
    await core.onJiraComment({ ...mention, commentId: "c2", body: "no mention here" });
    await core.onJiraComment({ ...mention, commentId: "c3", body: "[~accountid:scribe-bot] draft" });
    await core.onJiraComment({ ...mention, commentId: "c4", authorId: "tm-1" }); // its own comment
    await core.onJiraComment({ ...mention, issueKey: "HR-1", commentId: "c5" }); // outside its projects
    await settle(core);

    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("docs/digest-emails");
    expect(comments[0]?.body).toContain("AI-generated");
    expect(posted).toHaveLength(0);
  });
});

describe("first contact", () => {
  it("an empty mention or 'help' gets the capabilities card, with no model call", async () => {
    const core = await createTeammate(config(), vault, slack as never, "UBOT");
    script = { calls: [], reply: "SHOULD NOT BE CALLED" };
    await core.onMention({ channel: "C1", ts: "8.0", user: "U1", text: "<@UBOT>" });
    await core.onMention({ channel: "C1", ts: "8.1", user: "U1", text: "<@UBOT> help" });
    await settle(core);
    expect(posted).toHaveLength(2);
    for (const message of posted) {
      expect(message.text).toContain("I'm the Teammate");
      expect(message.text).toContain("waits for an approver: <@UPM>");
      expect(message.text).not.toContain("SHOULD NOT BE CALLED");
    }
  });
});

describe("spend caps", () => {
  it("a channel over today's budget gets a fixed notice and no model call — even after a restart", async () => {
    const auditFile = path.join(tmpRoot, "audit.jsonl");
    await fs.writeFile(auditFile, JSON.stringify({ ts: new Date().toISOString(), type: "llm.usage", scope: "C1", input: 5_000, output: 100 }) + "\n");
    const capped = { ...config(), teammate: { ...config().teammate, dailyTokens: 1_000 } } as AppConfig;
    const core = await createTeammate(capped, vault, slack as never, "UBOT");
    script = { calls: [], reply: "SHOULD NOT BE CALLED" };
    await core.onMention({ channel: "C1", ts: "9.0", user: "U1", text: "<@UBOT> when are digests sent?" });
    await settle(core);
    expect(posted[0]?.text).toContain("today's usage limit");
    expect(posted[0]?.text).not.toContain("SHOULD NOT BE CALLED");
  });
});
