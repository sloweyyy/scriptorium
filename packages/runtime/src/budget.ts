/**
 * A daily token budget per scope (a Slack channel, a DM, a PR channel). Usage is recorded
 * after every run — it is already on the audit log as `llm.usage` — and once a scope's
 * day is spent, the agent answers with a fixed notice and makes no model call until the
 * next UTC day. A runaway channel (or a script hammering the bot) costs a bounded amount.
 */
export class DailyBudget {
  private readonly spent = new Map<string, number>();

  constructor(
    /** Tokens per scope per UTC day. 0 or undefined: unlimited. */
    private readonly limit: number | undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private key(scope: string, at = this.now()): string {
    return `${at.toISOString().slice(0, 10)}:${scope}`;
  }

  exhausted(scope: string): boolean {
    return Boolean(this.limit) && (this.spent.get(this.key(scope)) ?? 0) >= (this.limit as number);
  }

  add(scope: string, tokens: number, at?: Date): void {
    const key = this.key(scope, at);
    this.spent.set(key, (this.spent.get(key) ?? 0) + Math.max(0, tokens));
  }

  /** Rebuild today's spend from the audit log, so a restart is not a fresh budget. */
  seed(lines: ReadonlyArray<{ ts?: string; type?: string; scope?: unknown; input?: unknown; output?: unknown }>): void {
    const today = this.now().toISOString().slice(0, 10);
    for (const line of lines) {
      if (line.type !== "llm.usage" || typeof line.scope !== "string" || !line.ts?.startsWith(today)) continue;
      this.add(line.scope, Number(line.input ?? 0) + Number(line.output ?? 0), new Date(line.ts));
    }
  }
}
