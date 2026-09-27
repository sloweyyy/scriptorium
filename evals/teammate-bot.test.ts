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
    const withJira = teammateConnectorTools(config({}, true), slack, new MemoryEffectLedger()).map((tool) => tool.name);
    expect(withJira).toEqual(expect.arrayContaining(["jira_search", "jira_create_issue", "confluence_search"]));
  });

  it("links the ticket a gap opened", () => {
    expect(formatReply({ kind: "gap", text: "Not in the KB.", gapPath: "_gaps/G-1.md", ticket: { key: "DOC-9", url: "https://x/DOC-9" } })).toContain("<https://x/DOC-9|DOC-9>");
  });
});
