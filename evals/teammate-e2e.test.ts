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

/** What the model was sent last — to check the thread it was given. */
let lastPrompt = "";
let threadReplies: Array<{ ts: string; user?: string; text: string }> = [];
let script: { calls: Array<{ name: string; input: unknown; waitMs?: number }>; reply: string; throwOnce?: boolean; hang?: boolean };
vi.mock("@scriptorium/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scriptorium/core")>()),
  llmProvider: () => "anthropic",
  anthropic: () => ({
    beta: {
      messages: {
        toolRunner: async (params: { tools: Array<{ name: string; run: (input: unknown) => Promise<unknown> }>; messages?: unknown }) => {
          lastPrompt = JSON.stringify(params.messages ?? "");
          // A model call still running when the process goes away.
          if (script.hang) return new Promise(() => undefined);
          if (script.throwOnce) {
            script.throwOnce = false;
            throw new Error("model overloaded");
          }
          for (const call of script.calls) {
            if (call.waitMs) await new Promise((resolve) => setTimeout(resolve, call.waitMs));
            await params.tools.find((tool) => tool.name === call.name)?.run(call.input);
          }
          return { stop_reason: "end_turn", content: [{ type: "text", text: script.reply }] };
        },
      },
    },
  }),
}));

const { createTeammate, APPROVE_ACTION, REJECT_ACTION, RETRY_ACTION } = await import("@scriptorium/agents").then(async (agents) => ({ ...agents, ...(await import("@scriptorium/connectors")) }));

interface Posted { channel: string; thread_ts?: string; text: string; blocks?: unknown[]; metadata?: { event_type: string; event_payload?: unknown } }
let tmpRoot: string;
let vault: Vault;
let posted: Posted[];
let progressUpdates: string[] = [];
/** How long a progress update takes to land (a slow call, or a 429 retried later). */
let progressDelayMs = 0;
/** Per-update delays, in order; the first slow update is the one a 429 retry held back. */
let progressDelays: number[] = [];
/** Lose the next reminder post's response after Slack stored it. */
let loseNextReminderPost = false;

