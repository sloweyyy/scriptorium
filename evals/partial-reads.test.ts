import { afterEach, describe, expect, it, vi } from "vitest";
import { JiraClient } from "@scriptorium/jira";
import { githubTools, jiraTools, slackTools, type SlackToolSettings } from "@scriptorium/connectors";
import { MemoryEffectLedger } from "@scriptorium/runtime";

/**
 * A read that stops at its limit says so. A digest from the first 30 issues, a PR review
 * from its first 100 files, a thread summary from its oldest 50 messages: each read as the
 * whole picture when nothing marked it partial. (Confluence attachments: confluence-connector.)
 */
afterEach(() => vi.unstubAllGlobals());

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
const issue = (n: number) => ({ id: String(n), key: `DOC-${n}`, fields: { summary: `Issue ${n}`, status: { name: "Open" } } });

function jira(count: number) {
  vi.stubGlobal("fetch", async () => json({ issues: Array.from({ length: count }, (_, i) => issue(i + 1)) }));
  const client = new JiraClient({ baseUrl: "https://example.atlassian.net", email: "a@example.com", apiToken: "t", projectKey: "DOC" });
  return Object.fromEntries(jiraTools({ client, allowedProjects: ["DOC"], ledger: new MemoryEffectLedger() }).map((tool) => [tool.name, tool]));
}

describe("reads say when they were cut", () => {
  it("jira_recent and jira_children mark a full page as partial, and the note is not a record", async () => {
    const full = jira(30);
    const recent = await full.jira_recent!.run({ days: 7 });
    expect(JSON.parse(recent).at(-1).note).toMatch(/first 30 .* partial/);
    expect(full.jira_recent!.records!({ days: 7 }, recent)).toHaveLength(30);
    expect((await jira(50).jira_children!.run({ key: "DOC-40" }))).toMatch(/first 50 child issues/);
    // Under the limit: the whole list, no note.
    expect(await jira(3).jira_recent!.run({ days: 7 })).not.toMatch(/partial/);
  });

  it("github_get_pull says when the description or the file list is cut", async () => {
    vi.stubGlobal("fetch", async (input: string) => {
      const url = String(input);
      if (url.includes("/files")) return json(Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}.ts`, status: "modified", additions: 1, deletions: 0 })));
      return json({ number: 12, title: "Big change", body: "x".repeat(5_000), state: "open", user: { login: "dev" }, head: { ref: "feat/big" }, html_url: "https://github.com/org/app/pull/12" });
    });
    const [get] = githubTools({ token: async () => "tok", allowedRepos: ["org/app"], ledger: new MemoryEffectLedger() }).filter((tool) => tool.name === "github_get_pull");
    const out = await get!.run({ repo: "org/app", number: 12 });
    expect(out).toContain("description cut at 4000 characters");
    expect(out).toMatch(/the first 100 only; the PR may change more/);
  });

  it("slack reads say when a thread or a channel window has more than was shown", async () => {
    const client = {
      conversations: {
        replies: async () => ({ messages: [{ user: "U1", text: "first" }], has_more: true }),
        history: async () => ({ messages: [{ ts: "1.1", user: "U1", text: "latest" }], has_more: true }),
      },
    } as unknown as SlackToolSettings["client"];
    const tools = Object.fromEntries(slackTools({ client, allowedChannels: ["C1"], ledger: new MemoryEffectLedger() }).map((tool) => [tool.name, tool]));
    expect(await tools.slack_read_thread!.run({ channel: "C1", thread_ts: "1.0" })).toMatch(/Only the first 1 messages of this thread/);
    const channel = await tools.slack_read_channel!.run({ channel: "C1", hours: 24 });
    expect(channel).toMatch(/Only the latest 1 messages/);
    expect(tools.slack_read_channel!.records!({ channel: "C1", hours: 24 }, channel)).toEqual(["slack:C1/1.1"]);
  });
});
