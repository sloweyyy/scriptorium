import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Vault, type AppConfig } from "@scriptorium/core";

/**
 * The board trail.
 *
 * A reviewer reads the columns before the comments, so the ticket's position has to be
 * true: In Progress while the agent is working, In Review the moment a human's decision
 * is what's missing, Done when it published. These pin that the agent drives all four
 * columns rather than narrating in comments from To Do — and, just as importantly, that
 * a refusal moves nothing, because claiming to work on a PRD it rejected is a lie the
 * board would tell all week.
 *
 * Only the model call is stubbed. The contract, the lint, the publish and the state
 * ledger are the real ones, so a board move that depends on the real control flow cannot
 * pass here by accident.
 */

const CLEAN_DRAFT = [
  "# Incident timeline embed",
  "",
  "## Overview",
  "",
  "Workspace admins can embed a read-only incident timeline in a status page.",
  "",
  "## Steps",
  "",
  "1. Open **Settings → Status page**.",
  "2. Choose *Embed timeline* and copy the snippet.",
].join("\n");

vi.mock("@scriptorium/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scriptorium/core")>()),
  generateText: vi.fn(async () => CLEAN_DRAFT),
}));

// Imported after the mock is registered so the pipeline closes over the stub.
const { startScribeJira } = await import("@scriptorium/agents");

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
/** Every status the agent moved the ticket to, in order. */
let moves: string[];
/** The columns this stubbed workflow offers. An empty board is one the agent cannot drive. */
let board: string[];

const COMPLETE_PRD = [
  "----",
  "feature: Incident timeline embed",
  "audience: workspace admins",
  "user_goal: embed a read-only incident timeline in a status page",
  "----",
  "h1. Incident timeline embed",
  "* an embeddable widget",
].join("\n");

const INCOMPLETE_PRD = ["----", "feature: Incident timeline embed", "----", "h1. Incident timeline embed"].join("\n");