/** Posted messages, as they read NOW: an update replaces the text of the message it targets. */
const slack = {
  chat: {
    postMessage: async (args: Posted) => {
      posted.push({ ...args });
      if (loseNextReminderPost && args.text.includes("Reminder:")) {
        loseNextReminderPost = false;
        throw new Error("socket hang up");
      }
      return { ok: true, ts: `9.${posted.length}` };
    },
    getPermalink: async (args: { channel: string; message_ts: string }) => ({ ok: true, permalink: `https://team.slack.com/archives/${args.channel}/p${args.message_ts.replace(".", "")}` }),
    update: async (args: { ts: string; text: string; blocks?: unknown[] }) => {
      if (args.text.startsWith("🔎")) {
        progressUpdates.push(args.text);
        const delay = progressDelays.shift() ?? progressDelayMs;
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      }
      const index = Number(args.ts.split(".")[1]) - 1;
      if (posted[index]) posted[index] = { ...posted[index]!, text: args.text, blocks: args.blocks };
      return { ok: true };
    },
  },
  conversations: {
    replies: async () => ({ messages: threadReplies }),
    // D1 is U1's DM with the bot; D_PEOPLE is a DM between two people the bot isn't in.
    info: async (args: { channel: string }) => {
      if (args.channel === "D1") return { ok: true, channel: { id: "D1", is_im: true, user: "U1" } };
      throw new Error("channel_not_found");
    },
    history: async (args: { channel: string }) => ({ messages: posted.filter((message) => message.channel === args.channel).map((message, index) => ({ ...message, ts: `9.${index + 1}` })) }),
  },
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
  progressUpdates = [];
  progressDelayMs = 0;
  progressDelays = [];
  threadReplies = [];
  lastPrompt = "";
  loseNextReminderPost = false;
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5 });
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
    expect(progressUpdates).toContain("🔎 Searching our docs…");
    const audit = await fs.readFile(path.join(tmpRoot, "audit.jsonl"), "utf8");
    expect(audit).toContain('"type":"teammate.ignored"');
  });

  it("a 👎 on one of its answers becomes a review candidate, traced to the run, with no Slack text kept", async () => {
    const core = await createTeammate(config(), vault, slack as never, "UBOT");
    script = { calls: [{ name: "search_vault", input: { query: "digest" } }], reply: "At 09:00 local time [[docs/digest-emails]]." };
    await core.onMention({ channel: "C1", ts: "1.0", user: "U1", text: "<@UBOT> when are digests sent?" });
    await settle(core);
    // The answer is the placeholder message it posted and then updated.
    await core.onReaction({ reaction: "-1", user: "U2", channel: "C1", ts: "9.1", itemUser: "UBOT" });
    await core.onReaction({ reaction: "thumbsdown::skin-tone-3", user: "U3", channel: "C1", ts: "9.1", itemUser: "UBOT" });
    await core.onReaction({ reaction: "-1", user: "U2", channel: "C1", ts: "9.1", itemUser: "UBOT" }); // again: still one person
    // Not a 👎, not its message, not where it answers: nothing.
    await core.onReaction({ reaction: "+1", user: "U2", channel: "C1", ts: "9.1", itemUser: "UBOT" });
    await core.onReaction({ reaction: "-1", user: "U2", channel: "C1", ts: "1.0", itemUser: "U1" });
    await core.onReaction({ reaction: "-1", user: "U2", channel: "C9", ts: "9.1", itemUser: "UBOT" });

    const { feedbackCandidates, parseAudit } = await import("@scriptorium/core");
    const text = await fs.readFile(path.join(tmpRoot, "audit.jsonl"), "utf8");
    const candidates = feedbackCandidates(parseAudit(text));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ channel: "C1", message: "9.1", kind: "answer", flaggedBy: ["U2", "U3"] });
    expect(candidates[0]?.run).toMatch(/^[0-9a-f-]{8,}/);
    expect(text.split("\n").filter((line) => line.includes("teammate.feedback")).join()).not.toContain("digest");
  });

  it("a Slack retry that reaches it after a restart is not answered twice", async () => {
    script = { calls: [{ name: "search_vault", input: { query: "digest" } }], reply: "At 09:00 local time [[docs/digest-emails]]." };
    const mention = { channel: "C1", ts: "5.0", user: "U1", text: "<@UBOT> when are digests sent?", client_msg_id: "msg-5" };
    const before = await createTeammate(config(), vault, slack as never, "UBOT");
    await before.onMention(mention);
    await settle(before);
    const answers = () => posted.filter((message) => message.text.includes("09:00 local time")).length;
    expect(answers()).toBe(1);
    const after = await createTeammate(config(), vault, slack as never, "UBOT");
    await after.onMention(mention);
    await settle(after);
    expect(answers()).toBe(1);
  });

  it("on a deploy overlap, the new instance leaves the old one's live answer alone, and closes a dead one's once its lease expires", async () => {
    const { Lease } = await import("@scriptorium/runtime");
    const leaseFile = path.join(tmpRoot, "state", "scheduler.lease");
    // The old revision holds the lease (a short TTL here) and is mid-answer.
    const old = await createTeammate(config(), vault, slack as never, "UBOT", undefined, { lease: new Lease(leaseFile, 300, "old", 0) });
    script = { calls: [], reply: "never", hang: true };
    await old.onMention({ channel: "C1", ts: "1.0", user: "U1", text: "<@UBOT> when are digests sent?" });
    expect(await old.drain(50)).toBe(false);
    expect(posted[0]?.text).toContain("Looking into it");

    // The new revision boots alongside it: the old answer is still live, so it is left alone.
    const fresh = await createTeammate(config(), vault, slack as never, "UBOT", undefined, { lease: new Lease(leaseFile, 300, "new", 0) });
    expect(posted[0]?.text).toContain("Looking into it");
    // Nor does it run the scheduled work while the old one holds it.
    await fresh.checkApprovals();
    expect(posted[0]?.text).toContain("Looking into it");

    // The old one dies and stops renewing; once its lease expires, the new one takes over and
    // closes what it left behind.
    await new Promise((resolve) => setTimeout(resolve, 350));
    await fresh.checkApprovals();
    expect(posted[0]?.text).toContain("I restarted before I finished this");
  });

  it("a turn cut off by a restart is closed with a notice on the next boot, not left 'Looking into it…'", async () => {
    const before = await createTeammate(config(), vault, slack as never, "UBOT");
    script = { calls: [], reply: "never", hang: true };
    await before.onMention({ channel: "C1", ts: "1.0", user: "U1", text: "<@UBOT> when are digests sent?" });
    expect(await before.drain(50)).toBe(false);
    expect(posted[0]?.text).toContain("Looking into it");

    await createTeammate(config(), vault, slack as never, "UBOT");
    expect(posted[0]?.text).toContain("I restarted before I finished this");
    // Closed once: a later boot leaves it alone.
    posted[0] = { ...posted[0]!, text: "sentinel" };
    await createTeammate(config(), vault, slack as never, "UBOT");
    expect(posted[0]?.text).toBe("sentinel");
  });

  it("a turn that finishes leaves nothing for the next boot to close", async () => {
    const core = await createTeammate(config(), vault, slack as never, "UBOT");
    script = { calls: [{ name: "search_vault", input: { query: "digest" } }], reply: "At 09:00 [[docs/digest-emails]]." };
    await core.onMention({ channel: "C1", ts: "1.0", user: "U1", text: "<@UBOT> when are digests sent?" });
    await settle(core);
    await createTeammate(config(), vault, slack as never, "UBOT");
    expect(posted[0]?.text).toContain("docs/digest-emails");
  });

  it("a progress update that lands late never overwrites the answer", async () => {
    progressDelayMs = 50;
    const core = await createTeammate(config(), vault, slack as never, "UBOT");
    script = { calls: [{ name: "search_vault", input: { query: "digest" } }], reply: "At 09:00 local time [[docs/digest-emails]]." };
    await core.onMention({ channel: "C1", ts: "1.0", user: "U1", text: "<@UBOT> when are digests sent?" });
    await settle(core);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(progressUpdates).toHaveLength(1);
    expect(posted[0]?.text).toContain("docs/digest-emails");
  });

  it("an earlier progress update held back by a retry never lands after the answer", async () => {
    // Two updates in one turn (2s apart, the throttle); the FIRST is slow, the second fast.
    progressDelays = [2_600, 10];
    const core = await createTeammate(config(), vault, slack as never, "UBOT");
    script = {
      calls: [
        { name: "search_vault", input: { query: "digest" } },
        { name: "read_note", input: { path: "docs/digest-emails" }, waitMs: 2_100 },
      ],
      reply: "At 09:00 local time [[docs/digest-emails]].",
    };
    await core.onMention({ channel: "C1", ts: "1.0", user: "U1", text: "<@UBOT> when are digests sent?" });
    await core.drain(8_000);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(progressUpdates).toHaveLength(2);
    expect(posted[0]?.text).toContain("docs/digest-emails");
  }, 15_000);

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

  it("an approved action whose connector fails can be retried from the thread — by an approver, once", async () => {
    const core = await createTeammate(config(), vault, slack as never, "UBOT");
    script = { calls: [{ name: "memory_save", input: { text: "Release notes go out on Thursdays.", scope: "channel:C1" } }], reply: "Asked." };
    await core.onMention({ channel: "C1", ts: "3.0", user: "U1", text: "<@UBOT> remember release notes go out on Thursdays" });
    await settle(core);
    const card = posted.find((message) => JSON.stringify(message.blocks ?? []).includes(APPROVE_ACTION));
    const requestId = JSON.stringify(card?.blocks).match(/"value":"([0-9a-f-]{36})"/)?.[1] as string;
    const writeNote = vault.writeNote.bind(vault);
    let failNext = true;
    vault.writeNote = (async (...args: Parameters<Vault["writeNote"]>) => {
      if (failNext && args[0].startsWith("_memory")) {
        failNext = false;
        throw new Error("EIO: disk hiccup");
      }
      return writeNote(...args);
    }) as Vault["writeNote"];
    const click = (action: string, user: string) => core.onApprovalClick(action, { actions: [{ value: requestId }], user: { id: user, username: user }, channel: { id: "C1" }, message: { ts: "9.1", thread_ts: "3.0" } });

    expect(await click(APPROVE_ACTION, "UPM")).toBeUndefined();
    const failed = posted.at(-1)!;
    expect(failed.text).toContain("couldn't carry it out");
    expect(failed.text).not.toContain("EIO");
    expect(JSON.stringify(failed.blocks)).toContain(RETRY_ACTION);
    expect(await vault.listNotes("_memory")).toHaveLength(0);

    expect(await click(RETRY_ACTION, "U_RANDOM")).toMatch(/^Not retried/);
    // Once expired, Retry does nothing: no run, and no fresh card for the same action.
    const stored = JSON.parse(await fs.readFile(path.join(tmpRoot, "state", "approvals.json"), "utf8")) as Array<{ id: string; expiresAt: string }>;
    const realExpiry = stored.find((entry) => entry.id === requestId)!.expiresAt;
    await fs.writeFile(path.join(tmpRoot, "state", "approvals.json"), JSON.stringify(stored.map((entry) => (entry.id === requestId ? { ...entry, expiresAt: new Date(Date.now() - 1000).toISOString() } : entry))));
    const cardsBefore = posted.filter((message) => JSON.stringify(message.blocks ?? []).includes(APPROVE_ACTION)).length;
    expect(await click(RETRY_ACTION, "UPM")).toMatch(/^Nothing to retry/);
    expect(posted.filter((message) => JSON.stringify(message.blocks ?? []).includes(APPROVE_ACTION))).toHaveLength(cardsBefore);
    expect(await vault.listNotes("_memory")).toHaveLength(0);
    const restored = JSON.parse(await fs.readFile(path.join(tmpRoot, "state", "approvals.json"), "utf8")) as Array<{ id: string; expiresAt: string }>;
    await fs.writeFile(path.join(tmpRoot, "state", "approvals.json"), JSON.stringify(restored.map((entry) => (entry.id === requestId ? { ...entry, expiresAt: realExpiry } : entry))));

    expect(await click(RETRY_ACTION, "UPM")).toBeUndefined();
    expect(posted.at(-1)?.text).toContain("✅ Done");
    expect(await vault.listNotes("_memory")).toHaveLength(1);
    expect(await click(RETRY_ACTION, "UPM")).toMatch(/^Nothing to retry/);
  });

  it("a DM or a ticket that asked hears the outcome there — the card was elsewhere", async () => {
    const comments: Array<{ issue: string; body: string; op?: string }> = [];
    const jira = {
      accountId: "tm-1",
      client: {
        addComment: async (issue: string, body: string, options: { op?: string } = {}) => (comments.push({ issue, body, op: options.op }), { id: String(comments.length), body, created: "now" }),
        findCommentByOp: async (_key: string, op: string) => comments.find((comment) => comment.op === op),
      } as never,
    };
    const dmConfig = { ...config(), slack: { notifyChannel: "CN" }, teammate: { ...config().teammate, allowDms: true, jiraProjects: ["DOC"] } } as AppConfig;
    const core = await createTeammate(dmConfig, vault, slack as never, "UBOT", jira);
    const cardIds = () => posted.filter((message) => message.channel === "CN" && message.blocks).map((message) => JSON.stringify(message.blocks).match(/"value":"([0-9a-f-]{36})"/)?.[1] as string);
    const click = (action: string, id: string) => core.onApprovalClick(action, { actions: [{ value: id }], user: { id: "UPM", username: "priya" }, channel: { id: "CN" }, message: { ts: "9.9" } });

    // One scripted call per turn: the DM asks for a person memory, the ticket for a global one.
    const scripts = [
      { calls: [{ name: "memory_save", input: { text: "I prefer short answers.", scope: "person:slack:U1" } }], reply: "Asked." },
      { calls: [{ name: "memory_save", input: { text: "DOC tickets need a design link.", scope: "global" } }], reply: "Asked." },
    ];
    script = scripts[0]!;
    await core.onDirectMessage({ channel: "D1", channel_type: "im", ts: "2.0", user: "U1", text: "remember I prefer short answers" });
    await settle(core);
    const [dmCard] = cardIds();
    await click(APPROVE_ACTION, dmCard!);
    expect(posted.find((message) => message.channel === "D1" && message.text.startsWith("✅ Done, approved by priya"))).toMatchObject({ thread_ts: "2.0" });

    // A drained core takes no more work: the ticket's turn runs on a fresh one (same stores).
    const again = await createTeammate(dmConfig, vault, slack as never, "UBOT", jira);
    script = scripts[1]!;
    await again.onJiraComment({ issueKey: "DOC-7", commentId: "c1", body: "[~accountid:tm-1] remember DOC tickets need a design link", authorId: "human-1" });
    await settle(again);
    const jiraCard = cardIds().at(-1)!;
    expect(jiraCard).not.toBe(dmCard);
    await again.onApprovalClick(REJECT_ACTION, { actions: [{ value: jiraCard }], user: { id: "UPM", username: "priya" }, channel: { id: "CN" }, message: { ts: "9.9" } });
    expect(comments.filter((comment) => comment.body.includes("Rejected by priya"))).toHaveLength(1);
    expect(comments.at(-1)?.issue).toBe("DOC-7");
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
    expect(summaries[0]?.text).toContain("<https://github.com/org/app/pull/12|org/app#12>");
    const audit = await fs.readFile(path.join(tmpRoot, "audit.jsonl"), "utf8");
    expect(audit).toContain("PR checks are not configured for this repo");
  });

  it("the card a PR check raises threads under that check's summary", async () => {
    const prConfig = { ...config(), teammate: { ...config().teammate, githubRepos: ["org/app"], prChannel: "CPR" } } as AppConfig;
    const core = await createTeammate(prConfig, vault, slack as never, "UBOT");
    script = { calls: [{ name: "memory_save", input: { text: "PRs in org/app need a DOC key.", scope: "global" } }], reply: "Proposed a note; it waits on approval." };
    await core.onPullRequest({ repo: "org/app", number: 12, author: "dev", deliveryId: "d-3" });
    await settle(core);
    const [summary, card, ...rest] = posted.filter((message) => message.channel === "CPR");
    expect(rest).toEqual([]);
    expect(summary?.thread_ts).toBeUndefined();
    expect(summary?.text).toContain("Waiting for approval");
    expect(card?.text).toContain("Approval needed");
    expect(card?.thread_ts).toBe(`9.${posted.indexOf(summary!) + 1}`);
  });
});

