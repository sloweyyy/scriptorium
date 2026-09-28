import fs from "node:fs";
import path from "node:path";
import type { AgentEvent, EventSource } from "./event";

/**
 * The intake gate: which events an agent even looks at.
 *
 * Every refusal carries a reason, and the reason is the point — "the bot ignored me" is
 * the most common report from anyone using an agent unsupervised, and without a reason in
 * the log there is nothing to answer it with.
 */

export interface GateRules {
  /** Accounts the platform itself acts as. Never react to your own output. */
  selfIds: readonly string[];
  /** React to other bots? Default no: two agents replying to each other is a loop. */
  allowBots?: boolean;
  /**
   * Where each source may be heard, as key prefixes (e.g. `slack:thread:C123/`,
   * `jira:issue:DOC-`). A source with no entry is heard everywhere; an empty list, nowhere.
   */
  scopes?: Partial<Record<EventSource, readonly string[]>>;
}

export type GateResult = { accepted: true } | { accepted: false; reason: string };

/** Where accepted delivery ids are remembered. */
export interface SeenIds {
  has(id: string): boolean;
  add(id: string): void;
}

/**
 * Delivery ids that outlive the process. In memory only, a Slack retry that reached a
 * restarted instance (a deploy, a crash) was a new event, and the question was answered
 * twice. Slack retries within minutes, so a short window is enough. Written synchronously,
 * before the event is worked, so a crash mid-answer can't lose the record of it. Per host:
 * two instances at once each keep their own (run one).
 */
export class FileSeenIds implements SeenIds {
  private readonly ids: string[];
  private readonly set: Set<string>;
  constructor(
    private readonly file: string,
    private readonly capacity = 2_000,
  ) {
    let loaded: unknown;
    try {
      loaded = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      loaded = [];
    }
    this.ids = Array.isArray(loaded) ? loaded.filter((id): id is string => typeof id === "string").slice(-capacity) : [];
    this.set = new Set(this.ids);
  }
  has(id: string): boolean {
    return this.set.has(id);
  }
  add(id: string): void {
    this.set.add(id);
    this.ids.push(id);
    while (this.ids.length > this.capacity) this.set.delete(this.ids.shift() as string);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.ids));
      fs.renameSync(tmp, this.file);
    } catch (error) {
      // Dedupe falls back to this process's memory; the event is still worked once here.
      console.warn(`[gate] could not record delivery ids: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

class MemorySeenIds implements SeenIds {
  private readonly set = new Set<string>();
  private readonly order: string[] = [];
  constructor(private readonly capacity: number) {}
  has(id: string): boolean {
    return this.set.has(id);
  }
  add(id: string): void {
    this.set.add(id);
    this.order.push(id);
    if (this.order.length > this.capacity) this.set.delete(this.order.shift() as string);
  }
}

export class Gate {
  private readonly seen: SeenIds;

  constructor(
    private readonly rules: GateRules,
    /** Delivery ids remembered for dedupe. Redeliveries arrive within minutes, not days. */
    memory = 5_000,
    /** Durable instead of in-memory: see FileSeenIds. */
    seen?: SeenIds,
  ) {
    this.seen = seen ?? new MemorySeenIds(memory);
  }

  check(event: AgentEvent): GateResult {
    const deliveryId = `${event.source}:${event.id}`;
    if (this.seen.has(deliveryId)) return { accepted: false, reason: "duplicate delivery" };

    if (this.rules.selfIds.includes(event.actor.id)) return { accepted: false, reason: "own event" };
    if (event.actor.isBot && !this.rules.allowBots) return { accepted: false, reason: "sent by another bot" };

    const scopes = this.rules.scopes?.[event.source];
    if (scopes && !scopes.some((prefix) => event.key.startsWith(prefix))) {
      return { accepted: false, reason: `${event.key} is outside the configured ${event.source} scope` };
    }

    // Remembered only once accepted: a refused delivery that becomes acceptable (config
    // change, retry) must not be silently dropped as a duplicate.
    this.seen.add(deliveryId);
    return { accepted: true };
  }
}
