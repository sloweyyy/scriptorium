import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Exactly-once side effects (ADR-001, invariant 5).
 *
 * Every write to the outside world — a Jira comment, a Slack post, a Confluence page
 * update — runs through `once` under an op-key derived from what caused it. The ledger
 * records the op as in-progress BEFORE acting and done AFTER. A crash in between leaves
 * it in-progress, and the retry asks the outside world (`probe`) whether the write
 * already landed before doing it again. That is the difference between exactly-once and
 * the at-most-once the poller had (mark processed, then act: a crash lost the `approve`)
 * or the at-least-once a naive retry gives (act again: a second comment).
 */

/** Deterministic: the same cause always yields the same op. */
export function opKey(...parts: Array<string | number | undefined>): string {
  return createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\u0000"))
    .digest("hex")
    .slice(0, 24);
}

export interface EffectRecord {
  op: string;
  status: "in-progress" | "done";
  startedAt: string;
  completedAt?: string;
  /** What the effect returned — replayed to the caller instead of acting again. */
  result?: unknown;
  /** Free-form context for an audit reader (which tool, which key). */
  meta?: Record<string, unknown>;
}

export interface EffectLedger {
  get(op: string): Promise<EffectRecord | undefined>;
  put(record: EffectRecord): Promise<void>;
  /** Ops a crash left half-done — what a restart must look at first. */
  inProgress(): Promise<EffectRecord[]>;
}

export class MemoryEffectLedger implements EffectLedger {
  private readonly records = new Map<string, EffectRecord>();
  async get(op: string): Promise<EffectRecord | undefined> {
    const record = this.records.get(op);
    return record && { ...record };
  }
  async put(record: EffectRecord): Promise<void> {
    this.records.set(record.op, { ...record });
  }
  async inProgress(): Promise<EffectRecord[]> {
    return [...this.records.values()].filter((record) => record.status === "in-progress");
  }
}

/** One JSON file, rewritten atomically; writes are serialized within the process. */
export class FileEffectLedger implements EffectLedger {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  private async load(): Promise<Record<string, EffectRecord>> {
    try {
      return JSON.parse(await fs.readFile(this.file, "utf8")) as Record<string, EffectRecord>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  async get(op: string): Promise<EffectRecord | undefined> {
    await this.chain;
    return (await this.load())[op];
  }

  put(record: EffectRecord): Promise<void> {
    const write = this.chain.then(async () => {
      const all = await this.load();
      all[record.op] = record;
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(all, null, 2));
      await fs.rename(tmp, this.file);
    });
    this.chain = write.catch(() => undefined);
    return write;
  }

  async inProgress(): Promise<EffectRecord[]> {
    await this.chain;
    return Object.values(await this.load()).filter((record) => record.status === "in-progress");
  }
}

export interface OnceOptions<T> {
  /**
   * Ask the outside world whether this op already landed (e.g. a Jira comment carrying
   * the op in its properties). Consulted only when a previous attempt was interrupted.
   * Without a probe, an interrupted op is retried — at-least-once, and the caller chose it.
   */
  probe?: () => Promise<T | undefined>;
  meta?: Record<string, unknown>;
}

export interface OnceResult<T> {
  result: T;
  /** True when nothing was done now: the effect had already happened. */
  replayed: boolean;
}

/**
 * In-process single flight per (ledger, op). Without it, two concurrent calls for the same
 * op both read "no record" and both act — the ledger only stops the retries that come
 * AFTER a record lands. The second caller now waits for the first and replays its result.
 */
const inFlight = new WeakMap<EffectLedger, Map<string, Promise<OnceResult<unknown>>>>();

export function once<T>(ledger: EffectLedger, op: string, act: () => Promise<T>, options: OnceOptions<T> = {}): Promise<OnceResult<T>> {
  let running = inFlight.get(ledger);
  if (!running) inFlight.set(ledger, (running = new Map()));
  const current = running.get(op);
  if (current) return current.then((first) => ({ result: first.result as T, replayed: true }));
  const attempt = onceUnshared(ledger, op, act, options).finally(() => running.delete(op));
  running.set(op, attempt as Promise<OnceResult<unknown>>);
  return attempt;
}

async function onceUnshared<T>(ledger: EffectLedger, op: string, act: () => Promise<T>, options: OnceOptions<T>): Promise<OnceResult<T>> {
  const existing = await ledger.get(op);
  if (existing?.status === "done") return { result: existing.result as T, replayed: true };

  if (existing?.status === "in-progress" && options.probe) {
    const landed = await options.probe();
    if (landed !== undefined) {
      await ledger.put({ ...existing, status: "done", completedAt: new Date().toISOString(), result: landed });
      return { result: landed, replayed: true };
    }
  }

  const startedAt = existing?.startedAt ?? new Date().toISOString();
  await ledger.put({ op, status: "in-progress", startedAt, meta: options.meta });
  // If `act` throws, the record stays in-progress on purpose: the write may have landed
  // before the error (a timeout after the server accepted it), and the retry must probe.
  const result = await act();
  await ledger.put({ op, status: "done", startedAt, completedAt: new Date().toISOString(), result, meta: options.meta });
  return { result, replayed: false };
}
