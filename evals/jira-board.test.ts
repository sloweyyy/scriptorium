import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Vault, generateText, type AppConfig, type GenerateOptions } from "@scriptorium/core";

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
  properties?: unknown;
}

/** Drop the response to the next comment POST after storing it. */
let loseNextCommentResponse = false;
/** Fail the Nth comment POST from now WITHOUT storing it (a plain network error). */
let failCommentPostIn = 0;

let tmpRoot: string;
let vault: Vault;
let comments: StubComment[];
let issue: Record<string, unknown>;
/** Every status the agent moved the ticket to, in order. */
let moves: string[];
/** The columns this stubbed workflow offers. An empty board is one the agent cannot drive. */
let board: string[];
/** Every assignee the agent set, in order — the board's "who owes the next action". */
let assignments: Array<string | null>;
/** Changelog served under expand=changelog — who moved the ticket where. */
let changelog: Array<{ author: { displayName: string; accountId: string }; items: Array<{ field: string; toString: string }> }>;

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
    teammate: { channels: [], jiraProjects: [], confluenceSpaces: [], digestWeekday: 1, digestHour: 9 },
    slack: {},
    sites: {},
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
      if (failCommentPostIn > 0 && --failCommentPostIn === 0) throw new TypeError("fetch failed: connect ECONNRESET");
      const body = JSON.parse(String(init?.body ?? "{}")) as { body: string; properties?: unknown };
      const posted: StubComment = {
        id: `bot-${comments.length + 1}`,
        body: body.body,
        created: new Date().toISOString(),
        author: { accountId: "bot-1", displayName: "Scribe" },
        ...(body.properties ? { properties: body.properties } : {}),
      };
      comments.push(posted);
      // Jira stored it; the response never arrives. The case exactly-once exists for.
      if (loseNextCommentResponse) {
        loseNextCommentResponse = false;
        throw new TypeError("fetch failed: socket hang up");
      }
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
        changelog.push({ author: { displayName: "Scribe", accountId: "bot-1" }, items: [{ field: "status", toString: target }] });
      }
      return new Response(null, { status: 204 });
    }
    if (url.includes("/assignee") && method === "PUT") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { accountId: string | null };
      assignments.push(body.accountId);
      return new Response(null, { status: 204 });
    }
    if (url.includes("/remotelink")) return json([]);
    // Attachment bytes: any body works, the pipeline only base64s whatever it downloads.
    if (url.includes("/attachment/content/")) return new Response("PNGBYTES", { status: 200 });
    if (url.includes("/attachments") || url.includes("/attachment")) return json([]);
    if (url.includes("expand=changelog")) return json({ ...issue, changelog: { histories: changelog } });
    if (url.includes("/rest/api/2/issue/")) return json(issue);
    return new Response("unexpected call", { status: 500 });
  });
}

