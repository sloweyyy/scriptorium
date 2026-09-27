import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Vault, type AppConfig } from "@scriptorium/core";
import { hydrateVaultFromDocsRepo, publishApprovedDoc, syncFromDocsRepo } from "@scriptorium/agents";

/**
 * Boot restore, against a real git remote on disk.
 *
 * A container's vault is whatever the image shipped, so the notes written *after* the image
 * was built — approved house rules and gap notes — exist only in the docs repo. Restoring
 * them is what makes a lesson keep applying across a deploy, and the failure is silent in
 * the worst way: the rule still renders on the internal site while no longer shaping a
 * single draft. The bug these pin is precisely that: the restore used to bail whenever the
 * vault was non-empty, and the image ships a committed `vault/docs/*.md`, so it never ran
 * in production even once.
 */

const exec = promisify(execFile);

let tmpRoot: string;
let remote: string;
let vaultDir: string;
let vault: Vault;

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec("git", args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
}

/** A docs repo whose `vault-live` branch carries an internal tree, as the agent leaves it. */
async function seedRemote(): Promise<void> {
  const work = path.join(tmpRoot, "seed");
  await fs.mkdir(work, { recursive: true });
  await git(work, "init", "-b", "main");
  await git(work, "config", "user.email", "agent@example.invalid");
  await git(work, "config", "user.name", "scriptorium agent");
  await fs.writeFile(path.join(work, "README.md"), "# docs repo\n");
  await git(work, "add", "-A");
  await git(work, "commit", "-m", "init");

  await git(work, "checkout", "-b", "vault-live");
  for (const [relPath, body] of [
    ["internal/_lessons/L-001-timezone.md", "---\nstatus: approved\n---\n\nAlways quote a maintenance window in UTC.\n"],
    ["internal/_gaps/does-beacon-support-sso.md", "---\nasked_by: a reviewer\n---\n\nNobody has documented SSO.\n"],
    ["internal/docs/status-page-subscriber-management.md", "---\ntitle: Subscriber management\n---\n\n## Overview\n\nPublished on an earlier revision.\n"],
    ["internal/docs/scheduled-maintenance-announcements.md", "---\ntitle: Maintenance\n---\n\n## Overview\n\nThe version in the docs repo.\n"],
  ] as const) {
    await fs.mkdir(path.dirname(path.join(work, relPath)), { recursive: true });
    await fs.writeFile(path.join(work, relPath), body);
  }
  await git(work, "add", "-A");
  await git(work, "commit", "-m", "vault: published notes");
  await git(work, "checkout", "main");

  remote = path.join(tmpRoot, "remote.git");
  await exec("git", ["clone", "--bare", work, remote]);
  // The bare clone must carry vault-live too, which `clone --bare` does for all branches.
  await git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
}

