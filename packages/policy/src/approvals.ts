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
}

/** One JSON file, rewritten atomically — the ledger's pattern, and just as local. */
export class FileApprovalStore implements ApprovalStore {
  constructor(private readonly file: string) {}

  async all(): Promise<ApprovalRequest[]> {
    try {
      return JSON.parse(await fs.readFile(this.file, "utf8")) as ApprovalRequest[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async save(request: ApprovalRequest): Promise<void> {
    const rest = (await this.all()).filter((existing) => existing.id !== request.id);
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify([...rest, request], null, 2));
    await fs.rename(tmp, this.file);
  }
}

export class MemoryApprovalStore implements ApprovalStore {
  private readonly requests = new Map<string, ApprovalRequest>();
  async all(): Promise<ApprovalRequest[]> {
    return [...this.requests.values()];
  }
  async save(request: ApprovalRequest): Promise<void> {
    this.requests.set(request.id, { ...request });
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
  const found = (await store.all()).find((request) => request.id === id);
  if (!found) return { ok: false, reason: "no such approval request" };
  const request = live(found, now);
  if (request.status !== "pending") return { ok: false, reason: `this request is already ${request.status}` };
  const rule = envelope.tools[request.tool];
  if (!rule || rule.tier !== "approve") return { ok: false, reason: `${request.tool} is not an approvable action for ${envelope.agent}` };
  const allowed = mayApprove(envelope, rule, approver, request.requestedBy);
  if (!allowed.ok) return allowed;

  const decided: ApprovalRequest = { ...request, status: decision, decidedBy: approver, decidedAt: now.toISOString() };
  await store.save(decided);
  return { ok: true, request: decided };
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
  const approved = (await store.all())
    .map((request) => live(request, now))
    .find((request) => request.agent === input.agent && request.tool === input.tool && request.argsHash === hash && request.status === "approved");
  if (!approved) return undefined;
  const consumed: ApprovalRequest = { ...approved, status: "consumed" };
  await store.save(consumed);
  return consumed;
}
