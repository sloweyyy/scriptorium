import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultJql } from "@scriptorium/core";
import {
  JiraClient,
  jiraToMarkdown,
  JiraState,
  markdownToJira,
  parseCommand,
  splitAtLastOwnComment,
  type JiraComment,
} from "@scriptorium/jira";
import { newestFirst, prdFrontmatter, safeDesignName } from "@scriptorium/agents";

function comment(body: string, accountId = "human-1", id = "1"): JiraComment {
  return { id, body, created: new Date().toISOString(), author: { accountId, displayName: "Reviewer" } };
}

describe("jira comment commands", () => {
  it("never treats its own comment as feedback", () => {
    const own = comment("**Draft ready** — reply with feedback or comment `approve`.", "bot-1", "9");
    expect(parseCommand(own, "bot-1")).toEqual({ kind: "ignore", reason: "own-comment" });
    // Same text from a human is feedback, so the guard is the account id, not the wording.
    expect(parseCommand({ ...own, author: { accountId: "human-1", displayName: "R" } }, "bot-1").kind).toBe("feedback");
  });

  it("acts on nothing without words, and asks for a summary of a wall of text", () => {
    for (const body of [".", "… !", "!screenshot-2026-09-28.png|thumbnail!", "[^export.pdf]", "!a.png! !b.png!"]) {
      expect(parseCommand(comment(body), "bot-1"), body).toEqual({ kind: "ignore", reason: "no-words" });
    }
    // A screenshot WITH words is feedback, and so is a short one.
    expect(parseCommand(comment("match this !mock-v2.png|thumbnail!"), "bot-1").kind).toBe("feedback");
    expect(parseCommand(comment("ok"), "bot-1").kind).toBe("feedback");
    expect(parseCommand(comment("?"), "bot-1").kind).toBe("help");
    const wall = "Log line from the incident export. ".repeat(400);
    expect(parseCommand(comment(wall), "bot-1")).toEqual({ kind: "too-long", length: wall.trim().length });
  });

  it("recognizes the approval vocabulary and nothing looser", () => {
    expect(parseCommand(comment("approve"), "bot-1").kind).toBe("approve-doc");
    expect(parseCommand(comment("Approve the draft"), "bot-1").kind).toBe("approve-doc");
    expect(parseCommand(comment("publish"), "bot-1").kind).toBe("approve-doc");
    // A sentence that merely contains the word must not publish anything.
    expect(parseCommand(comment("I'll approve once the FAQ is fixed"), "bot-1").kind).toBe("feedback");
  });

  it("never acts on a command inside a quote or a code block", () => {
    // Quoting the agent's vocabulary back is talking about the command, not issuing it.
    // With the markers stripped and the words kept, this comment published the doc.
    const quoted = parseCommand(comment("{quote}approve{quote}\nnot yet, the intro is wrong"), "bot-1");
    expect(quoted.kind).toBe("feedback");
    // …and the feedback keeps its quote, which is what gives it meaning.
    expect(quoted).toMatchObject({ text: expect.stringContaining("approve") });
    expect(parseCommand(comment("{code}approve{code}\nwhy does this say approve?"), "bot-1").kind).toBe("feedback");
    expect(parseCommand(comment("{noformat}publish{noformat}"), "bot-1").kind).toBe("feedback");
    expect(parseCommand(comment("bq. approve\nshould this be the command?"), "bot-1").kind).toBe("feedback");
    // A command typed after a quote is still the reviewer's own words.
    expect(parseCommand(comment("{quote}Step 2 is fine{quote}approve"), "bot-1").kind).toBe("approve-doc");
  });

  it("reads tone around a command as tone", () => {
    for (const body of ["Approved, thanks!", "*approve*", "approve 👍", "_Approve_ please", "approve the draft, thank you"]) {
      expect(parseCommand(comment(body), "bot-1").kind, body).toBe("approve-doc");
    }
  });

  it("asks instead of guessing when something only looks like an approval", () => {
    // Publishing is irreversible and a rewrite is not what they asked for: ask.
    expect(parseCommand(comment("LGTM"), "bot-1")).toEqual({ kind: "unclear", suggestion: "approve" });
    expect(parseCommand(comment("ship it"), "bot-1")).toEqual({ kind: "unclear", suggestion: "approve" });
    expect(parseCommand(comment("approve the intro but shorten step 2"), "bot-1").kind).toBe("unclear");
    expect(parseCommand(comment("approve L-001"), "bot-1")).toEqual({ kind: "unclear", suggestion: "approve lesson L-001" });
    // Not approval-shaped at all: still ordinary feedback.
    expect(parseCommand(comment("I'll approve once the FAQ is fixed"), "bot-1").kind).toBe("feedback");
    expect(parseCommand(comment("Looking at step 2, it is wrong"), "bot-1").kind).toBe("feedback");
  });

  it("parses lesson decisions with and without an explicit id", () => {
    expect(parseCommand(comment("approve lesson L-002"), "bot-1")).toEqual({ kind: "approve-lesson", id: "L-002" });
    expect(parseCommand(comment("approve lesson"), "bot-1")).toEqual({ kind: "approve-lesson", id: undefined });
    expect(parseCommand(comment("reject lesson l7"), "bot-1")).toEqual({ kind: "reject-lesson", id: "L-007" });
  });

  it("reads a command typed in Jira's inline code styling", () => {
    // Regression, DOC-32: every agent comment prints the vocabulary as code, so the
    // reviewer types it back the same way and Jira stores `{{...}}`. Unstripped, the
    // leading brace pushed this to feedback and the agent re-drafted a finished ticket
    // instead of approving the rule — the gate looked like it fired and had not.
    expect(parseCommand(comment("{{approve lesson L-006}}"), "bot-1")).toEqual({
      kind: "approve-lesson",
      id: "L-006",
    });
    expect(parseCommand(comment("{{approve}}"), "bot-1").kind).toBe("approve-doc");
    expect(parseCommand(comment("{{draft}}"), "bot-1").kind).toBe("draft");
    expect(parseCommand(comment("{{reject lesson L-007}}"), "bot-1")).toEqual({
      kind: "reject-lesson",
      id: "L-007",
    });
    // Styling is decoration; it must not turn prose into a command either.
    expect(parseCommand(comment("I'll {{approve}} once the FAQ is fixed"), "bot-1").kind).toBe("feedback");
  });

  it("reads plain feedback through Jira mention and colour markup", () => {
    const parsed = parseCommand(comment("[~accountid:abc] {color:#de350b}Add a rollback step{color}"), "bot-1");
    expect(parsed).toEqual({ kind: "feedback", text: "Add a rollback step" });
  });

  it("wakes on a mention only when the mention is all there is, or there is no draft yet", () => {
    const at = "[~accountid:bot-1]";
    const drafted = { hasDraft: true };
    const blank = { hasDraft: false };

    // The regression this rule exists to prevent: a request aimed at an existing draft is
    // feedback, not a greeting.
    expect(parseCommand(comment(`${at} make the intro shorter`), "bot-1", drafted)).toEqual({
      kind: "feedback",
      text: "make the intro shorter",
    });
    // A bare mention (or one wrapped in nothing but a vocative) can only mean "answer me".
    expect(parseCommand(comment(at), "bot-1", drafted).kind).toBe("wake");
    expect(parseCommand(comment(`${at} hi!`), "bot-1", drafted).kind).toBe("wake");
    // Nothing drafted yet: there is no draft for the words to be feedback about.
    expect(parseCommand(comment(`${at} can you draft this?`), "bot-1", blank).kind).toBe("wake");

    // Mention detection reads the raw body — a mention of somebody else is not a wake.
    expect(parseCommand(comment(`[~accountid:someone-else] shorten the intro`), "bot-1", blank).kind).toBe("feedback");
  });

  it("keeps command precedence: own comment, then explicit command, then wake", () => {
    const at = "[~accountid:bot-1]";
    // The agent quoting a mention back at itself must not wake itself.
    expect(parseCommand(comment(`${at} I'm here.`, "bot-1", "9"), "bot-1", { hasDraft: false })).toEqual({
      kind: "ignore",
      reason: "own-comment",
    });
    // A typed command outranks the mention that carries it, drafted or not.
    expect(parseCommand(comment(`${at} approve`), "bot-1", { hasDraft: true }).kind).toBe("approve-doc");
    expect(parseCommand(comment(`${at} draft`), "bot-1", { hasDraft: false }).kind).toBe("draft");
  });
});

