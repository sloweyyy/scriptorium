import { describe, expect, it } from "vitest";
import type { WebClient } from "@slack/web-api";
import { z } from "zod";
import type { ToolSpec } from "@scriptorium/core";
import { APPROVE_ACTION, REJECT_ACTION, SlackApprovalChannel, handleApprovalClick, slackTools } from "@scriptorium/connectors";
import { MemoryApprovalStore, runUnderPolicy, type Envelope } from "@scriptorium/policy";
import { MemoryEffectLedger } from "@scriptorium/runtime";

/**
 * Slack as tools and as the approval surface. A fake WebClient records every call; the
 * thread it serves is whatever has been posted to it.
 */

type Message = { ts: string; text?: string; user?: string; metadata?: { event_type: string; event_payload: unknown }; blocks?: unknown[] };

function fakeSlack(options: { loseNextPostResponse?: boolean; refusePosts?: boolean } = {}) {
  const thread: Message[] = [{ ts: "1.0", text: "How do digests work?", user: "U_ASKER" }];
  const updates: Array<{ ts: string; text: string }> = [];
  let lose = options.loseNextPostResponse ?? false;
  const client = {
    conversations: {
      replies: async () => ({ ok: true, messages: thread }),
    },
    chat: {
      postMessage: async (args: { text: string; metadata?: Message["metadata"]; blocks?: unknown[] }) => {
        if (options.refusePosts) return { ok: false, error: "not_in_channel" };
        const ts = `1.${thread.length}`;
        thread.push({ ts, text: args.text, metadata: args.metadata, blocks: args.blocks });
        if (lose) {
          lose = false;
          throw new Error("socket hang up");
        }
        return { ok: true, ts };
      },
      update: async (args: { ts: string; text: string }) => {
        updates.push(args);
        return { ok: true };
      },
    },
  };
  return { client: client as unknown as WebClient, thread, updates };
}

const byName = (tools: ToolSpec[]) => Object.fromEntries(tools.map((tool) => [tool.name, tool]));

describe("slack tools", () => {
  it("reads and replies only in allowed channels", async () => {
    const { client } = fakeSlack();
    const tools = byName(slackTools({ client, allowedChannels: ["C1"], ledger: new MemoryEffectLedger() }));
    expect(await tools.slack_read_thread!.run({ channel: "C1", thread_ts: "1.0" })).toContain("How do digests work?");
    expect(await tools.slack_read_thread!.run({ channel: "C_HR", thread_ts: "1.0" })).toMatch(/^NOT_ALLOWED:/);
    expect(await tools.slack_reply!.run({ channel: "C_HR", thread_ts: "1.0", text: "hi" })).toMatch(/^NOT_ALLOWED:/);
    // Slack's terms rule out bulk indexing: there is deliberately no search tool.
    expect(Object.keys(tools)).toEqual(["slack_read_thread", "slack_reply"]);
  });

  it("replies exactly once when the response is lost after Slack posted it", async () => {
    const slack = fakeSlack({ loseNextPostResponse: true });
    const ledger = new MemoryEffectLedger();
    const reply = () => byName(slackTools({ client: slack.client, allowedChannels: ["C1"], ledger })).slack_reply!.run({ channel: "C1", thread_ts: "1.0", text: "Digests go out at 9am." });
    await expect(reply()).rejects.toThrow(/socket hang up/);
    expect(await reply()).toMatch(/^Already replied/);
    expect(slack.thread.filter((message) => message.text === "Digests go out at 9am.")).toHaveLength(1);
  });
});

describe("slack approval card", () => {
  const envelope: Envelope = {
    agent: "teammate",
    selfAccountIds: ["slack:U_BOT"],
    tools: { jira_comment: { tier: "approve", approvers: ["slack:U_PM"], separateDuties: true } },
  };
  const ran: unknown[] = [];
  const tool: ToolSpec = { name: "jira_comment", description: "", inputSchema: z.object({}), run: async (input) => (ran.push(input), "done") };

  async function requestInThread(slack = fakeSlack()) {
    const store = new MemoryApprovalStore();
    const deps = { store, channel: new SlackApprovalChannel(slack.client), auditFile: "/dev/null", key: "slack:thread:C1/1.0", requestedBy: "slack:U_ASKER" };
    const outcome = await runUnderPolicy(envelope, tool, { key: "DOC-7", body: "hi" }, deps);
    return { slack, store, deps, outcome };
  }

  it("posts the card in the thread the request came from, with the request id on the buttons", async () => {
    const { slack, outcome } = await requestInThread();
    expect(outcome.kind).toBe("pending");
    const card = slack.thread.at(-1);
    expect(JSON.stringify(card?.blocks)).toContain(APPROVE_ACTION);
    expect(JSON.stringify(card?.blocks)).toContain(outcome.kind === "pending" ? outcome.request.id : "");
  });

  it("a card Slack refuses to post means the tool does not run", async () => {
    const { outcome } = await requestInThread(fakeSlack({ refusePosts: true }));
    expect(outcome.kind).toBe("unavailable");
  });

  it("only a listed approver's click counts; the requester's does not; the card is replaced once decided", async () => {
    const { slack, store, deps, outcome } = await requestInThread();
    if (outcome.kind !== "pending") throw new Error("expected pending");
    const click = (userId: string, action = APPROVE_ACTION) =>
      handleApprovalClick(slack.client, store, () => envelope, { action, requestId: outcome.request.id, userId, channel: "C1", messageTs: "1.1" });

    expect((await click("U_RANDOM")).ok).toBe(false);
    expect((await click("U_ASKER")).ok).toBe(false);
    expect(slack.updates).toHaveLength(0);

    expect(await click("U_PM")).toEqual({ ok: true, message: "✅ Approved." });
    expect(slack.updates).toHaveLength(1);
    // Decided cards cannot decide again, even if a stale client still shows the buttons.
    expect((await click("U_PM", REJECT_ACTION)).ok).toBe(false);

    expect((await runUnderPolicy(envelope, tool, { key: "DOC-7", body: "hi" }, deps)).kind).toBe("ran");
    expect(ran).toHaveLength(1);
  });
});

describe("the approval card cannot be dressed up by the text it shows", () => {
  it("escapes Slack's control characters and fences the arguments, so links and mentions stay inert", async () => {
    const { approvalBlocks, escapeMrkdwn } = await import("@scriptorium/connectors");
    const request = {
      id: "r1", agent: "Teammate", tool: "confluence_update_page", argsHash: "a".repeat(64), key: "k", requestedAt: "", expiresAt: "", status: "pending" as const,
      summary: "• markdown: See <https://attacker.example/x|docs.beacon.example/guide> <!channel> ``` break out",
    };
    const text = JSON.stringify(approvalBlocks(request));
    expect(text).not.toContain("<https://attacker");
    expect(text).not.toContain("<!channel>");
    expect(text).toContain("&lt;https://attacker.example/x|docs.beacon.example/guide&gt;");
    // The fence can't be closed from inside.
    expect((text.match(/```/g) ?? []).length).toBe(2);
    expect(escapeMrkdwn("a & b")).toBe("a &amp; b");
  });
});