function config(): AppConfig {
  return {
    model: "claude-opus-5",
    hasModelAccess: false,
    provider: "none",
    vertexRegion: "global",
    repoRoot: tmpRoot,
    vaultDir,
    auditFile: path.join(tmpRoot, "audit.jsonl"),
    port: 8080,
    scribe: {},
    curator: {},
    teammate: { channels: [], jiraProjects: [], confluenceSpaces: [], digestWeekday: 1, digestHour: 9 },
    slack: {},
    sites: {},
    webhook: {},
    docsRepo: {
      url: remote,
      base: "main",
      internalBranch: "vault-live",
      commitName: "scriptorium agent",
      commitEmail: "agent@example.invalid",
      workDir: path.join(tmpRoot, "docs-repo"),
    },
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

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-hydrate-"));
  vaultDir = path.join(tmpRoot, "vault");
  vault = new Vault(vaultDir);
  await vault.ensure();
  await seedRemote();
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("boot restore", () => {
  it("restores the lessons and gaps a shipped image cannot carry", async () => {
    // Exactly the production shape: the image ships one published doc, so the vault is not
    // empty on boot. The all-or-nothing guard used to read that as "already hydrated".
    await vault.writeNote("docs/scheduled-maintenance-announcements.md", "## Overview\n\nThe copy baked into the image.\n", { title: "Maintenance" });

    const restored = await hydrateVaultFromDocsRepo(config(), vault);

    expect(restored).toContain("_lessons/L-001-timezone.md");
    expect(restored).toContain("_gaps/does-beacon-support-sso.md");
    // And the doc published by an earlier revision, which is why Curator could not cite it.
    expect(restored).toContain("docs/status-page-subscriber-management.md");

    const lesson = await fs.readFile(path.join(vaultDir, "_lessons/L-001-timezone.md"), "utf8");
    expect(lesson).toContain("quote a maintenance window in UTC");
  });

  it("replaces a stale copy the image shipped, instead of trusting that it is there", async () => {
    // This assertion is the reverse of the one it replaces, deliberately. "Present" was
    // being read as "current", and the image ships a `vault/docs/*.md` frozen at build
    // time: a doc revised and published afterwards stayed correct on both sites and stale
    // in the vault, so every deploy rolled Curator's answers back to the build. It told
    // Slack a maintenance reminder arrives 1 hour before the window while linking the page
    // that said 24 — an answer contradicting its own citation.
    await vault.writeNote("docs/scheduled-maintenance-announcements.md", "## Overview\n\nThe copy baked into the image.\n", { title: "Maintenance" });

    const restored = await hydrateVaultFromDocsRepo(config(), vault);

    expect(restored).toContain("docs/scheduled-maintenance-announcements.md");
    const now = await fs.readFile(path.join(vaultDir, "docs/scheduled-maintenance-announcements.md"), "utf8");
    expect(now).toContain("The version in the docs repo");
    expect(now).not.toContain("baked into the image");
  });

  it("rewrites nothing when the vault already agrees with the branch", async () => {
    // Guards the comparison itself: the vault re-serialises frontmatter, so a note it wrote
    // is never byte-identical to the blob it came from. Comparing raw bytes would rewrite
    // every note on every boot and report the entire vault as restored.
    await hydrateVaultFromDocsRepo(config(), vault);
    expect(await hydrateVaultFromDocsRepo(config(), vault)).toEqual([]);
  });

  it("never touches a note the branch does not carry", async () => {
    // The branch is authoritative for what it holds, and silent about everything else.
    // Unpublished local work is not its business, and nothing is ever deleted.
    await vault.writeNote("docs/not-published-anywhere.md", "## Draft\n\nLocal work in progress.\n", { title: "Local" });

    const restored = await hydrateVaultFromDocsRepo(config(), vault);

    expect(restored).not.toContain("docs/not-published-anywhere.md");
    expect(await fs.readFile(path.join(vaultDir, "docs/not-published-anywhere.md"), "utf8")).toContain("Local work in progress");
  });

  it("restores everything into a genuinely empty vault", async () => {
    const restored = await hydrateVaultFromDocsRepo(config(), vault);
    expect(restored.sort()).toEqual([
      "_gaps/does-beacon-support-sso.md",
      "_lessons/L-001-timezone.md",
      "docs/scheduled-maintenance-announcements.md",
      "docs/status-page-subscriber-management.md",
    ]);
  });

  it("does nothing when no docs repo is configured", async () => {
    const settings = config();
    const restored = await hydrateVaultFromDocsRepo({ ...settings, docsRepo: { ...settings.docsRepo, url: undefined } }, vault);
    expect(restored).toEqual([]);
  });
});

describe("publishing a note the vault has lost", () => {
  it("refuses instead of reporting both trees already up to date", async () => {
    // A doc published on one revision whose push then failed is gone from the next
    // container's vault. The repo then trivially "matches" a vault with no note in it, so
    // the retry reported success and pushed nothing — and the doc was quietly unrecoverable.
    const outcome = await publishApprovedDoc(config(), vault, {
      issueKey: "DOC-2",
      issueUrl: "https://example.atlassian.net/browse/DOC-2",
      slug: "status-page-subscriber-management",
      relPath: "docs/status-page-subscriber-management.md",
      approvedBy: "A Reviewer",
    });

    expect(outcome.published).toBe(false);
    expect(outcome.comment).toContain("vault copy is missing");
    // The retry flag stays unset, and the ticket says what to do about it.
    expect(outcome.comment).toContain("`draft`");
  });

  it("publishes normally once the note is there", async () => {
    // A path the seeded remote does not already carry: a note the repo has but the agent
    // never published reads as a human's file and is correctly refused, which is a
    // different test (see publish.test.ts) than the guard above.
    await vault.writeNote("docs/incident-timeline-embed.md", "## Overview\n\nReal content.\n", {
      title: "Incident timeline embed",
    });

    const outcome = await publishApprovedDoc(config(), vault, {
      issueKey: "DOC-3",
      issueUrl: "https://example.atlassian.net/browse/DOC-3",
      slug: "incident-timeline-embed",
      relPath: "docs/incident-timeline-embed.md",
      approvedBy: "A Reviewer",
    });

    expect(outcome.comment).not.toContain("vault copy is missing");
    expect(outcome.published).toBe(true);
  });

  it("stays retryable when one tree refuses", async () => {
    // The seeded remote carries this note without the agent's publish trailer, so the
    // internal target reads it as a human's file and refuses. `published` must be false:
    // a conflict is exactly the case that has to be approvable again later.
    await vault.writeNote("docs/status-page-subscriber-management.md", "## Overview\n\nRewritten.\n", {
      title: "Subscriber management",
    });

    const outcome = await publishApprovedDoc(config(), vault, {
      issueKey: "DOC-2",
      issueUrl: "https://example.atlassian.net/browse/DOC-2",
      slug: "status-page-subscriber-management",
      relPath: "docs/status-page-subscriber-management.md",
      approvedBy: "A Reviewer",
    });

    expect(outcome.published).toBe(false);
    expect(outcome.comment).toContain("Publish refused");
  });
});

describe("telling a landed publish from a human edit", () => {
  async function publishIncident(): Promise<void> {
    await vault.writeNote("docs/incident-timeline-embed.md", "## Overview\n\nReal content.\n", {
      title: "Incident timeline embed",
      slug: "incident-timeline-embed",
      jira_issue: "DOC-3",
    });
    const outcome = await publishApprovedDoc(config(), vault, {
      issueKey: "DOC-3",
      issueUrl: "https://example.atlassian.net/browse/DOC-3",
      slug: "incident-timeline-embed",
      relPath: "docs/incident-timeline-embed.md",
      approvedBy: "A Reviewer",
    });
    expect(outcome.published).toBe(true);
  }

  async function mergePublishBranch(): Promise<void> {
    const work = path.join(tmpRoot, "merge-clone");
    await exec("git", ["clone", "--quiet", remote, work]);
    await git(work, "config", "user.email", "human@example.invalid");
    await git(work, "config", "user.name", "A Human");
    await git(work, "merge", "--no-ff", "-m", "merge publish PR", "origin/docs/doc-3-incident-timeline-embed");
    await git(work, "push", "--quiet", "origin", "main");
  }

  it("reports the PR merge as the doc going live, not as a human edit", async () => {
    // Merging the agent's own publish branch changes docs/* on main too — but that is
    // the doc LANDING. Warning about an overwrite that is not one teaches people to
    // ignore the warning that matters.
    await publishIncident();
    await mergePublishBranch();

    const change = await syncFromDocsRepo(config(), vault, ["docs/incident-timeline-embed.md"]);
    expect(change.externalEdited).toHaveLength(1);
    expect(change.externalEdited[0]?.issueKey).toBe("DOC-3");
    expect(change.externalEdited[0]?.landed).toBe(true);
  });

  it("still reports a genuine human edit as one", async () => {
    await publishIncident();
    await mergePublishBranch();

    // A human then edits the published copy on main: content no longer matches the
    // publish branch tip, whatever route it took in.
    const work = path.join(tmpRoot, "edit-clone");
    await exec("git", ["clone", "--quiet", remote, work]);
    await git(work, "config", "user.email", "human@example.invalid");
    await git(work, "config", "user.name", "A Human");
    const target = path.join(work, "docs/incident-timeline-embed.md");
    await fs.writeFile(target, (await fs.readFile(target, "utf8")) + "\nA human addendum.\n");
    await git(work, "add", "-A");
    await git(work, "commit", "-m", "human touch-up");
    await git(work, "push", "--quiet", "origin", "main");

    const change = await syncFromDocsRepo(config(), vault, ["docs/incident-timeline-embed.md"]);
    expect(change.externalEdited[0]?.landed).toBe(false);
  });
});

describe("two tickets approved at once", () => {
  it("both publish — one work tree, one writer", async () => {
    // Observed live: three approvals inside one second, all racing the same git clone, and
    // the loser got "docs repo work tree is not clean". The per-issue lock upstream cannot
    // help — these are different issues sharing one directory.
    await vault.writeNote("docs/first-feature.md", "## Overview\n\nFirst.\n", { title: "First" });
    await vault.writeNote("docs/second-feature.md", "## Overview\n\nSecond.\n", { title: "Second" });

    const publish = (slug: string, key: string): Promise<{ comment: string; published: boolean }> =>
      publishApprovedDoc(config(), vault, {
        issueKey: key,
        issueUrl: `https://example.atlassian.net/browse/${key}`,
        slug,
        relPath: `docs/${slug}.md`,
        approvedBy: "A Reviewer",
      });

    const [a, b] = await Promise.all([publish("first-feature", "DOC-90"), publish("second-feature", "DOC-91")]);

    for (const outcome of [a, b]) {
      expect(outcome.comment).not.toContain("not clean");
      expect(outcome.published).toBe(true);
    }
  });
});
