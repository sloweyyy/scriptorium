import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "@scriptorium/core";
import { PROBE_EVENT, secretMatches, startIngress, verifyGitHubSignature } from "@scriptorium/agents";

/**
 * The ingress is the only inbound surface, so these pin the security properties rather
 * than the routing: a wrong Jira secret must be indistinguishable from "nothing here",
 * an unsigned GitHub payload must be refused outright, and the doctor's probe must prove
 * reachability without touching a ticket.
 */

const JIRA_SECRET = "s3cret-path-segment";
const GITHUB_SECRET = "hmac-shared-secret";
const JIRA_HMAC = "jira-webhook-signing-secret";

let server: Server;
let base: string;
let tmpRoot: string;
let nudged: string[];
let docsChanges: Array<{ paths: string[]; commitUrl?: string }>;

function config(): AppConfig {
  return {
    model: "claude-opus-5",
    hasModelAccess: true,
    provider: "anthropic",
    vertexRegion: "global",
    repoRoot: tmpRoot,
    vaultDir: path.join(tmpRoot, "vault"),
    auditFile: path.join(tmpRoot, "audit.jsonl"),
    port: 0,
    scribe: {},
    curator: {},
    teammate: { channels: [], jiraProjects: [], confluenceSpaces: [], githubRepos: [], allowDms: false, digestWeekday: 1, digestHour: 9 },
    slack: {},
    sites: {},
    webhook: { jiraSecret: JIRA_SECRET, githubSecret: GITHUB_SECRET, jiraHmacSecret: JIRA_HMAC },
    docsRepo: { base: "main", internalBranch: "vault-live", commitName: "scriptorium agent", commitEmail: "agent@example.invalid", workDir: path.join(tmpRoot, "docs-repo"), url: "git@github.com:o/r.git" },
    jira: {
      label: "doc-request",
      issueType: "Task",
      inProgressStatus: "In Progress",
      inReviewStatus: "In Review",
      approvedStatus: "Done",
      pollMs: 60_000,
      stateDir: path.join(tmpRoot, "state"),
    },
  };
}

function jiraSigned(body: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-hub-signature": `sha256=${createHmac("sha256", JIRA_HMAC).update(Buffer.from(body)).digest("hex")}`,
  };
}