describe("approvals nobody decides", () => {
  it("nudges the approvers once after a day, and closes the card honestly when it expires", async () => {
    const core = await createTeammate(config(), vault, slack as never, "UBOT");
    script = { calls: [{ name: "memory_save", input: { text: "Release notes go out on Thursdays.", scope: "channel:C1" } }], reply: "Asked." };
    await core.onMention({ channel: "C1", ts: "3.0", user: "U1", text: "<@UBOT> remember release notes go out on Thursdays" });
    await settle(core);
    const cardIndex = posted.findIndex((message) => JSON.stringify(message.blocks ?? []).includes(APPROVE_ACTION));
    const cardTs = `9.${cardIndex + 1}`;
    const count = posted.length;

    await core.checkApprovals(new Date(Date.now() + 2 * 3_600_000)); // too soon
    expect(posted).toHaveLength(count);
    await core.checkApprovals(new Date(Date.now() + 25 * 3_600_000));
    await core.checkApprovals(new Date(Date.now() + 26 * 3_600_000)); // once only
    const nudges = posted.slice(count);
    expect(nudges).toHaveLength(1);
    expect(nudges[0]).toMatchObject({ channel: "C1", thread_ts: cardTs });
    expect(nudges[0]?.text).toContain("Still waiting for an approver: <@UPM>");

    await core.checkApprovals(new Date(Date.now() + 8 * 24 * 3_600_000));
    expect(posted[cardIndex]?.text).toContain("Expired without a decision");
    expect(JSON.stringify(posted[cardIndex]?.blocks ?? [])).not.toContain(APPROVE_ACTION);
  });
});

describe("nudges respect what admins switched off", () => {
  it("no approver is pinged about a request whose tool is switched off: the click would refuse it", async () => {
    const admins = { ...config(), teammate: { ...config().teammate, admins: ["UADMIN"] } } as AppConfig;
    const core = await createTeammate(admins, vault, slack as never, "UBOT");
    script = { calls: [{ name: "memory_save", input: { text: "Release notes go out on Thursdays.", scope: "channel:C1" } }], reply: "Asked." };
    await core.onMention({ channel: "C1", ts: "3.0", user: "U1", text: "<@UBOT> remember release notes go out on Thursdays" });
    await settle(core);
    expect(await core.onSlashCommand({ channel: "C1", user: "UADMIN", text: "admin deny memory_save", commandId: "n1" })).toMatch(/is off/);
    const count = posted.length;
    await core.checkApprovals(new Date(Date.now() + 25 * 3_600_000));
    expect(posted.slice(count).filter((message) => String(message.text).includes("Still waiting"))).toEqual([]);
    // Switched back on: the nudge goes out.
    await core.onSlashCommand({ channel: "C1", user: "UADMIN", text: "admin allow memory_save", commandId: "n2" });
    await core.checkApprovals(new Date(Date.now() + 26 * 3_600_000));
    expect(posted.slice(count).filter((message) => String(message.text).includes("Still waiting"))).toHaveLength(1);
  });
});

