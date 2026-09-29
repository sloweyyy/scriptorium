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

describe("jira_children", () => {
  it("lists an epic's children with only the validated key in the JQL, and refuses other projects", async () => {
    const out = await tools().jira_children!.run({ key: "doc-40" });
    expect(JSON.parse(out)[0]).toMatchObject({ cite: "jira:DOC-7" });
    const jql = requests.filter((request) => request.url.includes("/search")).at(-1)?.url ?? "";
    expect(jql).toContain('parent = "DOC-40"');
    expect(await tools().jira_children!.run({ key: "HR-1" })).toMatch(/^NOT_ALLOWED/);
    expect(await tools().jira_children!.run({ key: 'DOC-1" OR project = HR' })).toMatch(/^NOT_ALLOWED/);
  });
});

describe("small Jira edits: move, assign, label, link", () => {
  function stubEdits(users: Array<{ accountId: string; displayName: string; emailAddress?: string }>) {
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      const url = decodeURIComponent(String(input));
      const method = init?.method ?? "GET";
      requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
      if (url.endsWith("/transitions") && method === "GET") return json({ transitions: [{ id: "31", name: "Start review", to: { name: "In Review" } }] });
      if (url.includes("/user/search")) return json(users.map((user) => ({ ...user, active: true, accountType: "atlassian" })));
      return method === "GET" ? json({}) : method === "POST" ? new Response("", { status: 201 }) : new Response(null, { status: 204 });
    });
  }

  it("moves by status name, and a status it can't reach is not 'done'", async () => {
    stubEdits([]);
    expect(await tools().jira_transition!.run({ key: "doc-7", status: "in review" }, { approval: { id: "a1" } })).toBe("Moved jira:DOC-7 to in review.");
    expect(requests.find((request) => request.method === "POST")?.body).toEqual({ transition: { id: "31" } });
    expect(await tools().jira_transition!.run({ key: "DOC-7", status: "Done" }, { approval: { id: "a2" } })).toMatch(/^NOT_ALLOWED: jira:DOC-7 has no transition to "Done"/);
    expect(await tools().jira_transition!.run({ key: "HR-1", status: "Done" })).toMatch(/^NOT_ALLOWED/);
  });

  it("assigns only the one person whose name or email is exactly what the approver read", async () => {
    stubEdits([{ accountId: "acc-mai", displayName: "Mai Tran", emailAddress: "mai@beacon.example" }, { accountId: "acc-maia", displayName: "Maia Lee" }]);
    expect(await tools().jira_assign!.run({ key: "DOC-7", assignee: "mai tran" }, { approval: { id: "a1" } })).toBe("Assigned jira:DOC-7 to Mai Tran.");
    expect(requests.find((request) => request.method === "PUT")?.body).toEqual({ accountId: "acc-mai" });
    expect(await tools().jira_assign!.run({ key: "DOC-7", assignee: "Mai@Beacon.example" }, { approval: { id: "a1b" } })).toBe("Assigned jira:DOC-7 to Mai Tran.");
    // A partial name is whoever the fuzzy search returns today: refused, even with one hit.
    stubEdits([{ accountId: "acc-mai", displayName: "Mai Tran" }]);
    const puts = () => requests.filter((request) => request.method === "PUT").length;
    const before = puts();
    expect(await tools().jira_assign!.run({ key: "DOC-7", assignee: "Mai" }, { approval: { id: "a2" } })).toMatch(/^NOT_ALLOWED: No Jira user is named exactly "Mai"/);
    expect(puts()).toBe(before);
    stubEdits([{ accountId: "a", displayName: "Mai Tran" }, { accountId: "b", displayName: "Mai Tran" }]);
    expect(await tools().jira_assign!.run({ key: "DOC-7", assignee: "Mai Tran" }, { approval: { id: "a3" } })).toMatch(/^NOT_ALLOWED: "Mai Tran" is the name of 2 people/);
    expect(await tools().jira_assign!.run({ key: "DOC-7", assignee: "unassigned" }, { approval: { id: "a4" } })).toBe("Assigned jira:DOC-7 to nobody.");
  });

  it("labels are validated, and a link needs both ends inside the allow-list", async () => {
    stubEdits([]);
    expect(await tools().jira_labels!.run({ key: "DOC-7", add: ["needs-docs"], remove: ["triage"] }, { approval: { id: "a1" } })).toBe("Labels on jira:DOC-7: +needs-docs -triage.");
    expect(requests.find((request) => request.method === "PUT")?.body).toEqual({ update: { labels: [{ add: "needs-docs" }, { remove: "triage" }] } });
    await expect(tools().jira_labels!.run({ key: "DOC-7", add: ["two words"] })).rejects.toThrow();
    expect(await tools().jira_link!.run({ from: "DOC-7", to: "DOC-9", type: "Blocks" }, { approval: { id: "a1" } })).toBe("Linked jira:DOC-7 → jira:DOC-9 (Blocks).");
    // "DOC-7 blocks DOC-9": Jira reads inwardIssue as the subject of the outward verb.
    expect(requests.find((request) => request.url.endsWith("/issueLink"))?.body).toEqual({ type: { name: "Blocks" }, inwardIssue: { key: "DOC-7" }, outwardIssue: { key: "DOC-9" } });
    expect(await tools().jira_link!.run({ from: "DOC-7", to: "HR-2" })).toMatch(/^NOT_ALLOWED/);
  });
});

describe("sprint report", () => {
  it("reads a project's open sprint through fixed JQL, and only allowed projects", async () => {
    const out = await tools().jira_sprint!.run({ project: "doc" });
    const jql = requests.find((request) => request.url.includes("/search"))?.url ?? "";
    expect(jql).toContain('project = "DOC" AND sprint in openSprints()');
    expect(JSON.parse(out)[0]).toMatchObject({ cite: "jira:DOC-7", status: "In Review", assignee: "unassigned" });
    expect(tools().jira_sprint!.records!({ project: "DOC" }, out)).toEqual(["jira:DOC-7"]);
    expect(await tools().jira_sprint!.run({ project: "HR" })).toMatch(/^NOT_ALLOWED/);
    expect(await tools().jira_sprint!.run({ project: 'DOC" OR project = HR' })).toMatch(/^NOT_ALLOWED/);
  });
});

describe("a sprint bigger than one read", () => {
  it("says it shows only the first 100", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ issues: Array.from({ length: 100 }, (_, i) => ({ id: String(i), key: `DOC-${i + 1}`, fields: { summary: "s", status: { name: "To Do" } } })) }), { status: 200 }));
    const out = JSON.parse(await tools().jira_sprint!.run({ project: "DOC" })) as Array<{ note?: string }>;
    expect(out).toHaveLength(101);
    expect(out.at(-1)?.note).toMatch(/first 100 issues/);
  });
});
