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

export class Gate {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  constructor(
    private readonly rules: GateRules,
    /** Delivery ids remembered for dedupe. Redeliveries arrive within minutes, not days. */
    private readonly memory = 5_000,
  ) {}

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
    this.order.push(deliveryId);
    if (this.order.length > this.memory) this.seen.delete(this.order.shift() as string);
    return { accepted: true };
  }
}