describe("poller query", () => {
  it("keeps the approval status in view even when it lives in the Done category", () => {
    // Approval by transition is only observable if the issue is still in the result set
    // after it moves. With approvedStatus=Done, a bare `statusCategory != Done` filter
    // drops the issue at the exact moment a human approves it.
    const jql = defaultJql({
      projectKey: "DOC",
      label: "doc-request",
      issueType: "Task",
      inProgressStatus: "In Progress",
      inReviewStatus: "In Review",
      approvedStatus: "Done",
      pollMs: 15_000,
      stateDir: "/tmp/state",
    });
    expect(jql).toContain('status = "Done"');
    expect(jql).not.toMatch(/labels\s*=/);
  });
});

describe("markdown <-> jira wiki markup", () => {
  it("converts structure without mangling code blocks", () => {
    const wiki = markdownToJira(
      ["# Title", "", "Use **bold** and `inline` code.", "", "- one", "  - nested", "", "```bash", "npm run **not-bold**", "```"].join("\n"),
    );
    expect(wiki).toContain("h1. Title");
    expect(wiki).toContain("*bold*");
    expect(wiki).toContain("{{inline}}");
    expect(wiki).toContain("* one");
    expect(wiki).toContain("** nested");
    expect(wiki).toContain("{code:bash}");
    // Transform order matters: content inside the fence stays byte-for-byte.
    expect(wiki).toContain("npm run **not-bold**");
  });

  it("escapes braces and brackets that would otherwise open a Jira macro", () => {
    const wiki = markdownToJira("Set {retention} to [30] days.");
    expect(wiki).toBe("Set \\{retention\\} to \\[30\\] days.");
  });

  it("keeps markdown links as Jira links", () => {
    expect(markdownToJira("See [the vault](https://example.com/v).")).toBe("See [the vault|https://example.com/v].");
  });

  it("recovers a PRD that Jira's editor rewrote as wiki markup", () => {
    const typedIntoJira = ["----", "feature: Scheduled maintenance", "audience: admins", "----", "h1. Scheduled maintenance", "* a bullet"].join("\n");
    const markdown = jiraToMarkdown(typedIntoJira);
    expect(markdown.startsWith("---\nfeature: Scheduled maintenance")).toBe(true);
    expect(markdown).toContain("# Scheduled maintenance");
    expect(markdown).toContain("- a bullet");
  });
});

