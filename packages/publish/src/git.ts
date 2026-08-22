import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Minimal git surface, shelling out the same way `commitVault` in `@scriptorium/core` does.
 * Unlike `commitVault` these calls are NOT best-effort: the publish path is fail-closed,
 * so a git failure has to surface rather than be warned about and swallowed.
 */
export async function git(cwd: string, args: string[]): Promise<string> {
  // gpgsign off: a signing prompt in a headless agent hangs the publish.
  const { stdout } = await exec("git", ["-c", "commit.gpgsign=false", ...args], { cwd });
  return stdout.trim();
}

/** Runs git and returns undefined instead of throwing — for existence probes only. */
export async function gitMaybe(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return await git(cwd, args);
  } catch {
    return undefined;
  }
}

/** The blob sha at `relPath` in `rev`, or undefined when the path is absent there. */
export async function blobAt(cwd: string, rev: string, relPath: string): Promise<string | undefined> {
  return gitMaybe(cwd, ["rev-parse", `${rev}:${relPath}`]);
}
