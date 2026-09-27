import { describe, expect, it } from "vitest";
import type { AppConfig } from "@scriptorium/core";
import { formatReply, mentionToEvent, teammateConnectorTools } from "@scriptorium/agents";
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

  it("offers only the connectors configured on this host", () => {
    const slackOnly = teammateConnectorTools(config(), slack, new MemoryEffectLedger()).map((tool) => tool.name);
    expect(slackOnly).toEqual(["slack_read_thread", "slack_reply"]);
    // The shared token reads; it never writes as the Teammate.
    const shared = teammateConnectorTools(config({}, true), slack, new MemoryEffectLedger()).map((tool) => tool.name);
    expect(shared).toEqual(expect.arrayContaining(["jira_search", "jira_get_issue", "confluence_search"]));
    for (const write of ["jira_comment", "jira_create_issue", "confluence_create_page", "confluence_update_page"]) expect(shared).not.toContain(write);
    // Its own service account: writes are offered (and still approve-tier in its envelope).
    const own = teammateConnectorTools(config({ atlassianEmail: "teammate@example.com", atlassianToken: "t2" }, true), slack, new MemoryEffectLedger()).map((tool) => tool.name);
    expect(own).toEqual(expect.arrayContaining(["jira_create_issue", "confluence_update_page"]));
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
});
