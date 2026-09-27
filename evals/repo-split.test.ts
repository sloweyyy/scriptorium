import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Vault, type AppConfig } from "@scriptorium/core";
import { hydrateVaultFromDocsRepo, publishApprovedDoc, pushInternalPlane } from "@scriptorium/agents";

/**
 * The public docs repo and the private vault repo, as two real remotes on disk.
 *
 * The docs repo is public, and every branch of a public repo is public. So the invariant
 * is not "internal notes land on the right branch" but "no internal path exists anywhere
 * in the docs remote" — any branch, any commit. And a vault remote that is not configured
 * must mean the internal plane goes nowhere, never that it falls back to the docs repo.
 */

const exec = promisify(execFile);
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

let tmpRoot: string;
let docsRemote: string;
let vaultRemote: string;
let vault: Vault;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, env: GIT_ENV });
  return stdout.trim();
}

async function bareRemote(name: string, branch: string): Promise<string> {
  const work = path.join(tmpRoot, `seed-${name}`);
  await fs.mkdir(work, { recursive: true });
  await git(work, "init", "-b", branch);
  await git(work, "config", "user.email", "agent@example.invalid");
  await git(work, "config", "user.name", "scriptorium agent");
  await fs.writeFile(path.join(work, "README.md"), `# ${name}\n`);
  await git(work, "add", "-A");
  await git(work, "commit", "-m", "init");
  const remote = path.join(tmpRoot, `${name}.git`);
  await exec("git", ["clone", "--bare", work, remote], { env: GIT_ENV });
  return remote;
}

/** Every path in every commit reachable from any branch of a remote. */
async function everyPath(remote: string): Promise<string[]> {
  const log = await git(remote, "log", "--all", "--name-only", "--format=");
  return log.split("\n").filter(Boolean);
}

function config(overrides: Partial<AppConfig["docsRepo"]> = {}): AppConfig {
  return {
    model: "claude-opus-5",
    hasModelAccess: false,
    provider: "none",
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
    teammate: { channels: [], jiraProjects: [], confluenceSpaces: [], githubRepos: [], allowDms: false, digestWeekday: 1, digestHour: 9 },
    docsRepo: {
      url: docsRemote,
      base: "main",
      vaultUrl: vaultRemote,
      internalBranch: "vault-live",
      commitName: "scriptorium agent",
      commitEmail: "agent@example.invalid",
      workDir: path.join(tmpRoot, "docs-repo"),
      vaultWorkDir: path.join(tmpRoot, "vault-repo"),
      ...overrides,
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

async function seedVault(): Promise<void> {
  await vault.writeNote("docs/incident-timeline-embed.md", "## Overview\n\nEmbed the incident timeline.\n", {
    title: "Incident timeline embed",
    slug: "incident-timeline-embed",
    jira_issue: "DOC-3",
  });
  await vault.writeNote("prd/incident-timeline-embed.md", "An unreleased requirement.\n", { kind: "prd", feature: "Incident timeline embed" });
  await vault.writeNote("_lessons/L-001-utc.md", "Quote maintenance windows in UTC.\n", { id: "L-001", status: "approved" });
}

const approval = {
  issueKey: "DOC-3",
  issueUrl: "https://example.atlassian.net/browse/DOC-3",
  slug: "incident-timeline-embed",
  relPath: "docs/incident-timeline-embed.md",
  approvedBy: "A Reviewer",
};

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-split-"));
  vault = new Vault(path.join(tmpRoot, "vault"));
  await vault.ensure();
  docsRemote = await bareRemote("docs", "main");
  vaultRemote = await bareRemote("vault", "vault-live");
  await seedVault();
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5 });
});

describe("two repositories", () => {
  it("puts the public doc in the docs repo and nothing internal anywhere in it", async () => {
    const outcome = await publishApprovedDoc(config(), vault, approval);
    expect(outcome.published).toBe(true);

    const docsPaths = await everyPath(docsRemote);
    expect(docsPaths).toContain("docs/incident-timeline-embed.md");
    expect(docsPaths.filter((p) => p.startsWith("internal/") || p.startsWith("prd/") || p.startsWith("_lessons/"))).toEqual([]);

    const vaultTree = await git(vaultRemote, "ls-tree", "-r", "--name-only", "vault-live");
    expect(vaultTree).toContain("internal/docs/incident-timeline-embed.md");
    expect(vaultTree).toContain("internal/prd/incident-timeline-embed.md");
    expect(vaultTree).toContain("internal/_lessons/L-001-utc.md");
  });

  it("never lets the public doc branch reach the vault repo", async () => {
    await publishApprovedDoc(config(), vault, approval);
    const vaultBranches = await git(vaultRemote, "for-each-ref", "--format=%(refname:short)", "refs/heads");
    expect(vaultBranches.split("\n").sort()).toEqual(["vault-live"]);
  });

  it("restores the vault from the vault repo, not the docs repo", async () => {
    await publishApprovedDoc(config(), vault, approval);
    const fresh = new Vault(path.join(tmpRoot, "fresh-vault"));
    await fresh.ensure();

    const restored = await hydrateVaultFromDocsRepo({ ...config(), vaultDir: path.join(tmpRoot, "fresh-vault") }, fresh);

    expect(restored).toContain("_lessons/L-001-utc.md");
    expect(restored).toContain("prd/incident-timeline-embed.md");
  });
});

describe("a vault repo that cannot be reached", () => {
  it("still reaches the pull request step, and stays retryable", async () => {
    // The likely first-deploy mistake: a wrong VAULT_REPO_SSH_KEY. The external branch is
    // already pushed by then; throwing past the PR step left a doc no human could merge,
    // because the retry saw the branch `unchanged` and never opened the PR.
    const outcome = await publishApprovedDoc(config({ vaultUrl: path.join(tmpRoot, "no-such-remote.git"), slug: "o/docs" }), vault, approval);

    expect(outcome.published).toBe(false);
    expect(outcome.comment).toContain("Internal plane: **push failed**");
    expect(outcome.comment).toContain("No GitHub App or token configured");
    expect(await everyPath(docsRemote)).toContain("docs/incident-timeline-embed.md");
  });
});

describe("no vault repo configured", () => {
  it("publishes the public doc, pushes nothing internal, and says so", async () => {
    const outcome = await publishApprovedDoc(config({ vaultUrl: undefined }), vault, approval);

    expect(outcome.published).toBe(true);
    expect(outcome.comment).toContain("Internal plane: **not pushed**");
    expect(outcome.comment).toContain("VAULT_REPO_URL");
    const docsPaths = await everyPath(docsRemote);
    expect(docsPaths.filter((p) => p.startsWith("internal/"))).toEqual([]);
  });

  it("refuses an internal-only push instead of sending it to the docs repo", async () => {
    const pushed = await pushInternalPlane(config({ vaultUrl: undefined }), vault, "lessons: approve L-001");

    expect(pushed).toBe(false);
    expect((await everyPath(docsRemote)).filter((p) => p.startsWith("internal/"))).toEqual([]);
  });
});