function config(): AppConfig {
  return {
    model: "claude-opus-5",
    hasModelAccess: true,
    provider: "anthropic",
    vertexRegion: "global",
    repoRoot: tmpRoot,
    vaultDir: path.join(tmpRoot, "vault"),
    auditFile: path.join(tmpRoot, "audit.jsonl"),
    port: 8080,
    scribe: {},
    curator: {},
    slack: {},
    webhook: {},
    docsRepo: {
      base: "main",
      internalBranch: "vault-live",
      commitName: "scriptorium agent",
      commitEmail: "agent@example.invalid",
      workDir: path.join(tmpRoot, "docs-repo"),
    },
    jira: {
      baseUrl: "https://example.atlassian.net",
      email: "agent@example.com",
      apiToken: "token",
      projectKey: "DOC",
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

function status(): string {
  return String((issue.fields as { status: { name: string } }).status.name);
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
    if (url.includes("/transitions") && method === "GET") {
      return json({ transitions: board.map((name, index) => ({ id: String(index + 1), name, to: { name } })) });
    }
    if (url.includes("/transitions") && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { transition: { id: string } };
      const target = board[Number(body.transition.id) - 1];
      if (target) {
        moves.push(target);
        issue = { ...issue, fields: { ...(issue.fields as object), status: { name: target } } };
      }
      return new Response(null, { status: 204 });
    }
    if (url.includes("/attachments") || url.includes("/attachment")) return json([]);
    if (url.includes("/rest/api/2/issue/")) return json(issue);
    return new Response("unexpected call", { status: 500 });
  });
}

function human(id: string, body: string): StubComment {
  return { id, body, created: "2026-08-20T12:00:00.000+0000", author: { accountId: "human-1", displayName: "Reviewer" } };
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-board-"));
  vault = new Vault(path.join(tmpRoot, "vault"));
  await vault.ensure();
  comments = [];
  moves = [];
  board = ["In Progress", "In Review", "Done"];
  issue = {
    id: "1",
    key: "DOC-1",
    fields: {
      summary: "Document the incident timeline embed",
      description: COMPLETE_PRD,
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

describe("board transitions", () => {
  it("walks To Do -> In Progress -> In Review while drafting, and stops there", async () => {
    const stop = await startScribeJira(config(), vault);
    stop.stop();

    expect(moves).toEqual(["In Progress", "In Review"]);
    // In Review, not Done: the next move belongs to a human, and the column says so.
    expect(status()).toBe("In Review");
  });

  it("reaches Done only when a human approves", async () => {
    const settings = config();
    const first = await startScribeJira(settings, vault);
    first.stop();
    expect(status()).toBe("In Review");

    comments.push(human("h1", "approve"));
    issue = { ...issue, fields: { ...(issue.fields as object), updated: "2026-08-20T13:00:00.000+0000" } };
    const second = await startScribeJira(settings, vault);
    second.stop();

    expect(moves).toEqual(["In Progress", "In Review", "Done"]);
    expect(await vault.listNotes("docs")).toHaveLength(1);
  });

  it("leaves the board alone when it refuses the PRD", async () => {
    issue = { ...issue, fields: { ...(issue.fields as object), description: INCOMPLETE_PRD } };
    const stop = await startScribeJira(config(), vault);
    stop.stop();

    // It asked for the missing fields and did nothing else: a ticket parked in To Do is
    // the honest state when the agent is waiting on the PM, and In Progress would not be.
    expect(moves).toEqual([]);
    expect(status()).toBe("To Do");
    expect(comments.some((comment) => comment.body.includes("user_goal"))).toBe(true);
  });

  it("still drafts on a board that offers no such column", async () => {
    // A workflow with only Done: every move is a no-op, and the draft has to land anyway.
    board = ["Done"];
    const stop = await startScribeJira(config(), vault);
    stop.stop();

    expect(moves).toEqual([]);
    expect(status()).toBe("To Do");
    // The comment is the fallback channel, and it carried the draft.
    expect(comments.some((comment) => comment.body.includes("Incident timeline embed"))).toBe(true);
  });

  it("reaches Done on a push-only retry too, not just on the first approval", async () => {
    const settings = config();
    const first = await startScribeJira(settings, vault);
    first.stop();

    comments.push(human("h1", "approve"));
    issue = { ...issue, fields: { ...(issue.fields as object), updated: "2026-08-20T13:00:00.000+0000" } };
    const second = await startScribeJira(settings, vault);
    second.stop();
    expect(status()).toBe("Done");

    // The reviewer asks for one more change, so the ticket walks the board again — and the
    // vault copy stays published, which puts the next approval on the retry path.
    comments.push(human("h2", "say which timezone the window is quoted in"));
    issue = { ...issue, fields: { ...(issue.fields as object), updated: "2026-08-20T14:00:00.000+0000" } };
    const third = await startScribeJira(settings, vault);
    third.stop();
    expect(status()).toBe("In Review");

    comments.push(human("h3", "approve"));
    issue = { ...issue, fields: { ...(issue.fields as object), updated: "2026-08-20T15:00:00.000+0000" } };
    const fourth = await startScribeJira(settings, vault);
    fourth.stop();

    // Published and pushed, so "In Review" would be a column with nothing left to review.
    expect(status()).toBe("Done");
  });

  it("corrects the column on a re-approval with nothing left to publish", async () => {
    // DOC-1's exact production state: published AND pushed, then walked back through the
    // board by a revision. Every unit of work is done, so `approve` has nothing to do
    // except the one thing still wrong — the column. Seeded directly, because a stubbed
    // Jira has no docs repo to push to and so can never reach `docsPushed` on its own.
    const settings = config();
    const stateDir = settings.jira.stateDir;
    await fs.mkdir(path.join(stateDir, "drafts"), { recursive: true });
    await fs.writeFile(path.join(stateDir, "drafts", "DOC-1.md"), CLEAN_DRAFT);
    await fs.writeFile(
      path.join(stateDir, "jira-state.json"),
      JSON.stringify({
        version: 1,
        issues: {
          "DOC-1": {
            hasDraft: true,
            docSlug: "incident-timeline-embed",
            publishedPath: "docs/incident-timeline-embed.md",
            docsPushed: true,
            lastStatus: "In Review",
            sourceFingerprint: "seeded",
            processedComments: [],
          },
        },
      }),
    );
    issue = { ...issue, fields: { ...(issue.fields as object), status: { name: "In Review" } } };

    comments.push(human("h1", "approve"));
    const stop = await startScribeJira(settings, vault);
    stop.stop();

    expect(status()).toBe("Done");
    // And it still says why it did nothing else, rather than implying it re-published.
    expect(comments.at(-1)?.body).toContain("Already published");
  });

  it("never re-announces a move the ticket is already in", async () => {
    issue = { ...issue, fields: { ...(issue.fields as object), status: { name: "In Progress" } } };
    const stop = await startScribeJira(config(), vault);
    stop.stop();

    // Already working, so only the In Review move is real.
    expect(moves).toEqual(["In Review"]);
  });
});
