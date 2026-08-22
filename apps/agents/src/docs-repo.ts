import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { docsRepoReady, parseMarkdown, type AppConfig, type Vault } from "@scriptorium/core";
import { docBranchName, docPullRequestBody, openPullRequest, publishVault, type PublishToRepoResult } from "@scriptorium/publish";

const exec = promisify(execFile);

/**
 * The egress side of an approval: push the allowlisted vault into the docs repo, and open
 * the pull request whose merge publishes it.
 *
 * Two gates that mean different things — a human approved the *content* on the ticket; a
 * human merges to *publish* it. The external tree goes to a per-ticket branch so the PR
 * exists to be merged; the internal tree (PRDs, gaps, house rules) goes straight to the
 * base branch, because losing it is the failure this exists to prevent and there is no
 * second audience to review it for.
 */

export interface PublishOutcome {
  /** Markdown for the ticket comment — always says what happened, including refusals. */
  comment: string;
  published: boolean;
  pullRequestUrl?: string;
}

function ssh(config: AppConfig): NodeJS.ProcessEnv {
  const key = config.docsRepo.sshKey;
  if (!key) return process.env;
  // Repo-scoped deploy key, pinned with IdentitiesOnly so a loaded agent key can't shadow it.
  return { ...process.env, GIT_SSH_COMMAND: `ssh -i ${key} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new` };
}

/** Clone on first use, fetch afterwards. The clone is scratch — safe to delete. */
export async function ensureDocsRepo(config: AppConfig): Promise<string> {
  const { url, workDir, base } = config.docsRepo;
  if (!url) throw new Error("DOCS_REPO_URL is not set");

  const env = ssh(config);
  const gitDir = path.join(workDir, ".git");
  try {
    await fs.access(gitDir);
    await exec("git", ["fetch", "origin", base], { cwd: workDir, env });
  } catch {
    await fs.mkdir(path.dirname(workDir), { recursive: true });
    await fs.rm(workDir, { recursive: true, force: true });
    await exec("git", ["clone", "--branch", base, url, workDir], { env });
  }
  // Identity must exist inside the clone: the commit records the approver in the message,
  // but git still refuses to commit without an author.
  await exec("git", ["config", "user.name", "scriptorium agent"], { cwd: workDir });
  await exec("git", ["config", "user.email", "agent@scriptorium.local"], { cwd: workDir });
  return workDir;
}

function describe(result: PublishToRepoResult, label: string): string {
  switch (result.status) {
    case "published":
      // `published` covers committed-but-not-pushed too, so say which actually happened.
      return result.pushed
        ? `- ${label}: pushed to \`${result.branch}\` (${result.changed.length} file(s), commit \`${result.commit.slice(0, 8)}\`)`
        : `- ${label}: committed locally to \`${result.branch}\` but not pushed`;
    case "unchanged":
      return `- ${label}: already up to date`;
    case "conflict": {
      const paths = result.diverged.map((item) => `\`${item.path}\` (${item.reason})`).join(", ");
      return `- ${label}: **refused** — the docs repo diverged from what I last published: ${paths}`;
    }
    case "push-failed":
      return `- ${label}: **push failed** — ${result.error}`;
  }
}

export async function publishApprovedDoc(
  config: AppConfig,
  vault: Vault,
  input: { issueKey: string; issueUrl: string; slug: string; relPath: string; approvedBy: string; appliedLessons?: string[] },
): Promise<PublishOutcome> {
  if (!docsRepoReady(config.docsRepo)) {
    return { comment: "_Docs repo not configured, so the vault stayed local — nothing was published to a site._", published: false };
  }

  const repoDir = await ensureDocsRepo(config);
  const branch = docBranchName(input.issueKey, input.slug);
  const lines: string[] = [];

  // External first: it is the one a human still has to merge, so its result decides the tone.
  const external = await publishVault({
    vault,
    repoDir,
    target: "external",
    subdir: "docs",
    branch,
    remote: "origin",
    approvedBy: input.approvedBy,
    message: `docs: ${input.slug} (${input.issueKey}, approved by ${input.approvedBy})`,
  });
  lines.push(describe(external.push, "External docs"));

  const internal = await publishVault({
    vault,
    repoDir,
    target: "internal",
    subdir: "internal",
    branch: config.docsRepo.base,
    remote: "origin",
    approvedBy: input.approvedBy,
    message: `vault: ${input.slug} (${input.issueKey})`,
  });
  lines.push(describe(internal.push, "Internal plane"));

  let pullRequestUrl: string | undefined;
  const externalPublished = external.push.status === "published" && external.push.pushed;

  if (externalPublished && config.docsRepo.token && config.docsRepo.slug) {
    try {
      const pull = await openPullRequest({
        repo: config.docsRepo.slug,
        head: branch,
        base: config.docsRepo.base,
        title: `docs: ${input.slug} (${input.issueKey})`,
        body: docPullRequestBody({ ...input, approvedBy: input.approvedBy }),
        token: config.docsRepo.token,
      });
      pullRequestUrl = pull.url;
      lines.push(`- Pull request: ${pull.url} — merging it publishes to the site`);
    } catch (error) {
      // A missing PR is not a failed publish: the branch is pushed and mergeable by hand.
      lines.push(`- Pull request could not be opened (${error instanceof Error ? error.message : String(error)}); the branch is pushed and can be merged manually`);
    }
  } else if (externalPublished) {
    lines.push(`- No API token configured, so no PR was opened — merge \`${branch}\` into \`${config.docsRepo.base}\` to publish`);
  }

  const refused = external.push.status === "conflict" || internal.push.status === "conflict";
  const heading = refused
    ? "**Publish refused — the docs repo has human edits I would have overwritten.**"
    : "**Pushed to the docs repo.**";

  return {
    comment: [heading, "", ...lines, "", refused ? "Nothing was force-pushed. Reconcile the diverged files and comment `approve` again." : "The vault note is the source; the site builds from the repo."].join("\n"),
    published: externalPublished,
    pullRequestUrl,
  };
}

