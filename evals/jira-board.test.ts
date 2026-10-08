import { createHash } from "node:crypto";
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
const { JiraState } = await import("@scriptorium/jira");

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
/** Refuse every comment carrying a revision (first try or re-post), the way a 400 would, until turned off. */
let failRevisionPosts = false;
/** Run once, right after a comment containing `text` is stored: a human acting mid-tick. */
let afterPost: { text: string; run: () => void } | undefined;
/** Fail the next comment post containing this text, once. */
let failNextPostContaining: string | undefined;
/** A search that returns an older view of the ticket than a fetch does: a second caller's snapshot. */
let staleSearch: unknown;

let tmpRoot: string;
let vault: Vault;
let comments: StubComment[];
/** Search queries and issue reads, in order. */
let fetched: string[] = [];
let issue: Record<string, unknown>;
/** Every status the agent moved the ticket to, in order. */
let moves: string[];
/** The columns this stubbed workflow offers. An empty board is one the agent cannot drive. */
let board: string[];
/** Every assignee the agent set, in order — the board's "who owes the next action". */
let assignments: Array<string | null>;
/** Changelog served under expand=changelog — who moved the ticket where. */
/** Attachments the agent uploaded, by download id: the fake keeps what Jira would. */
let uploaded: Map<string, Buffer>;
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
    teammate: { channels: [], jiraProjects: [], confluenceSpaces: [], githubRepos: [], allowDms: false, digestWeekday: 1, digestHour: 9 },
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
    if (url.includes("/search")) {
      fetched.push(decodeURIComponent(url.replace(/\+/g, " ")));
      return json({ issues: [staleSearch ?? issue] });
    }
    if (/\/issue\/[A-Z]+-\d+(\?|$)/.test(url) && method === "GET") fetched.push(url);
    if (url.includes("/comment") && method === "GET") return json({ comments });
    if (url.includes("/comment") && method === "POST") {
      if (failCommentPostIn > 0 && --failCommentPostIn === 0) throw new TypeError("fetch failed: connect ECONNRESET");
      const body = JSON.parse(String(init?.body ?? "{}")) as { body: string; properties?: unknown };
      // Jira's own limit: a longer comment is refused, every time.
      if (body.body.length > 32_767) return new Response(JSON.stringify({ errors: { comment: "too long" } }), { status: 400 });
      if (failNextPostContaining && body.body.includes(failNextPostContaining)) {
        failNextPostContaining = undefined;
        throw new TypeError("fetch failed: connect ECONNRESET");
      }
      if (failRevisionPosts && (body.body.includes("Revised draft") || body.body.includes("Draft (posted again)"))) return new Response(JSON.stringify({ errorMessages: ["bad request"] }), { status: 400 });
      const posted: StubComment = {
        id: `bot-${comments.length + 1}`,
        body: body.body,
        created: new Date().toISOString(),
        author: { accountId: "bot-1", displayName: "Scribe" },
        ...(body.properties ? { properties: body.properties } : {}),
      };
      comments.push(posted);
      if (afterPost && body.body.includes(afterPost.text)) {
        const hook = afterPost;
        afterPost = undefined;
        hook.run();
      }
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
        // A transition changes `updated`, as Jira's does.
        const updated = new Date(Math.max(Date.parse((issue.fields as { updated: string }).updated) + 1000, Date.now())).toISOString();
        issue = { ...issue, fields: { ...(issue.fields as object), status: { name: target }, updated } };
        changelog.push({ author: { displayName: "Scribe", accountId: "bot-1" }, items: [{ field: "status", toString: target }] });
      }
      return new Response(null, { status: 204 });
    }
    if (url.includes("/assignee") && method === "PUT") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { accountId: string | null };
      assignments.push(body.accountId);
      issue = { ...issue, fields: { ...(issue.fields as object), assignee: body.accountId ? { accountId: body.accountId } : null } };
      return new Response(null, { status: 204 });
    }
    if (url.includes("/remotelink")) return json([]);
    // Attachment bytes: any body works, the pipeline only base64s whatever it downloads.
    // A real PNG signature, then filler; "fake-png" serves a PDF under an image's name.
    const stored = uploaded.get(url.split("/attachment/content/")[1] ?? "");
    if (stored) return new Response(stored, { status: 200 });
    if (url.includes("/attachment/content/missing-")) return new Response("gone", { status: 404 });
    if (url.includes("/attachment/content/fake-png")) fetched.push(url);
    if (url.includes("/attachment/content/fake-png")) return new Response("%PDF-1.7 not an image", { status: 200 });
    // Two versions of one design: the bytes say which is which.
    const version = url.match(/\/attachment\/content\/design-(v\d)/)?.[1];
    if (version) return new Response(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(version)]), { status: 200 });
    // A design just under the per-image cap: eight of them overflow one request.
    if (url.includes("/attachment/content/big-")) fetched.push(url);
    if (url.includes("/attachment/content/big-")) return new Response(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(3_600_000)]), { status: 200 });
    if (url.includes("/attachment/content/")) return new Response(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("PNGBYTES")]), { status: 200 });
    if (url.endsWith("/attachments") && method === "POST" && init?.body instanceof FormData) {
      const file = init.body.get("file") as File;
      const bytes = Buffer.from(await file.arrayBuffer());
      const id = `up-${uploaded.size + 1}`;
      uploaded.set(id, bytes);
      const attachment = { id, filename: file.name, mimeType: "text/markdown", size: bytes.length, created: new Date().toISOString(), content: `https://example.atlassian.net/rest/api/2/attachment/content/${id}`, author: { accountId: "bot-1" } };
      issue = { ...issue, fields: { ...(issue.fields as object), attachment: [...(((issue.fields as { attachment?: unknown[] }).attachment) ?? []), attachment] } };
      return json([attachment]);
    }
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
  fetched = [];
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-board-"));
  vault = new Vault(path.join(tmpRoot, "vault"));
  await vault.ensure();
  comments = [];
  failRevisionPosts = false;
  failNextPostContaining = undefined;
  staleSearch = undefined;
  afterPost = undefined;
  uploaded = new Map();
  moves = [];
  changelog = [];
  assignments = [];
  vi.mocked(generateText).mockClear();
  // A test that fails before putting the stub back must not hand the next one its draft.
  vi.mocked(generateText).mockImplementation(async () => CLEAN_DRAFT);
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
  await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5 });
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

  it("a push retry never sends a vault note edited after its approval", async () => {
    // Published, push not done yet: the next `approve` is a push-only retry. Between the two,
    // the vault repo's sync rewrote the note. That text was never approved.
    const settings = config();
    const relPath = "docs/incident-timeline-embed.md";
    await vault.writeNote(relPath, "## Overview\n\nEmbed the incident timeline.\n", { jira_issue: "DOC-1" });
    const approvedHash = createHash("sha256").update((await vault.readNote(relPath)).body.trim()).digest("hex");
    await fs.mkdir(path.join(settings.jira.stateDir, "drafts"), { recursive: true });
    await fs.writeFile(path.join(settings.jira.stateDir, "drafts", "DOC-1.md"), CLEAN_DRAFT);
    await fs.writeFile(
      path.join(settings.jira.stateDir, "jira-state.json"),
      JSON.stringify({
        version: 1,
        issues: {
          "DOC-1": {
            hasDraft: true,
            docSlug: "incident-timeline-embed",
            publishedPath: relPath,
            publishedBodyHash: approvedHash,
            docsPushed: false,
            lastStatus: "In Review",
            sourceFingerprint: "seeded",
            processedComments: [],
          },
        },
      }),
    );
    await vault.writeNote(relPath, "## Overview\n\nEmbed the incident timeline. Also: free for everyone, forever.\n", { jira_issue: "DOC-1" });
    issue = { ...issue, fields: { ...(issue.fields as object), status: { name: "In Review" } } };

    comments.push(human("h1", "approve"));
    const held = await startScribeJira(settings, vault);
    held.stop();
    expect(comments.at(-1)?.body).toContain("changed after it was approved");
    expect(comments.some((comment) => comment.body.includes("retrying the docs-repo push only"))).toBe(false);

    // The approved text back in place: the retry goes ahead.
    await vault.writeNote(relPath, "## Overview\n\nEmbed the incident timeline.\n", { jira_issue: "DOC-1" });
    comments.push(human("h2", "approve"));
    issue = { ...issue, fields: { ...(issue.fields as object), updated: "2026-08-20T16:00:00.000+0000" } };
    const retried = await startScribeJira(settings, vault);
    retried.stop();
    expect(comments.some((comment) => comment.body.includes("retrying the docs-repo push only"))).toBe(true);
  });

  it("a ticket with no recorded approved body republishes from the approved draft, not the vault copy", async () => {
    // State rebuilt after a lost ledger (or written before the hash existed): published, push
    // not done, and nothing to check the vault copy against. It must not be pushed as is.
    const settings = config();
    const relPath = "docs/incident-timeline-embed.md";
    await vault.writeNote(relPath, "## Overview\n\nFree for everyone, forever.\n", { jira_issue: "DOC-1" });
    await fs.mkdir(path.join(settings.jira.stateDir, "drafts"), { recursive: true });
    await fs.writeFile(path.join(settings.jira.stateDir, "drafts", "DOC-1.md"), CLEAN_DRAFT);
    await fs.writeFile(
      path.join(settings.jira.stateDir, "jira-state.json"),
      JSON.stringify({
        version: 1,
        issues: {
          "DOC-1": {
            hasDraft: true,
            docSlug: "incident-timeline-embed",
            publishedPath: relPath,
            docsPushed: false,
            postedDraftHash: createHash("sha256").update(CLEAN_DRAFT.trim()).digest("hex"),
            lastStatus: "In Review",
            sourceFingerprint: "seeded",
            processedComments: [],
          },
        },
      }),
    );
    issue = { ...issue, fields: { ...(issue.fields as object), status: { name: "In Review" } } };
    comments.push(human("h1", "approve"));
    const run = await startScribeJira(settings, vault);
    run.stop();
    expect(comments.some((comment) => comment.body.includes("retrying the docs-repo push only"))).toBe(false);
    const published = await vault.readNote(relPath);
    expect(published.body).not.toContain("Free for everyone");
    expect(published.body).toContain("## Overview");
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
        // The draft on disk is the one on the ticket.
        "DOC-1": { hasDraft: true, docSlug: "incident-timeline-embed", sourceFingerprint: "seeded", processedComments: [], lastStatus: "In Review", lastUpdated: "2026-08-20T10:00:00.000+0000", postedDraftHash: createHash("sha256").update(CLEAN_DRAFT.trim()).digest("hex") },
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

  it("a drag to Approved made while a revise runs is neither swallowed nor taken as approving the revision", async () => {
    const settings = config();
    (await startScribeJira(settings, vault)).stop();
    // The reviewer drags the ticket, having read the FIRST draft, just as the revision lands
    // (after the agent's own last move of the tick).
    vi.mocked(generateText).mockImplementationOnce(async () => `${CLEAN_DRAFT}\n3. Paste the snippet into your page.`);
    afterPost = {
      text: "Revised draft",
      run: () => {
        issue = { ...issue, fields: { ...(issue.fields as object), status: { name: "Done" } } };
        changelog.push({ author: { displayName: "Reviewer", accountId: "human-1" }, created: new Date(Date.now() - 1000).toISOString(), items: [{ field: "status", toString: "Done" }] } as never);
      },
    };
    comments.push(human("f1", "add the paste step"));
    issue = { ...issue, fields: { ...(issue.fields as object), updated: new Date(Date.now() + 1000).toISOString() } };
    (await startScribeJira(settings, vault)).stop();

    // Next poll: the drag is seen, and it predates the revision, so it is held and said.
    issue = { ...issue, fields: { ...(issue.fields as object), updated: new Date(Date.now() + 2000).toISOString() } };
    (await startScribeJira(settings, vault)).stop();
    expect(await vault.listNotes("docs")).toHaveLength(0);
    expect(comments.some((comment) => comment.body.includes("one you haven't seen yet"))).toBe(true);
    expect(status()).toBe("In Review");

    // A drag made after reading the revision publishes it.
    issue = { ...issue, fields: { ...(issue.fields as object), status: { name: "Done" }, updated: new Date(Date.now() + 5000).toISOString() } };
    changelog.push({ author: { displayName: "Reviewer", accountId: "human-1" }, created: new Date(Date.now() + 5000).toISOString(), items: [{ field: "status", toString: "Done" }] } as never);
    (await startScribeJira(settings, vault)).stop();
    const [doc] = await vault.listNotes("docs");
    expect((await vault.readNote(doc as string)).body).toContain("Paste the snippet into your page.");
  });

  it("a drag to Approved during the model call is not undone by the agent's own move, and is then judged", async () => {
    const settings = config();
    (await startScribeJira(settings, vault)).stop();
    // The reviewer drags it while the model is still revising (before the agent's own moves).
    vi.mocked(generateText).mockImplementationOnce(async () => {
      issue = { ...issue, fields: { ...(issue.fields as object), status: { name: "Done" } } };
      changelog.push({ author: { displayName: "Reviewer", accountId: "human-1" }, created: new Date(Date.now() - 1000).toISOString(), items: [{ field: "status", toString: "Done" }] } as never);
      return `${CLEAN_DRAFT}\n3. Paste the snippet into your page.`;
    });
    comments.push(human("f1", "add the paste step"));
    issue = { ...issue, fields: { ...(issue.fields as object), updated: new Date(Date.now() + 1000).toISOString() } };
    const movesBefore = moves.length;
    (await startScribeJira(settings, vault)).stop();
    // The agent left the human's column alone.
    expect(moves.slice(movesBefore)).not.toContain("In Review");
    expect(status()).toBe("Done");

    // Next poll judges the drag: it predates the revision, so it is held, said, and put back.
    issue = { ...issue, fields: { ...(issue.fields as object), updated: new Date(Date.now() + 2000).toISOString() } };
    (await startScribeJira(settings, vault)).stop();
    expect(await vault.listNotes("docs")).toHaveLength(0);
    expect(comments.some((comment) => comment.body.includes("one you haven't seen yet"))).toBe(true);
    expect(status()).toBe("In Review");
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

  it("a column a person picks while it drafts stays theirs", async () => {
    // The PM closes it as Won't Do mid-draft: the agent's In Progress / In Review moves would
    // pull it back onto the board and into the poller's query.
    vi.mocked(generateText).mockImplementationOnce(async () => {
      issue = { ...issue, fields: { ...(issue.fields as object), status: { name: "Won't Do" } } };
      return CLEAN_DRAFT;
    });
    const movesBefore = moves.length;
    (await startScribeJira(config(), vault)).stop();
    expect(moves.slice(movesBefore)).not.toContain("In Review");
    expect(status()).toBe("Won't Do");
  });

  it("a ticket a person put in In Progress before asking for a draft still goes to In Review", async () => {
    (await startScribeJira(config(), vault)).stop();
    expect(status()).toBe("In Review");
    comments.push(human("h-redraft", "draft"));
    issue = { ...issue, fields: { ...(issue.fields as object), status: { name: "In Progress" }, updated: "2026-08-21T10:00:00.000+0000" } };
    (await startScribeJira(config(), vault)).stop();
    expect(status()).toBe("In Review");
  });

  it("after a lost ledger, a ticket where it only answered `help` is not taken for one it drafts", async () => {
    // Unlabelled: mention-only. Someone typed `help`, and it answered.
    issue = { ...issue, fields: { ...(issue.fields as object), labels: [] } };
    comments.push(human("h-help", "help"), { id: "bot-help", body: "Here is what I understand: …", created: new Date().toISOString(), author: { accountId: "bot-1", displayName: "Scribe" } });
    await fs.rm(path.join(tmpRoot, "state"), { recursive: true, force: true });
    comments.push(human("h-chat", "the intro of the PRD needs work before anyone drafts this"));
    const movesBefore = moves.length;
    const calls = vi.mocked(generateText).mock.calls.length;
    (await startScribeJira(config(), vault)).stop();
    // Conversation, not feedback: nothing drafted, nothing moved, nothing taken.
    expect(vi.mocked(generateText).mock.calls.length).toBe(calls);
    expect(moves.slice(movesBefore)).toEqual([]);
    expect(assignments).toEqual([]);
  });

  it("after a lost ledger, a published ticket isn't told its draft never reached it", async () => {
    (await startScribeJira(config(), vault)).stop();
    comments.push(human("h-ok", "approve"));
    issue = { ...issue, fields: { ...(issue.fields as object), updated: "2026-08-21T10:00:00.000+0000" } };
    (await startScribeJira(config(), vault)).stop();
    expect(await vault.listNotes("docs")).toHaveLength(1);
    await fs.rm(path.join(tmpRoot, "state"), { recursive: true, force: true });
    const before = comments.length;
    (await startScribeJira(config(), vault)).stop();
    expect(comments.slice(before).filter((comment) => comment.body.includes("posted again"))).toEqual([]);
  });

  it("a fingerprint from before the description was hashed is brought up to date, so a same-length edit is then seen", async () => {
    const settings = config();
    const description = (issue.fields as { description: string }).description;
    await fs.mkdir(settings.jira.stateDir, { recursive: true });
    // Recorded before the upgrade: the description's length, not its words.
    await fs.writeFile(
      path.join(settings.jira.stateDir, "jira-state.json"),
      JSON.stringify({ version: 1, issues: { "DOC-1": { processedComments: [], lastStatus: "To Do", lastUpdated: "2026-08-19T10:00:00.000+0000", sourceFingerprint: `|${description.trim().length}|` } } }),
    );
    (await startScribeJira(settings, vault)).stop();
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
    // The same length, different words: a new source.
    issue = { ...issue, fields: { ...(issue.fields as object), description: description.replace("admins", "ADMINS"), updated: "2026-08-21T10:00:00.000+0000" } };
    (await startScribeJira(settings, vault)).stop();
    expect(vi.mocked(generateText)).toHaveBeenCalled();
  });

  it("after a lost ledger, a recovery whose first lookup failed still runs on the next tick", async () => {
    (await startScribeJira(config(), vault)).stop();
    const calls = vi.mocked(generateText).mock.calls.length;
    const drafts = () => ((issue.fields as { attachment?: Array<{ filename: string }> }).attachment ?? []).filter((attachment) => attachment.filename.startsWith("draft-")).length;
    const attached = drafts();
    // Long since uploaded: nothing on the ticket is still arriving.
    issue = { ...issue, fields: { ...(issue.fields as object), attachment: ((issue.fields as { attachment?: object[] }).attachment ?? []).map((attachment) => ({ ...attachment, created: "2026-08-20T09:00:00.000+0000" })) } };
    await fs.rm(path.join(tmpRoot, "state"), { recursive: true, force: true });
    // The other agents' accounts can't be read this time (the Teammate is down).
    (await startScribeJira(config(), vault, { otherAgentIds: async () => { throw new Error("teammate unreachable"); } })).stop();
    (await startScribeJira(config(), vault)).stop();
    // Recovered from the ticket: its draft is known, so it isn't drafted again.
    expect(vi.mocked(generateText).mock.calls.length).toBe(calls);
    expect(drafts()).toBe(attached);
  });

  it("after a lost ledger, a recovery that failed halfway is begun again on the next tick", async () => {
    (await startScribeJira(config(), vault)).stop();
    const calls = vi.mocked(generateText).mock.calls.length;
    issue = { ...issue, fields: { ...(issue.fields as object), attachment: ((issue.fields as { attachment?: object[] }).attachment ?? []).map((attachment) => ({ ...attachment, created: "2026-08-20T09:00:00.000+0000" })) } };
    await fs.rm(path.join(tmpRoot, "state"), { recursive: true, force: true });
    // Seeded, then marking the old comments done fails.
    const mark = vi.spyOn(JiraState.prototype, "markProcessed").mockRejectedValueOnce(new Error("disk full"));
    try {
      (await startScribeJira(config(), vault)).stop();
    } finally {
      mark.mockRestore();
    }
    (await startScribeJira(config(), vault)).stop();
    expect(vi.mocked(generateText).mock.calls.length).toBe(calls);
  });

  it("a first sight that failed after showing its draft doesn't repost it as never having landed", async () => {
    // The draft is posted and recorded; the write that closes first sight fails.
    const original = JiraState.prototype.patch;
    let failed = false;
    const patch = vi.spyOn(JiraState.prototype, "patch").mockImplementation(async function (this: never, key: string, values: object) {
      if (!failed && "adopting" in values && "lastUpdated" in values) {
        failed = true;
        throw new Error("disk full");
      }
      return original.call(this, key, values as never);
    });
    try {
      (await startScribeJira(config(), vault)).stop();
    } finally {
      patch.mockRestore();
    }
    (await startScribeJira(config(), vault)).stop();
    expect(comments.filter((comment) => comment.body.includes("posted again"))).toHaveLength(0);
  });

  it("a greeting whose response was lost is followed by the draft, on the next tick", async () => {
    loseNextCommentResponse = true;
    (await startScribeJira(config(), vault)).stop();
    expect(comments.some((comment) => comment.body.includes("Draft ready"))).toBe(false);
    (await startScribeJira(config(), vault)).stop();
    expect(comments.some((comment) => comment.body.includes("Draft ready"))).toBe(true);
  });

  it("hands a ticket back when the holder can't be read, and keeps who to give it to when the assign fails", async () => {
    const { handBack } = await import("@scriptorium/agents");
    const assigned: Array<string | null> = [];
    const patches: object[] = [];
    let failAssign = false;
    const ctx = {
      botAccountId: "bot-1",
      client: {
        getIssue: async () => { throw new Error("jira 503"); },
        assign: async (_key: string, accountId: string | null) => { if (failAssign) throw new Error("jira 503"); assigned.push(accountId); },
      },
      state: { get: () => known, patch: async (_key: string, values: object) => patches.push(values) },
    };
    let known: object = {};
    const issue = { key: "DOC-9", fields: { assignee: { accountId: "writer-1" }, reporter: { accountId: "pm-1" } } };
    // Never taken (a "no PRD" reply on a writer's ticket): it stays with the writer.
    await handBack(ctx as never, "DOC-9", issue as never);
    expect(assigned).toEqual([]);
    // Taken: recorded as held by the take itself.
    const { takeTicket } = await import("@scriptorium/agents");
    await takeTicket({ ...ctx, client: { ...ctx.client, assign: async () => undefined } } as never, "DOC-9", issue as never);
    expect(patches).toContainEqual({ held: true });
    // And then the snapshot predates the take and shows the writer, while the agent holds it.
    known = { handBackTo: "writer-1", held: true };
    await handBack(ctx as never, "DOC-9", issue as never);
    expect(assigned).toEqual(["writer-1"]);
    failAssign = true;
    patches.length = 0;
    await handBack(ctx as never, "DOC-9", issue as never);
    expect(patches).toEqual([]);
  });

  it("a ticket whose column the agent can't place is not moved: it knows nothing, so it moves nothing", async () => {
    const { moveTo } = await import("@scriptorium/agents");
    const transitionTo = vi.fn(async () => true);
    const ctx = {
      config: { jira: { approvedStatus: "Approved" } },
      client: { getIssue: async () => ({ fields: { status: { name: "Approved" } } }), transitionTo },
      state: { get: () => ({}), patch: async () => ({}) },
    };
    // No status seen and none recorded (an older ledger): a drag to Approved stays put.
    await moveTo(ctx as never, "DOC-9", "In Review");
    expect(transitionTo).not.toHaveBeenCalled();
  });

  it("a ticket already in the column the agent wanted is recorded there, so its next move goes ahead", async () => {
    const { moveTo } = await import("@scriptorium/agents");
    const patches: object[] = [];
    const ctx = {
      config: { jira: { approvedStatus: "Approved" } },
      client: { getIssue: async () => ({ fields: { status: { name: "In Progress" } } }), transitionTo: vi.fn(async () => true) },
      state: { get: () => ({ lastStatus: "To Do" }), patch: async (_key: string, values: object) => patches.push(values) },
    };
    // Seen in To Do; a person had moved it on to In Progress since.
    await moveTo(ctx as never, "DOC-9", "In Progress", "To Do");
    expect(patches).toEqual([{ lastStatus: "In Progress" }]);
  });

  it("hands the ticket back to whoever had it before, not always to its reporter", async () => {
    issue = { ...issue, fields: { ...(issue.fields as object), assignee: { accountId: "writer-1", displayName: "Writer" } } };
    (await startScribeJira(config(), vault)).stop();
    expect(assignments).toEqual(["bot-1", "writer-1"]);
  });

  it("leaves a ticket it never took with the writer who holds it", async () => {
    // No PRD: it replies and never takes the ticket, so the writer on it keeps it.
    issue = { ...issue, fields: { ...(issue.fields as object), description: "", assignee: { accountId: "writer-1", displayName: "Writer" } } };
    (await startScribeJira(config(), vault)).stop();
    expect(comments.some((comment) => /PRD/.test(comment.body))).toBe(true);
    expect(assignments).toEqual([]);
  });

  it("a person who takes the ticket while it drafts keeps it", async () => {
    vi.mocked(generateText).mockImplementationOnce(async () => {
      issue = { ...issue, fields: { ...(issue.fields as object), assignee: { accountId: "writer-2", displayName: "Writer Two" } } };
      return CLEAN_DRAFT;
    });
    (await startScribeJira(config(), vault)).stop();
    expect(assignments).toEqual(["bot-1"]);
    expect((issue.fields as { assignee?: { accountId: string } }).assignee?.accountId).toBe("writer-2");
  });

  it("a writer who unassigned themselves isn't handed the ticket again on a later revision", async () => {
    issue = { ...issue, fields: { ...(issue.fields as object), assignee: { accountId: "writer-1", displayName: "Writer" } } };
    (await startScribeJira(config(), vault)).stop();
    expect(assignments).toEqual(["bot-1", "writer-1"]);
    issue = { ...issue, fields: { ...(issue.fields as object), assignee: null, updated: "2026-08-21T10:00:00.000+0000" } };
    comments.push(human("h-fb", "make the intro shorter"));
    (await startScribeJira(config(), vault)).stop();
    // Taken from nobody, so given back to the reporter.
    expect(assignments.slice(2)).toEqual(["bot-1", "human-1"]);
  });

  it("a ticket given back once isn't given to the same person again by a reply that never took it", async () => {
    issue = { ...issue, fields: { ...(issue.fields as object), assignee: { accountId: "writer-1", displayName: "Writer" } } };
    (await startScribeJira(config(), vault)).stop();
    expect(assignments).toEqual(["bot-1", "writer-1"]);
    // The writer steps off and the PRD goes; asked to draft again, it can only say what's missing.
    issue = { ...issue, fields: { ...(issue.fields as object), assignee: null, description: "", updated: "2026-08-21T10:00:00.000+0000" } };
    await fs.rm(path.join(tmpRoot, "state", "drafts"), { recursive: true, force: true });
    comments.push(human("h-redraft", "draft"));
    (await startScribeJira(config(), vault)).stop();
    expect(assignments.slice(2)).not.toContain("writer-1");
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

  it("a second caller holding a view from before the first one's work doesn't answer the same drag again", async () => {
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
    // The poller and the webhook each take a view of the drag before either has the lock.
    const view = issue;
    (await startScribeJira(settings, vault)).stop();
    expect(comments.at(-1)?.body).toContain("haven't seen yet");
    expect(status()).toBe("In Review");
    const answered = comments.length;
    // The second caller, with the view from before the first one's work.
    staleSearch = view;
    (await startScribeJira(settings, vault)).stop();
    expect(comments.length).toBe(answered);
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

describe("webhook nudges", () => {
  it("a nudge for a ticket the poller wouldn't work does nothing: not read, not handled", async () => {
    const handle = await startScribeJira(config(), vault);
    handle.stop();
    const before = comments.length;
    fetched = [];
    await handle.nudge("HR-9");
    expect(fetched.some((url) => url.includes('key = "HR-9"'))).toBe(true);
    expect(fetched.some((url) => /\/issue\/HR-9/.test(url))).toBe(false);
    expect(comments.length).toBe(before);
  });

  it("concurrent work on one ticket runs one at a time, however the callers interleave", async () => {
    const { withIssueLock } = await import("@scriptorium/agents");
    const ctx = { locks: new Map<string, Promise<unknown>>() } as never;
    let running = 0;
    let most = 0;
    const work = (ms: number) => async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, ms));
      running -= 1;
    };
    // A tick; two webhook nudges; a nudge from its own reply once the first finished; the
    // next tick while that one runs. The old lock let the last two run side by side.
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const runs: Array<Promise<unknown>> = [withIssueLock(ctx, "DOC-1", work(40))];
    await sleep(4);
    runs.push(withIssueLock(ctx, "DOC-1", work(40)));
    await sleep(4);
    runs.push(withIssueLock(ctx, "DOC-1", work(40)));
    await sleep(80);
    runs.push(withIssueLock(ctx, "DOC-1", work(120)));
    await sleep(60);
    runs.push(withIssueLock(ctx, "DOC-1", work(40)));
    await Promise.all(runs);
    expect(most).toBe(1);
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
    issue = { ...issue, key: "DOC-2", id: "2", fields: { ...(issue.fields as object), summary: "Document digest emails", status: { name: "To Do" }, attachment: [], updated: "2026-08-21T09:00:00.000+0000" } };
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

  it("feedback waiting for its lesson is held with who wrote it", async () => {
    vi.mocked(generateText).mockImplementation(async () => CLEAN_DRAFT);
    const settings = config();
    (await startScribeJira(settings, vault)).stop();
    comments.push(human("f1", "always state which timezone the send time uses"));
    issue = { ...issue, fields: { ...(issue.fields as object), updated: "2026-08-20T13:00:00.000+0000" } };
    (await startScribeJira(settings, vault)).stop();
    const state = JSON.parse(await fs.readFile(path.join(settings.jira.stateDir, "jira-state.json"), "utf8"));
    expect(state.issues["DOC-1"]).toMatchObject({ feedback: ["always state which timezone the send time uses"], feedbackAuthors: ["human-1"] });
  });

  it("`approve` and `approve lesson` in one poll: the rule the publish just proposed, which nobody read, stays a proposal", async () => {
    const { DISTILL_SYSTEM_PROMPT, listLessons } = await import("@scriptorium/scribe");
    vi.mocked(generateText).mockImplementation(async (options: GenerateOptions) => (options.system === DISTILL_SYSTEM_PROMPT ? `LESSON: ${RULE}` : CLEAN_DRAFT));
    const settings = config();
    (await startScribeJira(settings, vault)).stop();
    comments.push(human("f1", "always state which timezone the send time uses"));
    issue = { ...issue, fields: { ...(issue.fields as object), updated: "2026-08-20T13:00:00.000+0000" } };
    (await startScribeJira(settings, vault)).stop();
    comments.push(human("a1", "approve"), human("a2", "approve lesson"));
    issue = { ...issue, fields: { ...(issue.fields as object), updated: "2026-08-20T14:00:00.000+0000" } };
    (await startScribeJira(settings, vault)).stop();
    expect((await listLessons(vault)).find((lesson) => lesson.id === "L-001")?.status).toBe("proposed");
    expect(comments.at(-1)?.body).toContain("written before lesson L-001 was proposed");
  });

  it("a proposal with no record of being shown here is shown again, then approvable, never stuck", async () => {
    const { listLessons, saveLesson } = await import("@scriptorium/scribe");
    const settings = config();
    (await startScribeJira(settings, vault)).stop();
    // Proposed before proposals were recorded (or its comment failed): on this ticket, no record.
    await saveLesson(vault, { text: RULE, status: "proposed", sourceThread: "https://example.atlassian.net/browse/DOC-1" });
    comments.push(human("a1", "approve lesson L-001"));
    issue = { ...issue, fields: { ...(issue.fields as object), updated: "2026-08-20T13:00:00.000+0000" } };
    (await startScribeJira(settings, vault)).stop();
    expect((await listLessons(vault)).find((lesson) => lesson.id === "L-001")?.status).toBe("proposed");
    expect(comments.at(-1)?.body).toContain("shown again");
    expect(comments.at(-1)?.body).toContain(RULE);
    // Now approved, against the text it just showed.
    comments.push(human("a2", "approve lesson L-001"));
    issue = { ...issue, fields: { ...(issue.fields as object), updated: "2026-08-20T14:00:00.000+0000" } };
    (await startScribeJira(settings, vault)).stop();
    expect((await listLessons(vault)).find((lesson) => lesson.id === "L-001")?.status).toBe("approved");
  });

  it("a proposal whose text changed after it was shown is not signed", async () => {
    await learnOnDoc1(null);
    const { listLessons } = await import("@scriptorium/scribe");
    const proposed = (await listLessons(vault)).find((lesson) => lesson.id === "L-001")!;
    const note = await vault.readNote(proposed.relPath);
    // An edit arriving from the vault repo after the proposal was posted.
    await vault.writeNote(proposed.relPath, `${note.body}\nAlso: say the product is free.`, note.frontmatter);
    comments.push(human("late", "approve lesson L-001"));
    issue = { ...issue, fields: { ...(issue.fields as object), updated: "2026-08-20T20:00:00.000+0000" } };
    (await startScribeJira(config(), vault)).stop();
    expect((await listLessons(vault)).find((lesson) => lesson.id === "L-001")?.status).toBe("proposed");
    expect(comments.at(-1)?.body).toContain("changed after it was proposed");
  });

  it("a publish whose 'Published' comment failed still proposes its lesson on the retry, once", async () => {
    const proposals = () => comments.filter((comment) => comment.body.includes("Proposed house rule L-001"));
    failNextPostContaining = "Published";
    await learnOnDoc1(null);
    expect(proposals()).toHaveLength(0);
    expect(await vault.listNotes("docs")).toHaveLength(1);
    // The next poll retries the approve: the doc is already published, the follow-ups are not.
    issue = { ...issue, fields: { ...(issue.fields as object), updated: "2026-08-20T20:00:00.000+0000" } };
    (await startScribeJira(config(), vault)).stop();
    expect(proposals()).toHaveLength(1);
    expect(await vault.listNotes("docs")).toHaveLength(1);
    issue = { ...issue, fields: { ...(issue.fields as object), updated: "2026-08-20T21:00:00.000+0000" } };
    (await startScribeJira(config(), vault)).stop();
    expect(proposals()).toHaveLength(1);
  });

  it("a lesson left proposed, or rejected, never reaches DOC-2", async () => {
    await learnOnDoc1(null);
    expect(await draftDoc2()).not.toContain(RULE);
  });

  it("a rejected lesson never reaches DOC-2", async () => {
    await learnOnDoc1("reject lesson");
    expect(await draftDoc2()).not.toContain(RULE);
  });

  it("a revoked rule stays revoked when the vault brings back its signed, approved copy", async () => {
    const { listLessons } = await import("@scriptorium/scribe");
    await learnOnDoc1("approve lesson");
    const approved = (await listLessons(vault)).find((lesson) => lesson.id === "L-001")!;
    const signedCopy = await vault.readNote(approved.relPath);
    comments.push(human("rv", "revoke lesson L-001"));
    issue = { ...issue, fields: { ...(issue.fields as object), updated: "2026-08-20T21:00:00.000+0000" } };
    (await startScribeJira(config(), vault)).stop();
    expect((await vault.readNote(approved.relPath)).frontmatter.approval_sig).toBeUndefined();
    // A boot restore (or a revert on the vault branch) writes the approved copy back.
    await vault.writeNote(approved.relPath, signedCopy.body, signedCopy.frontmatter);
    expect(await draftDoc2()).not.toContain(RULE);
  });
});

describe("designs the model cannot take", () => {
  it("a PDF named .png is left out and named, never sent as an image; an oversized PRD file is too", async () => {
    const { sniffImage } = await import("@scriptorium/agents");
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]))).toBe("image/png");
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImage(Buffer.from("GIF89a...."))).toBe("image/gif");
    expect(sniffImage(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImage(Buffer.from("%PDF-1.7"))).toBeUndefined();

    const fake = { id: "att-fake", filename: "flow.png", mimeType: "image/png", size: 30_000, content: "https://example.atlassian.net/rest/api/2/attachment/content/fake-png" };
    const real = { id: "att-real", filename: "form.png", mimeType: "image/png", size: 30_000, content: "https://example.atlassian.net/rest/api/2/attachment/content/att-real" };
    const bigPrd = { id: "att-prd", filename: "prd-export.md", mimeType: "text/markdown", size: 5_000_000, content: "https://example.atlassian.net/rest/api/2/attachment/content/att-prd" };
    issue = { ...issue, fields: { ...(issue.fields as object), attachment: [fake, real, bigPrd] } };
    (await startScribeJira(config(), vault)).stop();
    const draft = comments.find((comment) => comment.body.includes("Draft ready"));
    expect(draft?.body).toContain("flow.png (named as an image, but it isn't one)");
    expect(draft?.body).toContain("prd-export.md (over 200 KB");
    // The draft went ahead from the description, with the one real design.
    const call = vi.mocked(generateText).mock.calls.at(-1)?.[0] as GenerateOptions & { images?: Array<{ mediaType: string }> };
    expect(call.images?.map((image) => image.mediaType)).toEqual(["image/png"]);
  });

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

describe("which PRD and which design", () => {
  it("an oversized newest PRD is refused, and the older one it replaced is not read instead", async () => {
    const md = (id: string, filename: string, created: string, size: number) => ({ id, filename, mimeType: "text/markdown", size, created, content: `https://example.atlassian.net/rest/api/2/attachment/content/${id}` });
    issue = { ...issue, fields: { ...(issue.fields as object), description: "", attachment: [md("prd-v1", "prd-v1.md", "2026-08-20T08:00:00.000+0000", 900), md("prd-v2", "prd-v2.md", "2026-08-20T09:00:00.000+0000", 900_000)] } };
    (await startScribeJira(config(), vault)).stop();
    const said = comments.map((comment) => comment.body).join("\n");
    expect(said).toContain("prd-v1.md (older than prd-v2.md, which replaced it, so not read)");
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
  });

  it("a PM's PRD named `draft-….md` is a PRD; only the agent's own draft file is skipped", async () => {
    const theirs = { id: "pm-draft", filename: "draft-incident-timeline-prd.md", mimeType: "text/markdown", size: 900, created: "2026-08-20T09:00:00.000+0000", content: "https://example.atlassian.net/rest/api/2/attachment/content/pm-draft", author: { accountId: "pm-1" } };
    issue = { ...issue, fields: { ...(issue.fields as object), description: "", attachment: [theirs] } };
    (await startScribeJira(config(), vault)).stop();
    expect(comments.map((comment) => comment.body).join("\n")).not.toMatch(/can't find a PRD/i);
  });

  it("two uploads of one design name: the vault keeps the newest", async () => {
    const design = (version: string, created: string) => ({ id: `design-${version}`, filename: "wireframe.png", mimeType: "image/png", size: 12, created, content: `https://example.atlassian.net/rest/api/2/attachment/content/design-${version}` });
    issue = { ...issue, fields: { ...(issue.fields as object), attachment: [design("v1", "2026-08-20T08:00:00.000+0000"), design("v2", "2026-08-20T09:00:00.000+0000")] } };
    (await startScribeJira(config(), vault)).stop();
    const stored = (await vault.listNotes()).length >= 0 ? await fs.readdir(vault.abs("design")).catch(() => [] as string[]) : [];
    const where = stored.includes("wireframe.png") ? "design/wireframe.png" : "_inbox/wireframe.png";
    expect((await fs.readFile(vault.abs(where))).subarray(8).toString()).toBe("v2");
  });
});

describe("designs that fit one request", () => {
  it("near-cap designs stop at the total one draft can take; the rest are named, and the draft goes ahead", async () => {
    const big = (n: number) => ({ id: `big-${n}`, filename: `screen-${n}.png`, mimeType: "image/png", size: 3_600_008, created: `2026-08-20T09:0${n}:00.000+0000`, content: `https://example.atlassian.net/rest/api/2/attachment/content/big-${n}` });
    issue = { ...issue, fields: { ...(issue.fields as object), attachment: [1, 2, 3, 4, 5, 6, 7].map(big) } };
    (await startScribeJira(config(), vault)).stop();
    const draftCall = vi.mocked(generateText).mock.calls[0]?.[0] as GenerateOptions;
    const sent = (draftCall.images ?? []).reduce((sum, image) => sum + Buffer.from(image.base64, "base64").length, 0);
    expect(sent).toBeLessThanOrEqual(18_000_000);
    expect(draftCall.images!.length).toBeLessThan(7);
    expect(comments.some((comment) => comment.body.includes("fill what one draft can take"))).toBe(true);
    expect(comments.some((comment) => comment.body.includes("I hit an error"))).toBe(false);
    // Once Jira's sizes say the budget is full, the rest aren't downloaded to be thrown away.
    expect(fetched.filter((url) => url.includes("/attachment/content/big-")).length).toBe(draftCall.images!.length);
  });

  it("near-cap designs whose size Jira doesn't give still stop at the total, measured as they arrive", async () => {
    const big = (n: number) => ({ id: `big-${n}`, filename: `screen-${n}.png`, mimeType: "image/png", created: `2026-08-20T09:0${n}:00.000+0000`, content: `https://example.atlassian.net/rest/api/2/attachment/content/big-${n}` });
    issue = { ...issue, fields: { ...(issue.fields as object), attachment: [1, 2, 3, 4, 5, 6, 7].map(big) } };
    (await startScribeJira(config(), vault)).stop();
    const draftCall = vi.mocked(generateText).mock.calls[0]?.[0] as GenerateOptions;
    const sent = (draftCall.images ?? []).reduce((sum, image) => sum + Buffer.from(image.base64, "base64").length, 0);
    expect(sent).toBeLessThanOrEqual(18_000_000);
  });

  it("a design that can't be downloaded is left out and named, and the draft goes ahead", async () => {
    const gone = { id: "missing-1", filename: "deleted.png", mimeType: "image/png", size: 30, created: "2026-08-20T09:00:00.000+0000", content: "https://example.atlassian.net/rest/api/2/attachment/content/missing-1" };
    issue = { ...issue, fields: { ...(issue.fields as object), attachment: [gone] } };
    (await startScribeJira(config(), vault)).stop();
    expect(comments.some((comment) => comment.body.includes("Draft ready"))).toBe(true);
    expect(comments.some((comment) => comment.body.includes("deleted.png") && comment.body.includes("couldn't be downloaded"))).toBe(true);
  });

  it("an empty newest PRD is refused, not passed over for the version it replaced", async () => {
    const prd = (id: string, created: string) => ({ id, filename: `${id}.md`, mimeType: "text/markdown", created, content: `https://example.atlassian.net/rest/api/2/attachment/content/${id}` });
    uploaded.set("prd-v1", Buffer.from(COMPLETE_PRD));
    uploaded.set("prd-v2", Buffer.alloc(0));
    issue = { ...issue, fields: { ...(issue.fields as object), description: "", attachment: [prd("prd-v1", "2026-08-20T08:00:00.000+0000"), prd("prd-v2", "2026-08-20T09:00:00.000+0000")] } };
    (await startScribeJira(config(), vault)).stop();
    expect(comments.some((comment) => comment.body.includes("Draft ready"))).toBe(false);
    expect(comments.some((comment) => comment.body.includes("prd-v2.md (empty)"))).toBe(true);
  });

  it("follows a redirect to a relative location, from where it was asked for", async () => {
    const { JiraClient } = await import("@scriptorium/jira");
    const client = new JiraClient({ baseUrl: "https://example.atlassian.net", email: "a@b.example", apiToken: "t" } as never);
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL) => {
      asked.push(String(url));
      return asked.length === 1 ? new Response(null, { status: 302, headers: { location: "/file/abc" } }) : new Response("ok", { status: 200 });
    });
    const bytes = await client.downloadAttachment({ id: "x", filename: "x.md", mimeType: "text/markdown", content: "https://example.atlassian.net/rest/api/2/attachment/content/x" } as never);
    expect(bytes.toString()).toBe("ok");
    expect(asked[1]).toBe("https://example.atlassian.net/file/abc");
  });

  it("downloads stop at the design limit even when none of them turn out to be designs", async () => {
    const fake = (n: number) => ({ id: `fake-png-${n}`, filename: `shot-${n}.png`, mimeType: "image/png", size: 30, created: `2026-08-20T09:${String(n).padStart(2, "0")}:00.000+0000`, content: `https://example.atlassian.net/rest/api/2/attachment/content/fake-png-${n}` });
    issue = { ...issue, fields: { ...(issue.fields as object), attachment: Array.from({ length: 12 }, (_, n) => fake(n)) } };
    (await startScribeJira(config(), vault)).stop();
    expect(fetched.filter((url) => url.includes("/attachment/content/fake-png")).length).toBeLessThanOrEqual(8);
  });

  it("an attachment is refused while it downloads once it passes the cap, whatever its size said", async () => {
    const { JiraClient, AttachmentTooLargeError } = await import("@scriptorium/jira");
    const client = new JiraClient({ baseUrl: "https://example.atlassian.net", email: "a@b.example", apiToken: "t" } as never);
    const attachment = { id: "x", filename: "x.png", mimeType: "image/png", content: "https://example.atlassian.net/rest/api/2/attachment/content/x" };
    let pulled = 0;
    // 10 MB with no length declared: read whole, it is all in memory before anyone measures it.
    const large = new ReadableStream({
      pull(controller) {
        pulled += 1;
        if (pulled > 10) controller.close();
        else controller.enqueue(new Uint8Array(1_000_000));
      },
    });
    vi.stubGlobal("fetch", async () => new Response(large, { status: 200 }));
    await expect(client.downloadAttachment(attachment as never, 3_000_000)).rejects.toBeInstanceOf(AttachmentTooLargeError);
    expect(pulled).toBeLessThan(6);
    // A size the server declares is refused before reading.
    vi.stubGlobal("fetch", async () => new Response("x", { status: 200, headers: { "content-length": "99000000" } }));
    await expect(client.downloadAttachment(attachment as never, 3_000_000)).rejects.toBeInstanceOf(AttachmentTooLargeError);
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

  it("never publishes a revision that didn't reach the ticket: it posts it again and waits for an approval of that", async () => {
    const settings = config();
    (await startScribeJira(settings, vault)).stop();
    const revised = `${CLEAN_DRAFT}\n3. Paste the snippet into your page.`;
    vi.mocked(generateText).mockImplementation(async () => revised);
    failRevisionPosts = true;
    await tickWith(settings, "add the paste step");
    await tickWith(settings);
    await tickWith(settings);
    expect(comments.some((comment) => comment.body.includes("I tried that 3 times"))).toBe(true);
    failRevisionPosts = false;

    // The reviewer has only ever seen the first draft, and approves it.
    await tickWith(settings, "approve");
    expect(comments.some((comment) => comment.body.includes("*Published* —"))).toBe(false);
    expect(await vault.listNotes("docs")).toHaveLength(0);
    const again = comments.find((comment) => comment.body.includes("Draft (posted again)"));
    expect(again?.body).toContain("Paste the snippet into your page.");

    // Approving what is now on the ticket publishes exactly that.
    await tickWith(settings, "approve");
    const [doc] = await vault.listNotes("docs");
    expect(doc).toBeDefined();
    expect((await vault.readNote(doc as string)).body).toContain("Paste the snippet into your page.");
    vi.mocked(generateText).mockImplementation(async () => CLEAN_DRAFT);
  });

  it("a draft too long for one Jira comment is posted shortened, pointing at the attachment", async () => {
    const long = `${CLEAN_DRAFT}\n\n## Reference\n\n${"Every embed option is described here in full. ".repeat(900)}`;
    vi.mocked(generateText).mockImplementation(async () => long);
    const settings = config();
    (await startScribeJira(settings, vault)).stop();
    const draft = comments.find((comment) => comment.body.includes("Draft ready"));
    expect(draft).toBeDefined();
    expect(draft?.body.length).toBeLessThan(32_767);
    expect(draft?.body).toMatch(/the whole of it is attached as .{0,4}draft-incident/);
    vi.mocked(generateText).mockImplementation(async () => CLEAN_DRAFT);
  });

  it("a revise retried after its comment failed posts the revision, instead of revising it again", async () => {
    const settings = config();
    (await startScribeJira(settings, vault)).stop();
    const revised = `${CLEAN_DRAFT}\n3. Paste the snippet into your page.`;
    vi.mocked(generateText).mockImplementation(async () => revised);
    failNextPostContaining = "Revised draft";
    await tickWith(settings, "add the paste step");
    const modelCalls = vi.mocked(generateText).mock.calls.length;
    await tickWith(settings);
    // No second revise of the revision: the model wasn't asked again.
    expect(vi.mocked(generateText).mock.calls.length).toBe(modelCalls);
    // The revision's own comment, posted as it would have been: once, with the step once.
    const reposts = comments.filter((comment) => /Revised draft|posted again/.test(comment.body));
    expect(reposts).toHaveLength(1);
    expect(reposts[0]?.body).toContain("Revised draft");
    expect(reposts[0]?.body.match(/Paste the snippet into your page\./g)).toHaveLength(1);
    await tickWith(settings, "approve");
    const [doc] = await vault.listNotes("docs");
    expect((await vault.readNote(doc as string)).body).toContain("Paste the snippet into your page.");
    vi.mocked(generateText).mockImplementation(async () => CLEAN_DRAFT);
  });

  it("a revise retried with new feedback applies only the new feedback to the revision that never posted", async () => {
    const settings = config();
    (await startScribeJira(settings, vault)).stop();
    vi.mocked(generateText).mockImplementation(async () => `${CLEAN_DRAFT}\n3. Paste the snippet into your page.`);
    failNextPostContaining = "Revised draft";
    await tickWith(settings, "add the paste step");
    const before = vi.mocked(generateText).mock.calls.length;
    // The failed comment comes round again, with a new one beside it.
    await tickWith(settings, "say that only admins can do this");
    const prompts = vi.mocked(generateText).mock.calls.slice(before).map((call) => (call[0] as GenerateOptions).prompt);
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts[0]).toContain("say that only admins can do this");
    // The saved revision already has the paste step: asking for it again added it twice.
    expect(prompts.join("\n")).not.toContain("add the paste step");
    expect(comments.filter((comment) => comment.body.includes("Revised draft"))).toHaveLength(1);
    vi.mocked(generateText).mockImplementation(async () => CLEAN_DRAFT);
  });

  /** Everything lands, then marking the human's comment done fails once (a disk, a restart). */
  const failMarkingHumanCommentOnce = () => {
    const original = JiraState.prototype.markProcessed;
    let failed = false;
    return vi.spyOn(JiraState.prototype, "markProcessed").mockImplementation(async function (this: never, key: string, ids: string[], settled?: object) {
      if (!failed && ids.some((id) => !id.startsWith("bot-"))) {
        failed = true;
        throw new Error("disk full");
      }
      return original.call(this, key, ids, settled as never);
    });
  };

  it("a revision whose comment landed, retried before its feedback was marked done, is neither revised again nor said to be posted unseen", async () => {
    const settings = config();
    (await startScribeJira(settings, vault)).stop();
    vi.mocked(generateText).mockImplementation(async () => `${CLEAN_DRAFT}\n3. Paste the snippet into your page.`);
    // The revision posts and is recorded; then marking its feedback done fails.
    const mark = failMarkingHumanCommentOnce();
    try {
      await tickWith(settings, "add the paste step");
    } finally {
      mark.mockRestore();
    }
    expect(comments.filter((comment) => comment.body.includes("Revised draft"))).toHaveLength(1);
    const calls = vi.mocked(generateText).mock.calls.length;
    vi.mocked(generateText).mockImplementation(async () => `${CLEAN_DRAFT}\n3. Paste the snippet into your page.\n4. Paste it again.`);
    await tickWith(settings);
    // The feedback is in the posted revision already: no second revise, nothing reposted.
    expect(vi.mocked(generateText).mock.calls.length).toBe(calls);
    expect(comments.filter((comment) => /Revised draft|posted again/.test(comment.body))).toHaveLength(1);
    await tickWith(settings, "approve");
    const [doc] = await vault.listNotes("docs");
    expect((await vault.readNote(doc as string)).body).not.toContain("Paste it again");
    vi.mocked(generateText).mockImplementation(async () => CLEAN_DRAFT);
  });

  it("a draft written again on a retry is posted, never recorded under the earlier draft's comment", async () => {
    const settings = config();
    (await startScribeJira(settings, vault)).stop();
    vi.mocked(generateText).mockImplementation(async () => `${CLEAN_DRAFT}\n3. First take.`);
    const mark = failMarkingHumanCommentOnce();
    try {
      await tickWith(settings, "draft");
    } finally {
      mark.mockRestore();
    }
    vi.mocked(generateText).mockImplementation(async () => `${CLEAN_DRAFT}\n3. Second take.`);
    await tickWith(settings);
    // Whatever is approved next must be a draft a comment showed.
    expect(comments.some((comment) => comment.body.includes("Second take"))).toBe(true);
    await tickWith(settings, "approve");
    const [doc] = await vault.listNotes("docs");
    expect((await vault.readNote(doc as string)).body).toContain("Second take");
    vi.mocked(generateText).mockImplementation(async () => CLEAN_DRAFT);
  });

  it("a revision recorded but not saved is made again from the draft it started from, not from itself", async () => {
    const settings = config();
    (await startScribeJira(settings, vault)).stop();
    vi.mocked(generateText).mockImplementation(async () => `${CLEAN_DRAFT}\n3. Paste the snippet into your page.`);
    // Recording the revision fails: the draft it made is never saved.
    const original = JiraState.prototype.patch;
    let failed = false;
    const patch = vi.spyOn(JiraState.prototype, "patch").mockImplementation(async function (this: never, key: string, values: object) {
      if (!failed && "revision" in values) {
        failed = true;
        throw new Error("disk full");
      }
      return original.call(this, key, values as never);
    });
    try {
      await tickWith(settings, "add the paste step");
    } finally {
      patch.mockRestore();
    }
    const before = vi.mocked(generateText).mock.calls.length;
    await tickWith(settings);
    const retried = vi.mocked(generateText).mock.calls.slice(before).map((call) => (call[0] as GenerateOptions).prompt);
    expect(retried[0]).toContain("add the paste step");
    // Revised from the first draft: the step isn't there yet to be added twice.
    expect(retried[0]).not.toContain("Paste the snippet into your page.");
  });

  it("a revision posted after a first draft that never landed is not posted a second time", async () => {
    const settings = config();
    failNextPostContaining = "Draft ready";
    (await startScribeJira(settings, vault)).stop();
    vi.mocked(generateText).mockImplementation(async () => `${CLEAN_DRAFT}\n3. Paste the snippet into your page.`);
    await tickWith(settings, "add the paste step");
    expect(comments.filter((comment) => comment.body.includes("Revised draft"))).toHaveLength(1);
    expect(comments.filter((comment) => comment.body.includes("posted again"))).toHaveLength(0);
    vi.mocked(generateText).mockImplementation(async () => CLEAN_DRAFT);
  });

  it("a revision whose comment landed but wasn't recorded is not posted a second time", async () => {
    const settings = config();
    (await startScribeJira(settings, vault)).stop();
    vi.mocked(generateText).mockImplementation(async () => `${CLEAN_DRAFT}\n3. Paste the snippet into your page.`);
    // The comment lands; recording that it did fails.
    const original = JiraState.prototype.patch;
    let failed = false;
    const patch = vi.spyOn(JiraState.prototype, "patch").mockImplementation(async function (this: never, key: string, values: object) {
      if (!failed && "postedDraftHash" in values) {
        failed = true;
        throw new Error("disk full");
      }
      return original.call(this, key, values as never);
    });
    try {
      await tickWith(settings, "add the paste step");
    } finally {
      patch.mockRestore();
    }
    await tickWith(settings);
    expect(comments.filter((comment) => /Revised draft|posted again/.test(comment.body))).toHaveLength(1);
  });

  it("a published doc's revision is published on approval, even when recording the revision failed once", async () => {
    const settings = config();
    (await startScribeJira(settings, vault)).stop();
    await tickWith(settings, "approve");
    expect(await vault.listNotes("docs")).toHaveLength(1);
    vi.mocked(generateText).mockImplementation(async () => `${CLEAN_DRAFT}\n3. Paste the snippet into your page.`);
    const original = JiraState.prototype.patch;
    let failed = false;
    const patch = vi.spyOn(JiraState.prototype, "patch").mockImplementation(async function (this: never, key: string, values: object) {
      if (!failed && "draftPublished" in values && (values as { draftPublished?: boolean }).draftPublished === false) {
        failed = true;
        throw new Error("disk full");
      }
      return original.call(this, key, values as never);
    });
    try {
      await tickWith(settings, "add the paste step");
    } finally {
      patch.mockRestore();
    }
    await tickWith(settings);
    await tickWith(settings, "approve");
    const [doc] = await vault.listNotes("docs");
    expect((await vault.readNote(doc as string)).body).toContain("Paste the snippet into your page.");
  });

  it("a revision recorded before its comment was kept, and already shown, is not shown again", async () => {
    const settings = config();
    await fs.mkdir(path.join(settings.jira.stateDir, "drafts"), { recursive: true });
    await fs.writeFile(path.join(settings.jira.stateDir, "drafts", "DOC-1.md"), CLEAN_DRAFT);
    const shown = createHash("sha256").update(CLEAN_DRAFT.trim()).digest("hex");
    await fs.writeFile(
      path.join(settings.jira.stateDir, "jira-state.json"),
      JSON.stringify({
        version: 1,
        issues: {
          "DOC-1": { hasDraft: true, engaged: true, docSlug: "incident-timeline-embed", sourceFingerprint: "seeded", processedComments: [], lastStatus: "In Review", lastUpdated: "2026-08-20T10:00:00.000+0000", postedDraftHash: shown, revision: { feedback: ["shorten the intro"], draftHash: shown } },
        },
      }),
    );
    comments.push(human("h1", "shorten the intro"));
    issue = { ...issue, fields: { ...(issue.fields as object), status: { name: "In Review" }, updated: "2026-08-20T15:00:00.000+0000" } };
    (await startScribeJira(settings, vault)).stop();
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
    expect(comments.filter((comment) => /posted again|Revised draft/.test(comment.body))).toHaveLength(0);
  });

  it("a retry attaches the draft once, not once per attempt", async () => {
    const settings = config();
    const drafts = () => ((issue.fields as { attachment?: Array<{ filename: string }> }).attachment ?? []).filter((attachment) => attachment.filename.startsWith("draft-"));
    // The first draft's comment fails after its attachment landed; the next poll posts it.
    failNextPostContaining = "Draft ready";
    (await startScribeJira(settings, vault)).stop();
    expect(drafts()).toHaveLength(1);
    await tickWith(settings);
    expect(comments.some((comment) => comment.body.includes("Draft (posted again)"))).toBe(true);
    expect(drafts()).toHaveLength(1);
    // A real revision is a new attachment: different text.
    vi.mocked(generateText).mockImplementation(async () => `${CLEAN_DRAFT}\n3. Paste the snippet into your page.`);
    await tickWith(settings, "add the paste step");
    expect(drafts()).toHaveLength(2);
    vi.mocked(generateText).mockImplementation(async () => CLEAN_DRAFT);
  });

  it("a first draft whose comment failed is posted on the next poll, once", async () => {
    const settings = config();
    failNextPostContaining = "Draft ready";
    (await startScribeJira(settings, vault)).stop();
    expect(comments.some((comment) => comment.body.includes("Draft ready"))).toBe(false);
    const posted = () => comments.filter((comment) => comment.body.includes("Draft (posted again)"));
    await tickWith(settings);
    expect(posted()).toHaveLength(1);
    expect(posted()[0]?.body).toContain("Workspace admins can embed a read-only incident timeline");
    await tickWith(settings);
    expect(posted()).toHaveLength(1);
    // And it is approvable: the draft on the ticket is the one that publishes.
    await tickWith(settings, "approve");
    expect(await vault.listNotes("docs")).toHaveLength(1);
  });

  it("a wordless comment changes nothing; a pasted wall of text is answered, not revised from", async () => {
    const settings = config();
    (await startScribeJira(settings, vault)).stop();
    const calls = vi.mocked(generateText).mock.calls.length;
    const before = comments.length;
    await tickWith(settings, "!screenshot.png|thumbnail!", ".");
    expect(vi.mocked(generateText).mock.calls.length).toBe(calls);
    expect(comments.length).toBe(before + 2); // only the two human comments
    await tickWith(settings, "Log line from the incident export. ".repeat(400));
    expect(vi.mocked(generateText).mock.calls.length).toBe(calls);
    expect(comments.at(-1)?.body).toContain("far longer than feedback on a draft");
    expect(comments.some((comment) => comment.body.includes("Revised draft"))).toBe(false);
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
