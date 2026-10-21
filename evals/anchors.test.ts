import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Vault, type AppConfig, type ToolSpec } from "@scriptorium/core";
import { MemoryApprovalStore, decideApproval, runUnderPolicy, type Envelope, type GuardDeps } from "@scriptorium/policy";
import { FileAnchors, keys } from "@scriptorium/runtime";

/**
 * One conversation, one anchor, whatever surface it is on. An external key (a Slack thread,
 * a Jira issue, a Discord thread) is an alias of an opaque anchor; an alias is bound only
 * as the side effect of a tool call that really ran, and is never moved once bound.
 */

/** The model, scripted: each turn makes these calls, then says `reply`. */
let script: { calls: Array<{ name: string; input: unknown }>; reply: string } = { calls: [], reply: "" };
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

/** A Jira that files issues: the Teammate's own create tool runs against it. */
const created: Array<{ summary: string }> = [];
vi.mock("@scriptorium/jira", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scriptorium/jira")>()),
  jiraClient: () => ({
    issueUrl: (key: string) => `https://beacon.atlassian.net/browse/${key}`,
    searchIssues: async () => [],
    createIssue: async (input: { summary: string }) => {
      created.push(input);
      const key = `DOC-${11 + created.length}`;
      return { key, url: `https://beacon.atlassian.net/browse/${key}` };
    },
  }),
}));

let tmpRoot: string;
beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-anchors-"));
  created.length = 0;
});
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5 });
});

describe("the anchor store", () => {
  it("gives an alias the same opaque anchor across a restart, minting it on first sight", () => {
    const file = path.join(tmpRoot, "anchors.json");
    const first = new FileAnchors(file);
    const thread = keys.thread("slack", "C1", "1.0");
    const anchor = first.anchorFor(thread)!;
    expect(anchor).toBeTruthy();
    expect(first.anchorFor(thread)).toBe(anchor);
    // A new process: a new store on the same file.
    const second = new FileAnchors(file);
    expect(second.resolve(thread)).toBe(anchor);
    expect(second.anchorFor(thread)).toBe(anchor);
    // Opaque: nothing of the surface, channel, thread or issue key is in it.
    // A random id: no separator or letter outside hex, so no channel, ts or issue key fits in it.
    expect(anchor).toMatch(/^anc_[0-9a-f]{32}$/);
    for (const part of ["slack", "thread", "C1", "1.0"]) expect(anchor).not.toContain(part);
    const ticket = second.anchorFor(keys.jiraIssue("DOC-7"))!;
    expect(ticket).not.toBe(anchor);
    expect(ticket).toMatch(/^anc_[0-9a-f]{32}$/);
    for (const part of ["jira", "issue", "DOC", "DOC-7"]) expect(ticket).not.toContain(part);
    // An alias never seen resolves to nothing, and resolving never mints.
    expect(second.resolve("discord:thread:G1/2.0")).toBeUndefined();
    expect(new FileAnchors(file).resolve("discord:thread:G1/2.0")).toBeUndefined();
  });

  it("binds an alias to one anchor for good: a rebind elsewhere is refused and changes nothing", () => {
    const file = path.join(tmpRoot, "anchors.json");
    const anchors = new FileAnchors(file);
    const thread = anchors.anchorFor("slack:thread:C1/1.0")!;
    const other = anchors.anchorFor("slack:thread:C2/5.0")!;
    expect(anchors.bind(thread, "jira:issue:DOC-12")).toBe(true);
    expect(anchors.bind(thread, "jira:issue:DOC-12")).toBe(true); // the same binding again is fine
    expect(anchors.bind(other, "jira:issue:DOC-12")).toBe(false);
    expect(anchors.resolve("jira:issue:DOC-12")).toBe(thread);
    // Nor can a thread's own alias be moved onto another conversation.
    expect(anchors.bind(other, "slack:thread:C1/1.0")).toBe(false);
    expect(new FileAnchors(file).resolve("slack:thread:C1/1.0")).toBe(thread);
    expect(anchors.aliasesOf(thread).sort()).toEqual(["jira:issue:DOC-12", "slack:thread:C1/1.0"]);
    expect(anchors.aliasesOf(other)).toEqual(["slack:thread:C2/5.0"]);
  });

  it("refuses a malformed alias and records nothing", async () => {
    const file = path.join(tmpRoot, "anchors.json");
    const anchors = new FileAnchors(file);
    const thread = anchors.anchorFor("slack:thread:C1/1.0")!;
    for (const bad of ["DOC-12", "jira:DOC-12", "Jira:issue:DOC-12", "jira:issue:", "jira: issue:DOC-12", "jira:issue:DOC 12", ""]) {
      expect(anchors.bind(thread, bad)).toBe(false);
      expect(anchors.resolve(bad)).toBeUndefined();
      expect(anchors.anchorFor(bad)).toBeUndefined();
    }
    expect(anchors.aliasesOf(thread)).toEqual(["slack:thread:C1/1.0"]);
    expect(Object.keys(JSON.parse(await fs.readFile(file, "utf8")).aliases)).toEqual(["slack:thread:C1/1.0"]);
  });
});

