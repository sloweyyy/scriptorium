import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { docSlug, Vault, type AppConfig } from "@scriptorium/core";
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
/** Storage XHTML served for any Confluence page fetch; undefined -> 403 (restricted). */
let confluenceStorage: string | undefined;
/** Remote links on the issue, as Jira returns them. */
let remoteLinks: Array<{ object: { url: string; title?: string } }>;

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
    teammate: { channels: [], jiraProjects: [], confluenceSpaces: [] },
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
    if (url.includes("/remotelink")) return json(remoteLinks);
    if (url.includes("/wiki/rest/api/content/")) {
      if (confluenceStorage === undefined) return new Response('{"message":"restricted"}', { status: 403 });
      return json({ title: "Beacon PRD", body: { storage: { value: confluenceStorage } } });
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
  confluenceStorage = undefined;
  remoteLinks = [];
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

describe("an upload still in progress", () => {
  it("waits instead of drafting from half of it", async () => {
    // Attachments land one at a time. A tick landing mid-upload used to draft from the PRD
    // alone and never mention the designs — measured three times out of three on the live
    // board. The PRD here is complete, so a draft WOULD have been attempted.
    issue = {
      ...issue,
      fields: {
        ...(issue.fields as object),
        description: prdInJira("feature: X", "audience: admins", "user_goal: do the thing"),
        attachment: [
          {
            id: "att-warm",
            filename: "just-uploaded.png",
            mimeType: "image/png",
            content: "https://example.atlassian.net/rest/api/2/attachment/content/att-warm",
            created: new Date().toISOString(),
          },
        ],
      },
    };

    const stop = await startScribeJira(config(), vault);
    stop.stop();

    // Greeted, but nothing drafted and nothing refused: it is waiting, not deciding.
    expect(comments.some((comment) => comment.body.includes("Draft ready"))).toBe(false);
    expect(comments.some((comment) => comment.body.includes("can't draft"))).toBe(false);
  });

  it("comes back to a deferred draft even though nothing changed since", async () => {
    // The trap this closes: attachments are usually the LAST thing to touch a ticket, so
    // the tick that defers also records their timestamp as seen. Without a flag the
    // untouched gate then parks the ticket forever with the PRD sitting right there —
    // observed live, a ticket that greeted, deferred, and never spoke again.
    const warm = {
      id: "att-warm3",
      filename: "just-uploaded.png",
      mimeType: "image/png",
      content: "https://example.atlassian.net/rest/api/2/attachment/content/att-warm3",
      created: new Date().toISOString(),
    };
    issue = {
      ...issue,
      fields: {
        ...(issue.fields as object),
        description: prdInJira("feature: X", "audience: admins", "user_goal: do the thing"),
        attachment: [warm],
      },
    };

    const settings = config();
    const first = await startScribeJira(settings, vault);
    first.stop();
    expect(comments.some((comment) => comment.body.includes("Draft ready"))).toBe(false);

    // Same `updated`, same status, same attachments — nothing at all has changed. The
    // upload has simply finished, and the agent has to notice that by itself.
    issue = {
      ...issue,
      fields: {
        ...(issue.fields as object),
        attachment: [{ ...warm, created: new Date(Date.now() - 120_000).toISOString() }],
      },
    };
    const second = await startScribeJira(settings, vault);
    second.stop();

    // It looked again. (No model in this suite, so the draft itself cannot complete —
    // what matters is that it stopped deferring and tried.)
    const log = comments.map((comment) => comment.body).join("\n");
    expect(log).toContain("Reading this ticket now");
  });

  it("drafts once the upload has settled", async () => {
    issue = {
      ...issue,
      fields: {
        ...(issue.fields as object),
        description: prdInJira("feature: X", "audience: admins", "user_goal: do the thing"),
        attachment: [
          {
            id: "att-cold",
            filename: "settled.png",
            mimeType: "image/png",
            content: "https://example.atlassian.net/rest/api/2/attachment/content/att-cold",
            // Landed a while ago: the upload is over.
            created: new Date(Date.now() - 120_000).toISOString(),
          },
        ],
      },
    };

    const stop = await startScribeJira(config(), vault);
    stop.stop();
    // No model in this suite, so the draft call itself throws — what matters is that it
    // got past the wait and tried, rather than returning early.
    expect(comments.some((comment) => comment.body.includes("Reading this ticket now"))).toBe(true);
  });

  it("a human typing `draft` never waits", async () => {
    const settings = config();
    const first = await startScribeJira(settings, vault);
    first.stop();

    issue = {
      ...issue,
      fields: {
        ...(issue.fields as object),
        attachment: [
          {
            id: "att-warm2",
            filename: "just-uploaded.png",
            mimeType: "image/png",
            content: "https://example.atlassian.net/rest/api/2/attachment/content/att-warm2",
            created: new Date().toISOString(),
          },
        ],
        updated: "2026-08-20T13:00:00.000+0000",
      },
    };
    comments.push(human("h1", "draft"));

    const second = await startScribeJira(settings, vault);
    second.stop();
    // Forced: it acts on the ticket rather than silently deferring the human's request.
    expect(comments.length).toBeGreaterThan(2);
  });
});

describe("a page linked after the ticket was already refused", () => {
  it("notices it, even though Jira bumps nothing the poller can see", async () => {
    // The real sequence a PM produces: file the ticket, get told the PRD is missing, then
    // go and link the Confluence page that has it. Adding a remote link does NOT change
    // `fields.updated`, so the poller's change gate sees an untouched ticket forever and
    // the PRD sits one click away, invisible.
    const settings = config();
    const first = await startScribeJira(settings, vault);
    first.stop();
    const afterRefusal = comments.length;
    expect(comments.some((comment) => comment.body.includes("can't draft"))).toBe(true);

    // The page appears. `updated` is deliberately left exactly as it was.
    remoteLinks = [{ object: { url: "https://example.atlassian.net/wiki/spaces/PROD/pages/98311/Beacon+PRD" } }];
    confluenceStorage = "<h1>Beacon PRD</h1><p><strong>Feature:</strong> Incident timeline embed</p>";

    const second = await startScribeJira(settings, vault);
    second.stop();

    // It looked again, and it read the page — the refusal now names the Confluence source
    // and asks only for what the page did not answer.
    expect(comments.length).toBeGreaterThan(afterRefusal);
    expect(comments.at(-1)?.body).toContain("Confluence page");
    expect(comments.at(-1)?.body).toContain("Beacon PRD");
  });

  it("does not re-read a ticket whose links have not moved", async () => {
    // The other half: the check must not turn every blocked ticket into a per-tick retry.
    remoteLinks = [{ object: { url: "https://example.atlassian.net/wiki/spaces/PROD/pages/98311/Beacon+PRD" } }];
    confluenceStorage = "<h1>Beacon PRD</h1><p><strong>Feature:</strong> Incident timeline embed</p>";

    const settings = config();
    const first = await startScribeJira(settings, vault);
    first.stop();
    const afterFirst = comments.length;

    // Same links, same everything: silence.
    const second = await startScribeJira(settings, vault);
    second.stop();
    expect(comments).toHaveLength(afterFirst);
  });

  it("stays quiet on a ticket nobody asked it to work", async () => {
    // Unlabelled and never mentioned: a link appearing there is somebody else's business,
    // and the agent must not even spend the API call finding out.
    unlabelled();
    const settings = config();
    const first = await startScribeJira(settings, vault);
    first.stop();
    expect(comments).toHaveLength(0);

    remoteLinks = [{ object: { url: "https://example.atlassian.net/wiki/spaces/PROD/pages/98311/Beacon+PRD" } }];
    confluenceStorage = "<h1>Beacon PRD</h1><p><strong>Feature:</strong> X</p>";
    const second = await startScribeJira(settings, vault);
    second.stop();
    expect(comments).toHaveLength(0);
  });
});

describe("re-draft with the agent's own attachments present", () => {
  it("never reads its own draft attachment back as the PRD", async () => {
    // After a draft, the ticket carries `draft-<slug>.md` uploaded by the agent. A later
    // `draft` command re-reads the sources — and picking its own output as "the PRD" made
    // it ask the PM for frontmatter fields that no draft ever carries.
    issue = {
      ...issue,
      fields: {
        ...(issue.fields as object),
        description: "",
        attachment: [
          {
            id: "att-draft",
            filename: "draft-incident-timeline-embed.md",
            mimeType: "text/markdown",
            content: "https://example.atlassian.net/rest/api/2/attachment/content/att-draft",
          },
        ],
      },
    };

    const stop = await startScribeJira(config(), vault);
    stop.stop();

    const bodies = comments.map((comment) => comment.body);
    // With only its own draft present there is NO PRD — and it must say that, not demand
    // frontmatter from a file it wrote itself.
    expect(bodies.some((body) => body.includes("can't find a PRD"))).toBe(true);
    expect(bodies.some((body) => body.includes("can't draft"))).toBe(false);
  });
});

describe("prd in confluence", () => {
  it("reads the PRD off the linked page and names it as the source", async () => {
    // The ticket carries no attachment and no description PRD — just the remote link
    // Jira creates when a Confluence page is linked. The page itself is a natural PRD:
    // bold labels, no YAML. Incomplete on purpose, so the refusal proves which source
    // was read without needing a model.
    remoteLinks = [{ object: { url: "https://example.atlassian.net/wiki/spaces/PROD/pages/98311/Beacon+PRD" } }];
    confluenceStorage = "<h1>Beacon PRD</h1><p><strong>Feature:</strong> Incident timeline embed</p>";
    issue = { ...issue, fields: { ...(issue.fields as object), description: "" } };

    const stop = await startScribeJira(config(), vault);
    stop.stop();

    const refusal = comments.map((comment) => comment.body).find((body) => body.includes("can't draft"));
    expect(refusal).toBeDefined();
    expect(refusal).toContain("Confluence page");
    expect(refusal).toContain("Beacon PRD");
    // It asks only for what the page did not answer — feature was found as a bold label.
    expect(refusal).toContain("audience");
    expect(refusal).not.toContain("*feature* —");
  });

  it("drafts nothing and says why when the linked page is restricted", async () => {
    // A pointed-at page the account cannot read is a permissions problem, and "attach a
    // .md file" is the wrong advice for it. The agent has to say what is actually wrong.
    issue = {
      ...issue,
      fields: {
        ...(issue.fields as object),
        description: "PRD: https://example.atlassian.net/wiki/spaces/PROD/pages/98311/Beacon+PRD",
      },
    };
    confluenceStorage = undefined;

    const stop = await startScribeJira(config(), vault);
    stop.stop();

    const bodies = comments.map((comment) => comment.body);
    expect(bodies.some((body) => body.includes("Confluence page I can't read"))).toBe(true);
    expect(await vault.listNotes("docs")).toHaveLength(0);
  });

  it("prefers a .md attachment over the linked page", async () => {
    // Priority is fidelity: an attached markdown file is the author's exact bytes.
    remoteLinks = [{ object: { url: "https://example.atlassian.net/wiki/spaces/PROD/pages/98311/Beacon+PRD" } }];
    confluenceStorage = "<p><strong>Feature:</strong> The wrong source</p>";
    issue = {
      ...issue,
      fields: {
        ...(issue.fields as object),
        description: "",
        attachment: [
          {
            id: "att-1",
            filename: "prd.md",
            mimeType: "text/markdown",
            content: "https://example.atlassian.net/rest/api/2/attachment/content/att-1",
          },
        ],
      },
    };

    const stop = await startScribeJira(config(), vault);
    stop.stop();

    const refusal = comments.map((comment) => comment.body).find((body) => body.includes("can't draft"));
    expect(refusal).toBeDefined();
    expect(refusal).toContain("the attachment");
    expect(refusal).not.toContain("Confluence");
  });
});

describe("a PRD whose feature is a sentence", () => {
  it("seeds the PRD under the capped doc slug, pinned so the organizer keeps it", async () => {
    // A gap ticket's PRD often carries the asker's question as `feature`. The doc is
    // published under docSlug(feature) and `sourcePrd` points at prd/<that slug>; the seeded
    // PRD has to carry the same slug or the organizer re-derives an 80-character one.
    const feature = "Users can export their dashboard view as a PDF file so they can share it with stakeholders";
    issue = {
      ...issue,
      fields: {
        ...(issue.fields as object),
        description: prdInJira(`feature: ${feature}`, "audience: admins", "user_goal: share a dashboard"),
      },
    };

    const stop = await startScribeJira(config(), vault);
    stop.stop();

    const slug = docSlug(feature);
    expect(slug).toBe("users-can-export-their-dashboard-view-as-a");
    const seeded = await vault.readNote(`_inbox/${slug}.md`);
    expect(seeded.frontmatter.slug).toBe(slug);
    expect(seeded.frontmatter.kind).toBe("prd");
  });
});
