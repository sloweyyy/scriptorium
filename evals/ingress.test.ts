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
    slack: {},
    webhook: { jiraSecret: JIRA_SECRET, githubSecret: GITHUB_SECRET, jiraHmacSecret: JIRA_HMAC },
    docsRepo: { base: "main", internalBranch: "vault-live", commitName: "scriptorium agent", commitEmail: "agent@example.invalid", workDir: path.join(tmpRoot, "docs-repo"), url: "git@github.com:o/r.git" },
    jira: {
      label: "doc-request",
      issueType: "Task",
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
