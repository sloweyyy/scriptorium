import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JiraClient } from "@scriptorium/jira";
import { jiraTools, jqlString } from "@scriptorium/connectors";
import { MemoryEffectLedger } from "@scriptorium/runtime";
import { MemoryApprovalStore, decideApproval, guard, type Envelope } from "@scriptorium/policy";

/**
 * Jira as agent tools: projects allow-listed, words-not-JQL, exactly-once comments, and
 * writes reachable only through the policy layer. Against a stubbed Jira.
 */

let requests: Array<{ url: string; method: string; body?: unknown }>;
let comments: Array<{ id: string; body: string; properties?: Array<{ key: string; value: unknown }> }>;
/** Fail the next comment POST AFTER Jira stored it: the crash-after case. */
let dropNextCommentResponse: boolean;

beforeEach(() => {
  requests = [];
  comments = [];
  dropNextCommentResponse = false;
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = decodeURIComponent(String(input).replace(/\+/g, " "));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, method, body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (url.includes("/search")) return json({ issues: [{ id: "1", key: "DOC-7", fields: { summary: "Digest emails", status: { name: "In Review" } } }] });
    if (url.includes("/comment") && method === "POST") {
      const stored = { id: String(comments.length + 1), body: body.body, properties: body.properties, created: "now" };
      comments.push(stored);
      if (dropNextCommentResponse) {
        dropNextCommentResponse = false;
        throw new TypeError("fetch failed: socket hang up");
      }
      return json(stored, 201);
    }
    if (url.includes("/comment")) return json({ comments });
    if (url.match(/\/issue\/DOC-7$/) || url.includes("/issue/DOC-7?")) {
      return json({ id: "1", key: "DOC-7", fields: { summary: "Digest emails", status: { name: "In Review" }, description: "h1. Goal\nOne email a day." } });
    }
    return json({ errorMessages: ["not found"] }, 404);
  });
});

afterEach(() => vi.unstubAllGlobals());

const client = () => new JiraClient({ baseUrl: "https://example.atlassian.net", email: "a@example.com", apiToken: "t", projectKey: "DOC" });
const tools = (ledger = new MemoryEffectLedger(), allowedProjects = ["DOC"]) =>
  Object.fromEntries(jiraTools({ client: client(), allowedProjects, ledger }).map((tool) => [tool.name, tool]));

describe("jira connector", () => {
  it("searches only allowed projects, with the model's words escaped", async () => {
    const out = await tools().jira_search!.run({ query: 'digest" OR project = HR' });
    expect(JSON.parse(out)).toEqual([{ cite: "jira:DOC-7", key: "DOC-7", summary: "Digest emails", status: "In Review" }]);
    const jql = requests.find((request) => request.url.includes("/search"))?.url ?? "";
    expect(jql).toContain('project in ("DOC")');
    expect(jql).toContain('text ~ "digest\\" OR project = HR"');
    expect(jqlString('a"b')).toBe('"a\\"b"');
  });

  it("reads an allowed issue as markdown and refuses any other project before a request", async () => {
    const out = await tools().jira_get_issue!.run({ key: "doc-7" });
    expect(out).toMatch(/^jira:DOC-7 — Digest emails \[In Review\]/);
    expect(out).toContain("# Goal");
    const before = requests.length;
    expect(await tools().jira_get_issue!.run({ key: "HR-1" })).toMatch(/^NOT_ALLOWED:/);
    expect(await tools().jira_get_issue!.run({ key: "../../myself" })).toMatch(/^NOT_ALLOWED:/);
    expect(requests.length).toBe(before);
  });

  it("comments exactly once, even when the response is lost after Jira stored it", async () => {
    const ledger = new MemoryEffectLedger();
    dropNextCommentResponse = true;
    await expect(tools(ledger).jira_comment!.run({ key: "DOC-7", body: "Ready for review." })).rejects.toThrow(/socket hang up/);
    // The retry probes Jira by op-key, finds the comment it already made, and does not post.
    expect(await tools(ledger).jira_comment!.run({ key: "DOC-7", body: "Ready for review." })).toMatch(/^Already commented/);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.properties?.[0]?.key).toBe("scriptorium.op");
  });

  it("is only reachable through the policy layer: an approve-tier comment waits for a human", async () => {
    const envelope: Envelope = { agent: "teammate", selfAccountIds: ["bot"], tools: { jira_comment: { tier: "approve", approvers: ["pm"] } } };
    const store = new MemoryApprovalStore();
    const posted: string[] = [];
    const deps = { store, channel: { post: async (request: { id: string }) => void posted.push(request.id) }, auditFile: "/dev/null", key: "slack:thread:C1/1.0" };
    const guarded = guard(envelope, tools().jira_comment!, deps);
    expect(await guarded.run({ key: "DOC-7", body: "Hi" })).toMatch(/^APPROVAL_PENDING/);
    expect(comments).toHaveLength(0);
    await decideApproval(store, envelope, posted[0]!, "approved", { accountId: "pm" });
    expect(await guarded.run({ key: "DOC-7", body: "Hi" })).toMatch(/^Commented/);
    expect(comments).toHaveLength(1);
  });

  it("no allowed projects means no Jira", async () => {
    expect(await tools(new MemoryEffectLedger(), []).jira_search!.run({ query: "x" })).toMatch(/^NOT_ALLOWED:/);
  });
});