describe("poller state", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-jira-state-"));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true, maxRetries: 5 });
  });

  it("seeds an issue's status on first sight instead of acting on it", async () => {
    const state = await JiraState.open(stateDir);
    await state.seed("DOC-1", "Approved");
    // Re-seeding must not overwrite: an issue found in Approved is not a fresh approval.
    await state.patch("DOC-1", { hasDraft: true });
    await state.seed("DOC-1", "In Progress");
    expect(state.get("DOC-1")?.lastStatus).toBe("Approved");
    expect(state.get("DOC-1")?.hasDraft).toBe(true);
  });

  it("keeps the processed-comment ledger across a restart", async () => {
    const first = await JiraState.open(stateDir);
    await first.markProcessed("DOC-2", ["100", "101"]);
    await first.saveDraft("DOC-2", "# Draft\n");

    const reopened = await JiraState.open(stateDir);
    expect(reopened.isProcessed("DOC-2", "100")).toBe(true);
    expect(reopened.isProcessed("DOC-2", "102")).toBe(false);
    expect(await reopened.readDraft("DOC-2")).toContain("# Draft");
  });

  it("splits a thread at the agent's own last comment — the downtime rule", () => {
    const thread = [comment("shorten the intro", "human-1", "1"), comment("**Draft ready**", "bot-1", "2"), comment("approve", "human-1", "3")];
    const { history, unprocessed } = splitAtLastOwnComment(thread, "bot-1");
    // Older than its own last word: history. Newer: still owed an answer.
    expect(history.map((item) => item.id)).toEqual(["1", "2"]);
    expect(unprocessed.map((item) => item.id)).toEqual(["3"]);

    // Never spoke here, so nothing is history — a mention typed before it ever polled counts.
    const untouched = splitAtLastOwnComment(thread, "other-bot");
    expect(untouched.history).toHaveLength(0);
    expect(untouched.unprocessed).toHaveLength(3);
  });

  it("keeps unapproved drafts out of the vault and out of git", async () => {
    const state = await JiraState.open(stateDir);
    await state.saveDraft("DOC-3", "# Not approved yet\n");
    const draftPath = state.draftPath("DOC-3");
    expect(draftPath.startsWith(stateDir)).toBe(true);
    expect(draftPath).not.toContain(`${path.sep}vault${path.sep}`);
  });
});

