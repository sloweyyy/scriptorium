import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { approvalVerified, docsRepoReady, parseMarkdown, vaultRepoReady, type AppConfig, type Frontmatter, type Vault } from "@scriptorium/core";
import { GitHubError, docBranchName, docPullRequestBody, installationToken, openPullRequest, publishVault, type PublishToRepoResult } from "@scriptorium/publish";

const exec = promisify(execFile);

/**
 * The egress side of an approval: push the allowlisted vault into two repositories, and
 * open the pull request whose merge publishes the public half.
 *
 * Two gates that mean different things — a human approved the *content* on the ticket; a
 * human merges to *publish* it. The external tree goes to a per-ticket branch of the
 * public docs repo so the PR exists to be merged; the internal tree (PRDs, gaps, house
 * rules) goes straight to the private vault repo, because losing it is the failure this
 * exists to prevent and there is no second audience to review it for.
 *
 * Two repositories rather than two branches of one: the docs repo is public, and every
 * branch of a public repo is public. The internal tree has no route into the docs repo —
 * not a fallback, not a default — so a missing vault remote skips the internal push
 * instead of publishing it.
 */

/** One remote the agent writes to: where it lives, which branch, which key. */
interface RepoTarget {
  url: string;
  workDir: string;
  branch: string;
  sshKey?: string;
}

function docsTarget(config: AppConfig): RepoTarget {
  const { url, workDir, base, sshKey } = config.docsRepo;
  if (!url) throw new Error("DOCS_REPO_URL is not set");
  return { url, workDir, branch: base, sshKey };
}

/** Undefined when no vault remote is configured — callers skip, never substitute. */
function vaultTarget(config: AppConfig): RepoTarget | undefined {
  const docs = config.docsRepo;
  if (!vaultRepoReady(docs) || !docs.vaultUrl) return undefined;
  return {
    url: docs.vaultUrl,
    workDir: docs.vaultWorkDir ?? path.join(path.dirname(docs.workDir), "vault-repo"),
    branch: docs.internalBranch,
    sshKey: docs.vaultSshKey,
  };
}

export interface PublishOutcome {
  /** Markdown for the ticket comment — always says what happened, including refusals. */
  comment: string;
  published: boolean;
  pullRequestUrl?: string;
}

/**
 * Usable copies of each deploy key, by the path they were configured at.
 *
 * The key reaches git through `core.sshCommand` in each clone's own config, not through
 * `GIT_SSH_COMMAND` on the process. Passing it per-exec only covered the git calls in THIS
 * file — `@scriptorium/publish` shells out to git itself — so it once had to be set
 * process-wide. With two repos that is wrong: GitHub binds a deploy key to one repository,
 * and a process-wide key sends the docs key to the vault remote. Clone-local config reaches
 * every git process run inside that clone, whoever spawns it.
 */
const usableKeys = new Map<string, string>();

/**
 * One work tree, one writer at a time.
 *
 * Every publish shares the git clones. The per-issue lock upstream serialises the wrong
 * axis: two DIFFERENT tickets approved seconds apart both checkout, copy and commit in the
 * same directory, and the second finds the first one's half-staged tree and refuses with
 * "work tree is not clean". Observed live — three approvals inside one second, one casualty.
 * Git is the shared resource, so the lock belongs to git, not to the ticket.
 *
 * Failures do not poison the queue: the next caller runs regardless of how the last ended.
 */
let repoQueue: Promise<unknown> = Promise.resolve();

function withRepoLock<T>(work: () => Promise<T>): Promise<T> {
  const run = repoQueue.then(work, work);
  repoQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * A key path ssh will actually accept.
 *
 * ssh refuses a private key that group or others can read, and Cloud Run mounts secrets
 * read-only at 0444 — so the correctly-mounted key was declined with "UNPROTECTED PRIVATE
 * KEY FILE" and the push failed as `Permission denied (publickey)`. The mount cannot be
 * chmod-ed, so copy it once to a private file and use that. Memoised: the copy is per
 * process, and re-copying on every git call would be pointless churn.
 */
async function privateKeyPath(keyPath: string): Promise<string> {
  const known = usableKeys.get(keyPath);
  if (known) return known;
  const stat = await fs.stat(keyPath);
  if ((stat.mode & 0o077) === 0) {
    usableKeys.set(keyPath, keyPath);
    return keyPath;
  }
  // A fresh 0700 directory, and the file created 0600: never, even for a moment, a copy of
  // the key that another user of the machine could read.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-deploy-key-"));
  const copy = path.join(dir, "key");
  await fs.writeFile(copy, await fs.readFile(keyPath), { mode: 0o600, flag: "wx" });
  console.log(`[docs] copied the deploy key to ${copy} with 0600 — ssh rejects the 0444 secret mount`);
  usableKeys.set(keyPath, copy);
  return copy;
}

/** GitHub's host keys, pinned in the repo (from api.github.com/meta). */
export const GITHUB_KNOWN_HOSTS = fileURLToPath(new URL("../ssh/github_known_hosts", import.meta.url));

/** The host an SSH remote names: `git@github.com:o/r.git`, `ssh://git@github.com/o/r`. */
function sshHost(url: string): string | undefined {
  return url.match(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)/)?.[1] ?? url.match(/^(?:[^@/]+@)?([^/:]+):(?!\/\/)/)?.[1];
}