function signed(body: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-hub-signature-256": `sha256=${createHmac("sha256", GITHUB_SECRET).update(Buffer.from(body)).digest("hex")}`,
  };
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-ingress-"));
  nudged = [];
  docsChanges = [];
  server = startIngress({
    config: config(),
    hooks: {
      nudge: async (key) => void nudged.push(key),
      docsChanged: async (input) => void docsChanges.push({ paths: input.paths, commitUrl: input.commitUrl }),
    },
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/** The hooks run after the response is sent, so give the event loop a turn. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

describe("ingress", () => {
  it("serves health with what is actually configured", async () => {
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
      const body = (await response.json()) as { status: string; webhooks: Record<string, boolean> };
    expect(body.status).toBe("ok");
    expect(body.webhooks).toEqual({ jira: true, jiraSigned: true, github: true });
  });

  it("answers a wrong Jira secret with 404 and does no work", async () => {
    const response = await fetch(`${base}/jira/webhook/not-the-secret`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ webhookEvent: "comment_created", issue: { key: "DOC-1" } }),
    });
    // 404 rather than 401: an unauthenticated caller learns nothing about what lives here.
    expect(response.status).toBe(404);
    await settle();
    expect(nudged).toEqual([]);
  });

  it("accepts a signed-by-path Jira event and works the issue by key", async () => {
    const body = JSON.stringify({ webhookEvent: "comment_created", issue: { key: "DOC-7" }, comment: { id: "10001" } });
    const response = await fetch(`${base}/jira/webhook/${JIRA_SECRET}`, { method: "POST", headers: jiraSigned(body), body });
    expect(response.status).toBe(202);
    await settle();
    // Only the key is taken from the payload — the handler re-fetches the issue itself.
    expect(nudged).toEqual(["DOC-7"]);
  });

  it("refuses a right-path request that is not signed, once a secret is configured", async () => {
    // The path segment is no longer sufficient when Jira is signing: an attacker who
    // learned the URL still cannot forge a payload.
    const body = JSON.stringify({ webhookEvent: "comment_created", issue: { key: "DOC-9" } });
    const response = await fetch(`${base}/jira/webhook/${JIRA_SECRET}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(response.status).toBe(401);
    await settle();
    expect(nudged).toEqual([]);
  });

  it("accepts a correctly signed Jira event", async () => {
    const body = JSON.stringify({ webhookEvent: "jira:issue_updated", issue: { key: "DOC-11" } });
    const response = await fetch(`${base}/jira/webhook/${JIRA_SECRET}`, { method: "POST", headers: jiraSigned(body), body });
    expect(response.status).toBe(202);
    await settle();
    expect(nudged).toEqual(["DOC-11"]);
  });

  it("treats the reachability probe as a no-op", async () => {
    const probeBody = JSON.stringify({ webhookEvent: PROBE_EVENT, issue: { key: "DOC-1" } });
    const response = await fetch(`${base}/jira/webhook/${JIRA_SECRET}`, { method: "POST", headers: jiraSigned(probeBody), body: probeBody });
    expect(response.status).toBe(200);
    await settle();
    expect(nudged).toEqual([]);
  });

  it("refuses an unsigned or wrongly-signed GitHub payload", async () => {
    const body = JSON.stringify({ ref: "refs/heads/main", commits: [{ modified: ["docs/a.md"] }] });
    const unsigned = await fetch(`${base}/github/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    expect(unsigned.status).toBe(401);

    const wrong = await fetch(`${base}/github/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-hub-signature-256": `sha256=${"0".repeat(64)}` },
      body,
    });
    expect(wrong.status).toBe(401);
    await settle();
    expect(docsChanges).toEqual([]);
  });

  it("accepts a correctly signed push on the base branch and reports the changed paths", async () => {
    const body = JSON.stringify({
      ref: "refs/heads/main",
      after: "abc123",
      commits: [{ id: "abc123", url: "https://github.com/o/r/commit/abc123", modified: ["docs/a.md"], added: ["internal/_lessons/L-001.md"] }],
    });
    const response = await fetch(`${base}/github/webhook`, { method: "POST", headers: signed(body), body });
    expect(response.status).toBe(202);
    await settle();
    expect(docsChanges).toHaveLength(1);
    expect(docsChanges[0]?.paths.sort()).toEqual(["docs/a.md", "internal/_lessons/L-001.md"]);
    expect(docsChanges[0]?.commitUrl).toContain("abc123");
  });

  it("ignores a push to any branch other than the base", async () => {
    const body = JSON.stringify({ ref: "refs/heads/docs/doc-1-thing", commits: [{ modified: ["docs/a.md"] }] });
    const response = await fetch(`${base}/github/webhook`, { method: "POST", headers: signed(body), body });
    expect(response.status).toBe(202);
    await settle();
    // The agent's own publish branch pushes here constantly; only the base branch matters.
    expect(docsChanges).toEqual([]);
  });
});

describe("ingress primitives", () => {
  it("works a redelivered Jira or GitHub webhook once, not twice", async () => {
    const body = JSON.stringify({ webhookEvent: "comment_created", issue: { key: "DOC-7" }, comment: { id: "10001" } });
    const headers = { ...jiraSigned(body), "x-atlassian-webhook-identifier": "delivery-1" };
    expect((await fetch(`${base}/jira/webhook/${JIRA_SECRET}`, { method: "POST", headers, body })).status).toBe(202);
    const replay = await fetch(`${base}/jira/webhook/${JIRA_SECRET}`, { method: "POST", headers, body });
    expect(await replay.json()).toMatchObject({ accepted: false, reason: "duplicate delivery" });

    const push = JSON.stringify({ ref: "refs/heads/main", commits: [{ modified: ["docs/a.md"] }], head_commit: { id: "abc", url: "https://x" } });
    const pushHeaders = { ...signed(push), "x-github-delivery": "gh-1" };
    await fetch(`${base}/github/webhook`, { method: "POST", headers: pushHeaders, body: push });
    await fetch(`${base}/github/webhook`, { method: "POST", headers: pushHeaders, body: push });
    await settle();
    expect(nudged).toEqual(["DOC-7"]);
    expect(docsChanges.length).toBeLessThanOrEqual(1);
  });

  it("only remembers authenticated deliveries", async () => {
    const body = JSON.stringify({ webhookEvent: "comment_created", issue: { key: "DOC-8" } });
    // A forged delivery with a real-looking id must not poison the genuine one.
    await fetch(`${base}/jira/webhook/${JIRA_SECRET}`, { method: "POST", headers: { "Content-Type": "application/json", "x-atlassian-webhook-identifier": "delivery-2" }, body });
    await fetch(`${base}/jira/webhook/${JIRA_SECRET}`, { method: "POST", headers: { ...jiraSigned(body), "x-atlassian-webhook-identifier": "delivery-2" }, body });
    await settle();
    expect(nudged).toEqual(["DOC-8"]);
  });

  it("rejects a secret of the wrong length without throwing", () => {
    expect(secretMatches("short", "much-longer-secret")).toBe(false);
    expect(secretMatches("same", "same")).toBe(true);
  });

  it("verifies GitHub's HMAC over the raw bytes", () => {
    const raw = Buffer.from('{"ref":"refs/heads/main"}');
    const good = `sha256=${createHmac("sha256", GITHUB_SECRET).update(raw).digest("hex")}`;
    expect(verifyGitHubSignature(raw, good, GITHUB_SECRET)).toBe(true);
    expect(verifyGitHubSignature(raw, good, "other-secret")).toBe(false);
    expect(verifyGitHubSignature(raw, undefined, GITHUB_SECRET)).toBe(false);
    // One byte different in the body must invalidate it.
    expect(verifyGitHubSignature(Buffer.from('{"ref":"refs/heads/mai"}'), good, GITHUB_SECRET)).toBe(false);
  });
});

describe("run viewer", () => {
  it("is closed without the token, and shows one run's events, escaped, with it", async () => {
    const auditFile = path.join(tmpRoot, "audit.jsonl");
    await fs.mkdir(path.dirname(auditFile), { recursive: true });
    await fs.writeFile(
      auditFile,
      [
        JSON.stringify({ ts: "2026-09-27T10:00:00Z", run: "3f2a9c1b-aaaa", type: "teammate.answer", question: "<script>alert(1)</script>" }),
        JSON.stringify({ ts: "2026-09-27T10:01:00Z", run: "ffffffff-bbbb", type: "other.run" }),
      ].join("\n"),
    );
    const viewer = startIngress({ config: { ...config(), auditFile, webhook: { ...config().webhook, traceToken: "tok-123" } } as AppConfig, hooks: {} });
    await new Promise<void>((resolve) => viewer.once("listening", resolve));
    const at = `http://127.0.0.1:${(viewer.address() as AddressInfo).port}`;
    try {
      expect((await fetch(`${at}/runs/3f2a9c1b`)).status).toBe(404);
      expect((await fetch(`${at}/runs/3f2a9c1b?token=wrong`)).status).toBe(404);
      const page = await fetch(`${at}/runs/3f2a9c1b?token=tok-123`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
      const html = await page.text();
      expect(html).toContain("teammate.answer");
      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).toContain("&lt;script&gt;");
      expect(html).not.toContain("other.run");
      // A short prefix is not "show me everything".
      expect((await fetch(`${at}/runs/f?token=tok-123`)).status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => viewer.close(() => resolve()));
    }
  });
});

describe("pull request webhooks", () => {
  it("hands opened, reopened and ready-for-review PRs to the Teammate — never drafts or other actions", async () => {
    const { pullRequestFrom } = await import("@scriptorium/agents");
    const pr = (action: string, draft = false) => ({ action, pull_request: { number: 12, draft, user: { login: "dev" } }, repository: { full_name: "Org/App" } });
    expect(pullRequestFrom("pull_request", pr("opened"))).toEqual({ repo: "org/app", number: 12, author: "dev" });
    expect(pullRequestFrom("pull_request", pr("ready_for_review"))).toMatchObject({ number: 12 });
    expect(pullRequestFrom("pull_request", pr("opened", true))).toBeUndefined();
    expect(pullRequestFrom("pull_request", pr("closed"))).toBeUndefined();
    expect(pullRequestFrom("push", pr("opened"))).toBeUndefined();
  });

  it("a signed pull_request delivery reaches the hook once", async () => {
    const seen: Array<{ repo: string; number: number }> = [];
    const hooked = startIngress({ config: config(), hooks: { pullRequest: async (input) => void seen.push(input) } });
    await new Promise<void>((resolve) => hooked.once("listening", resolve));
    const at = `http://127.0.0.1:${(hooked.address() as AddressInfo).port}`;
    try {
      const body = JSON.stringify({ action: "opened", pull_request: { number: 7, user: { login: "dev" } }, repository: { full_name: "org/app" } });
      const headers = { ...signed(body), "x-github-event": "pull_request", "x-github-delivery": "pr-1" };
      await fetch(`${at}/github/webhook`, { method: "POST", headers, body });
      await fetch(`${at}/github/webhook`, { method: "POST", headers, body });
      await settle();
      expect(seen).toMatchObject([{ repo: "org/app", number: 7 }]);
    } finally {
      await new Promise<void>((resolve) => hooked.close(() => resolve()));
    }
  });
});

describe("jira comment webhooks", () => {
  it("parses comment_created into what the Teammate needs, and nothing else", async () => {
    const { jiraCommentFrom } = await import("@scriptorium/agents");
    expect(jiraCommentFrom({ webhookEvent: "comment_created", issue: { key: "DOC-7" }, comment: { id: 10001, body: "hi", author: { accountId: "h1" } } })).toEqual({ issueKey: "DOC-7", commentId: "10001", body: "hi", authorId: "h1", restriction: {} });
    // An edit is read too (adding the forgotten mention); other events are not.
    expect(jiraCommentFrom({ webhookEvent: "comment_updated", issue: { key: "DOC-7" }, comment: { id: 1, body: "x" } })?.commentId).toBe("1");
    expect(jiraCommentFrom({ webhookEvent: "comment_deleted", issue: { key: "DOC-7" }, comment: { id: 1, body: "x" } })).toBeUndefined();
    expect(jiraCommentFrom({ webhookEvent: "comment_created", issue: { key: "DOC-7" }, comment: { id: 1 } })).toBeUndefined();
  });
});

describe("new Jira issues", () => {
  it("parses issue_created with its reporter, and nothing else", async () => {
    const { jiraCreatedFrom } = await import("@scriptorium/agents");
    expect(jiraCreatedFrom({ webhookEvent: "jira:issue_created", issue: { key: "BEA-1", fields: { reporter: { accountId: "h1" } } } })).toEqual({ issueKey: "BEA-1", reporterId: "h1" });
    expect(jiraCreatedFrom({ webhookEvent: "jira:issue_updated", issue: { key: "BEA-1" } })).toBeUndefined();
  });
});

describe("restricted Jira comments", () => {
  it("carry their visibility or JSM internal flag; a visibility we can't read is not answered", async () => {
    const { jiraCommentFrom } = await import("@scriptorium/agents");
    const hook = (comment: Record<string, unknown>) => jiraCommentFrom({ webhookEvent: "comment_created", issue: { key: "SD-1" }, comment: { id: 1, body: "hi", ...comment } });
    expect(hook({ visibility: { type: "role", value: "Service Desk Team" } })?.restriction).toEqual({ visibility: { type: "role", value: "Service Desk Team" } });
    expect(hook({ jsdPublic: false })?.restriction).toEqual({ internal: true });
    expect(hook({ properties: [{ key: "sd.public.comment", value: { internal: true } }] })?.restriction).toEqual({ internal: true });
    expect(hook({ jsdPublic: true })?.restriction).toEqual({});
    expect(hook({ visibility: { type: "team", value: 7 } })).toBeUndefined();
  });
});

describe("ADF comment bodies", () => {
  it("keep a pasted issue link (a smart card) as its URL", async () => {
    const { adfToText } = await import("@scriptorium/agents");
    const adf = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "is " }, { type: "inlineCard", attrs: { url: "https://x.atlassian.net/browse/DOC-42" } }, { type: "text", text: " ready?" }] }] };
    expect(adfToText(adf)).toBe("is https://x.atlassian.net/browse/DOC-42 ready?\n");
  });

  it("are read, mentions included, instead of being dropped", async () => {
    const { jiraCommentFrom } = await import("@scriptorium/agents");
    const adf = { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: "tm-1", text: "@Teammate" } }, { type: "text", text: " when do digests go out?" }] }] };
    expect(jiraCommentFrom({ webhookEvent: "comment_created", issue: { key: "DOC-1" }, comment: { id: "9", body: adf, author: { accountId: "h1" } } })).toEqual({
      issueKey: "DOC-1",
      commentId: "9",
      body: "[~accountid:tm-1] when do digests go out?",
      authorId: "h1",
      restriction: {},
    });
  });
});

describe("jira assignment webhooks", () => {
  it("reads who an issue was assigned to from the changelog", async () => {
    const { jiraAssignmentFrom } = await import("@scriptorium/agents");
    expect(jiraAssignmentFrom({ webhookEvent: "jira:issue_updated", issue: { key: "DOC-9" }, changelog: { id: "10500", items: [{ field: "assignee", fieldId: "assignee", to: "tm-1" }] } })).toEqual({ issueKey: "DOC-9", assigneeId: "tm-1", changeId: "10500" });
    expect(jiraAssignmentFrom({ webhookEvent: "jira:issue_updated", issue: { key: "DOC-9" }, changelog: { items: [{ field: "status", to: "3" }] } })).toBeUndefined();
    expect(jiraAssignmentFrom({ webhookEvent: "jira:issue_updated", issue: { key: "DOC-9" }, changelog: { items: [{ fieldId: "assignee", to: null }] } })).toBeUndefined();
  });
});