function human(id: string, body: string): StubComment {
  // Stamped when posted, like Jira: whether an approval is older than the draft it approves is
  // decided on these times.
  return { id, body, created: new Date().toISOString(), author: { accountId: "human-1", displayName: "Reviewer" } };
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-board-"));
  vault = new Vault(path.join(tmpRoot, "vault"));
  await vault.ensure();
  comments = [];
  moves = [];
  changelog = [];
  assignments = [];
  vi.mocked(generateText).mockClear();
  board = ["In Progress", "In Review", "Done"];
  issue = {
    id: "1",
    key: "DOC-1",
    fields: {
      summary: "Document the incident timeline embed",
      description: COMPLETE_PRD,
      status: { name: "To Do" },
      reporter: { accountId: "human-1", displayName: "Reviewer" },
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

  it("publishes a revision approved after the first publish, instead of refusing forever", async () => {
    // The exact production thread: draft -> approve -> published & pushed -> feedback ->
    // revised draft -> approve -> "Already published… comment draft" -> draft -> approve ->
    // the same refusal. The revised draft could never be published, and the suggested way
    // out would have discarded the very feedback that caused the revision.
    const settings = config();
    const first = await startScribeJira(settings, vault);
    first.stop();

    comments.push(human("h1", "approve"));
    issue = { ...issue, fields: { ...(issue.fields as object), updated: "2026-08-20T13:00:00.000+0000" } };
    const second = await startScribeJira(settings, vault);
    second.stop();
    const publishesAfterFirst = comments.filter((comment) => comment.body.includes("*Published* —")).length;
    expect(publishesAfterFirst).toBe(1);

    comments.push(human("h2", "always state which timezone the digest send time uses"));
    issue = { ...issue, fields: { ...(issue.fields as object), updated: "2026-08-20T14:00:00.000+0000" } };
    const third = await startScribeJira(settings, vault);
    third.stop();
    expect(comments.at(-1)?.body).toContain("Revised draft");

    comments.push(human("h3", "approve"));
    issue = { ...issue, fields: { ...(issue.fields as object), updated: "2026-08-20T15:00:00.000+0000" } };
    const fourth = await startScribeJira(settings, vault);
    fourth.stop();

    const bodies = comments.map((comment) => comment.body);
    // The revision published — a second **Published**, not the already-published refusal.
    expect(bodies.filter((body) => body.includes("*Published* —"))).toHaveLength(2);
    expect(bodies.filter((body) => body.includes("Already published"))).toHaveLength(0);

    // And approving once more after THAT is the no-op it should be.
    comments.push(human("h4", "approve"));
    issue = { ...issue, fields: { ...(issue.fields as object), updated: "2026-08-20T16:00:00.000+0000" } };
    const fifth = await startScribeJira(settings, vault);
    fifth.stop();
    expect(comments.at(-1)?.body).toContain("Already published");
    expect(comments.at(-1)?.body).not.toContain("Comment `draft`");
  });

  it("does not read its own board move as a human approval", async () => {
    // The production incident: feedback arrived while the ticket sat in Done (from the
    // previous approve). The revise moved the board Done -> In Progress -> In Review,
    // mutating lastStatus through the live state reference mid-tick — and the approval
    // detector then compared the STALE issue snapshot ("Done") against the FRESH ledger
    // ("In Review"), read the agent's own move as a human decision, and published a
    // revision nobody had approved, attributed to the agent itself.
    const settings = config();
    const first = await startScribeJira(settings, vault);
    first.stop();
    comments.push(human("h1", "approve"));
    issue = { ...issue, fields: { ...(issue.fields as object), updated: "2026-08-20T13:00:00.000+0000" } };
    const second = await startScribeJira(settings, vault);
    second.stop();
    expect(status()).toBe("Done");

    comments.push(human("h2", "always state which timezone the digest send time uses"));
    issue = { ...issue, fields: { ...(issue.fields as object), updated: "2026-08-20T14:00:00.000+0000" } };
    const third = await startScribeJira(settings, vault);
    third.stop();

    const bodies = comments.map((comment) => comment.body);
    // Revised, in review, and — the point — NOT published a second time.
    expect(bodies.at(-1)).toContain("Revised draft");
    expect(bodies.filter((body) => body.includes("*Published* —"))).toHaveLength(1);
    expect(status()).toBe("In Review");
  });

  it("publishes on a transition only when a human made it", async () => {
    // Belt to the snapshot's braces: even when the ledger genuinely lags (a crash between
    // the agent's transition and its bookkeeping), a transition authored by the agent's
    // own account is never an approval.
    const settings = config();
    const stateDir = settings.jira.stateDir;
    await fs.mkdir(path.join(stateDir, "drafts"), { recursive: true });
    await fs.writeFile(path.join(stateDir, "drafts", "DOC-1.md"), CLEAN_DRAFT);
    const seeded = {
      version: 1,
      issues: {
        "DOC-1": { hasDraft: true, docSlug: "incident-timeline-embed", sourceFingerprint: "seeded", processedComments: [], lastStatus: "In Review", lastUpdated: "2026-08-20T10:00:00.000+0000" },
      },
    };
    await fs.writeFile(path.join(stateDir, "jira-state.json"), JSON.stringify(seeded));
    issue = { ...issue, fields: { ...(issue.fields as object), status: { name: "Done" }, updated: "2026-08-20T15:00:00.000+0000" } };

    // The agent's own account moved it: bookkeeping, not approval. Nothing publishes.
    changelog = [{ author: { displayName: "Scribe", accountId: "bot-1" }, items: [{ field: "status", toString: "Done" }] }];
    const first = await startScribeJira(settings, vault);
    first.stop();
    expect(comments.filter((comment) => comment.body.includes("*Published* —"))).toHaveLength(0);

    // A human moved it: that IS the approval, attributed to them.
    await fs.writeFile(path.join(stateDir, "jira-state.json"), JSON.stringify(seeded));
    issue = { ...issue, fields: { ...(issue.fields as object), updated: "2026-08-20T16:00:00.000+0000" } };
    changelog = [{ author: { displayName: "Reviewer", accountId: "human-1" }, items: [{ field: "status", toString: "Done" }] }];
    const second = await startScribeJira(settings, vault);
    second.stop();

    const published = comments.find((comment) => comment.body.includes("*Published* —"));
    expect(published?.body).toContain("approved by Reviewer");
  });

  it("re-reads the designs when revising, so a mockup attached with the feedback is not ignored", async () => {
    // A reviewer who attaches a corrected wireframe and writes "match this" has said half
    // of it visually. The revision used to run on the feedback TEXT alone — the image was
    // downloaded for the first draft and never looked at again, silently.
    const withDesign = {
      id: "att-png",
      filename: "delivery-log-v2.png",
      mimeType: "image/png",
      content: "https://example.atlassian.net/rest/api/2/attachment/content/att-png",
    };
    issue = { ...issue, fields: { ...(issue.fields as object), attachment: [withDesign] } };

    const settings = config();
    const first = await startScribeJira(settings, vault);
    first.stop();

    comments.push(human("h1", "match the column order in the new mockup"));
    issue = { ...issue, fields: { ...(issue.fields as object), updated: "2026-08-20T14:00:00.000+0000" } };
    const second = await startScribeJira(settings, vault);
    second.stop();

    expect(comments.at(-1)?.body).toContain("Revised draft");

    // The revision call — the last one — carried the image, and told the model the
    // attached designs are the current ones.
    const calls = vi.mocked(generateText).mock.calls;
    const revision = calls.at(-1)?.[0] as GenerateOptions;
    expect(revision.images).toHaveLength(1);
    // The safety property, not just the presence of a hint: a design settles details and
    // must never redefine the subject.
    // The safety property, not merely the presence of a hint: the subject is named, and
    // an image of something else is to be ignored rather than followed.
    expect(revision.prompt).toContain('This document is about "Incident timeline embed"');
    expect(revision.prompt).toContain("ignore that image completely");

    // ...and the ticket says so, so a reviewer can see the mockup was read.
    expect(comments.at(-1)?.body).toContain("designs read: delivery-log-v2.png");
  });

  it("withholds the designs when the feedback never points at one", async () => {
    // The dangerous case, measured on the live board twice: an attached wireframe of a
    // DIFFERENT feature rewrote the document's subject even though the feedback said
    // nothing about designs. So plain prose feedback stays text-only, as it always was.
    const withDesign = {
      id: "att-png",
      filename: "some-other-feature.png",
      mimeType: "image/png",
      content: "https://example.atlassian.net/rest/api/2/attachment/content/att-png",
    };
    issue = { ...issue, fields: { ...(issue.fields as object), attachment: [withDesign] } };

    const settings = config();
    const first = await startScribeJira(settings, vault);
    first.stop();

    comments.push(human("h1", "the overview is too long, cut it to two sentences"));
    issue = { ...issue, fields: { ...(issue.fields as object), updated: "2026-08-20T14:00:00.000+0000" } };
    const second = await startScribeJira(settings, vault);
    second.stop();

    expect(comments.at(-1)?.body).toContain("Revised draft");
    const revision = vi.mocked(generateText).mock.calls.at(-1)?.[0] as GenerateOptions;
    expect(revision.images ?? []).toHaveLength(0);
    expect(comments.at(-1)?.body).not.toContain("designs read:");
  });

  it("says nothing about designs when a ticket has none", async () => {
    const settings = config();
    const first = await startScribeJira(settings, vault);
    first.stop();

    comments.push(human("h1", "tighten the overview"));
    issue = { ...issue, fields: { ...(issue.fields as object), updated: "2026-08-20T14:00:00.000+0000" } };
    const second = await startScribeJira(settings, vault);
    second.stop();

    const revision = vi.mocked(generateText).mock.calls.at(-1)?.[0] as GenerateOptions;
    expect(revision.images ?? []).toHaveLength(0);
    // No design hint in the prompt: the model is never told to look at images that do not exist.
    expect(revision.prompt).not.toContain("never change what this document is about");
    expect(comments.at(-1)?.body).not.toContain("designs read:");
  });

  it("takes the ticket while drafting and hands it back for review", async () => {
    // The assignee column is the fastest thing to read on a board and should answer one
    // question: who is this waiting on? Agent while it works, reporter the moment a
    // human's judgement is what is missing.
    const stop = await startScribeJira(config(), vault);
    stop.stop();

    expect(assignments).toEqual(["bot-1", "human-1"]);
    expect(status()).toBe("In Review");
  });

  it("hands the ticket back when it refuses the PRD", async () => {
    // It cannot proceed without fields only a human can supply, so the ticket is theirs —
    // and the board should not show it parked on the agent.
    issue = { ...issue, fields: { ...(issue.fields as object), description: INCOMPLETE_PRD } };
    const stop = await startScribeJira(config(), vault);
    stop.stop();

    expect(assignments).toEqual(["human-1"]);
    // Still To Do: a refusal moves nothing, it just changes whose turn it is.
    expect(status()).toBe("To Do");
  });

  it("leaves a gap ticket unassigned rather than parking it on itself", async () => {
    // Curator files gap tickets, so the agent is their reporter. Handing one "back" to the
    // reporter would assign it to the agent while a human is the only one who can supply
    // the PRD — a board that says the bot is blocked on itself.
    issue = {
      ...issue,
      fields: {
        ...(issue.fields as object),
        description: INCOMPLETE_PRD,
        reporter: { accountId: "bot-1", displayName: "Scribe" },
      },
    };

    const stop = await startScribeJira(config(), vault);
    stop.stop();

    expect(assignments).toEqual([null]);
  });

  it("never re-announces a move the ticket is already in", async () => {
    issue = { ...issue, fields: { ...(issue.fields as object), status: { name: "In Progress" } } };
    const stop = await startScribeJira(config(), vault);
    stop.stop();

    // Already working, so only the In Review move is real.
    expect(moves).toEqual(["In Review"]);
  });
});

describe("approving a revision nobody has seen", () => {
  it("holds a comment approval that arrives in the same poll as feedback", async () => {
    // "Fix the typo in step 2" then "approve", both before the next poll: the approval was
    // given to the draft on the ticket, and the revision it would publish is one the
    // reviewer has never read.
    const settings = config();
    const first = await startScribeJira(settings, vault);
    first.stop();

    comments.push(human("h1", "fix the typo in step 2"), human("h2", "approve"));
    issue = { ...issue, fields: { ...(issue.fields as object), updated: "2026-08-20T13:00:00.000+0000" } };
    const second = await startScribeJira(settings, vault);
    second.stop();

    expect(comments.filter((comment) => comment.body.includes("*Published* —"))).toHaveLength(0);
    expect(await vault.listNotes("docs")).toHaveLength(0);
    expect(comments.at(-1)?.body).toContain("haven't seen yet");

    // Having now seen it, the next approval publishes.
    comments.push(human("h3", "approve"));
    issue = { ...issue, fields: { ...(issue.fields as object), updated: "2026-08-20T14:00:00.000+0000" } };
    const third = await startScribeJira(settings, vault);
    third.stop();
    expect(comments.filter((comment) => comment.body.includes("*Published* —"))).toHaveLength(1);
  });

  it("holds a drag to Approved made while feedback was still being applied", async () => {
    const settings = config();
    const stateDir = settings.jira.stateDir;
    await fs.mkdir(path.join(stateDir, "drafts"), { recursive: true });
    await fs.writeFile(path.join(stateDir, "drafts", "DOC-1.md"), CLEAN_DRAFT);
    await fs.writeFile(
      path.join(stateDir, "jira-state.json"),
      JSON.stringify({
        version: 1,
        issues: {
          "DOC-1": { hasDraft: true, engaged: true, docSlug: "incident-timeline-embed", sourceFingerprint: "seeded", processedComments: [], lastStatus: "In Review", lastUpdated: "2026-08-20T10:00:00.000+0000" },
        },
      }),
    );
    comments.push(human("h1", "the intro should name the audience"));
    issue = { ...issue, fields: { ...(issue.fields as object), status: { name: "Done" }, updated: "2026-08-20T15:00:00.000+0000" } };
    changelog = [{ author: { displayName: "Reviewer", accountId: "human-1" }, items: [{ field: "status", toString: "Done" }] }];

    const run = await startScribeJira(settings, vault);
    run.stop();

    expect(comments.filter((comment) => comment.body.includes("*Published* —"))).toHaveLength(0);
    expect(comments.at(-1)?.body).toContain("haven't seen yet");
    expect(status()).toBe("In Review");
  });
});

describe("the Slack approve button", () => {
  it("refuses a card posted for an earlier draft, and publishes the draft it names", async () => {
    const { draftFingerprint } = await import("@scriptorium/agents");
    const settings = config();
    const handle = await startScribeJira(settings, vault);
    handle.stop();

    await expect(handle.approve("DOC-1", "Pat (slack:U1)", "0000000000000000")).rejects.toThrow(/draft has changed/);
    expect(comments.filter((comment) => comment.body.includes("*Published* —"))).toHaveLength(0);

    await handle.approve("DOC-1", "Pat (slack:U1)", draftFingerprint(CLEAN_DRAFT));
    expect(comments.filter((comment) => comment.body.includes("*Published* —"))).toHaveLength(1);
  });
});

describe("who may approve on Jira", () => {
  it("with approvers configured, a non-approver's `approve` is refused and nothing publishes", async () => {
    const settings = config();
    settings.jira.approvers = ["pm-1"];
    const first = await startScribeJira(settings, vault);
    first.stop();

    comments.push(human("h1", "approve"));
    issue = { ...issue, fields: { ...(issue.fields as object), updated: "2026-08-20T13:00:00.000+0000" } };
    const second = await startScribeJira(settings, vault);
    second.stop();
    expect(comments.filter((comment) => comment.body.includes("*Published* —"))).toHaveLength(0);
    expect(comments.at(-1)?.body).toContain("Only the configured approvers");
  });

  it("a board move nobody can attribute is not an approval", async () => {
    const settings = config();
    const stateDir = settings.jira.stateDir;
    await fs.mkdir(path.join(stateDir, "drafts"), { recursive: true });
    await fs.writeFile(path.join(stateDir, "drafts", "DOC-1.md"), CLEAN_DRAFT);
    await fs.writeFile(
      path.join(stateDir, "jira-state.json"),
      JSON.stringify({ version: 1, issues: { "DOC-1": { hasDraft: true, engaged: true, docSlug: "incident-timeline-embed", sourceFingerprint: "seeded", processedComments: [], lastStatus: "In Review", lastUpdated: "2026-08-20T10:00:00.000+0000" } } }),
    );
    issue = { ...issue, fields: { ...(issue.fields as object), status: { name: "Done" }, updated: "2026-08-20T15:00:00.000+0000" } };
    changelog = [];

    const run = await startScribeJira(settings, vault);
    run.stop();
    expect(comments.filter((comment) => comment.body.includes("*Published* —"))).toHaveLength(0);
    expect(comments.at(-1)?.body).toContain("couldn't tell who approved");
  });
});

describe("a lesson learned on one ticket shapes the next (TODO #6)", () => {
  const RULE = "Always state the timezone for any scheduled time.";

  async function learnOnDoc1(decision: "approve lesson" | "reject lesson" | null): Promise<void> {
    const { DISTILL_SYSTEM_PROMPT } = await import("@scriptorium/scribe");
    vi.mocked(generateText).mockImplementation(async (options: GenerateOptions) =>
      options.system === DISTILL_SYSTEM_PROMPT ? `LESSON: ${RULE}` : CLEAN_DRAFT,
    );
    const settings = config();
    let clock = 13;
    const tick = async (...bodies: string[]) => {
      bodies.forEach((body, index) => comments.push(human(`h${clock}-${index}`, body)));
      issue = { ...issue, fields: { ...(issue.fields as object), updated: `2026-08-20T${clock++}:00:00.000+0000` } };
      (await startScribeJira(settings, vault)).stop();
    };
    (await startScribeJira(settings, vault)).stop();
    await tick("always state which timezone the send time uses");
    await tick("approve");
    if (decision) await tick(decision);
  }

  async function draftDoc2(): Promise<string> {
    vi.mocked(generateText).mockClear();
    comments = [];
    issue = { ...issue, key: "DOC-2", id: "2", fields: { ...(issue.fields as object), summary: "Document digest emails", status: { name: "To Do" }, updated: "2026-08-21T09:00:00.000+0000" } };
    (await startScribeJira(config(), vault)).stop();
    const draftCall = vi.mocked(generateText).mock.calls.find(([options]) => !String((options as GenerateOptions).system).includes("review one piece of feedback"));
    return String((draftCall?.[0] as GenerateOptions | undefined)?.prompt ?? "");
  }

  it("an approved lesson from DOC-1 is in DOC-2's draft prompt, and reported as applied", async () => {
    await learnOnDoc1("approve lesson");
    const prompt = await draftDoc2();
    expect(prompt).toContain(RULE);
    expect(comments.some((comment) => comment.body.includes("L-001"))).toBe(true);
  });

  it("a lesson left proposed, or rejected, never reaches DOC-2", async () => {
    await learnOnDoc1(null);
    expect(await draftDoc2()).not.toContain(RULE);
  });

  it("a rejected lesson never reaches DOC-2", async () => {
    await learnOnDoc1("reject lesson");
    expect(await draftDoc2()).not.toContain(RULE);
  });
});

describe("designs the model cannot take", () => {
  it("drafts without an oversized image, and names it instead of failing the whole ticket", async () => {
    const huge = { id: "att-big", filename: "full-page-4k.png", mimeType: "image/png", size: 12_000_000, content: "https://example.atlassian.net/rest/api/2/attachment/content/att-big" };
    const fine = { id: "att-ok", filename: "form.png", mimeType: "image/png", size: 200_000, content: "https://example.atlassian.net/rest/api/2/attachment/content/att-ok" };
    issue = { ...issue, fields: { ...(issue.fields as object), attachment: [huge, fine] } };
    const run = await startScribeJira(config(), vault);
    run.stop();

    const draftCall = vi.mocked(generateText).mock.calls[0]?.[0] as GenerateOptions;
    expect(draftCall.images).toHaveLength(1);
    const draftComment = comments.find((comment) => comment.body.includes("full-page-4k.png"));
    expect(draftComment?.body).toMatch(/over 3\.8 MB/);
    expect(comments.some((comment) => comment.body.includes("I hit an error"))).toBe(false);
  });
});

describe("a crash or an error mid-batch loses nothing and repeats nothing (H4)", () => {
  const tickWith = async (settings: AppConfig, ...bodies: string[]) => {
    bodies.forEach((body, index) => comments.push(human(`c${comments.length}-${index}`, body)));
    issue = { ...issue, fields: { ...(issue.fields as object), updated: new Date(Date.now() + comments.length * 1000).toISOString() } };
    (await startScribeJira(settings, vault)).stop();
  };

  it("feedback + approve with a failing revise: both survive to the next poll, and the old approval is held", async () => {
    const settings = config();
    (await startScribeJira(settings, vault)).stop();
    vi.mocked(generateText).mockRejectedValueOnce(new Error("model overloaded"));
    await tickWith(settings, "shorten the intro", "approve");
    expect(comments.filter((comment) => comment.body.includes("Revised draft"))).toHaveLength(0);

    await tickWith(settings);
    const bodies = comments.map((comment) => comment.body);
    expect(bodies.filter((body) => body.includes("Revised draft"))).toHaveLength(1);
    // The approve was typed before this revision existed: held, not published.
    expect(bodies.some((body) => body.includes("haven't seen yet"))).toBe(true);
    expect(bodies.filter((body) => body.includes("*Published* —"))).toHaveLength(0);
  });

  it("a reply whose response was lost is found on retry, not posted twice", async () => {
    const settings = config();
    (await startScribeJira(settings, vault)).stop();
    loseNextCommentResponse = true;
    await tickWith(settings, "help");
    await tickWith(settings);
    // First sight posts HELP + "Reading this ticket now…"; the answer to `help` is HELP alone.
    const answers = comments.filter(
      (comment) => comment.author.accountId === "bot-1" && comment.body.includes("How to work with me") && !comment.body.includes("Reading this ticket now"),
    );
    expect(loseNextCommentResponse).toBe(false);
    expect(answers).toHaveLength(1);
  });

  it("a command that keeps failing is set aside after three tries, with a note", async () => {
    const settings = config();
    (await startScribeJira(settings, vault)).stop();
    vi.mocked(generateText).mockRejectedValue(new Error("model overloaded"));
    await tickWith(settings, "draft");
    await tickWith(settings);
    await tickWith(settings);
    expect(comments.some((comment) => comment.body.includes("I tried that 3 times"))).toBe(true);
    const before = comments.length;
    await tickWith(settings);
    // Set aside means set aside: no fourth attempt, no new noise.
    expect(comments.length).toBe(before);
    vi.mocked(generateText).mockReset();
    vi.mocked(generateText).mockImplementation(async () => CLEAN_DRAFT);
  });
});

describe("a command retried after the feedback before it landed", () => {
  it("still posts the command's own reply — the revision's comment is not mistaken for it", async () => {
    const settings = config();
    (await startScribeJira(settings, vault)).stop();
    // The revision's comment posts; the help reply after it fails outright.
    failCommentPostIn = 2;
    comments.push(human("f1", "shorten the intro"), human("c1", "help"));
    issue = { ...issue, fields: { ...(issue.fields as object), updated: new Date(Date.now() + 1000).toISOString() } };
    (await startScribeJira(settings, vault)).stop();
    issue = { ...issue, fields: { ...(issue.fields as object), updated: new Date(Date.now() + 2000).toISOString() } };
    (await startScribeJira(settings, vault)).stop();

    const bodies = comments.filter((comment) => comment.author.accountId === "bot-1").map((comment) => comment.body);
    expect(bodies.filter((body) => body.includes("Revised draft"))).toHaveLength(1);
    expect(bodies.filter((body) => body.includes("How to work with me") && !body.includes("Reading this ticket now"))).toHaveLength(1);
  });
});
