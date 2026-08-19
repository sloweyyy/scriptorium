import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Vault, type AppConfig } from "@scriptorium/core";
import { startScribeJira } from "@scriptorium/agents";

/**
 * The unsupervised loop, end to end, against a stubbed Jira.
 *
 * The reviewer exercises this surface alone, so the paths that must not need an LLM —
 * adopting a ticket, refusing an incomplete PRD, and never answering itself — are pinned
 * here without touching the network or the model.
 */

interface StubComment {
  id: string;
  body: string;
  created: string;
  author: { accountId: string; displayName: string };
}

let tmpRoot: string;
let vault: Vault;
let comments: StubComment[];
let issue: Record<string, unknown>;

/** A PRD as Jira's editor stores it: wiki markup, with `---` frontmatter fences rewritten as `----`. */
function prdInJira(...frontmatter: string[]): string {
  return ["----", ...frontmatter, "----", "h1. Incident timeline embed", "* an embeddable widget"].join("\n");
}

const INCOMPLETE_PRD = prdInJira("feature: Incident timeline embed");

function config(): AppConfig {
  return {
    model: "claude-opus-5",
    hasAnthropicKey: true,
    repoRoot: tmpRoot,
    vaultDir: path.join(tmpRoot, "vault"),
    auditFile: path.join(tmpRoot, "audit.jsonl"),
    port: 8080,
    scribe: {},
    curator: {},
    jira: {
      baseUrl: "https://example.atlassian.net",
      email: "agent@example.com",
      apiToken: "token",
      projectKey: "DOC",
      label: "doc-request",
      issueType: "Task",
      approvedStatus: "Approved",
      pollMs: 60_000,
      stateDir: path.join(tmpRoot, "state"),
    },
  };
}

function stubJira(): void {
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const json = (value: unknown): Response => new Response(JSON.stringify(value), { status: 200 });

    if (url.includes("/myself")) return json({ accountId: "bot-1", displayName: "Scribe" });
    if (url.includes("/search")) return json({ issues: [issue] });
    if (url.includes("/comment") && method === "GET") return json({ comments });
    if (url.includes("/comment") && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { body: string };
      const posted: StubComment = {
        id: `bot-${comments.length + 1}`,
        body: body.body,
        created: new Date().toISOString(),
        author: { accountId: "bot-1", displayName: "Scribe" },
      };
      comments.push(posted);
      return json(posted);
    }
    if (url.includes("/transitions")) return json({ transitions: [] });
    if (url.includes("/rest/api/2/issue/")) return json(issue);
    return new Response("unexpected call", { status: 500 });
  });
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-flow-"));
  vault = new Vault(path.join(tmpRoot, "vault"));
  await vault.ensure();
  comments = [];
  issue = {
    id: "1",
    key: "DOC-1",
    fields: {
      summary: "Document the incident timeline embed",
      description: INCOMPLETE_PRD,
      status: { name: "To Do" },
      labels: ["doc-request"],
      attachment: [],
      updated: "2026-08-20T10:00:00.000+0000",
    },
  };
  stubJira();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("scribe on jira", () => {
  it("adopts a new ticket and refuses an incomplete PRD instead of guessing", async () => {
    const stop = await startScribeJira(config(), vault);
    stop();

    const bodies = comments.map((comment) => comment.body);
    expect(bodies.some((body) => body.includes("How to work with me"))).toBe(true);

    const refusal = bodies.find((body) => body.includes("can't draft"));
    expect(refusal).toBeDefined();
    // It asks for exactly the fields the contract requires, and nothing was published.
    expect(refusal).toContain("audience");
    expect(refusal).toContain("user_goal");
    expect(await vault.listNotes("docs")).toHaveLength(0);

    const log = await fs.readFile(path.join(tmpRoot, "audit.jsonl"), "utf8");
    expect(log).toContain('"type":"jira.contract.rejected"');
  });

  it("says nothing on the next poll — its own comments are never read as feedback", async () => {
    const settings = config();
    const first = await startScribeJira(settings, vault);
    first();
    const afterFirstPoll = comments.length;
    expect(afterFirstPoll).toBeGreaterThan(0);

    // A restart with the same state directory: the issue is known, its comments are the
    // agent's own, and the PRD has not changed.
    issue = { ...issue, fields: { ...(issue.fields as object), updated: "2026-08-20T10:05:00.000+0000" } };
    const second = await startScribeJira(settings, vault);
    second();

    expect(comments).toHaveLength(afterFirstPoll);
  });

  it("retries by itself once the PRD actually changes", async () => {
    const settings = config();
    const first = await startScribeJira(settings, vault);
    first();
    const afterFirstPoll = comments.length;

    // The PM fixes the frontmatter: new description, so a fresh attempt is warranted.
    issue = {
      ...issue,
      fields: {
        ...(issue.fields as object),
        description: prdInJira("feature: Incident timeline embed", "audience: workspace admins"),
        updated: "2026-08-20T11:00:00.000+0000",
      },
    };
    const second = await startScribeJira(settings, vault);
    second();

    expect(comments.length).toBeGreaterThan(afterFirstPoll);
    expect(comments.at(-1)?.body).toContain("user_goal");
  });
});