describe("approvals nobody decides, while paused or erased", () => {
  const ask = async (core: Awaited<ReturnType<typeof createTeammate>>) => {
    script = { calls: [{ name: "memory_save", input: { text: "Release notes go out on Thursdays.", scope: "channel:C1" } }], reply: "Asked." };
    await core.onMention({ channel: "C1", ts: "3.0", user: "U1", text: "<@UBOT> remember release notes go out on Thursdays" });
    await settle(core);
    return posted.findIndex((message) => JSON.stringify(message.blocks ?? []).includes(APPROVE_ACTION));
  };

  it("a crash between a nudge and its ledger record doesn't nudge twice", async () => {
    const core = await createTeammate(config(), vault, slack as never, "UBOT");
    const cardIndex = await ask(core);
    const file = path.join(tmpRoot, "state", "approvals.json");
    const [request] = JSON.parse(await fs.readFile(file, "utf8")) as Array<{ id: string }>;
    const { FileEffectLedger, opKey } = await import("@scriptorium/runtime");
    await new FileEffectLedger(path.join(tmpRoot, "state", "effects.json")).put({ op: opKey("teammate.card.nudged", request!.id), status: "in-progress", startedAt: new Date().toISOString() });
    // The nudge the crashed run posted is in the card's thread.
    threadReplies = [{ ts: "9.99", text: "⏰ Still waiting for an approver", metadata: { event_type: "scriptorium_approval_nudge", event_payload: { request: request!.id } } } as never];
    const count = posted.length;
    await core.checkApprovals(new Date(Date.now() + 25 * 3_600_000));
    expect(posted.slice(count).filter((message) => message.text.includes("Still waiting"))).toHaveLength(0);
    expect(cardIndex).toBeGreaterThanOrEqual(0);
  });

  it("sends no nudge while paused", async () => {
    const core = await createTeammate({ ...config(), teammate: { ...config().teammate, admins: ["UADMIN"] } } as AppConfig, vault, slack as never, "UBOT");
    await ask(core);
    await core.onSlashCommand({ channel: "C1", user: "UADMIN", text: "admin pause maintenance", commandId: "p1" });
    const count = posted.length;
    await core.checkApprovals(new Date(Date.now() + 25 * 3_600_000));
    expect(posted.slice(count).filter((message) => message.text.includes("Still waiting"))).toHaveLength(0);
  });

  it("closes the card of a request cancelled outright (privacy erase), not only one that timed out", async () => {
    const core = await createTeammate(config(), vault, slack as never, "UBOT");
    const cardIndex = await ask(core);
    const file = path.join(tmpRoot, "state", "approvals.json");
    const stored = JSON.parse(await fs.readFile(file, "utf8")) as Array<{ status: string }>;
    await fs.writeFile(file, JSON.stringify(stored.map((entry) => ({ ...entry, status: "expired" }))));
    await core.checkApprovals(new Date());
    expect(posted[cardIndex]?.text).toContain("Expired without a decision");
    expect(JSON.stringify(posted[cardIndex]?.blocks ?? [])).not.toContain(APPROVE_ACTION);
  });
});

