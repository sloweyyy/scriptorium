import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { currentRunId } from "./run";

const exec = promisify(execFile);

export interface AuditEvent {
  type: string;
  actor?: string;
  [key: string]: unknown;
}

/**
 * Append-only JSONL log — one line per gated action, never rewritten.
 *
 * Hash-chained: each line carries `prev`, the sha256 of the line before it (`genesis` for
 * the first). An edited or deleted line breaks every `prev` after it, which `verifyAudit`
 * (and `pnpm auditlog verify`) finds. Appends to one file are serialised in-process, so two
 * concurrent events can't both chain onto the same predecessor.
 */
export async function audit(file: string, event: AuditEvent): Promise<void> {
  const resolved = path.resolve(file);
  const previous = appending.get(resolved) ?? Promise.resolve();
  const next = previous.then(async () => {
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    const run = currentRunId();
    // `prev` is the chain field: an event can't supply its own.
    const { prev: _ignored, ...fields } = event;
    // Read from the file every time, not cached: the file is the record, whatever else wrote to it.
    const prev = await tailHash(resolved);
    const line = JSON.stringify({ ts: new Date().toISOString(), ...(run ? { run } : {}), ...fields, prev });
    await fs.appendFile(resolved, `${line}\n`);
  });
  appending.set(resolved, next.catch(() => undefined));
  return next;
}

const appending = new Map<string, Promise<unknown>>();

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The hash of the file's last line, read from its tail — or `genesis` for a new file. */
async function tailHash(file: string): Promise<string> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, "r");
    const { size } = await handle.stat();
    const length = Math.min(size, 64 * 1024);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const last = buffer.toString("utf8").split("\n").filter((line) => line.trim()).at(-1);
    return last ? sha256(last) : "genesis";
  } catch {
    return "genesis";
  } finally {
    await handle?.close();
  }
}

export type AuditVerdict = { ok: true; lines: number; chained: number } | { ok: false; line: number; reason: string };

/**
 * Does the chain hold? Lines written before the chain existed (no `prev`) are accepted only
 * as a prefix: once a chained line appears, every later line must chain.
 */
export function verifyAudit(text: string): AuditVerdict {
  const lines = text.split("\n").filter((line) => line.trim());
  let chained = 0;
  for (const [index, line] of lines.entries()) {
    let prev: unknown;
    try {
      prev = (JSON.parse(line) as { prev?: unknown }).prev;
    } catch {
      return { ok: false, line: index + 1, reason: "not valid JSON" };
    }
    if (prev === undefined) {
      if (chained) return { ok: false, line: index + 1, reason: "an unchained line after the chain began" };
      continue;
    }
    const expected = index === 0 ? "genesis" : sha256(lines[index - 1] as string);
    // The first chained line after a legacy prefix chains onto the last legacy line.
    if (prev !== expected && !(chained === 0 && index === 0 && prev === "genesis")) {
      return { ok: false, line: index + 1, reason: "does not follow the line before it (edited, removed or reordered)" };
    }
    chained += 1;
  }
  return { ok: true, lines: lines.length, chained };
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