describe("jira client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const client = (): JiraClient =>
    new JiraClient({ baseUrl: "https://example.atlassian.net", email: "a@b.c", apiToken: "t", projectKey: "DOC" });

  it("reads every comment on a long ticket, paged, and stops on a server that ignores paging", async () => {
    const all = Array.from({ length: 250 }, (_, index) => ({ id: String(index + 1), body: `c${index + 1}`, created: "2026-09-28T00:00:00.000+0000" }));
    vi.stubGlobal("fetch", async (url: string) => {
      const query = new URL(String(url)).searchParams;
      const startAt = Number(query.get("startAt") ?? 0);
      const max = Number(query.get("maxResults") ?? 50);
      return new Response(JSON.stringify({ startAt, maxResults: max, total: all.length, comments: all.slice(startAt, startAt + max) }), { status: 200 });
    });
    const comments = await client().listComments("DOC-1");
    expect(comments).toHaveLength(250);
    expect(comments.at(-1)?.body).toBe("c250");

    // Past the cap, the newest are kept: that's where unread commands are.
    expect((await client().listComments("DOC-1", 120)).map((comment) => comment.body).slice(0, 1)).toEqual(["c131"]);

    // Same page every time, no total: read once, not forever.
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      return new Response(JSON.stringify({ comments: all.slice(0, 100) }), { status: 200 });
    });
    expect(await client().listComments("DOC-1")).toHaveLength(100);
    expect(calls).toBe(2);
  });

  it("falls back to the legacy search endpoint when the instance has no /search/jql", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(String(url));
      if (String(url).includes("/search/jql")) return new Response("", { status: 404 });
      return new Response(JSON.stringify({ issues: [{ id: "1", key: "DOC-1", fields: { summary: "x" } }] }), { status: 200 });
    });

    const jira = client();
    expect((await jira.searchIssues("project = DOC")).map((issue) => issue.key)).toEqual(["DOC-1"]);
    expect(jira.searchEndpoint).toBe("/rest/api/2/search");
    // The working endpoint is remembered, so the fallback is paid once, not every poll.
    await jira.searchIssues("project = DOC");
    expect(calls.filter((url) => url.includes("/search/jql"))).toHaveLength(1);
  });

  it("drops the auth header when an attachment redirects to media storage", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const auth = new Headers(init?.headers ?? {}).get("authorization");
      seen.push({ url: String(url), auth });
      if (String(url).includes("/attachment/content/")) {
        return new Response("", { status: 303, headers: { location: "https://media.example.com/signed" } });
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });

    const bytes = await client().downloadAttachment({
      id: "1",
      filename: "prd.md",
      mimeType: "text/markdown",
      content: "https://example.atlassian.net/rest/api/2/attachment/content/1",
    });

    expect(bytes.byteLength).toBe(3);
    expect(seen[0]?.auth).toMatch(/^Basic /);
    expect(seen[1]?.url).toBe("https://media.example.com/signed");
    expect(seen[1]?.auth).toBeNull();
  });

  it("surfaces Jira's error body instead of a bare status code", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ errorMessages: ["Issue does not exist"] }), { status: 404 }));
    await expect(client().getIssue("DOC-404")).rejects.toThrow(/Issue does not exist/);
  });
});

describe("which PRD attachment is the PRD", () => {
  it("prefers the newest upload over a stale one still attached", () => {
    const at = (filename: string, created: string) => ({ id: filename, filename, mimeType: "text/markdown", content: "", created });
    const picked = newestFirst([at("prd.md", "2026-08-20T10:00:00.000+0000"), at("prd-fixed.md", "2026-08-21T09:00:00.000+0000")]);
    expect(picked.map((attachment) => attachment.filename)).toEqual(["prd-fixed.md", "prd.md"]);
  });
});

