import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Vault } from "@scriptorium/core";
import type { PublishTarget } from "./allowlist";
import { blobAt, git, gitMaybe } from "./git";
import { stageVault, type StageResult } from "./stage";

/**
 * Trailer stamped on every publish commit. It is how the agent finds its OWN last publish
 * commit later — the baseline the divergence gate compares against. Matched with
 * `--fixed-strings`, so keep it literal.
 */
export const PUBLISH_TRAILER_KEY = "Scriptorium-Publish";

export function publishTrailer(target: PublishTarget): string {
  return `${PUBLISH_TRAILER_KEY}: ${target}`;
}

export type DivergenceReason = "modified-by-human" | "created-by-human" | "deleted-by-human";

export interface DivergedPath {
  /** Repo-relative path. */
  path: string;
  reason: DivergenceReason;
  baselineBlob?: string;
  headBlob?: string;
}

export interface PublishToRepoInput {
  /** Work tree of the docs repo clone. */
  repoDir: string;
  target: PublishTarget;
  /** Directory produced by `stageVault`. */
  stagedDir: string;
  /** Vault-relative paths inside `stagedDir` — `StageResult.files`. */
  files: readonly string[];
  /** Where the staged tree lands inside the repo (e.g. `src/content/docs`). Default: root. */
  subdir?: string;
  /** Branch to publish onto. Default: the branch the work tree is on. */
  branch?: string;
  remote?: string;
  approvedBy: string;
  message?: string;
  /** Pull-rebase before the gate so a human's pushed commit is visible. Default true. */
  pull?: boolean;
  /** Default true. Never a force push. */
  push?: boolean;
}

export interface PublishToRepoBase {
  target: PublishTarget;
  branch: string;
  /** The agent's own last publish commit, or undefined on a first publish. */
  baseline?: string;
}

export type PublishToRepoResult =
  | (PublishToRepoBase & { status: "conflict"; diverged: DivergedPath[]; committed: false; pushed: false })
  | (PublishToRepoBase & { status: "unchanged"; committed: false; pushed: false })
  | (PublishToRepoBase & { status: "published"; commit: string; changed: string[]; committed: true; pushed: boolean })
  | (PublishToRepoBase & { status: "push-failed"; commit: string; changed: string[]; committed: true; pushed: false; error: string });

function repoPath(subdir: string | undefined, relPath: string): string {
  return subdir ? path.posix.join(subdir, relPath) : relPath;
}

/**
 * Find the agent's own last publish commit for this target. Git is the baseline: not the
 * vault copy (which has moved on since that publish) and not a stored path (which holds a
 * path, not content).
 */
export async function lastPublishCommit(
  repoDir: string,
  target: PublishTarget,
  rev = "HEAD",
): Promise<string | undefined> {
  const found = await gitMaybe(repoDir, [
    "log",
    "-n",
    "1",
    "--format=%H",
    "--fixed-strings",
    `--grep=${publishTrailer(target)}`,
    rev,
  ]);
  return found ? found : undefined;
}

/**
 * The divergence gate.
 *
 * For every path this publish would overwrite, compare the blob at HEAD with the blob at
 * the same path in the agent's own last publish commit. Equal means nobody has touched the
 * file since the agent wrote it and overwriting is safe. Anything else — changed, newly
 * created by someone else, or deleted — means a human commit sits on top of the agent's
 * content, and the publish must refuse.
 *
 * Why the pull-rebase is not enough: the agent rewrites each file wholesale from the vault.
 * A human edit to the same file rebases cleanly (the agent's commit lands on top of the
 * human's, no textual conflict, because the agent's version replaces the whole file) and
 * the human's edit disappears without git ever reporting anything. Rebase protects commit
 * ordering; only this blob comparison protects content.
 *
 * First publish (no baseline commit) with a path already present in HEAD refuses too: the
 * agent has never published there, so whatever is there is somebody else's. Deliberately
 * fail-closed.
 */