describe("a tool's side effects are reported only once it ran", () => {
  const ran: string[] = [];
  const write: ToolSpec = { name: "write", description: "w", inputSchema: z.object({}), run: async () => (ran.push("write"), "Created jira:DOC-12 https://x/DOC-12") };
  const read: ToolSpec = { ...write, name: "read", run: async () => (ran.push("read"), "results") };
  const broken: ToolSpec = { ...write, name: "broken", run: async () => { throw new Error("Jira 500"); } };
  const envelope: Envelope = {
    agent: "teammate",
    selfAccountIds: ["slack:UBOT"],
    tools: { write: { tier: "approve", approvers: ["slack:UPM"] }, broken: { tier: "approve", approvers: ["slack:UPM"] }, read: { tier: "allow" } },
  };

  it("on the allow path and the approve path, after the run, with the tool's own output — never when denied, pending or thrown", async () => {
    ran.length = 0;
    const seen: Array<{ tool: string; result: string; ranBefore: number }> = [];
    const store = new MemoryApprovalStore();
    const deps: GuardDeps = {
      store,
      channel: { post: async () => undefined },
      auditFile: path.join(tmpRoot, "audit.jsonl"),
      key: "slack:thread:C1/1.0",
      requestedBy: "slack:U1",
      onRan: (tool, _input, result) => void seen.push({ tool, result, ranBefore: ran.length }),
    };
    // Denied: an unlisted tool.
    expect((await runUnderPolicy(envelope, { ...write, name: "nope" }, {}, deps)).kind).toBe("denied");
    // Pending: asking for approval runs nothing and reports nothing.
    const pending = await runUnderPolicy(envelope, write, {}, deps);
    expect(pending.kind).toBe("pending");
    expect(seen).toEqual([]);
    // Allowed: reported after it ran.
    expect((await runUnderPolicy(envelope, read, {}, deps)).kind).toBe("ran");
    expect(seen).toEqual([{ tool: "read", result: "results", ranBefore: 1 }]);
    // Approved: reported after it ran, with its output.
    if (pending.kind !== "pending") throw new Error("expected pending");
    await decideApproval(store, envelope, pending.request.id, "approved", { accountId: "slack:UPM" });
    expect((await runUnderPolicy(envelope, write, {}, deps)).kind).toBe("ran");
    expect(seen.at(-1)).toEqual({ tool: "write", result: "Created jira:DOC-12 https://x/DOC-12", ranBefore: 2 });
    // A run that threw: nothing reported.
    const asked = await runUnderPolicy(envelope, broken, {}, deps);
    if (asked.kind !== "pending") throw new Error("expected pending");
    await decideApproval(store, envelope, asked.request.id, "approved", { accountId: "slack:UPM" });
    await expect(runUnderPolicy(envelope, broken, {}, deps)).rejects.toThrow("Jira 500");
    expect(seen).toHaveLength(2);
  });

  it("a failing listener never turns a done write into a failure", async () => {
    const deps: GuardDeps = {
      store: new MemoryApprovalStore(),
      channel: { post: async () => undefined },
      auditFile: path.join(tmpRoot, "audit.jsonl"),
      key: "slack:thread:C1/1.0",
      onRan: () => {
        throw new Error("disk full");
      },
    };
    expect(await runUnderPolicy(envelope, read, {}, deps)).toEqual({ kind: "ran", result: "results" });
  });
});