describe("untrusted ticket input stays input", () => {
  it("keeps only the fields a PRD legitimately carries", () => {
    const kept = prdFrontmatter({ feature: "Digest", audience: "admins", user_goal: "one email", source_url: "https://evil.example", kind: "doc", status: "published", approved_by: "CEO" });
    expect(kept).toEqual({ feature: "Digest", audience: "admins", user_goal: "one email" });
  });

  it("names a design by its media type, never by what the uploader typed", () => {
    expect(safeDesignName("approve.md", "image/png", "digest-design-1")).toBe("approve.png");
    expect(safeDesignName("../../docs/Evil Name.JPG", "image/jpeg", "x")).toBe("evil-name.jpg");
    expect(safeDesignName("...", "image/webp", "digest-design-2")).toBe("digest-design-2.webp");
    expect(safeDesignName(undefined, "image/gif", "digest-design-3")).toBe("digest-design-3.gif");
  });
});

describe("mayApproveOnJira", () => {
  it("never approves an unknown account or the agent itself, and honours the approver list", async () => {
    const { mayApproveOnJira } = await import("@scriptorium/agents");
    expect(mayApproveOnJira({}, "bot", undefined).ok).toBe(false);
    expect(mayApproveOnJira({}, "bot", "bot").ok).toBe(false);
    // The Teammate's transition or comment is never a publish approval, approvers or not.
    expect(mayApproveOnJira({}, "bot", "tm-1", ["tm-1"]).ok).toBe(false);
    expect(mayApproveOnJira({}, "bot", "human-1", ["tm-1"]).ok).toBe(true);
    expect(mayApproveOnJira({}, "bot", "anyone").ok).toBe(true);
    expect(mayApproveOnJira({ approvers: ["pm"] }, "bot", "anyone").ok).toBe(false);
    expect(mayApproveOnJira({ approvers: ["pm"] }, "bot", "pm").ok).toBe(true);
  });
});

describe("reading a PRD out of Confluence", () => {
  it("uses the v2 pages API, falls back to v1 only when v2 is absent, and rejects a non-numeric id", async () => {
    const { JiraClient } = await import("@scriptorium/jira");
    const hits: string[] = [];
    let v2Exists = true;
    vi.stubGlobal("fetch", async (input: string) => {
      const url = String(input);
      hits.push(url.replace("https://example.atlassian.net", ""));
      if (url.includes("/api/v2/pages/") && !v2Exists) return new Response("", { status: 404 });
      return new Response(JSON.stringify({ title: "PRD", body: { storage: { value: "<p>x</p>" } } }), { status: 200 });
    });
    const client = new JiraClient({ baseUrl: "https://example.atlassian.net", email: "a", apiToken: "t", projectKey: "DOC" });
    expect(await client.confluencePage("123")).toEqual({ title: "PRD", storage: "<p>x</p>" });
    expect(hits).toEqual(["/wiki/api/v2/pages/123?body-format=storage"]);
    v2Exists = false;
    hits.length = 0;
    await client.confluencePage("123");
    expect(hits).toEqual(["/wiki/api/v2/pages/123?body-format=storage", "/wiki/rest/api/content/123?expand=body.storage"]);
    await expect(client.confluencePage("../admin")).rejects.toThrow(/not a Confluence page id/);
    vi.unstubAllGlobals();
  });
});