const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

/**
 * The ssh command for one remote. A GitHub remote is checked against GitHub's pinned keys,
 * strictly: `accept-new` on a container that is always new trusts whatever answers first,
 * so one poisoned DNS answer would take the deploy key's pushes. Another host has nothing
 * pinned here; it keeps `accept-new`, and says so.
 */
export async function sshCommandFor(url: string, sshKey: string): Promise<string> {
  const key = `ssh -i ${quote(await privateKeyPath(sshKey))} -o IdentitiesOnly=yes`;
  if (sshHost(url)?.toLowerCase() === "github.com") {
    return `${key} -o UserKnownHostsFile=${quote(GITHUB_KNOWN_HOSTS)} -o StrictHostKeyChecking=yes`;
  }
  console.warn(`[docs] ${sshHost(url) ?? url} has no pinned host key; trusting the first one seen`);
  return `${key} -o StrictHostKeyChecking=accept-new`;
}

async function sshCommand(target: RepoTarget): Promise<string | undefined> {
  if (!target.sshKey) return undefined;
  return sshCommandFor(target.url, target.sshKey);
}

/**
 * Clone on first use, fetch afterwards. The clone is scratch — safe to delete.
 *
 * The clone's own `core.sshCommand` carries its key. `GIT_SSH_COMMAND` would override that
 * for every repo at once, so it is cleared when a key is configured.
 */
async function ensureRepo(config: AppConfig, target: RepoTarget): Promise<string> {
  const { url, workDir, branch } = target;
  const command = await sshCommand(target);
  if (command) delete process.env.GIT_SSH_COMMAND;

  const gitDir = path.join(workDir, ".git");
  try {
    await fs.access(gitDir);
    if (command) await exec("git", ["config", "core.sshCommand", command], { cwd: workDir });
    await exec("git", ["fetch", "origin", branch], { cwd: workDir });
  } catch {
    await fs.mkdir(path.dirname(workDir), { recursive: true });
    await fs.rm(workDir, { recursive: true, force: true });
    const withKey = command ? ["-c", `core.sshCommand=${command}`] : [];
    await exec("git", ["clone", ...withKey, "--branch", branch, url, workDir]);
  }
  // Identity must exist inside the clone — and it must be an identity GitHub can associate
  // with a user, or Vercel blocks the build with COMMIT_AUTHOR_REQUIRED and the published
  // doc never reaches the site. The approver's name is recorded in the commit message.
  await exec("git", ["config", "user.name", config.docsRepo.commitName], { cwd: workDir });
  await exec("git", ["config", "user.email", config.docsRepo.commitEmail], { cwd: workDir });
  return workDir;
}

export async function ensureDocsRepo(config: AppConfig): Promise<string> {
  return ensureRepo(config, docsTarget(config));
}

/** The vault clone, or undefined when no vault remote is configured. */
export async function ensureVaultRepo(config: AppConfig): Promise<string | undefined> {
  const target = vaultTarget(config);
  return target ? ensureRepo(config, target) : undefined;
}

const NO_VAULT_REPO =
  "VAULT_REPO_URL is not set, so the internal plane (PRDs, gaps, house rules) was not pushed anywhere — it never goes to the public docs repo";

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
  return withRepoLock(() => publishApprovedDocLocked(config, vault, input));
}

