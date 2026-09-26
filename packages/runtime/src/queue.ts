import type { AgentEvent } from "./event";

/**
 * Work, one lane per conversation.
 *
 * Events for the same key run strictly one batch at a time and in arrival order, so a
 * ticket's `feedback` and `approve` can never race each other. Different keys run in
 * parallel up to `concurrency`, so one slow draft never stalls every other conversation —
 * the failure mode of a single serial poll loop.
 *
 * Coalescing: while a key is running, everything that arrives for it is batched into ONE
 * follow-up run. Five comments during a long draft cost one more run, not five.
 */

export type Handler = (key: string, events: AgentEvent[]) => Promise<void>;

export interface QueueOptions {
  concurrency?: number;
  /** Called when a handler throws. The lane keeps going: one bad batch never wedges a key. */
  onError?: (key: string, error: unknown, events: AgentEvent[]) => void;
}

export class KeyedQueue {
  private readonly pending = new Map<string, AgentEvent[]>();
  private readonly running = new Set<string>();
  /** Keys with pending work waiting for a free slot, in the order they became ready. */
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
      if (!this.running.has(event.key)) this.ready.push(event.key);
    }
    this.pump();
    return true;
  }

  /** Number of keys with work running or waiting. */
  get size(): number {
    return new Set([...this.running, ...this.pending.keys()]).size;
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

  private pump(): void {
    const limit = this.options.concurrency ?? 2;
    while (this.active < limit && this.ready.length) {
      const key = this.ready.shift() as string;
      const events = this.pending.get(key);
      if (!events || this.running.has(key)) continue;
      this.pending.delete(key);
      this.running.add(key);
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
      this.running.delete(key);
      this.active -= 1;
      // Whatever arrived while this key was running is next in line for it.
      if (this.pending.has(key)) this.ready.push(key);
      this.pump();
    }
  }
}