describe("your memories", () => {
  it("/teammate memories lists what applies to you; you can forget your own at once, not others'", async () => {
    const core = await createTeammate({ ...config(), teammate: { ...config().teammate, admins: ["UADMIN"] } } as AppConfig, vault, slack as never, "UBOT");
    const write = (id: string, scope: string, text: string) => vault.writeNote(`_memory/${id}.md`, text, { id, scope, status: "approved", approved_by: "Priya" });
    await write("M-0000aaaa", "person:slack:U1", "Prefers short answers.");
    await write("M-0000bbbb", "channel:C1", "Release notes go out on Thursdays.");
    await write("M-0000cccc", "person:slack:U2", "Someone else's preference.");

    const listed = (await core.onSlashCommand({ channel: "C1", user: "U1", text: "memories", commandId: "m1" }))!;
    expect(listed).toContain("`M-0000aaaa` (about you): Prefers short answers.");
    expect(listed).toContain("`M-0000bbbb` (channel:C1)");
    expect(listed).not.toContain("Someone else");

    expect(await core.onSlashCommand({ channel: "C1", user: "U1", text: "forget M-0000cccc", commandId: "m2" })).toMatch(/^Nothing forgotten: M-0000cccc isn't yours/);
    expect(await core.onSlashCommand({ channel: "C1", user: "U1", text: "forget M-0000bbbb", commandId: "m3" })).toMatch(/^Nothing forgotten/);
    expect(await core.onSlashCommand({ channel: "C1", user: "U1", text: "forget M-0000aaaa", commandId: "m4" })).toMatch(/^Forgotten: `M-0000aaaa`/);
    expect(await vault.exists("_memory/M-0000aaaa.md")).toBe(false);
    // An admin may curate the shared ones.
    expect(await core.onSlashCommand({ channel: "C1", user: "UADMIN", text: "forget M-0000bbbb", commandId: "m5" })).toMatch(/^Forgotten/);
    expect(await fs.readFile(path.join(tmpRoot, "audit.jsonl"), "utf8")).toContain('"type":"memory.forgotten"');
    expect(posted).toEqual([]);
  });
});

describe("admin controls", () => {
  it("an admin pauses it: nothing is answered or carried out until they resume; others can't", async () => {
    const admins = { ...config(), teammate: { ...config().teammate, admins: ["UADMIN"] } } as AppConfig;
    const core = await createTeammate(admins, vault, slack as never, "UBOT");
    script = { calls: [{ name: "memory_save", input: { text: "Release notes go out on Thursdays.", scope: "channel:C1" } }], reply: "Asked." };
    await core.onMention({ channel: "C1", ts: "3.0", user: "U1", text: "<@UBOT> remember release notes go out on Thursdays" });
    await settle(core);
    const card = posted.find((message) => JSON.stringify(message.blocks ?? []).includes(APPROVE_ACTION))!;
    const requestId = JSON.stringify(card.blocks).match(/"value":"([0-9a-f-]{36})"/)?.[1] as string;

    expect(await core.onSlashCommand({ channel: "C1", user: "U1", text: "admin pause", commandId: "a0" })).toMatch(/^Only Teammate admins/);
    expect(await core.onSlashCommand({ channel: "C_ANY", user: "UADMIN", text: "admin pause investigating", commandId: "a1" })).toMatch(/^⏸️ Paused/);

    const again = await createTeammate(admins, vault, slack as never, "UBOT");
    posted.length = 0;
    script = { calls: [], reply: "SHOULD NOT BE CALLED" };
    await again.onMention({ channel: "C1", ts: "4.0", user: "U1", text: "<@UBOT> hello?" });
    await settle(again);
    expect(posted.map((message) => message.text)).toEqual(["⏸️ I've been paused by an admin, so I'm not answering or changing anything right now."]);
    // A click while paused decides nothing: the request is still pending afterwards.
    const core2 = await createTeammate(admins, vault, slack as never, "UBOT");
    expect(await core2.onApprovalClick(APPROVE_ACTION, { actions: [{ value: requestId }], user: { id: "UPM", username: "priya" }, channel: { id: "C1" }, message: { ts: "9.1" } })).toContain("paused");
    expect(await vault.listNotes("_memory")).toHaveLength(0);

    expect(await core2.onSlashCommand({ channel: "C_ANY", user: "UADMIN", text: "admin resume", commandId: "a2" })).toBe("▶️ Resumed.");
    expect(await core2.onApprovalClick(APPROVE_ACTION, { actions: [{ value: requestId }], user: { id: "UPM", username: "priya" }, channel: { id: "C1" }, message: { ts: "9.1" } })).toBeUndefined();
    expect(await vault.listNotes("_memory")).toHaveLength(1);
  });

  it("an admin delegates an away approver to a stand-in, until a date, and can end it", async () => {
    const admins = { ...config(), teammate: { ...config().teammate, admins: ["UADMIN"] } } as AppConfig;
    const core = await createTeammate(admins, vault, slack as never, "UBOT");
    const until = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    expect(await core.onSlashCommand({ channel: "C1", user: "UADMIN", text: `admin delegate <@UPM|priya> <@UALT> ${until}`, commandId: "d1" })).toContain("<@UALT> can approve what <@UPM> can");
    expect(await core.onSlashCommand({ channel: "C1", user: "U1", text: `admin delegate UPM U1 ${until}`, commandId: "d2" })).toMatch(/^Only Teammate admins/);

    const ask = async (user: string, ts: string) => {
      script = { calls: [{ name: "memory_save", input: { text: `Note from ${user}.`, scope: "channel:C1" } }], reply: "Asked." };
      const again = await createTeammate(admins, vault, slack as never, "UBOT");
      await again.onMention({ channel: "C1", ts, user, text: "<@UBOT> remember this" });
      await settle(again);
      const card = [...posted].reverse().find((message) => JSON.stringify(message.blocks ?? []).includes(APPROVE_ACTION))!;
      return JSON.stringify(card.blocks).match(/"value":"([0-9a-f-]{36})"/)?.[1] as string;
    };
    const click = (id: string, user: string) => createTeammate(admins, vault, slack as never, "UBOT").then((fresh) => fresh.onApprovalClick(APPROVE_ACTION, { actions: [{ value: id }], user: { id: user, username: user }, channel: { id: "C1" }, message: { ts: "9.1" } }));

    const byU1 = await ask("U1", "3.0");
    expect(await click(byU1, "UALT")).toBeUndefined(); // the stand-in approves
    expect(await vault.listNotes("_memory")).toHaveLength(1);
    expect(await click(await ask("U2", "4.0"), "U_NOBODY")).toMatch(/^Not recorded/);
    expect(await core.onSlashCommand({ channel: "C1", user: "UADMIN", text: "admin status", commandId: "d3" })).toContain("standing in: <@UALT> for <@UPM>");
    expect(await core.onSlashCommand({ channel: "C1", user: "UADMIN", text: "admin undelegate UPM", commandId: "d4" })).toBe("Delegation from <@UPM> ended.");
    expect(await click(await ask("U3", "5.0"), "UALT")).toMatch(/^Not recorded/);
  });

  it("a tool an admin switched off is not offered, and an approval for it isn't carried out", async () => {
    const admins = { ...config(), teammate: { ...config().teammate, admins: ["UADMIN"] } } as AppConfig;
    const core = await createTeammate(admins, vault, slack as never, "UBOT");
    expect(await core.onSlashCommand({ channel: "C1", user: "UADMIN", text: "admin deny memory_save", commandId: "a3" })).toBe("🚫 `memory_save` is off.");
    script = { calls: [{ name: "memory_save", input: { text: "x is y.", scope: "channel:C1" } }], reply: "Asked." };
    await core.onMention({ channel: "C1", ts: "5.0", user: "U1", text: "<@UBOT> remember x" });
    await settle(core);
    expect(posted.some((message) => JSON.stringify(message.blocks ?? []).includes(APPROVE_ACTION))).toBe(false);
  });
});

describe("reminders", () => {
  it("a reminder is approved once, posted once when due, escaped, and only in the channel that asked", async () => {
    const core = await createTeammate(config(), vault, slack as never, "UBOT");
    const at = new Date(Date.now() + 3_600_000).toISOString();
    script = { calls: [{ name: "schedule_reminder", input: { channel: "C1", at, text: "Update estimates <!channel>" } }], reply: "Asked." };
    await core.onMention({ channel: "C1", ts: "3.0", user: "U1", text: "<@UBOT> remind us in an hour to update estimates" });
    await settle(core);
    const card = posted.find((message) => JSON.stringify(message.blocks ?? []).includes(APPROVE_ACTION))!;
    expect(JSON.stringify(card.blocks)).toContain("Post a reminder in channel C1");
    const requestId = JSON.stringify(card.blocks).match(/"value":"([0-9a-f-]{36})"/)?.[1] as string;
    await core.onApprovalClick(APPROVE_ACTION, { actions: [{ value: requestId }], user: { id: "UPM", username: "priya" }, channel: { id: "C1" }, message: { ts: "9.1", thread_ts: "3.0" } });

    posted.length = 0;
    await core.checkReminders(new Date(Date.now() + 60_000)); // not yet
    expect(posted).toEqual([]);
    await core.checkReminders(new Date(Date.now() + 3_700_000));
    await core.checkReminders(new Date(Date.now() + 3_800_000)); // already sent
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ channel: "C1" });
    expect(posted[0]?.text).toContain("Update estimates &lt;!channel&gt;");
    expect(posted[0]?.text).toContain("approved by priya");
  });

  it("an approved reminder waits while an admin has reminders switched off, or its channel is no longer allowed", async () => {
    const admins = { ...config(), teammate: { ...config().teammate, admins: ["UADMIN"] } } as AppConfig;
    const core = await createTeammate(admins, vault, slack as never, "UBOT");
    const at = new Date(Date.now() + 3_600_000).toISOString();
    script = { calls: [{ name: "schedule_reminder", input: { channel: "C1", at, text: "Update estimates" } }], reply: "Asked." };
    await core.onMention({ channel: "C1", ts: "3.0", user: "U1", text: "<@UBOT> remind us in an hour" });
    await settle(core);
    const card = posted.find((message) => JSON.stringify(message.blocks ?? []).includes(APPROVE_ACTION))!;
    const requestId = JSON.stringify(card.blocks).match(/"value":"([0-9a-f-]{36})"/)?.[1] as string;
    await core.onApprovalClick(APPROVE_ACTION, { actions: [{ value: requestId }], user: { id: "UPM", username: "priya" }, channel: { id: "C1" }, message: { ts: "9.1", thread_ts: "3.0" } });

    expect(await core.onSlashCommand({ channel: "C1", user: "UADMIN", text: "admin deny schedule_reminder", commandId: "r1" })).toMatch(/is off/);
    posted.length = 0;
    await core.checkReminders(new Date(Date.now() + 3_700_000));
    expect(posted).toEqual([]);

    // Its channel taken off the allow-list: still nothing.
    await core.onSlashCommand({ channel: "C1", user: "UADMIN", text: "admin allow schedule_reminder", commandId: "r2" });
    const elsewhere = await createTeammate({ ...admins, teammate: { ...admins.teammate, channels: ["C2"] } } as AppConfig, vault, slack as never, "UBOT");
    await elsewhere.checkReminders(new Date(Date.now() + 3_700_000));
    expect(posted.filter((message) => message.channel === "C1")).toEqual([]);

    // Back on, in an allowed channel: it posts.
    await core.checkReminders(new Date(Date.now() + 3_700_000));
    expect(posted.filter((message) => message.channel === "C1")).toHaveLength(1);
  });

  it("posts once even when Slack's response to the post is lost", async () => {
    const { reminderTools } = await import("@scriptorium/agents");
    const { FileEffectLedger } = await import("@scriptorium/runtime");
    const store = new FileEffectLedger(path.join(tmpRoot, "state", "reminders.json"));
    const [schedule] = reminderTools(store);
    await schedule!.run({ channel: "C1", at: new Date(Date.now() + 60_000).toISOString(), text: "stand-up" }, { approval: { id: "ap-lost" } });
    const core = await createTeammate(config(), vault, slack as never, "UBOT");
    loseNextReminderPost = true;
    await core.checkReminders(new Date(Date.now() + 120_000));
    await core.checkReminders(new Date(Date.now() + 180_000));
    expect(posted.filter((message) => message.text.includes("stand-up"))).toHaveLength(1);
  });

  it("needs a timezone, and ids stay tellable apart for the steps of one plan", async () => {
    const { reminderTools, shortId } = await import("@scriptorium/agents");
    const { MemoryEffectLedger } = await import("@scriptorium/runtime");
    const store = new MemoryEffectLedger();
    const [schedule, list, cancel] = reminderTools(store);
    expect(await schedule!.run({ channel: "C1", at: "2030-10-02T09:00:00", text: "x" })).toMatch(/timezone offset/);
    expect(await schedule!.run({ channel: "C1", at: "2030-10-02", text: "x" })).toMatch(/timezone offset/);
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    await schedule!.run({ channel: "C1", at: soon, text: "one" }, { approval: { id: "4f1c2a90-aaaa-bbbb-cccc-000000000000#1" } });
    await schedule!.run({ channel: "C1", at: soon, text: "two" }, { approval: { id: "4f1c2a90-aaaa-bbbb-cccc-000000000000#2" } });
    const ids = (JSON.parse(await list!.run({ channel: "C1" })) as Array<{ id: string }>).map((reminder) => reminder.id);
    expect(ids).toEqual(["4f1c2a90#1", "4f1c2a90#2"]);
    expect(await cancel!.run({ channel: "C1", id: "4f1c2a90#2" })).toBe("Cancelled reminder 4f1c2a90#2.");
    expect(JSON.parse(await list!.run({ channel: "C1" }))).toHaveLength(1);
    expect(shortId("abcdef1234")).toBe("abcdef12");
  });

  it("can't be set for another channel, and one a day overdue is dropped, not posted", async () => {
    const { bindToTurn, reminderTools, dueReminders } = await import("@scriptorium/agents");
    const { MemoryEffectLedger } = await import("@scriptorium/runtime");
    const store = new MemoryEffectLedger();
    const [schedule] = bindToTurn(reminderTools(store), { question: "q", askedBy: "slack:U1", channel: "C1", threadTs: "1.0" });
    expect(await schedule!.run({ channel: "C_OTHER", at: new Date(Date.now() + 3_600_000).toISOString(), text: "x" })).toMatch(/^NOT_ALLOWED/);
    expect(await schedule!.run({ channel: "C1", at: "2020-01-01T00:00:00Z", text: "x" })).toMatch(/^NOT_ALLOWED: that time has already passed/);
    expect(await schedule!.run({ channel: "C1", at: new Date(Date.now() + 40 * 24 * 3_600_000).toISOString(), text: "x" })).toMatch(/at most 30 days/);
    await schedule!.run({ channel: "C1", at: new Date(Date.now() + 60_000).toISOString(), text: "stand-up" }, { approval: { id: "ap-1" } });
    const { due, stale } = await dueReminders(store, Date.now() + 2 * 24 * 3_600_000);
    expect(due).toEqual([]);
    expect(stale.map((reminder) => reminder.text)).toEqual(["stand-up"]);
  });
});

