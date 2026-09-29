import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * One instance runs the scheduled work (ADR-002).
 *
 * Cloud Run runs the old and new revisions side by side on every deploy, over one shared
 * state volume. Without this, both ran the digest, the reminders and the approval nudges,
 * and the new one's boot sweep closed the old one's live "Looking into it…" placeholders.
 *
 * A lease is a small file: who holds it, and until when. The holder renews it on each tick;
 * another instance takes it over only once it has expired. Writes are atomic (tmp + rename),
 * and a read-back after a short pause catches a concurrent writer. The remaining race (two
 * instances finding it expired in the same instant) is a millisecond window, once, at a
 * handover; a CAS on the storage layer is the path if that ever matters.
 */
export interface LeaseState {
  owner: string;
  until: string;
}

export class Lease {
  readonly owner: string;
  private held = false;

  constructor(
    private readonly file: string,
    private readonly ttlMs = 180_000,
    owner = `${process.pid}-${randomUUID().slice(0, 8)}`,
    private readonly settleMs = 150,
  ) {
    this.owner = owner;
  }

  /** Who holds it now, if anyone holds a lease that hasn't expired. */
  async holder(now = Date.now()): Promise<LeaseState | undefined> {
    const state = await this.read();
    return state && Date.parse(state.until) > now ? state : undefined;
  }

  /**
   * True when this instance holds the lease after the call: it renewed its own, took over an
   * expired one, or found none. False while another instance's lease is still live.
   */
  async acquire(now = Date.now()): Promise<boolean> {
    const current = await this.read();
    if (current && current.owner !== this.owner && Date.parse(current.until) > now) {
      this.held = false;
      return false;
    }
    await this.write({ owner: this.owner, until: new Date(now + this.ttlMs).toISOString() });
    // Read back after a moment: a concurrent writer that won the race shows up here.
    if (this.settleMs) await new Promise((resolve) => setTimeout(resolve, this.settleMs));
    const after = await this.read();
    this.held = after?.owner === this.owner;
    return this.held;
  }

  /** Whether the last acquire succeeded (no I/O). */
  get isHeld(): boolean {
    return this.held;
  }

  /** Let go at shutdown, so the next revision doesn't wait out the TTL. */
  async release(): Promise<void> {
    const current = await this.read();
    if (current?.owner === this.owner) await fs.rm(this.file, { force: true }).catch(() => undefined);
    this.held = false;
  }

  private async read(): Promise<LeaseState | undefined> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as Partial<LeaseState>;
      return typeof parsed.owner === "string" && typeof parsed.until === "string" ? { owner: parsed.owner, until: parsed.until } : undefined;
    } catch {
      return undefined;
    }
  }

  private async write(state: LeaseState): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${this.owner}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state));
    await fs.rename(tmp, this.file);
  }
}
