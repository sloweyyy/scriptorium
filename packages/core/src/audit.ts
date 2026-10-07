import { execFile } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
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
    // Read from the file every time, not cached: the file is the record, whatever else wrote to it.
    const prev = await tailHash(resolved);
    await fs.appendFile(resolved, `${auditLine(event, prev, run)}\n`);
  });
  appending.set(resolved, next.catch(() => undefined));
  return next;
}

const appending = new Map<string, Promise<unknown>>();

/** One chained line. `prev` is the chain field: an event can't supply its own. */
function auditLine(event: AuditEvent, prev: string, run?: string): string {
  const { prev: _ignored, ...fields } = event;
  return JSON.stringify({ ts: new Date().toISOString(), ...(run ? { run } : {}), ...fields, prev });
}

/**
 * Run `fn` with this process's appends to `file` held, for a writer that replaces the file
 * (an erasure): no `audit()` call can land between its read and its rename.
 */
export async function withAuditLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const resolved = path.resolve(file);
  const previous = appending.get(resolved) ?? Promise.resolve();
  const next = previous.then(fn);
  appending.set(resolved, next.catch(() => undefined));
  return next;
}

/** `text` with one more line chained onto its last: what `audit()` would append, as text. */
export function appendAuditLine(text: string, event: AuditEvent): string {
  const last = text.split("\n").filter((line) => line.trim()).at(-1);
  const body = text && !text.endsWith("\n") ? `${text}\n` : text;
  return `${body}${auditLine(event, last ? lineHash(last) : "genesis", currentRunId())}\n`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The hash of the file's last line — or `genesis` for a new file. Read backwards in chunks
 * until the whole last line is in hand: a fixed 64 KiB window hashed a fragment of any
 * longer line (one revision's feedback batch can be), so the next line chained onto
 * nothing, verify failed there, and nothing after it could be checked again.
 */
async function tailHash(file: string): Promise<string> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, "r");
    const last = await lastLine(handle, (await handle.stat()).size);
    return last ? lineHash(last) : "genesis";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "genesis";
    throw error;
  } finally {
    await handle?.close();
  }
}

const TAIL_CHUNK = 64 * 1024;

/** The last line with content, however long. Splits on the newline byte, which no UTF-8 sequence contains. */
async function lastLine(handle: fs.FileHandle, size: number): Promise<string | undefined> {
  let tail = Buffer.alloc(0);
  let start = size;
  while (true) {
    let end = tail.length;
    while (end > 0) {
      const newline = tail.lastIndexOf(0x0a, end - 1);
      const line = tail.subarray(newline + 1, end).toString("utf8");
      if (line.trim()) {
        // Whole only once the newline before it, or the file's start, is in hand.
        if (newline >= 0 || start === 0) return line;
        break;
      }
      if (newline < 0) break;
      end = newline;
    }
    if (start === 0) return undefined;
    const from = Math.max(0, start - TAIL_CHUNK);
    const piece = Buffer.alloc(start - from);
    await handle.read(piece, 0, piece.length, from);
    tail = Buffer.concat([piece, tail]);
    start = from;
  }
}

/** The hash a line after this one chains onto, for an extract's anchor. */
export function auditLineHash(line: string): string {
  return lineHash(line);
}

/**
 * The key an export's HMAC uses: derived from the signing key, never the signing key
 * itself. Whoever is handed it to check an extract can't sign an approval or a control.
 */
export function auditExportKey(signingKey: string | undefined): string | undefined {
  return signingKey ? createHmac("sha256", signingKey).update("scriptorium audit export v1").digest("hex") : undefined;
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
export function verifyAudit(text: string, options: { anchor?: string } = {}): AuditVerdict {
  const lines = text.split("\n").filter((line) => line.trim());
  let chained = 0;
  // Every erased line must be owned by a privacy.erased record: an erasure is on the record,
  // so a line blanked by hand with no such record is found. A record names the digest of
  // each tombstone it wrote, so a tombstone edited afterwards is found too; records written
  // before digests existed account by count.
  const tombstones: Array<{ line: number; digest: string }> = [];
  const recorded = new Set<string>();
  let counted = 0;
  for (const [index, line] of lines.entries()) {
    let prev: unknown;
    try {
      const parsed = JSON.parse(line) as { prev?: unknown; redacted?: unknown; type?: unknown; lines?: unknown; tombstones?: unknown };
      prev = parsed.prev;
      if (parsed.redacted === true) {
        tombstones.push({ line: index + 1, digest: sha256(line) });
      } else if (parsed.type === "privacy.erased") {
        if (Array.isArray(parsed.tombstones)) {
          for (const digest of parsed.tombstones) if (typeof digest === "string") recorded.add(digest);
        } else if (typeof parsed.lines === "number") {
          counted += parsed.lines;
        }
      }
    } catch {
      return { ok: false, line: index + 1, reason: "not valid JSON" };
    }
    if (prev === undefined) {
      if (chained) return { ok: false, line: index + 1, reason: "an unchained line after the chain began" };
      continue;
    }
    // An extract starts mid-chain: its first line follows the anchor it was exported with.
    const expected = index === 0 ? (options.anchor ?? "genesis") : lineHash(lines[index - 1] as string);
    // The first chained line after a legacy prefix chains onto the last legacy line.
    if (prev !== expected && !(chained === 0 && index === 0 && prev === "genesis")) {
      return { ok: false, line: index + 1, reason: "does not follow the line before it (edited, removed or reordered)" };
    }
    chained += 1;
  }
  // An extract can't account for erasures whose records fall outside it; the full log must.
  if (options.anchor === undefined) {
    let unrecorded = 0;
    for (const tombstone of tombstones) {
      if (recorded.has(tombstone.digest)) continue;
      unrecorded += 1;
      if (unrecorded > counted) return { ok: false, line: tombstone.line, reason: "an erased line no privacy.erased record accounts for (or one edited after it was erased)" };
    }
  }
  return { ok: true, lines: lines.length, chained, redacted: tombstones.length };
}

/** Fields an erasure never removes: who approved a write stays on the record. */
const ACCOUNTABILITY = new Set(["approvedBy", "decidedBy", "approver", "approved_by"]);
/** What an erased line keeps: what happened and when, never anyone's words. */
const STRUCTURAL = new Set(["actor", "tool", "tier", "approval", "kind", "status", "provider", "rounds", "input", "output", "cacheRead", "cacheWrite", "repo", "number", "issueKey", "op"]);

export interface AuditErasure {
  text: string;
  /** Lines replaced by tombstones. */
  redacted: number;
  /**
   * sha256 of each tombstone written, for the `privacy.erased` record. A tombstone's chain
   * link is the hash of the line it replaced, so nothing else covers what it kept (who
   * approved, which tool): with these on a chained record, editing a tombstone is found.
   */
  tombstones: string[];
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
  const tombstones: string[] = [];
  const out = text.split("\n").map((line) => {
    if (!line.trim() || !patterns.length) return line;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return line;
    }
    // Already a tombstone, or the record of an erasure (it names the operator who ran it, as
    // accountability; tombstoning it would lose the count that accounts for its tombstones).
    if (parsed.redacted === true || parsed.type === "privacy.erased") return line;
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
    const tombstone = JSON.stringify({ ts, type, ...(run ? { run } : {}), ...kept, redacted: true, hash: sha256(line), ...(prev !== undefined ? { prev } : {}) });
    tombstones.push(sha256(tombstone));
    return tombstone;
  });
  return { text: out.join("\n"), redacted, approvals, tombstones };
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
