import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { mayApprove, type Approver, type Envelope, type ToolRule } from "./policy";

/**
 * Approvals bound to exactly what was shown (ADR-001, invariant 2).
 *
 * A request carries the hash of the tool's arguments. A decision approves THAT hash; a
 * call with different arguments — a revised draft, a different page, another channel — is
 * a different action and needs its own approval. That is what makes "approve publishes a
 * revision nobody saw" impossible by construction rather than by careful ordering.
 */

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type ApprovalStatus = "pending" | "approved" | "rejected" | "consumed" | "expired";

export interface ApprovalRequest {
  id: string;
  agent: string;
  tool: string;
  argsHash: string;
  /**
   * The exact arguments that were shown for approval. Kept so an approval can be carried
   * out when it is given — the model that asked has long since finished its turn — and so
   * a card can show precisely what is being approved.
   */
  args?: unknown;
  /** Human-readable summary of the action, shown on the approval card. */
  summary: string;
  /** Where the request lives (e.g. `jira:issue:DOC-1`) — the approval surface for it. */
  key: string;
  requestedBy?: string;
  requestedAt: string;
  expiresAt: string;
  status: ApprovalStatus;
  decidedBy?: Approver;
  decidedAt?: string;
}

/** Stable across key order, so `{a, b}` and `{b, a}` are the same action. */
export function argsHash(args: unknown): string {
  return createHash("sha256").update(canonical(args)).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export interface ApprovalStore {
  all(): Promise<ApprovalRequest[]>;
  save(request: ApprovalRequest): Promise<void>;
  /**
   * Atomic read-modify-write of one request: `change` sees the current value and returns the
   * next one, or undefined to leave it. Two approvers clicking at once, or a click racing a
   * run, must not both see "pending" and both proceed — so every state transition goes here.
   */
  update(id: string, change: (current: ApprovalRequest) => ApprovalRequest | undefined): Promise<ApprovalRequest | undefined>;
}

/** Serialises async critical sections within one process. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/** One JSON file, rewritten atomically — the ledger's pattern, and just as local. */
export class FileApprovalStore implements ApprovalStore {
  private readonly lock = new Mutex();
  constructor(private readonly file: string) {}

  private async read(): Promise<ApprovalRequest[]> {
    try {
      return JSON.parse(await fs.readFile(this.file, "utf8")) as ApprovalRequest[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async write(requests: ApprovalRequest[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(requests, null, 2));
    await fs.rename(tmp, this.file);
  }

  all(): Promise<ApprovalRequest[]> {
    return this.lock.run(() => this.read());
  }

  save(request: ApprovalRequest): Promise<void> {
    return this.lock.run(async () => {
      const rest = (await this.read()).filter((existing) => existing.id !== request.id);
      await this.write([...rest, request]);
    });
  }

  update(id: string, change: (current: ApprovalRequest) => ApprovalRequest | undefined): Promise<ApprovalRequest | undefined> {
    return this.lock.run(async () => {
      const all = await this.read();
      const index = all.findIndex((request) => request.id === id);
      const next = index >= 0 ? change(all[index] as ApprovalRequest) : undefined;
      if (!next) return undefined;
      all[index] = next;
      await this.write(all);
      return next;
    });
  }
}

export class MemoryApprovalStore implements ApprovalStore {
  private readonly requests = new Map<string, ApprovalRequest>();
  private readonly lock = new Mutex();
  all(): Promise<ApprovalRequest[]> {
    return this.lock.run(async () => [...this.requests.values()].map((request) => ({ ...request })));
  }
  save(request: ApprovalRequest): Promise<void> {
    return this.lock.run(async () => void this.requests.set(request.id, { ...request }));
  }
  update(id: string, change: (current: ApprovalRequest) => ApprovalRequest | undefined): Promise<ApprovalRequest | undefined> {
    return this.lock.run(async () => {
      const current = this.requests.get(id);
      const next = current ? change({ ...current }) : undefined;
      if (next) this.requests.set(id, { ...next });
      return next;
    });
  }
}

function live(request: ApprovalRequest, now: Date): ApprovalRequest {
  if ((request.status === "pending" || request.status === "approved") && Date.parse(request.expiresAt) <= now.getTime()) {
    return { ...request, status: "expired" };
  }
  return request;
}

export async function requestApproval(
  store: ApprovalStore,
  input: { agent: string; tool: string; args: unknown; summary: string; key: string; requestedBy?: string; rule: ToolRule },
  now = new Date(),
): Promise<{ request: ApprovalRequest; created: boolean }> {
  const hash = argsHash(input.args);
  // Asking twice for the same action is one request, not two cards.
  const existing = (await store.all())
    .map((request) => live(request, now))
    .find((request) => request.agent === input.agent && request.tool === input.tool && request.argsHash === hash && request.status === "pending");
  if (existing) return { request: existing, created: false };

  const request: ApprovalRequest = {
    id: randomUUID(),
    agent: input.agent,
    tool: input.tool,
    argsHash: hash,
    args: input.args,
    summary: input.summary,
    key: input.key,
    requestedBy: input.requestedBy,
    requestedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (input.rule.ttlMs ?? DEFAULT_TTL_MS)).toISOString(),
    status: "pending",
  };
  await store.save(request);
  return { request, created: true };
}

export type DecisionResult = { ok: true; request: ApprovalRequest } | { ok: false; reason: string };

/** A human decides. Who may, and whether it still can be decided, is checked here — once. */
export async function decideApproval(
  store: ApprovalStore,
  envelope: Envelope,
  id: string,
  decision: "approved" | "rejected",
  approver: Approver | undefined,
  now = new Date(),
): Promise<DecisionResult> {
  let refusal = "no such approval request";
  // Checked and decided in ONE atomic step: two clicks can't both find it pending.
  const decided = await store.update(id, (found) => {
    const request = live(found, now);
    if (request.status !== "pending") {
      refusal = `this request is already ${request.status}`;
      return undefined;
    }
    const rule = envelope.tools[request.tool];
    if (!rule || rule.tier !== "approve") {
      refusal = `${request.tool} is not an approvable action for ${envelope.agent}`;
      return undefined;
    }
    const allowed = mayApprove(envelope, rule, approver, request.requestedBy);
    if (!allowed.ok) {
      refusal = allowed.reason;
      return undefined;
    }
    return { ...request, status: decision, decidedBy: approver, decidedAt: now.toISOString() };
  });
  return decided ? { ok: true, request: decided } : { ok: false, reason: refusal };
}

/**
 * Spend an approval: exactly one run per decision, and only for the exact arguments that
 * were approved. Returns the consumed request, or undefined when there is nothing to spend.
 */
export async function consumeApproval(
  store: ApprovalStore,
  input: { agent: string; tool: string; args: unknown },
  now = new Date(),
): Promise<ApprovalRequest | undefined> {
  const hash = argsHash(input.args);
  const candidates = (await store.all())
    .map((request) => live(request, now))
    .filter((request) => request.agent === input.agent && request.tool === input.tool && request.argsHash === hash && request.status === "approved");
  for (const candidate of candidates) {
    // Spent atomically: of two runs racing for one approval, exactly one gets it.
    const consumed = await store.update(candidate.id, (current) =>
      live(current, now).status === "approved" && current.argsHash === hash ? { ...current, status: "consumed" } : undefined,
    );
    if (consumed) return consumed;
  }
  return undefined;
}
