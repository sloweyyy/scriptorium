import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * One id per agent run, carried implicitly through everything the run does.
 *
 * Every audit line written inside `withRun` carries the run's id, so "why did the agent
 * say that?" is one grep: the trigger, each tool call, each policy decision, the reply. The
 * id travels with the async context, not through arguments — parallel runs cannot mix
 * their records up, and code that audits needs no changes to take part.
 */
const storage = new AsyncLocalStorage<{ runId: string }>();

export function withRun<T>(work: () => Promise<T>, runId: string = randomUUID()): Promise<T> {
  return storage.run({ runId }, work);
}

export function currentRunId(): string | undefined {
  return storage.getStore()?.runId;
}