export async function detectDivergence(
  repoDir: string,
  paths: readonly string[],
  baseline: string | undefined,
): Promise<DivergedPath[]> {
  const diverged: DivergedPath[] = [];
  for (const target of paths) {
    const headBlob = await blobAt(repoDir, "HEAD", target);
    if (!baseline) {
      if (headBlob) diverged.push({ path: target, reason: "created-by-human", headBlob });
      continue;
    }
    const baselineBlob = await blobAt(repoDir, baseline, target);
    if (!baselineBlob) {
      if (headBlob) diverged.push({ path: target, reason: "created-by-human", headBlob });
      continue;
    }
    if (!headBlob) {
      diverged.push({ path: target, reason: "deleted-by-human", baselineBlob });
      continue;
    }
    if (headBlob !== baselineBlob) {
      diverged.push({ path: target, reason: "modified-by-human", baselineBlob, headBlob });
    }
  }
  return diverged;
}

/**
 * Copy a staged tree into the docs repo and commit + push it, refusing on divergence.
 *
 * Nothing is written into the work tree until the gate has passed, so a conflict result is
 * literally "no files touched, no commit, no push".
 */
export async function publishToRepo(input: PublishToRepoInput): Promise<PublishToRepoResult> {
  const { repoDir, target, stagedDir, files, subdir, approvedBy } = input;
  const remote = input.remote ?? "origin";
  const branch = input.branch ?? (await git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]));

  // An already-dirty work tree is an operator error, not a human-edit divergence: the gate
  // reasons about committed blobs, so uncommitted work at a target path would be clobbered
  // invisibly. Refuse loudly instead.
  const dirty = await git(repoDir, ["status", "--porcelain"]);
  if (dirty) throw new Error(`publish: docs repo work tree is not clean (${repoDir}):\n${dirty}`);

  if (input.pull !== false) {
    // Pull FIRST: the human commit the gate has to see may only exist on the remote.
    await git(repoDir, ["pull", "--rebase", remote, branch]);
  }

  const baseline = await lastPublishCommit(repoDir, target);
  const targetPaths = files.map((relPath) => repoPath(subdir, relPath));
  const diverged = await detectDivergence(repoDir, targetPaths, baseline);
  if (diverged.length) {
    return { status: "conflict", target, branch, baseline, diverged, committed: false, pushed: false };
  }

  // Copy file by file from the include-list — never a recursive directory copy, even here
  // where the source is a staged tree that gate 1 already proved clean.
  for (const relPath of files) {
    const to = path.join(repoDir, repoPath(subdir, relPath));
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(path.join(stagedDir, relPath), to);
  }

  if (targetPaths.length) await git(repoDir, ["add", "--", ...targetPaths]);
  const changed = (await git(repoDir, ["diff", "--cached", "--name-only"])).split("\n").filter(Boolean);
  if (!changed.length) return { status: "unchanged", target, branch, baseline, committed: false, pushed: false };

  const subject = input.message ?? `docs: publish ${target} vault (approved by ${approvedBy})`;
  await git(repoDir, ["commit", "-m", `${subject}\n\n${publishTrailer(target)}\nApproved-By: ${approvedBy}`, "--no-verify"]);
  const commit = await git(repoDir, ["rev-parse", "HEAD"]);

  if (input.push === false) {
    return { status: "published", target, branch, baseline, commit, changed, committed: true, pushed: false };
  }
  try {
    // Plain push. If the remote moved between the pull and here, this is rejected and we
    // report it — never a force push, never a retry loop.
    await git(repoDir, ["push", remote, `HEAD:refs/heads/${branch}`]);
  } catch (error) {
    return {
      status: "push-failed",
      target,
      branch,
      baseline,
      commit,
      changed,
      committed: true,
      pushed: false,
      error: error instanceof Error ? error.message.split("\n")[0] ?? error.message : String(error),
    };
  }
  return { status: "published", target, branch, baseline, commit, changed, committed: true, pushed: true };
}

export interface PublishVaultInput extends Omit<PublishToRepoInput, "stagedDir" | "files"> {
  vault: Vault;
}

export interface PublishVaultResult {
  stage: StageResult;
  push: PublishToRepoResult;
}

/** Stage the include-list into a temp dir, then publish it. The temp dir never survives. */
export async function publishVault(input: PublishVaultInput): Promise<PublishVaultResult> {
  const destDir = await fs.mkdtemp(path.join(os.tmpdir(), `scriptorium-publish-${input.target}-`));
  try {
    const stage = await stageVault({ vault: input.vault, target: input.target, destDir });
    const push = await publishToRepo({ ...input, stagedDir: destDir, files: stage.files });
    return { stage, push };
  } finally {
    await fs.rm(destDir, { recursive: true, force: true });
  }
}