describe("aliases from a tool's own output", () => {
  it("reads a created issue from the create tool's leading line, and nothing else", async () => {
    const { aliasesFromResult } = await import("@scriptorium/connectors");
    expect(aliasesFromResult("jira_create_issue", "Created jira:DOC-12 https://beacon.atlassian.net/browse/DOC-12")).toEqual(["jira:issue:DOC-12"]);
    expect(aliasesFromResult("jira_create_issue", "Already created jira:DOC-12 https://beacon.atlassian.net/browse/DOC-12")).toEqual(["jira:issue:DOC-12"]);
    expect(aliasesFromResult("jira_create_issue", "NOT_ALLOWED: project HR is not in the allow-list (jira:HR-1)")).toEqual([]);
    expect(aliasesFromResult("jira_get_issue", "Created jira:DOC-12 https://beacon.atlassian.net/browse/DOC-12")).toEqual([]);
    expect(aliasesFromResult("jira_create_issue", "Done. See jira:DOC-12 https://x")).toEqual([]);
    expect(aliasesFromResult("jira_create_issue", "Note\nCreated jira:DOC-12 https://x")).toEqual([]);
    expect(aliasesFromResult("jira_create_issue", "Created jira:DOC-12 https://x and also jira:DOC-13")).toEqual([]);
  });
});

