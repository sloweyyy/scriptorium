import type { AgentEvent } from "./event";

/**
 * Work, one lane per conversation.
 *
 * Batches are formed per key and run strictly one at a time per key, in arrival order, so a
 * ticket's `feedback` and `approve` can never race each other. A batch also holds the anchor
 * its events belong to: a Slack thread and the ticket it filed share an anchor, so their
 * events never run at once either. Different conversations run in parallel up to
 * `concurrency`, so one slow draft never stalls every other conversation.
 *
 * The key is always held, whatever the anchor. A thread that gains an anchor partway through
 * (a ticket it asked for was filed) still runs its next event after the turn in flight: the
 * lane of one key never changes mid-flight, so the same thread or ticket never runs twice at once.
 *
 * Coalescing: while a key is running, everything that arrives for it is batched into ONE
 * follow-up run. Five comments during a long draft cost one more run, not five.
 */

/** `key` is the batch's key. Each event still carries its own `key` for replies. */
export type Handler = (key: string, events: AgentEvent[]) => Promise<void>;

export interface QueueOptions {
  concurrency?: number;
  /** Called when a handler throws. The lane keeps going: one bad batch never wedges a key. */
  onError?: (key: string, error: unknown, events: AgentEvent[]) => void;
}

export class KeyedQueue {
  private readonly pending = new Map<string, AgentEvent[]>();
  /** Every lock a running batch holds (its key, its anchors), and the key holding it. */
  private readonly held = new Map<string, string>();
  /** The locks each running key holds, released together when its batch ends. */
  private readonly holding = new Map<string, Set<string>>();
  /** Keys with pending work, in the order they became ready. */
  private readonly ready: string[] = [];
  private active = 0;
  private stopped = false;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly handler: Handler,
    private readonly options: QueueOptions = {},
  ) {}

  /** Returns false once the queue is stopped: intake is closed, the event was not taken. */
  push(event: AgentEvent): boolean {
    if (this.stopped) return false;
    const batch = this.pending.get(event.key);
    if (batch) batch.push(event);
    else {
      this.pending.set(event.key, [event]);
      this.ready.push(event.key);
    }
    this.pump();
    return true;
  }

  /** Still taking events. Check before recording an event as seen: a refused push loses it. */
  get open(): boolean {
    return !this.stopped;
  }

  /** Number of keys with work running or waiting. */
  get size(): number {
    return new Set([...this.holding.keys(), ...this.pending.keys()]).size;
  }

  /**
   * Stop intake, then wait for in-flight AND already-accepted work to finish, up to the
   * deadline. Resolves `true` when drained, `false` when the deadline won — whatever is
   * left is for the next process to pick up from its own durable state.
   */
  async drain(deadlineMs: number): Promise<boolean> {
    this.stopped = true;
    if (this.isIdle()) return true;
    let timer: NodeJS.Timeout | undefined;
    const idle = new Promise<boolean>((resolve) => this.idleWaiters.push(() => resolve(true)));
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), deadlineMs);
    });
    const drained = await Promise.race([idle, timeout]);
    if (timer) clearTimeout(timer);
    return drained;
  }

  private isIdle(): boolean {
    return this.active === 0 && this.pending.size === 0;
  }

  /** The locks a batch needs: its key, and every anchor its events carry. */
  private locksFor(key: string, events: AgentEvent[]): string[] {
    return [key, ...new Set(events.flatMap((event) => (event.anchor ? [`anchor:${event.anchor}`] : [])))];
  }

  private pump(): void {
    const limit = this.options.concurrency ?? 2;
    // A key whose locks are taken keeps its place; a later key that is free may go first.
    for (let index = 0; index < this.ready.length && this.active < limit; ) {
      const key = this.ready[index] as string;
      const events = this.pending.get(key);
      if (!events) {
        this.ready.splice(index, 1);
        continue;
      }
      const locks = this.locksFor(key, events);
      if (locks.some((lock) => this.held.has(lock))) {
        index += 1;
        continue;
      }
      this.ready.splice(index, 1);
      this.pending.delete(key);
      for (const lock of locks) this.held.set(lock, key);
      this.holding.set(key, new Set(locks));
      this.active += 1;
      void this.run(key, events);
    }
    if (this.isIdle()) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  private async run(key: string, events: AgentEvent[]): Promise<void> {
    try {
      await this.handler(key, events);
    } catch (error) {
      try {
        this.options.onError?.(key, error, events);
      } catch {
        // Reporting is best-effort; the lane must survive its own error handler.
      }
    } finally {
      for (const lock of this.holding.get(key) ?? []) this.held.delete(lock);
      this.holding.delete(key);
      this.active -= 1;
      // Whatever arrived for this key while it ran is already in `ready`, behind its place.
      this.pump();
    }
  }
}
