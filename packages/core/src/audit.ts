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
    return last ? lineHash(last) : "genesis";
  } catch {
    return "genesis";
  } finally {
    await handle?.close();
  }
}

/**
 * The hash the next line chains onto. For an erased line (a tombstone, see `eraseFromAudit`)
 * that is the hash of the line it replaced, which it carries: erasing removes the content,
 * not the link, so every other line still verifies and earlier extracts still match them.
 */
function lineHash(line: string): string {
  try {
    const parsed = JSON.parse(line) as { redacted?: unknown; hash?: unknown };
    if (parsed.redacted === true && typeof parsed.hash === "string" && /^[0-9a-f]{64}$/.test(parsed.hash)) return parsed.hash;
  } catch {
    // Not JSON: hashed as it stands, and verify reports it.
  }
  return sha256(line);
}

export type AuditVerdict = { ok: true; lines: number; chained: number; redacted: number } | { ok: false; line: number; reason: string };

/**
 * Does the chain hold? Lines written before the chain existed (no `prev`) are accepted only
 * as a prefix: once a chained line appears, every later line must chain.
 */
export function verifyAudit(text: string): AuditVerdict {
  const lines = text.split("\n").filter((line) => line.trim());
  let chained = 0;
  // Every erased line must be owned by a privacy.erased record: an erasure is on the record,
  // so a line blanked by hand with no such record is found.
  let redacted = 0;
  let accounted = 0;
  let lastRedacted = 0;
  for (const [index, line] of lines.entries()) {
    let prev: unknown;
    try {
      const parsed = JSON.parse(line) as { prev?: unknown; redacted?: unknown; type?: unknown; lines?: unknown };
      prev = parsed.prev;
      if (parsed.redacted === true) {
        redacted += 1;
        lastRedacted = index + 1;
      } else if (parsed.type === "privacy.erased" && typeof parsed.lines === "number") {
        accounted += parsed.lines;
      }
    } catch {
      return { ok: false, line: index + 1, reason: "not valid JSON" };
    }
    if (prev === undefined) {
      if (chained) return { ok: false, line: index + 1, reason: "an unchained line after the chain began" };
      continue;
    }
    const expected = index === 0 ? "genesis" : lineHash(lines[index - 1] as string);
    // The first chained line after a legacy prefix chains onto the last legacy line.
    if (prev !== expected && !(chained === 0 && index === 0 && prev === "genesis")) {
      return { ok: false, line: index + 1, reason: "does not follow the line before it (edited, removed or reordered)" };
    }
    chained += 1;
  }
  if (redacted > accounted) return { ok: false, line: lastRedacted, reason: "an erased line no privacy.erased record accounts for" };
  return { ok: true, lines: lines.length, chained, redacted };
}

/** Fields an erasure never removes: who approved a write stays on the record. */
const ACCOUNTABILITY = new Set(["approvedBy", "decidedBy", "approver", "approved_by"]);
/** What an erased line keeps: what happened and when, never anyone's words. */
const STRUCTURAL = new Set(["actor", "tool", "tier", "approval", "kind", "status", "provider", "rounds", "input", "output", "cacheRead", "cacheWrite", "repo", "number", "issueKey", "op"]);

export interface AuditErasure {
  text: string;
  /** Lines replaced by tombstones. */
  redacted: number;
  /** Lines kept because the person is on them only as the approver of a write. */
  approvals: number;
}

/**
 * Erase a person from the audit log, in place. Each line that mentions one of `ids` (anywhere
 * but an approver field) becomes a tombstone: its type, time and run, the structural fields
 * that don't name the person, the approver fields as they were, `redacted: true`, the hash of
 * the original line and its original `prev`. The chain still verifies, an edit to any other
 * line is still found, and every line not about the person is byte-for-byte unchanged.
 *
 * `ids` are bare account ids (`U123`, a Jira account id, a GitHub login), matched as whole
 * tokens, case-insensitively, anywhere in a value (so `slack:U123` and `<@U123>` match).
 * Pure: the caller writes the text and appends the `privacy.erased` record.
 */
export function eraseFromAudit(text: string, ids: readonly string[]): AuditErasure {
  const patterns = ids.filter((id) => id.length >= 2).map((id) => new RegExp(`(^|[^A-Za-z0-9_-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9_-])`, "i"));
  const mentions = (value: unknown): boolean => {
    if (typeof value === "string") return patterns.some((pattern) => pattern.test(value));
    if (Array.isArray(value)) return value.some(mentions);
    if (value && typeof value === "object") return Object.values(value).some(mentions);
    return false;
  };
  let redacted = 0;
  let approvals = 0;
  const out = text.split("\n").map((line) => {
    if (!line.trim() || !patterns.length) return line;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return line;
    }
    if (parsed.redacted === true) return line;
    const named = Object.entries(parsed).filter(([key]) => !ACCOUNTABILITY.has(key) && key !== "prev" && key !== "hash");
    if (!named.some(([, value]) => mentions(value))) {
      if (Object.entries(parsed).some(([key, value]) => ACCOUNTABILITY.has(key) && mentions(value))) approvals += 1;
      return line;
    }
    redacted += 1;
    const kept = Object.fromEntries(
      Object.entries(parsed).filter(([key, value]) => ACCOUNTABILITY.has(key) || (STRUCTURAL.has(key) && (typeof value === "number" || typeof value === "boolean" || (typeof value === "string" && !mentions(value))))),
    );
    const { ts, type, run, prev } = parsed;
    return JSON.stringify({ ts, type, ...(run ? { run } : {}), ...kept, redacted: true, hash: sha256(line), ...(prev !== undefined ? { prev } : {}) });
  });
  return { text: out.join("\n"), redacted, approvals };
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