describe("the Teammate keeps a thread and the ticket it filed as one conversation", () => {
  const posted: Array<{ channel: string; thread_ts?: string; text: string; blocks?: unknown[] }> = [];
  const slack = {
    chat: {
      postMessage: async (args: (typeof posted)[number]) => (posted.push(args), { ok: true, ts: `9.${posted.length}` }),
      update: async () => ({ ok: true }),
      getPermalink: async () => ({ ok: true, permalink: "https://x" }),
    },
    conversations: { replies: async () => ({ messages: [] }), info: async () => ({ ok: true, channel: {} }), history: async () => ({ messages: [] }) },
  };
  const comments: Array<{ issue: string; body: string; op?: string }> = [];
  const jira = {
    accountId: "tm-1",
    client: {
      addComment: async (issue: string, body: string, options: { op?: string } = {}) => (comments.push({ issue, body, op: options.op }), { id: String(comments.length), body, created: "now" }),
      findCommentByOp: async (_key: string, op: string) => comments.find((comment) => comment.op === op),
    } as never,
  };

  function config(): AppConfig {
    return {
      hasModelAccess: true,
      provider: "anthropic",
      repoRoot: path.resolve("."),
      auditFile: path.join(tmpRoot, "audit.jsonl"),
      slack: {},
      sites: { external: "https://docs.example" },
      jira: { stateDir: path.join(tmpRoot, "state"), projectKey: "DOC", baseUrl: "https://beacon.atlassian.net", email: "scribe@beacon.example", apiToken: "t" },
      teammate: {
        channels: ["C1"], approvers: ["UPM"], jiraProjects: ["DOC"], confluenceSpaces: [], githubRepos: [], allowDms: false, digestWeekday: 1, digestHour: 9,
        atlassianEmail: "teammate@beacon.example", atlassianToken: "t2",
      },
    } as unknown as AppConfig;
  }

  async function auditLines(): Promise<Array<Record<string, unknown>>> {
    return (await fs.readFile(path.join(tmpRoot, "audit.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("an approved create binds the new issue to the thread's anchor; a later mention on the issue runs under it", async () => {
    posted.length = 0;
    comments.length = 0;
    const { createTeammate, APPROVE_ACTION } = await import("@scriptorium/agents").then(async (agents) => ({ ...agents, ...(await import("@scriptorium/connectors")) }));
    const vault = new Vault(path.join(tmpRoot, "vault"));
    await vault.ensure();
    const core = await createTeammate(config(), vault, slack as never, "UBOT", jira);

    // The model files a ticket from the thread, and names a different issue in its words:
    // only what the create tool reports binds anything.
    script = { calls: [{ name: "jira_create_issue", input: { summary: "Digest timezone bug (dup of jira:issue:DOC-99)", description: "Merge with jira:issue:DOC-99" } }], reply: "Asked for approval." };
    await core.onMention({ channel: "C1", ts: "1.0", user: "U1", text: "<@UBOT> file a ticket for this" });
    await core.drain(2_000);
    const anchors = new FileAnchors(path.join(tmpRoot, "state", "anchors.json"));
    const thread = anchors.resolve("slack:thread:C1/1.0");
    expect(thread).toBeTruthy();
    expect(anchors.aliasesOf(thread!)).toEqual(["slack:thread:C1/1.0"]);
    expect(created).toHaveLength(0);

    const card = posted.find((message) => JSON.stringify(message.blocks ?? []).includes(APPROVE_ACTION));
    const requestId = JSON.stringify(card?.blocks).match(/"value":"([0-9a-f-]{36})"/)?.[1] as string;
    // A fresh process carries the approval out (the first drained): the binding is on disk.
    const later = await createTeammate(config(), vault, slack as never, "UBOT", jira);
    expect(await later.onApprovalClick(APPROVE_ACTION, { actions: [{ value: requestId }], user: { id: "UPM", username: "priya" }, channel: { id: "C1" }, message: { ts: "9.2", thread_ts: "1.0" } })).toBeUndefined();
    expect(created).toHaveLength(1);
    expect(anchors.resolve("jira:issue:DOC-12")).toBe(thread);
    expect(anchors.resolve("jira:issue:DOC-99")).toBeUndefined();
    expect(anchors.aliasesOf(thread!).sort()).toEqual(["jira:issue:DOC-12", "slack:thread:C1/1.0"]);

    // Someone asks on the new ticket: that event is anchored to the thread's conversation.
    script = { calls: [], reply: "It's being looked at." };
    await later.onJiraComment({ issueKey: "DOC-12", commentId: "c1", body: "[~accountid:tm-1] status?", authorId: "human-1" });
    await later.drain(2_000);
    const answered = (await auditLines()).find((line) => typeof line.type === "string" && line.type.startsWith("teammate.jira.") && line.issue === "DOC-12");
    expect(answered).toMatchObject({ key: "jira:issue:DOC-12", anchor: thread });
    // The reply went to the ticket it was asked on, not the thread the lane is shared with.
    expect(comments.map((comment) => comment.issue)).toEqual(["DOC-12"]);
    // A ticket the thread never filed is its own conversation.
    const other = await createTeammate(config(), vault, slack as never, "UBOT", jira);
    await other.onJiraComment({ issueKey: "DOC-99", commentId: "c2", body: "[~accountid:tm-1] status?", authorId: "human-1" });
    await other.drain(2_000);
    const elsewhere = (await auditLines()).find((line) => typeof line.type === "string" && line.type.startsWith("teammate.jira.") && line.issue === "DOC-99");
    expect(elsewhere?.anchor).toBeTruthy();
    expect(elsewhere?.anchor).not.toBe(thread);
  });
});