async function publishApprovedDocLocked(
  config: AppConfig,
  vault: Vault,
  input: { issueKey: string; issueUrl: string; slug: string; relPath: string; approvedBy: string; appliedLessons?: string[] },
): Promise<PublishOutcome> {

  // The note this approval is about must actually be in the vault, or "nothing to push"
  // and "already pushed" become the same answer. That is not hypothetical: a doc published
  // on one revision, whose push then failed, is gone from the next container's vault — and
  // the retry reported both trees "already up to date" and pushed nothing, because the repo
  // trivially matches a vault with no note in it. Reported as a refusal, so the retry flag
  // stays unset and the ticket says something a human can act on.
  try {
    await vault.readNote(input.relPath);
  } catch {
    return {
      comment: [
        `**Cannot publish \`${input.relPath}\`** — the vault copy is missing on this instance.`,
        "",
        "This happens when a doc was written on an earlier deployment whose push to the docs repo",
        "never landed: the note existed only in that container. Nothing was pushed and nothing was",
        "overwritten. Comment `draft` to regenerate it from the PRD, then `approve` again.",
      ].join("\n"),
      published: false,
    };
  }

  const repoDir = await ensureDocsRepo(config);
  const branch = docBranchName(input.issueKey, input.slug);
  const lines: string[] = [];

  // External first: it is the one a human still has to merge, so its result decides the tone.
  const external = await publishVault({
    vault,
    repoDir,
    target: "external",
    // No subdir: the vault path is already `docs/<slug>.md`, and prefixing again produced
    // `docs/docs/<slug>.md` in the repo — which the site then failed to build.
    subdir: undefined,
    branch,
    baseBranch: config.docsRepo.base,
    remote: "origin",
    approvedBy: input.approvedBy,
    message: `docs: ${input.slug} (${input.issueKey}, approved by ${input.approvedBy})`,
    // This ticket's doc, and nothing else: another approved doc waits for its own PR.
    only: [input.relPath],
  });
  lines.push(describe(external.push, "External docs"));

  // The internal tree goes to its own private repo or nowhere. The external publish above
  // stands either way: it carries nothing internal, and a human still has to merge it.
  //
  // A vault failure must not escape from here. The external branch is already pushed, and
  // a throw would skip the pull request below — then the retry finds the branch
  // `unchanged`, never opens the PR, and the doc waits for a merge nobody can see.
  let internal: Awaited<ReturnType<typeof publishVault>> | undefined;
  let internalError: string | undefined;
  const vaultConfigured = vaultRepoReady(config.docsRepo);
  if (vaultConfigured) {
    try {
      const vaultDir = await ensureVaultRepo(config);
      if (vaultDir) {
        internal = await publishVault({
          vault,
          repoDir: vaultDir,
          target: "internal",
          subdir: "internal",
          branch: config.docsRepo.internalBranch,
          remote: "origin",
          approvedBy: input.approvedBy,
          message: `vault: ${input.slug} (${input.issueKey})`,
        });
      }
    } catch (error) {
      internalError = error instanceof Error ? error.message.split("\n")[0] : String(error);
      console.warn(`[docs] vault repo push failed: ${internalError}`);
    }
  }
  if (internal) {
    lines.push(describe(internal.push, "Internal plane"));
  } else if (internalError !== undefined) {
    lines.push(`- Internal plane: **push failed** — could not reach the vault repo (${internalError})`);
  } else {
    console.warn(`[docs] ${NO_VAULT_REPO}`);
    lines.push(`- Internal plane: **not pushed** — ${NO_VAULT_REPO}`);
  }

  let pullRequestUrl: string | undefined;
  // `unchanged` counts: a retry after a crash between the push and the PR, or after a PR
  // that failed to open, finds the branch already holding the doc — and must still open
  // the PR, or the doc waits on a branch nobody was asked to merge.
  const externalOnBranch = external.push.status === "unchanged" || (external.push.status === "published" && external.push.pushed);
  let pullRequestFailed = false;

  if (externalOnBranch && config.docsRepo.slug) {
    try {
      // App credentials first: one repo, two permissions, hour-lived tokens, and the PR
      // shows as the app's own [bot] identity — the same split the Jira service account
      // makes visible. A PAT is the simpler fallback for a local run.
      const token =
        config.docsRepo.githubAppId && config.docsRepo.githubAppKey
          ? await installationToken({
              appId: config.docsRepo.githubAppId,
              privateKey: config.docsRepo.githubAppKey,
              repo: config.docsRepo.slug,
            })
          : config.docsRepo.token;
      if (token) {
        const pull = await openPullRequest({
          repo: config.docsRepo.slug,
          head: branch,
          base: config.docsRepo.base,
          title: `docs: ${input.slug} (${input.issueKey})`,
          body: docPullRequestBody({ ...input, approvedBy: input.approvedBy }),
          token,
        });
        pullRequestUrl = pull.url;
        lines.push(`- Pull request: ${pull.url} — merging it publishes to the site`);
      } else {
        lines.push(`- No GitHub App or token configured, so no PR was opened — merge \`${branch}\` into \`${config.docsRepo.base}\` to publish`);
      }
    } catch (error) {
      if (error instanceof GitHubError && error.status === 422 && /no commits between/i.test(error.message)) {
        // The branch holds nothing the base lacks: it was merged already.
        lines.push(`- \`${branch}\` is already merged into \`${config.docsRepo.base}\`; no pull request needed`);
      } else {
        // The doc is on the branch, but nobody has been asked to merge it: keep this
        // retryable, so the next \`approve\` opens the PR instead of saying "already published".
        pullRequestFailed = true;
        lines.push(`- Pull request could not be opened (${error instanceof Error ? error.message : String(error)}); the branch is pushed — comment \`approve\` again to retry, or merge \`${branch}\` by hand`);
      }
    }
  }
  if (internal?.push.status === "published") {
    lines.push(`- Internal site tracks \`${config.docsRepo.internalBranch}\`, so it is already live`);
  }

  const refused = external.push.status === "conflict" || internal?.push.status === "conflict";

  // The two targets are two renderings of ONE vault note, pushed in two separate commits.
  // That is not atomic: one can land while the other refuses, and then the public site and
  // the internal graph disagree about the same document with nothing to say so. The gate
  // compares each copy against what the agent last published FOR THAT TARGET, so neither
  // check can see the mismatch. Say it out loud instead.
  const landed = (status: string): boolean => status === "published" || status === "unchanged";
  // No vault repo is a configuration gap, reported above — not a divergence between two
  // copies, since only one copy exists.
  const inconsistent = internal !== undefined && landed(external.push.status) !== landed(internal.push.status);
  const heading = refused
    ? "**Publish refused — the docs repo has human edits I would have overwritten.**"
    : "**Pushed to the docs repo.**";

  if (inconsistent) {
    lines.push(
      "- ⚠️ **The two published copies now disagree**: one target landed and the other did not, so the public site and the internal graph are out of step for this doc. The vault note is unaffected — re-run `approve` once the refusal above is resolved.",
    );
  }

  return {
    comment: [heading, "", ...lines, "", refused ? "Nothing was force-pushed. Reconcile the diverged files and comment `approve` again." : "The vault note is the source; the site builds from the repo."].join("\n"),
    // "The egress is done", which is not the same as "this call pushed something". A
    // re-approval finds the external tree already up to date and reports `unchanged`;
    // reading that as failure left the retry flag unset forever, so every later `approve`
    // re-ran the whole push and the terminal "already published" reply was unreachable.
    // A configured vault repo that could not be reached keeps this retryable; an
    // unconfigured one is reported, not retried — there is nowhere to retry to.
    published: landed(external.push.status) && !pullRequestFailed && (internal ? landed(internal.push.status) : internalError === undefined),
    pullRequestUrl,
  };
}