export interface DocsRepoChange {
  /** Vault notes updated from the repo — internal tree only, see below. */
  vaultUpdated: string[];
  /** Published docs a human edited, per ticket. Reported, never imported. */
  externalEdited: Array<{ repoPath: string; issueKey?: string }>;
}

/**
 * The inbound half of the round trip.
 *
 * Asymmetric on purpose. The internal tree is published untransformed, so a human edit
 * there can be read straight back into the vault. The external tree is NOT: publishing
 * rewrites `[[wikilinks]]` into relative links and strips internal frontmatter, so
 * importing it back would overwrite a vault note with its own lossy projection. Those
 * edits are reported on the originating ticket for a human to fold in — the honest answer,
 * rather than a silent one-way corruption dressed up as a round trip.
 *
 * Reads blobs out of `origin/<base>` with `git show`, so nothing is checked out and the
 * agent's own publish branch in the work tree is left alone.
 */
export async function syncFromDocsRepo(config: AppConfig, vault: Vault, paths: readonly string[]): Promise<DocsRepoChange> {
  const change: DocsRepoChange = { vaultUpdated: [], externalEdited: [] };
  if (!docsRepoReady(config.docsRepo)) return change;

  const repoDir = await ensureDocsRepo(config);
  const env = ssh(config);
  const base = config.docsRepo.base;
  await exec("git", ["fetch", "origin", base], { cwd: repoDir, env });

  for (const repoPath of paths) {
    const isInternal = repoPath.startsWith("internal/");
    const isExternal = repoPath.startsWith("docs/");
    if (!isInternal && !isExternal) continue;

    let content: string;
    try {
      const { stdout } = await exec("git", ["show", `origin/${base}:${repoPath}`], { cwd: repoDir, maxBuffer: 8_000_000 });
      content = stdout;
    } catch {
      // Deleted upstream. Deleting vault notes on a remote delete is not something an
      // agent should decide by itself, so record nothing and move on.
      continue;
    }

    if (isInternal) {
      const relPath = repoPath.slice("internal/".length);
      const { frontmatter, body } = parseMarkdown(content);
      await vault.writeNote(relPath, body, { ...frontmatter, edited_in_repo: new Date().toISOString() });
      change.vaultUpdated.push(relPath);
      continue;
    }

    const issueKey = (() => {
      try {
        const value = parseMarkdown(content).frontmatter.jira_issue;
        return typeof value === "string" ? value : undefined;
      } catch {
        return undefined;
      }
    })();
    change.externalEdited.push({ repoPath, issueKey });
  }
  return change;
}

/**
 * Boot-time restore: rebuild the vault from the docs repo's internal tree.
 *
 * This is what makes "the vault is reconstructible from the docs repo" true rather than
 * aspirational. It reads `internal/**` — which carries the UNTRANSFORMED docs, PRDs, gap
 * notes, house rules and index — so a fresh container comes up with the same knowledge
 * plane it had before, and Curator can cite notes it never saw written.
 *
 * Only runs when the vault has no notes of its own: a restore must never overwrite local
 * work that has not been published yet.
 */
export async function hydrateVaultFromDocsRepo(config: AppConfig, vault: Vault): Promise<string[]> {
  if (!docsRepoReady(config.docsRepo)) return [];

  const existing = await vault.listNotes();
  const substantive = existing.filter((relPath) => !relPath.startsWith("_inbox/") && relPath !== "index.md");
  if (substantive.length) return [];

  const repoDir = await ensureDocsRepo(config);
  const env = ssh(config);
  const base = config.docsRepo.base;
  await exec("git", ["fetch", "origin", base], { cwd: repoDir, env });

  const { stdout } = await exec("git", ["ls-tree", "-r", "--name-only", `origin/${base}`, "internal/"], {
    cwd: repoDir,
    maxBuffer: 8_000_000,
  });
  const paths = stdout.split("\n").map((line) => line.trim()).filter((line) => line.endsWith(".md"));

  const restored: string[] = [];
  for (const repoPath of paths) {
    const relPath = repoPath.slice("internal/".length);
    if (!relPath) continue;
    try {
      const blob = await exec("git", ["show", `origin/${base}:${repoPath}`], { cwd: repoDir, maxBuffer: 8_000_000 });
      const { frontmatter, body } = parseMarkdown(blob.stdout);
      await vault.writeNote(relPath, body, frontmatter);
      restored.push(relPath);
    } catch {
      // One unreadable blob must not abort the restore.
    }
  }
  return restored;
}