describe("the poller sees every matching ticket", () => {
  const issueN = (n: number) => ({ id: String(n), key: `DOC-${n}`, fields: { summary: `t${n}` } });

  it("pages /search/jql by nextPageToken past the first 100", async () => {
    const { JiraClient } = await import("@scriptorium/jira");
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      const url = new URL(String(input));
      calls.push(url.searchParams.get("nextPageToken") ?? "-");
      const token = url.searchParams.get("nextPageToken");
      const max = Number(url.searchParams.get("maxResults"));
      const start = token ? Number(token) : 0;
      const issues = Array.from({ length: Math.min(max, 230 - start) }, (_, i) => issueN(start + i));
      const next = start + issues.length;
      return new Response(JSON.stringify({ issues, ...(next < 230 ? { nextPageToken: String(next), isLast: false } : { isLast: true }) }), { status: 200 });
    });
    const client = new JiraClient({ baseUrl: "https://example.atlassian.net", email: "a", apiToken: "t", projectKey: "DOC" });
    const all = await client.searchAllIssues("project = DOC");
    expect(all).toHaveLength(230);
    expect(all.at(-1)?.key).toBe("DOC-229");
    vi.unstubAllGlobals();
  });

  it("pages the legacy /search by startAt", async () => {
    const { JiraClient } = await import("@scriptorium/jira");
    vi.stubGlobal("fetch", async (input: string) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/search/jql")) return new Response("", { status: 404 });
      const start = Number(url.searchParams.get("startAt") ?? 0);
      const max = Number(url.searchParams.get("maxResults"));
      const issues = Array.from({ length: Math.max(0, Math.min(max, 150 - start)) }, (_, i) => issueN(start + i));
      return new Response(JSON.stringify({ issues, total: 150 }), { status: 200 });
    });
    const client = new JiraClient({ baseUrl: "https://example.atlassian.net", email: "a", apiToken: "t", projectKey: "DOC" });
    expect(await client.searchAllIssues("project = DOC")).toHaveLength(150);
    vi.unstubAllGlobals();
  });
});

describe("Jira's JSON is checked where it enters", () => {
  it("fails loudly, naming the field, when a load-bearing field is missing", async () => {
    const { parseComments, parseIssue, parseMyself } = await import("@scriptorium/jira");
    expect(() => parseMyself({ displayName: "Scribe" })).toThrow(/account: accountId/);
    expect(() => parseIssue({ id: "1", fields: {} })).toThrow(/issue: key/);
    expect(() => parseComments([{ body: "hi", created: "now" }])).toThrow(/comment list: 0\.id/);
  });

  it("is lenient about everything it does not depend on", async () => {
    const { parseComments, parseIssue } = await import("@scriptorium/jira");
    const issue = parseIssue({ id: "1", key: "DOC-7", fields: { summary: null, customfield_10020: [{ x: 1 }] }, expand: "x" });
    expect(issue.fields.summary).toBe("");
    expect((issue.fields as unknown as Record<string, unknown>).customfield_10020).toEqual([{ x: 1 }]);
    expect(parseComments([{ id: "5", body: null, created: "2026-01-01", author: null }])).toEqual([{ id: "5", body: "", created: "2026-01-01", author: undefined }]);
    expect(parseComments(undefined)).toEqual([]);
  });
});

describe("other agents' conversation is not Scribe's", () => {
  it("the Teammate's account is looked up until known — a failed lookup never means 'no other agent'", async () => {
    const { knownAccounts } = await import("@scriptorium/agents");
    let calls = 0;
    const lookup = knownAccounts(async () => {
      calls += 1;
      if (calls === 1) throw new Error("HTTP 503");
      return ["tm-1"];
    });
    await expect(lookup()).rejects.toThrow("503");
    expect(await lookup()).toEqual(["tm-1"]);
    expect(await lookup()).toEqual(["tm-1"]);
    expect(calls).toBe(2);
    expect(await knownAccounts(["a"])()).toEqual(["a"]);
  });

  it("a question to the Teammate, and the Teammate's answer, are never feedback on a draft", async () => {
    const { parseCommand } = await import("@scriptorium/jira");
    const drafted = { hasDraft: true, otherAgents: ["tm-1"] };
    const c = (body: string, author = "human-1") => ({ id: "1", body, created: "now", author: { accountId: author, displayName: "X" } });
    expect(parseCommand(c("[~accountid:tm-1] what does retention do?"), "bot-1", drafted)).toEqual({ kind: "ignore", reason: "addressed-to-another-agent" });
    expect(parseCommand(c("Retention keeps 90 days [[docs/retention]].", "tm-1"), "bot-1", drafted)).toEqual({ kind: "ignore", reason: "other-agent" });
    // Addressed to both, or to Scribe: still Scribe's.
    expect(parseCommand(c("[~accountid:bot-1] [~accountid:tm-1] shorten the intro"), "bot-1", drafted).kind).toBe("feedback");
    // Plain feedback with no mention at all stays feedback.
    expect(parseCommand(c("shorten the intro"), "bot-1", drafted).kind).toBe("feedback");
  });
});