describe("plans", () => {
  it("a plan with a step that needs its own approval is refused before any card is posted", async () => {
    const core = await createTeammate(config(), vault, slack as never, "UBOT");
    script = {
      calls: [{ name: "propose_plan", input: { title: "Sneaky", steps: [{ tool: "memory_save", args: { text: "x is y.", scope: "global" } }, { tool: "memory_save", args: { text: "z.", scope: "global" } }] } }],
      reply: "Proposed.",
    };
    await core.onMention({ channel: "C1", ts: "3.0", user: "U1", text: "<@UBOT> do the plan" });
    await settle(core);
    expect(posted.some((message) => JSON.stringify(message.blocks ?? []).includes(APPROVE_ACTION))).toBe(false);
  });
});

describe("the approvals inbox (App Home)", () => {
  it("shows an approver what is waiting for them, linked to the card; shows others nothing to approve", async () => {
    const core = await createTeammate(config(), vault, slack as never, "UBOT");
    script = { calls: [{ name: "memory_save", input: { text: "Release notes go out on Thursdays.", scope: "channel:C1" } }], reply: "Asked." };
    await core.onMention({ channel: "C1", ts: "3.0", user: "U1", text: "<@UBOT> remember release notes go out on Thursdays" });
    await settle(core);
    const card = posted.find((message) => JSON.stringify(message.blocks ?? []).includes(APPROVE_ACTION))!;
    const cardTs = `9.${posted.indexOf(card) + 1}`;

    const approver = JSON.stringify(await core.homeView("UPM"));
    expect(approver).toContain("Waiting for your approval (1)");
    expect(approver).toContain("Remember (channel:C1)");
    expect(approver).toContain(`https://team.slack.com/archives/C1/p${cardTs.replace(".", "")}|open the card`);
    // Read-only: deciding happens on the card, never from Home.
    expect(approver).not.toContain(APPROVE_ACTION);

    const asker = JSON.stringify(await core.homeView("U1"));
    expect(asker).toContain("Waiting for your approval (0)");
    expect(asker).toContain("*waiting*");
    expect(JSON.stringify(await core.homeView("U_RANDOM"))).toContain("Waiting for your approval (0)");
  });

  it("doesn't describe a request whose card is in a private channel", async () => {
    const privateConfig = { ...config(), teammate: { ...config().teammate, channels: ["C1", "G1"] } } as AppConfig;
    const core = await createTeammate(privateConfig, vault, slack as never, "UBOT");
    script = { calls: [{ name: "memory_save", input: { text: "The reorg is announced Friday.", scope: "channel:G1" } }], reply: "Asked." };
    await core.onMention({ channel: "G1", ts: "3.0", user: "U1", text: "<@UBOT> remember the reorg date" });
    await settle(core);
    const home = JSON.stringify(await core.homeView("UPM"));
    expect(home).toContain("Waiting for your approval (1)");
    expect(home).toContain("A request in a private conversation");
    expect(home).not.toContain("reorg");
  });
});

