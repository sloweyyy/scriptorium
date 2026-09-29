import { describe, expect, it } from "vitest";
import type { AppConfig } from "@scriptorium/core";
import { formatReply, mentionToEvent, sharesScribeAccount, teammateConnectorTools } from "@scriptorium/agents";
import type { SlackClient } from "@scriptorium/connectors";
import { Gate } from "@scriptorium/runtime";
import { MemoryEffectLedger } from "@scriptorium/runtime";

/** The Teammate's Slack surface: mapping, scoping, and what it can reach on a host. */

const slack = { chat: {}, conversations: {} } as unknown as SlackClient;

function config(overrides: Partial<AppConfig["teammate"]> = {}, jira = false): AppConfig {
  return {
    teammate: { channels: ["C1"], jiraProjects: [], confluenceSpaces: [], ...overrides },
    jira: jira ? { baseUrl: "https://example.atlassian.net", email: "a@example.com", apiToken: "t", projectKey: "DOC", issueType: "Task" } : {},
  } as unknown as AppConfig;
}

describe("teammate slack surface", () => {
  it("maps a mention to one conversation per thread, attributed to the Slack user", () => {
    const event = mentionToEvent({ channel: "C1", ts: "2.0", thread_ts: "1.0", user: "U9", text: "<@UBOT> when do digests go out?", client_msg_id: "m1" });
    expect(event).toMatchObject({ id: "m1", key: "slack:thread:C1/1.0", kind: "slack.mention", actor: { id: "slack:U9", isBot: false } });
    expect(event.payload.text).toBe("when do digests go out?");
    // A top-level mention starts its own thread.
    expect(mentionToEvent({ channel: "C1", ts: "3.0", user: "U9" }).key).toBe("slack:thread:C1/3.0");
  });

  it("answers nowhere when no channels are configured, and only in configured ones otherwise", () => {
    const nowhere = new Gate({ selfIds: [], scopes: { slack: [] } });
    expect(nowhere.check(mentionToEvent({ channel: "C1", ts: "1.0", user: "U9" })).accepted).toBe(false);
    const scoped = new Gate({ selfIds: ["slack:UBOT"], scopes: { slack: ["slack:thread:C1/"] } });
    expect(scoped.check(mentionToEvent({ channel: "C2", ts: "1.0", user: "U9" })).accepted).toBe(false);
    expect(scoped.check(mentionToEvent({ channel: "C1", ts: "1.1", user: "U9" })).accepted).toBe(true);
    expect(scoped.check(mentionToEvent({ channel: "C1", ts: "1.2", user: "UBOT" })).accepted).toBe(false);
  });

  it("an approved action's outcome: done, refused (not 'Done'), or failed without its error text", async () => {
    const { outcomeMessages } = await import("@scriptorium/agents");
    const who = { asker: "<@U1> ", approver: "priya", approverMention: "<@UPM>" };
    const done = outcomeMessages({ kind: "ran", result: "Created jira:DOC-9\nmore" }, who);
    expect(done).toEqual({ text: "<@U1> ✅ Done, approved by <@UPM>: Created jira:DOC-9", origin: "✅ Done, approved by priya: Created jira:DOC-9" });
    const refused = outcomeMessages({ kind: "ran", result: "NOT_ALLOWED: HR is outside the Jira projects this agent may use." }, who);
    expect(refused.notRun).toBe("refused");
    expect(refused.text).not.toContain("Done");
    expect(refused.text).toContain("HR is outside the Jira projects");
    // A plan part-way: neither "Done" nor "nothing was changed".
    const partial = outcomeMessages({ kind: "ran", result: "PARTIAL: plan “t”: 1 of 3 steps done; step 2 was refused (x), so nothing after it was run." }, who);
    expect(partial.notRun).toBe("partial");
    expect(partial.text).toContain("only partly done: plan “t”: 1 of 3 steps done");
    expect(partial.text).not.toContain("✅");
    const failedMidway = outcomeMessages({ kind: "failed", reason: "PARTIAL: 1 of 3 steps done before step 2 failed." }, who);
    expect(failedMidway.text).toContain("1 of 3 steps are done");
    expect(failedMidway.text).not.toContain("nothing was changed");
    const failed = outcomeMessages({ kind: "failed", reason: "ECONNRESET at socket.ts:88" }, who);
    expect(failed.notRun).toBe("failed");
    expect(failed.text + failed.origin).not.toContain("ECONNRESET");
  });

  it("the inbox calls an expired request expired, not waiting", async () => {
    const { homeBlocks } = await import("@scriptorium/agents");
    const expired = { id: "r", agent: "Teammate", tool: "jira_comment", argsHash: "h", summary: "", key: "slack:thread:C1/1.0", requestedAt: "2020-01-01", expiresAt: "2020-01-08T00:00:00Z", status: "pending" as const, args: { key: "DOC-1" } };
    expect(JSON.stringify(homeBlocks({ waiting: [], mine: [expired], help: "" }))).toContain("*expired*");
  });

  it("caps a question's length, and says it was cut", () => {
    const long = mentionToEvent({ channel: "C1", ts: "1.0", user: "U9", text: `<@UBOT> ${"x".repeat(10_000)}` });
    expect(long.payload.text.length).toBeLessThan(4_200);
    expect(long.payload.text).toContain("was cut off");
    expect(mentionToEvent({ channel: "C1", ts: "1.0", user: "U9", text: "<@UBOT> short" }).payload.text).toBe("short");
  });

  it("offers only the connectors configured on this host", () => {
    const slackOnly = teammateConnectorTools(config(), slack, new MemoryEffectLedger()).map((tool) => tool.name);
    expect(slackOnly).toEqual(["slack_read_thread", "slack_read_channel", "slack_reply"]);
    // The shared token reads; it never writes as the Teammate.
    const shared = teammateConnectorTools(config({}, true), slack, new MemoryEffectLedger()).map((tool) => tool.name);
    expect(shared).toEqual(expect.arrayContaining(["jira_search", "jira_get_issue", "confluence_search"]));
    for (const write of ["jira_comment", "jira_create_issue", "confluence_create_page", "confluence_update_page"]) expect(shared).not.toContain(write);
    // Its own service account: writes are offered (and still approve-tier in its envelope).
    const own = teammateConnectorTools(config({ atlassianEmail: "teammate@example.com", atlassianToken: "t2" }, true), slack, new MemoryEffectLedger()).map((tool) => tool.name);
    expect(own).toEqual(expect.arrayContaining(["jira_create_issue", "confluence_update_page"]));
    // "Its own" account set to Scribe's is Scribe's identity: reads only, and no Jira surface.
    const scribes = config({ atlassianEmail: " A@example.com", atlassianToken: "t2" }, true);
    expect(sharesScribeAccount(scribes)).toBe(true);
    const borrowed = teammateConnectorTools(scribes, slack, new MemoryEffectLedger()).map((tool) => tool.name);
    for (const write of ["jira_comment", "jira_create_issue", "confluence_create_page", "confluence_update_page"]) expect(borrowed).not.toContain(write);
    expect(sharesScribeAccount(config({ atlassianEmail: "teammate@example.com", atlassianToken: "t2" }, true))).toBe(false);
  });

  it("links the ticket a gap opened", () => {
    expect(formatReply({ kind: "gap", text: "Not in the KB.", gapPath: "_gaps/G-1.md", ticket: { key: "DOC-9", url: "https://x/DOC-9" } })).toContain("<https://x/DOC-9|DOC-9>");
  });
});