/**
 * Push ONLY the internal plane — the durability call for state that must survive the
 * container. A lesson used to exist nowhere but the local vault between its proposal and
 * the next publish: a redeploy in that window deleted it, reset the id numbering, and the
 * next proposal reused L-001 for a different rule. Anything a human decided (a proposal
 * they will vote on, an approval they gave) is pushed the moment it exists.
 */
export async function pushInternalPlane(config: AppConfig, vault: Vault, message: string): Promise<boolean> {
  if (!vaultRepoReady(config.docsRepo)) {
    if (docsRepoReady(config.docsRepo)) console.warn(`[docs] ${NO_VAULT_REPO} (${message})`);
    return false;
  }
  return withRepoLock(() => pushInternalPlaneLocked(config, vault, message));
}

async function pushInternalPlaneLocked(config: AppConfig, vault: Vault, message: string): Promise<boolean> {
  try {
    const repoDir = await ensureVaultRepo(config);
    if (!repoDir) return false;
    const result = await publishVault({
      vault,
      repoDir,
      target: "internal",
      subdir: "internal",
      branch: config.docsRepo.internalBranch,
      remote: "origin",
      approvedBy: "scriptorium agent",
      message,
    });
    if (result.push.status === "conflict") {
      // A silent false here cost a human's lesson approval once: the push was refused,
      // nothing said so, and the next container swap rolled the decision back.
      console.warn(
        `[docs] internal-plane push REFUSED (${message}): ${result.push.diverged.map((item) => `${item.path} (${item.reason})`).join(", ")}`,
      );
    }
    return result.push.status === "published" || result.push.status === "unchanged";
  } catch (error) {
    // Durability is best-effort here; the lesson flow itself must not die on a push.
    console.warn(`[docs] internal-plane push failed: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

export interface DocsRepoChange {
  /** Vault notes updated from the repo — internal tree only, see below. */
  vaultUpdated: string[];
  /**
   * Published docs that changed on the base branch, per ticket. Reported, never imported.
   * `landed: true` means the change IS the agent's own publish arriving via its PR merge
   * — the copy on base now equals the publish branch tip — and the ticket hears "live",
   * not an edit warning.
   */
  externalEdited: Array<{ repoPath: string; issueKey?: string; landed: boolean }>;
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
 * Reads blobs with `git show` — published docs from the docs repo's `origin/<base>`, internal
 * notes from the vault repo's branch — so nothing is checked out and the
 * agent's own publish branch in the work tree is left alone.
 */
export async function syncFromDocsRepo(config: AppConfig, vault: Vault, paths: readonly string[]): Promise<DocsRepoChange> {
  if (!docsRepoReady(config.docsRepo)) return { vaultUpdated: [], externalEdited: [] };
  return withRepoLock(() => syncFromDocsRepoLocked(config, vault, paths));
}

async function syncFromDocsRepoLocked(config: AppConfig, vault: Vault, paths: readonly string[]): Promise<DocsRepoChange> {
  const change: DocsRepoChange = { vaultUpdated: [], externalEdited: [] };

  const repoDir = await ensureDocsRepo(config);
  const base = config.docsRepo.base;
  const internal = config.docsRepo.internalBranch;
  const vaultDir = paths.some((repoPath) => repoPath.startsWith("internal/")) ? await ensureVaultRepo(config) : undefined;
  await exec("git", ["fetch", "origin", base], { cwd: repoDir });

  for (const repoPath of paths) {
    // Internal content is read from the vault repo only; the public repo holds none.
    const isInternal = repoPath.startsWith("internal/") && vaultDir !== undefined;
    const isExternal = repoPath.startsWith("docs/");
    if (!isInternal && !isExternal) continue;

    let content: string;
    try {
      const [cwd, ref] = isInternal && vaultDir ? [vaultDir, `origin/${internal}`] : [repoDir, `origin/${base}`];
      const { stdout } = await exec("git", ["show", `${ref}:${repoPath}`], { cwd, maxBuffer: 8_000_000 });
      content = stdout;
    } catch {
      // Deleted upstream. Deleting vault notes on a remote delete is not something an
      // agent should decide by itself, so record nothing and move on.
      continue;
    }

    if (isInternal) {
      const relPath = repoPath.slice("internal/".length);
      const parsed = parseMarkdown(content);
      // The webhook path gets the same check as a restore: a push to the branch is not a
      // human approving a house rule.
      const frontmatter = untrustedApprovalsDowngraded(relPath, parsed.frontmatter, parsed.body, config.signingKey);
      await vault.writeNote(relPath, parsed.body, { ...frontmatter, edited_in_repo: new Date().toISOString() });
      change.vaultUpdated.push(relPath);
      continue;
    }

    let issueKey: string | undefined;
    let slug: string | undefined;
    try {
      const frontmatter = parseMarkdown(content).frontmatter;
      issueKey = typeof frontmatter.jira_issue === "string" ? frontmatter.jira_issue : undefined;
      slug = typeof frontmatter.slug === "string" ? frontmatter.slug : undefined;
    } catch {
      // Unparseable frontmatter: still a change worth reporting, just unattributable.
    }

    // A merge of the agent's own publish PR changes this file too — but that is the doc
    // LANDING, not a human editing it, and warning about an overwrite that isn't one
    // teaches people to ignore the warning. The tell is content: when main's copy now
    // equals the tip of the agent's publish branch, this change is the merge of that
    // branch. A real human edit differs from what the agent pushed, whichever route it
    // took into main.
    let landed = false;
    if (issueKey) {
      const branch = docBranchName(issueKey, slug ?? path.basename(repoPath, ".md"));
      await exec("git", ["fetch", "origin", branch], { cwd: repoDir }).catch(() => undefined);
      const branchCopy = await exec("git", ["show", `origin/${branch}:${repoPath}`], { cwd: repoDir, maxBuffer: 8_000_000 }).catch(
        () => undefined,
      );
      landed = branchCopy !== undefined && branchCopy.stdout === content;
    }
    change.externalEdited.push({ repoPath, issueKey, landed });
  }
  return change;
}

/**
 * Boot-time restore: rebuild the vault from the vault repo's internal tree.
 *
 * This is what makes "the vault is reconstructible from git" true rather than
 * aspirational. It reads `internal/**` — which carries the UNTRANSFORMED docs, PRDs, gap
 * notes, house rules and index — so a fresh container comes up with the same knowledge
 * plane it had before, and Curator can cite notes it never saw written.
 *
 * Presence is not enough to decide with: the note can be there and still be WRONG.
 * Restoring only what was missing left every published doc frozen at whatever the image
 * was built with. A doc revised and published after the build stayed correct on both
 * sites and stale in the vault, so the next deploy silently rolled Curator's answers back
 * — it told Slack a reminder arrives 1 hour before a maintenance window while citing the
 * live page, which said 24. A cited answer that contradicts its own citation is the one
 * failure this system cannot have.
 *
 * So the internal branch wins on content, not just on absence. That is the same rule
 * `syncFromDocsRepo` already applies to an internal note edited by a human — hydration
 * being the weaker of the two was the inconsistency, not the fix. Notes the branch does
 * not carry are never touched, and nothing is ever deleted.
 */
/**
 * A lesson or memory arriving from the docs repo as `approved` is believed only if it
 * carries a valid approval signature — the key is in the deployment, never in the repo, so
 * write access to the branch cannot mint a house rule. Anything else comes back as a
 * proposal, marked so a human can see why. Without a configured key there is nothing to
 * verify against, and the branch is trusted as before (see docs/security-model.md).
 */
export function untrustedApprovalsDowngraded(relPath: string, frontmatter: Frontmatter, body: string, signingKey: string | undefined): Frontmatter {
  if (!signingKey || frontmatter.status !== "approved" || !/^_(lessons|memory)\//.test(relPath)) return frontmatter;
  if (approvalVerified(frontmatter, body, signingKey)) return frontmatter;
  return { ...frontmatter, status: "proposed", restored_unverified: true };
}

export async function hydrateVaultFromDocsRepo(config: AppConfig, vault: Vault): Promise<string[]> {
  if (!vaultRepoReady(config.docsRepo)) {
    if (docsRepoReady(config.docsRepo)) console.warn(`[docs] VAULT_REPO_URL is not set — nothing to restore the vault from`);
    return [];
  }
  return withRepoLock(() => hydrateVaultFromDocsRepoLocked(config, vault));
}

async function hydrateVaultFromDocsRepoLocked(config: AppConfig, vault: Vault): Promise<string[]> {

  // The all-or-nothing guard that used to live here never fired in production: the image
  // ships a committed `vault/docs/*.md`, so the vault was never empty on boot and the
  // restore never ran. The notes that matter most are exactly the ones no image can carry
  // — `_lessons/` and `_gaps/`, both written after the image was built — so an approved
  // house rule silently stopped shaping drafts at the next deploy while still rendering on
  // the internal site. Restoring the missing ones fixed that half; this fixes the other.
  const repoDir = await ensureVaultRepo(config);
  if (!repoDir) return [];
  const base = config.docsRepo.internalBranch;
  await exec("git", ["fetch", "origin", base], { cwd: repoDir });

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
      // Compare what would be written against what is there, not the raw blob against the
      // file: the vault round-trips frontmatter through its own serialiser, so a note it
      // wrote itself is never byte-identical to the blob it came from. Comparing raw would
      // rewrite every note on every boot and report the whole vault as restored.
      const parsed = parseMarkdown(blob.stdout);
      const body = parsed.body;
      const frontmatter = untrustedApprovalsDowngraded(relPath, parsed.frontmatter, body, config.signingKey);
      const current = await vault.readNote(relPath).catch(() => undefined);
      if (current && current.body === body && JSON.stringify(current.frontmatter) === JSON.stringify(frontmatter)) {
        continue;
      }
      await vault.writeNote(relPath, body, frontmatter);
      restored.push(relPath);
    } catch {
      // One unreadable blob must not abort the restore.
    }
  }
  return restored;
}