describe("slash command and shortcut", () => {
  it("/teammate posts the question as a thread and answers under it — only where it answers at all", async () => {
    const core = await createTeammate(config(), vault, slack as never, "UBOT");
    script = { calls: [{ name: "search_vault", input: { query: "digest" } }], reply: "At 09:00 [[docs/digest-emails]]." };
    expect(await core.onSlashCommand({ channel: "C1", user: "U1", text: "when are digests sent? <!channel>", commandId: "t1" })).toBeUndefined();
    expect(await core.onSlashCommand({ channel: "C_OTHER", user: "U1", text: "hello", commandId: "t2" })).toMatch(/^I don't work in this conversation\. Ask me in <#C1>/);
    expect(await core.onSlashCommand({ channel: "C1", user: "U1", text: "help", commandId: "t3" })).toContain("I'm the Teammate");
    await settle(core);
    const [root, answer, ...rest] = posted;
    expect(rest).toEqual([]);
    // The question is shown as asked, but can't ping the channel.
    expect(root).toMatchObject({ channel: "C1", text: "<@U1> asked: when are digests sent? &lt;!channel&gt;" });
    expect(answer).toMatchObject({ channel: "C1", thread_ts: "9.1" });
    expect(answer?.text).toContain("docs/digest-emails");
  });

  it("in DMs, only the invoker's own DM with the Teammate counts", async () => {
    const core = await createTeammate({ ...config(), teammate: { ...config().teammate, allowDms: true } } as AppConfig, vault, slack as never, "UBOT");
    expect(await core.onFileAsTicket({ channel: "D_PEOPLE", user: "U1", messageTs: "5.0", shortcutId: "s9" })).toMatch(/^I don't work/);
    expect(await core.onSlashCommand({ channel: "D1", user: "U2", text: "hi", commandId: "t9" })).toMatch(/^I don't work/);
    expect(await core.onSlashCommand({ channel: "D1", user: "U1", text: "help", commandId: "t10" })).toContain("I'm the Teammate");
  });

  it("'File as a ticket' reads the thread including the message it was used on", async () => {
    const core = await createTeammate(config(), vault, slack as never, "UBOT");
    threadReplies = [{ ts: "5.0", user: "U2", text: "Digest times should follow each subscriber's timezone" }];
    script = { calls: [], reply: "Proposed a ticket." };
    expect(await core.onFileAsTicket({ channel: "C1", user: "U1", messageTs: "5.0", shortcutId: "s1" })).toBeUndefined();
    expect(await core.onFileAsTicket({ channel: "C_OTHER", user: "U1", messageTs: "5.0", shortcutId: "s2" })).toMatch(/^I don't work/);
    await settle(core);
    expect(lastPrompt).toContain("follow each subscriber");
    expect(posted[0]).toMatchObject({ channel: "C1", thread_ts: "5.0" });
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
    await on.onDirectMessage({ channel: "D2", channel_type: "im", ts: "5.0", user: "U2", text: "when are digests sent? (screenshot attached)", subtype: "file_share" });
    await settle(on);
    // The screenshot DM is a question too.
    expect(posted.filter((message) => message.channel === "D2")).toHaveLength(1);
    posted.splice(posted.findIndex((message) => message.channel === "D2"), 1);
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

  it("one Jira turn that fails doesn't drop the next one queued on the same ticket", async () => {
    const { comments, jira } = fakeJira();
    const client = jira.client as unknown as { addComment: (key: string, body: string, options?: { op?: string }) => Promise<unknown> };
    const add = client.addComment;
    let calls = 0;
    client.addComment = async (key, body, options) => {
      calls += 1;
      if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 60)); // the first turn is slow: the next two queue as one batch
      if (calls === 2) throw new Error("Jira 403: the reply's restriction names a role the Teammate isn't in");
      return add(key, body, options);
    };
    const core = await createTeammate(config(), vault, slack as never, "UBOT", jira);
    script = { calls: [{ name: "search_vault", input: { query: "digest" } }], reply: "At 09:00 [[docs/digest-emails]]." };
    const mention = (commentId: string, body: string) => ({ issueKey: "DOC-7", commentId, body: `[~accountid:tm-1] ${body}`, authorId: "human-1" });
    const first = core.onJiraComment(mention("c0", "when do digests go out?"));
    await new Promise((resolve) => setTimeout(resolve, 15));
    await core.onJiraComment(mention("c1", "and on weekends?"));
    await core.onJiraComment(mention("c2", "and on holidays?"));
    await first;
    await settle(core);
    // c1's reply failed; c2, queued behind it in the same batch, is still answered.
    expect(comments).toHaveLength(2);
    expect(calls).toBe(3);
  });

  it("a comment edited to add the mention is answered — once, however often it is edited again", async () => {
    const { comments, jira } = fakeJira();
    const core = await createTeammate(config(), vault, slack as never, "UBOT", jira);
    script = { calls: [{ name: "search_vault", input: { query: "digest" } }], reply: "At 09:00 [[docs/digest-emails]]." };
    const first = { issueKey: "DOC-7", commentId: "c9", body: "when do digests go out?", authorId: "human-1" };
    await core.onJiraComment(first); // no mention yet: not for the Teammate
    await core.onJiraComment({ ...first, body: "[~accountid:tm-1] when do digests go out?" }); // the edit
    await core.onJiraComment({ ...first, body: "[~accountid:tm-1] when do digest emails go out?" }); // a typo fix
    await settle(core);
    expect(comments).toHaveLength(1);
  });

  it("answers a mention of its own account on the ticket, once, as itself — and nothing else", async () => {
    const { comments, jira } = fakeJira();
    const core = await createTeammate(config(), vault, slack as never, "UBOT", jira);
    script = { calls: [{ name: "search_vault", input: { query: "digest" } }], reply: "At 09:00 [[docs/digest-emails]]; see [[docs/digest-emails.md|Digest emails]]." };
    const mention = { issueKey: "DOC-7", commentId: "c1", body: "[~accountid:tm-1] when do digests go out?", authorId: "human-1" };
    await core.onJiraComment(mention);
    await core.onJiraComment(mention); // a webhook redelivery
    await core.onJiraComment({ ...mention, commentId: "c2", body: "no mention here" });
    await core.onJiraComment({ ...mention, commentId: "c3", body: "[~accountid:scribe-bot] draft" });
    await core.onJiraComment({ ...mention, commentId: "c4", authorId: "tm-1" }); // its own comment
    await core.onJiraComment({ ...mention, issueKey: "HR-1", commentId: "c5" }); // outside its projects
    await settle(core);

    expect(comments).toHaveLength(1);
    // A Jira link to the doc, not a raw [[wikilink]].
    expect(comments[0]?.body).toContain("[docs/digest-emails|https://docs.example/digest-emails]");
    // A `.md` target still resolves, and an alias is the link's label.
    expect(comments[0]?.body).toContain("[Digest emails|https://docs.example/digest-emails]");
    expect(comments[0]?.body).not.toContain("[[");
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

describe("restricted Jira comments", () => {
  it("an internal or role-restricted question is answered at the same visibility, never in public", async () => {
    const comments: Array<{ issue: string; body: string; options: Record<string, unknown> }> = [];
    const jira = {
      accountId: "tm-1",
      client: {
        addComment: async (issue: string, body: string, options: Record<string, unknown> = {}) => (comments.push({ issue, body, options }), { id: String(comments.length), body, created: "now" }),
        findCommentByOp: async () => undefined,
      } as never,
    };
    const core = await createTeammate({ ...config(), teammate: { ...config().teammate, jiraProjects: ["DOC"] } } as AppConfig, vault, slack as never, "UBOT", jira);
    script = { calls: [{ name: "search_vault", input: { query: "digest" } }], reply: "At 09:00 [[docs/digest-emails]]." };
    const role = { visibility: { type: "role" as const, value: "Developers" } };
    await core.onJiraComment({ issueKey: "DOC-7", commentId: "c1", body: "[~accountid:tm-1] when do digests go out?", authorId: "h1", restriction: role });
    await core.onJiraComment({ issueKey: "DOC-8", commentId: "c2", body: "[~accountid:tm-1] when do digests go out?", authorId: "h1", restriction: { internal: true } });
    await settle(core);
    expect(comments.find((comment) => comment.issue === "DOC-7")?.options.restriction).toEqual(role);
    expect(comments.find((comment) => comment.issue === "DOC-8")?.options.restriction).toEqual({ internal: true });
  });

  it("the client sends the restriction Jira reads", async () => {
    const { jiraClient } = await import("@scriptorium/jira");
    const sent: unknown[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => (sent.push(JSON.parse(String(init?.body))), new Response(JSON.stringify({ id: "1", body: "x", created: "now" }), { status: 201 }))) as typeof fetch;
    try {
      const client = jiraClient({ baseUrl: "https://x.atlassian.net", email: "a@x", apiToken: "t", projectKey: "DOC" } as never);
      await client.addComment("SD-1", "hi", { op: "o1", restriction: { internal: true, visibility: { type: "group", value: "staff" } } });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(sent[0]).toMatchObject({
      body: "hi",
      visibility: { type: "group", value: "staff" },
      properties: [{ key: "scriptorium.op", value: { op: "o1" } }, { key: "sd.public.comment", value: { internal: true } }],
    });
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

  it("a total cap holds across scopes: many DMs can't each spend a full channel's budget", async () => {
    const auditFile = path.join(tmpRoot, "audit.jsonl");
    const today = new Date().toISOString();
    await fs.writeFile(auditFile, ["D5", "D6"].map((scope) => JSON.stringify({ ts: today, type: "llm.usage", scope, input: 600, output: 0 })).join("\n") + "\n");
    const capped = { ...config(), teammate: { ...config().teammate, dailyTokensTotal: 1_000 } } as AppConfig;
    const core = await createTeammate(capped, vault, slack as never, "UBOT");
    script = { calls: [], reply: "SHOULD NOT BE CALLED" };
    await core.onMention({ channel: "C1", ts: "9.0", user: "U1", text: "<@UBOT> when are digests sent?" });
    await settle(core);
    expect(posted[0]?.text).toContain("today's usage limit");
    expect(await fs.readFile(auditFile, "utf8")).toContain('"scope":"*"');
  });

  it("/teammate over the cap answers privately and posts nothing", async () => {
    await fs.writeFile(path.join(tmpRoot, "audit.jsonl"), JSON.stringify({ ts: new Date().toISOString(), type: "llm.usage", scope: "C1", input: 5_000, output: 0 }) + "\n");
    const capped = { ...config(), teammate: { ...config().teammate, dailyTokens: 1_000 } } as AppConfig;
    const core = await createTeammate(capped, vault, slack as never, "UBOT");
    expect(await core.onSlashCommand({ channel: "C1", user: "U1", text: "when are digests sent?", commandId: "t1" })).toContain("today's usage limit");
    expect(posted).toEqual([]);
  });

  it("a Jira project and a PR repo are capped too — a ticket comment can't spend without limit", async () => {
    const auditFile = path.join(tmpRoot, "audit.jsonl");
    const today = new Date().toISOString();
    await fs.writeFile(
      auditFile,
      [{ scope: "jira:DOC" }, { scope: "github:org/app" }].map((line) => JSON.stringify({ ts: today, type: "llm.usage", input: 5_000, output: 0, ...line })).join("\n") + "\n",
    );
    const comments: Array<{ body: string; op?: string }> = [];
    const jira = {
      accountId: "tm-1",
      client: {
        addComment: async (_key: string, body: string, options: { op?: string } = {}) => (comments.push({ body, op: options.op }), { id: String(comments.length), body, created: "now" }),
        findCommentByOp: async (_key: string, op: string) => comments.find((comment) => comment.op === op),
      } as never,
    };
    const capped = { ...config(), teammate: { ...config().teammate, dailyTokens: 1_000, githubRepos: ["org/app"], prChannel: "CPR" } } as AppConfig;
    const core = await createTeammate(capped, vault, slack as never, "UBOT", jira);
    script = { calls: [], reply: "SHOULD NOT BE CALLED" };
    await core.onJiraComment({ issueKey: "DOC-7", commentId: "c1", body: "[~accountid:tm-1] when do digests go out?", authorId: "human-1" });
    await core.onPullRequest({ repo: "org/app", number: 12, author: "dev", deliveryId: "d-9" });
    await settle(core);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("today's usage limit");
    expect(posted.find((message) => message.channel === "CPR")?.text).toContain("today's usage limit");
    expect(JSON.stringify([comments, posted])).not.toContain("SHOULD NOT BE CALLED");
  });
});

describe("triage of new Jira tickets", () => {
  it("triages opted-in projects once per ticket, never its own tickets, within the hourly cap", async () => {
    const comments: Array<{ issue: string; body: string; op?: string }> = [];
    const jira = {
      accountId: "tm-1",
      client: {
        addComment: async (issue: string, body: string, options: { op?: string } = {}) => (comments.push({ issue, body, op: options.op }), { id: String(comments.length), body, created: "now" }),
        findCommentByOp: async (_key: string, op: string) => comments.find((comment) => comment.op === op),
      } as never,
    };
    const triage = { ...config(), teammate: { ...config().teammate, jiraProjects: ["BEA", "DOC"], triageProjects: ["BEA"], triagePerHour: 2 } } as AppConfig;
    const core = await createTeammate(triage, vault, slack as never, "UBOT", jira);
    script = { calls: [], reply: "NOT_IN_KB: acceptance criteria" };
    await core.onJiraCreated({ issueKey: "BEA-1", reporterId: "human-1" });
    await core.onJiraCreated({ issueKey: "BEA-1", reporterId: "human-1" }); // a redelivery
    await core.onJiraCreated({ issueKey: "DOC-5", reporterId: "human-1" }); // not opted in
    await core.onJiraCreated({ issueKey: "BEA-2", reporterId: "tm-1" }); // its own ticket
    await core.onJiraCreated({ issueKey: "BEA-3", reporterId: "human-1" });
    await core.onJiraCreated({ issueKey: "BEA-4", reporterId: "human-1" }); // over 2 an hour
    await settle(core);
    expect(comments.map((comment) => comment.issue).sort()).toEqual(["BEA-1", "BEA-3"]);
    expect(await fs.readFile(path.join(tmpRoot, "audit.jsonl"), "utf8")).toContain("triage rate cap for BEA reached");
  });

  it("the hourly cap rolls", async () => {
    const { HourlyCap } = await import("@scriptorium/agents");
    let now = 0;
    const cap = new HourlyCap(1, () => now);
    expect(cap.take("BEA")).toBe(true);
    expect(cap.take("BEA")).toBe(false);
    expect(cap.take("OPS")).toBe(true);
    now = 3_600_001;
    expect(cap.take("BEA")).toBe(true);
  });
});

describe("assigned on Jira", () => {
  it("checks readiness and replies on the ticket when the ticket is assigned to it — once, and only to it", async () => {
    const comments: Array<{ body: string; op?: string }> = [];
    const jira = {
      accountId: "tm-1",
      client: {
        addComment: async (_key: string, body: string, options: { op?: string } = {}) => (comments.push({ body, op: options.op }), { id: String(comments.length), body, created: "now" }),
        findCommentByOp: async (_key: string, op: string) => comments.find((comment) => comment.op === op),
      } as never,
    };
    const core = await createTeammate(config(), vault, slack as never, "UBOT", jira);
    script = { calls: [], reply: "NOT_IN_KB: acceptance criteria" };
    await core.onJiraAssigned({ issueKey: "DOC-9", assigneeId: "tm-1", changeId: "ch-1" });
    await core.onJiraAssigned({ issueKey: "DOC-9", assigneeId: "tm-1", changeId: "ch-1" });
    await core.onJiraAssigned({ issueKey: "DOC-9", assigneeId: "someone-else", changeId: "ch-2" });
    await settle(core);
    expect(comments).toHaveLength(1);
  });
});
