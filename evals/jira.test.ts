import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JiraClient, jiraToMarkdown, JiraState, markdownToJira, parseCommand, type JiraComment } from "@scriptorium/jira";

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

  it("recognizes the approval vocabulary and nothing looser", () => {
    expect(parseCommand(comment("approve"), "bot-1").kind).toBe("approve-doc");
    expect(parseCommand(comment("Approve the draft"), "bot-1").kind).toBe("approve-doc");
    expect(parseCommand(comment("publish"), "bot-1").kind).toBe("approve-doc");
    // A sentence that merely contains the word must not publish anything.
    expect(parseCommand(comment("I'll approve once the FAQ is fixed"), "bot-1").kind).toBe("feedback");
  });

  it("parses lesson decisions with and without an explicit id", () => {
    expect(parseCommand(comment("approve lesson L-002"), "bot-1")).toEqual({ kind: "approve-lesson", id: "L-002" });
    expect(parseCommand(comment("approve lesson"), "bot-1")).toEqual({ kind: "approve-lesson", id: undefined });
    expect(parseCommand(comment("reject lesson l7"), "bot-1")).toEqual({ kind: "reject-lesson", id: "L-007" });
  });

  it("reads plain feedback through Jira mention and colour markup", () => {
    const parsed = parseCommand(comment("[~accountid:abc] {color:#de350b}Add a rollback step{color}"), "bot-1");
    expect(parsed).toEqual({ kind: "feedback", text: "Add a rollback step" });
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
    await fs.rm(stateDir, { recursive: true, force: true });
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