describe("thread context", () => {
  it("reads the thread it was asked in, oldest first, without the triggering message", async () => {
    const { threadContext } = await import("@scriptorium/agents");
    const client = {
      conversations: {
        replies: async () => ({ messages: [
          { ts: "1.0", user: "U1", text: "The digest time should follow the subscriber's timezone" },
          { ts: "1.1", user: "U2", text: "Agreed, and it should be configurable per workspace" },
          { ts: "1.2", user: "U1", text: "<@UBOT> make a ticket for this" },
        ] }),
      },
      chat: {},
    } as unknown as SlackClient;
    const context = await threadContext(client, "C1", "1.0", "1.2");
    expect(context).toBe("<@U1>: The digest time should follow the subscriber's timezone\n<@U2>: Agreed, and it should be configurable per workspace");
    // A top-level mention has no thread yet.
    expect(await threadContext(client, "C1", "1.2", "1.2")).toBeUndefined();
  });

  it("in a long thread, keeps the parent and the latest messages — not the first page", async () => {
    const { threadContext } = await import("@scriptorium/agents");
    const all = Array.from({ length: 450 }, (_, i) => ({ ts: `1.${String(i).padStart(3, "0")}`, user: "U1", text: `msg ${i}` }));
    const client = {
      conversations: {
        // Oldest first, 200 a page, like Slack.
        replies: async ({ cursor }: { cursor?: string }) => {
          const start = Number(cursor ?? 0);
          const next = start + 200;
          return { messages: all.slice(start, next), response_metadata: { next_cursor: next < all.length ? String(next) : "" } };
        },
      },
      chat: {},
    } as unknown as SlackClient;
    const context = (await threadContext(client, "C1", "1.000", "1.449", 5))!.split("\n");
    expect(context).toEqual(["<@U1>: msg 0", "<@U1>: msg 445", "<@U1>: msg 446", "<@U1>: msg 447", "<@U1>: msg 448"]);
  });
});

