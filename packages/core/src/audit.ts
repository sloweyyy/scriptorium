import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface AuditEvent {
  type: string;
  actor?: string;
  [key: string]: unknown;
}

/** Append-only JSONL log — one line per gated action, never rewritten. */
export async function audit(file: string, event: AuditEvent): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
}

/**
 * Commit vault + audit changes so `git log` doubles as the tamper-evident history.
 * Non-fatal on failure (e.g. no git identity configured) — the demo must not crash on it.
 */
export async function commitVault(repoRoot: string, message: string): Promise<boolean> {
  try {
    await exec("git", ["add", "vault", "audit"], { cwd: repoRoot });
    await exec("git", ["commit", "-m", message, "--no-verify"], { cwd: repoRoot });
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!/nothing to commit|no changes added/.test(detail)) {
      console.warn(`[audit] git commit skipped: ${detail.split("\n")[0]}`);
    }
    return false;
  }
}
