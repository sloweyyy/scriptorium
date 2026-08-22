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
/** Every status the agent moved the ticket to, in order — the board trail it leaves. */
let moves: string[];
/** Columns the stubbed workflow offers; empty models a board the agent cannot drive. */
let board: string[];

/** A PRD as Jira's editor stores it: wiki markup, with `---` frontmatter fences rewritten as `----`. */
function prdInJira(...frontmatter: string[]): string {
  return ["----", ...frontmatter, "----", "h1. Incident timeline embed", "* an embeddable widget"].join("\n");
}

const INCOMPLETE_PRD = prdInJira("feature: Incident timeline embed");

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
    sites: {},
    webhook: {},
    docsRepo: { base: "main", internalBranch: "vault-live", commitName: "scriptorium agent", commitEmail: "agent@example.invalid", workDir: path.join(tmpRoot, "docs-repo") },
    jira: {
      baseUrl: "https://example.atlassian.net",
      email: "agent@example.com",
      apiToken: "token",
      projectKey: "DOC",
      label: "doc-request",
      issueType: "Task",
      inProgressStatus: "In Progress",
      inReviewStatus: "In Review",
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
    // A draft the agent attached earlier — what a restart with no ledger recovers from.
    if (url.includes("/attachment/content/")) return new Response("# Incident timeline embed\n\nA draft.\n", { status: 200 });
    if (url.includes("/rest/api/2/issue/")) return json(issue);
    return new Response("unexpected call", { status: 500 });
  });
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-flow-"));
  vault = new Vault(path.join(tmpRoot, "vault"));
  await vault.ensure();
  comments = [];
  moves = [];
  board = ["In Progress", "In Review", "Approved", "Done"];
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
    stop.stop();

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
    first.stop();
    const afterFirstPoll = comments.length;
    expect(afterFirstPoll).toBeGreaterThan(0);

    // A restart with the same state directory: the issue is known, its comments are the
    // agent's own, and the PRD has not changed.
    issue = { ...issue, fields: { ...(issue.fields as object), updated: "2026-08-20T10:05:00.000+0000" } };
    const second = await startScribeJira(settings, vault);
    second.stop();

    expect(comments).toHaveLength(afterFirstPoll);
  });

  it("retries by itself once the PRD actually changes", async () => {
    const settings = config();
    const first = await startScribeJira(settings, vault);
    first.stop();
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
    second.stop();

    expect(comments.length).toBeGreaterThan(afterFirstPoll);
    expect(comments.at(-1)?.body).toContain("user_goal");
  });
});

/** Everything the poller sees but was not labelled as a doc request. */
function unlabelled(): void {
  issue = { ...issue, fields: { ...(issue.fields as object), labels: [] } };
}

function bumpUpdated(stamp: string): void {
  issue = { ...issue, fields: { ...(issue.fields as object), updated: stamp } };
}

function human(id: string, body: string): StubComment {
  return { id, body, created: "2026-08-20T09:00:00.000+0000", author: { accountId: "human-1", displayName: "Reviewer" } };
}

describe("mention-only mode", () => {
  it("adopts an unlabelled ticket in silence — no greeting, no unsolicited draft", async () => {
    unlabelled();
    const stop = await startScribeJira(config(), vault);
    stop.stop();

    // The poller can see it (that is the point of the widened JQL) but nobody asked for
    // anything, so it spends neither a comment nor an LLM call.
    expect(comments).toHaveLength(0);
    expect(await vault.listNotes("docs")).toHaveLength(0);
    expect(await vault.listNotes("_inbox")).toHaveLength(0);
  });

  it("ignores other people's feedback on a ticket it has never engaged with", async () => {
    unlabelled();
    const settings = config();
    const first = await startScribeJira(settings, vault);
    first.stop();

    comments.push(human("h1", "the intro should mention the retention window"));
    bumpUpdated("2026-08-20T10:10:00.000+0000");
    const second = await startScribeJira(settings, vault);
    second.stop();

    // Two humans talking to each other. Answering would be barging in.
    expect(comments.filter((comment) => comment.author.accountId === "bot-1")).toHaveLength(0);
  });

  it("answers a mention on an unlabelled ticket", async () => {
    unlabelled();
    const settings = config();
    const first = await startScribeJira(settings, vault);
    first.stop();
    expect(comments).toHaveLength(0);

    comments.push(human("h1", "[~accountid:bot-1] can you draft this?"));
    bumpUpdated("2026-08-20T10:15:00.000+0000");
    const second = await startScribeJira(settings, vault);
    second.stop();

    // Substantive, not a greeting: the PRD is incomplete, so it names what it needs.
    const reply = comments.filter((comment) => comment.author.accountId === "bot-1");
    expect(reply).toHaveLength(1);
    expect(reply[0]?.body).toContain("user_goal");
  });
});

describe("restart with no ledger", () => {
  it("reconstructs from the ticket instead of re-greeting, and answers only what came after its last comment", async () => {
    // The state directory is empty — a fresh container on a ticket already worked: the
    // agent's own comment is on the thread and its draft is attached.
    comments = [
      human("h1", "make the intro shorter"),
      {
        id: "b1",
        body: "*Draft ready*",
        created: "2026-08-20T09:30:00.000+0000",
        author: { accountId: "bot-1", displayName: "Scribe" },
      },
      human("h2", "[~accountid:bot-1]"),
    ];
    issue = {
      ...issue,
      fields: {
        ...(issue.fields as object),
        attachment: [
          {
            id: "a1",
            filename: "draft-incident-timeline-embed.md",
            mimeType: "text/markdown",
            content: "https://example.atlassian.net/rest/api/2/attachment/content/a1",
            created: "2026-08-20T09:30:00.000+0000",
          },
        ],
      },
    };

    const stop = await startScribeJira(config(), vault);
    stop.stop();

    const posted = comments.slice(3);
    // Exactly one reply: the wake after its last word. No second HELP, no redraft, and the
    // pre-restart feedback stayed history instead of replaying as a duplicate revision
    // (which would have needed the model and surfaced as an error comment).
    expect(posted).toHaveLength(1);
    expect(posted[0]?.body).toContain("draft-incident-timeline-embed.md");
    expect(posted[0]?.body).not.toContain("How to work with me");
    expect(posted[0]?.body).not.toContain("hit an error");
  });

  it("says nothing at all on a ticket it already answered and nobody has replied to", async () => {
    // Greeted, refused the incomplete PRD, then went down. No draft was ever attached, so
    // recovery has nothing but the ticket's own inputs to go on — and must still stay quiet.
    comments = [
      {
        id: "b1",
        body: "*I can't draft from this PRD yet* — it is missing {{audience}} and {{user_goal}}.",
        created: "2026-08-20T09:30:00.000+0000",
        author: { accountId: "bot-1", displayName: "Scribe" },
      },
    ];

    const stop = await startScribeJira(config(), vault);
    stop.stop();

    expect(comments).toHaveLength(1);
  });
});