describe("a very long thread", () => {
  it("past the page cap, it still reads the replies just before the question, and says it skipped some", async () => {
    const { threadContext } = await import("@scriptorium/agents");
    // 5,000 replies ten seconds apart: far past 20 pages of 200.
    const base = 1_790_000_000;
    const all = Array.from({ length: 5_001 }, (_, i) => ({ ts: `${base + i * 10}.000100`, user: "U1", text: `msg ${i}` }));
    const client = {
      conversations: {
        replies: async ({ cursor, oldest, latest }: { cursor?: string; oldest?: string; latest?: string }) => {
          // The parent always comes first, like Slack; then the window, oldest first, 200 a page.
          const inWindow = all.slice(1).filter((m) => (!oldest || Number(m.ts) >= Number(oldest)) && (!latest || Number(m.ts) <= Number(latest)));
          const start = Number(cursor ?? 0);
          const page = inWindow.slice(start, start + 200);
          return { messages: start === 0 ? [all[0], ...page] : page, response_metadata: { next_cursor: start + 200 < inWindow.length ? String(start + 200) : "" } };
        },
      },
      chat: {},
    } as unknown as SlackClient;
    const trigger = all[5_000]!.ts;
    const context = (await threadContext(client, "C1", all[0]!.ts, trigger, 5))!.split("\n");
    expect(context).toEqual(["<@U1>: msg 0", "(… a very long thread: earlier replies not shown)", "<@U1>: msg 4996", "<@U1>: msg 4997", "<@U1>: msg 4998", "<@U1>: msg 4999"]);
  });
});

describe("tools bound to the turn", () => {
  it("reads only the thread it was asked in, and scopes memories to here or the asker", async () => {
    const { bindToTurn } = await import("@scriptorium/agents");
    const { z } = await import("zod");
    const ran: string[] = [];
    const tool = (name: string) => ({ name, description: name, inputSchema: z.object({}), run: async () => (ran.push(name), "ok") });
    const [read, save] = bindToTurn([tool("slack_read_thread"), tool("memory_save")], { question: "q", askedBy: "slack:U1", channel: "C1", threadTs: "1.0" });
    expect(await read!.run({ channel: "C1", thread_ts: "1.0" })).toBe("ok");
    expect(await read!.run({ channel: "C2", thread_ts: "9.9" })).toMatch(/^NOT_ALLOWED/);
    expect(await read!.run({ channel: "C1", thread_ts: "2.0" })).toMatch(/^NOT_ALLOWED/);
    for (const scope of ["global", "channel:C1", "person:slack:U1"]) expect(await save!.run({ text: "x is y.", scope })).toBe("ok");
    for (const scope of ["channel:C2", "person:slack:U2"]) expect(await save!.run({ text: "x is y.", scope })).toMatch(/^NOT_ALLOWED/);
    expect(ran).toEqual(["slack_read_thread", "memory_save", "memory_save", "memory_save"]);
  });

  it("a plan's steps are held to the same bounds — a reminder step for another channel is refused", async () => {
    const { bindToTurn } = await import("@scriptorium/agents");
    const { z } = await import("zod");
    const ran: unknown[] = [];
    const [plan] = bindToTurn([{ name: "propose_plan", description: "", inputSchema: z.object({}), run: async (input) => (ran.push(input), "ok") }], { question: "q", askedBy: "slack:U1", channel: "C1", threadTs: "1.0" });
    const reminder = (channel: string) => ({ tool: "schedule_reminder", args: { channel, at: "2030-01-01T09:00:00Z", text: "x" } });
    expect(await plan!.run({ title: "t", steps: [reminder("C1"), reminder("C_PRIVATE")] })).toMatch(/^NOT_ALLOWED: step 2: reminders can be set/);
    expect(await plan!.run({ title: "t", steps: [reminder("C1"), { tool: "jira_labels", args: { key: "DOC-1" } }] })).toBe("ok");
    expect(ran).toHaveLength(1);
  });

  it("reads only the channel it was asked in — never another allowed one", async () => {
    const { bindToTurn } = await import("@scriptorium/agents");
    const { z } = await import("zod");
    const [channel] = bindToTurn([{ name: "slack_read_channel", description: "", inputSchema: z.object({}), run: async () => "ok" }], { question: "q", askedBy: "slack:U1", channel: "C1", threadTs: "1.0" });
    expect(await channel!.run({ channel: "C1", hours: 24 })).toBe("ok");
    expect(await channel!.run({ channel: "C_PRIVATE", hours: 24 })).toMatch(/^NOT_ALLOWED/);
  });
});

describe("progress", () => {
  it("names what the agent is doing, in plain words", async () => {
    const { progressText } = await import("@scriptorium/agents");
    expect(progressText("confluence_search")).toBe("🔎 Searching Confluence…");
    expect(progressText("something_new")).toBe("🔎 Working on it…");
  });
});
