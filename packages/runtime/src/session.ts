import { anthropic, llmProvider, modelId, runGeminiToolLoop, type ToolSpec } from "@scriptorium/core";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";

/**
 * The one model loop every agent runs (ADR-001 slice 3).
 *
 * An agent is a system prompt, a set of (policy-guarded) tools, and a question; this runs
 * it on whichever provider is configured and returns the final text — or fails CLOSED.
 * "Closed" means the caller always learns why an answer is missing: a loop that ran out
 * of rounds, a reply cut off mid-sentence, a refusal and an empty reply are four different
 * `SessionError`s, never a partial string that reads like an answer.
 *
 * Before this existed the Claude path returned whatever the tool runner's last message
 * held: on a round cap or a truncation that was half an answer, and the round-cap rescue
 * the Q&A contract relies on only ever fired on Gemini.
 */

export type SessionFailure = "round-cap" | "truncated" | "refused" | "empty";

export class SessionError extends Error {
  constructor(
    readonly failure: SessionFailure,
    message: string,
  ) {
    super(message);
    this.name = "SessionError";
  }
}

export interface SessionOptions {
  system: string;
  prompt: string;
  tools: ToolSpec[];
  maxTokens: number;
  /** Model turns before giving up. Same budget on both providers, so both fail alike. */
  maxRounds?: number;
  /** What the run cost, summed over every round. Called once, when the loop ends. */
  onUsage?: (usage: SessionUsage) => void;
  /** The primary model was overloaded or failing and `MODEL_FALLBACK` answered instead. */
  onFallback?: (info: { from: string; to: string; status: number }) => void;
}

/**
 * The model to try when the primary is overloaded or erroring (`MODEL_FALLBACK`). Only for
 * 5xx/529 responses — the model never saw the request, or failed on its side — never for a
 * refusal, a truncation or a bad request, which a second model would not fix.
 */
export function fallbackModelId(): string | undefined {
  return process.env.MODEL_FALLBACK?.trim() || undefined;
}

const RETRYABLE_STATUS = new Set([500, 502, 503, 504, 529]);

/**
 * Tokens for one session, all rounds. `input` is the TRUE input: the API reports cached
 * reads and cache writes separately from `input_tokens`, and reading only the latter makes
 * a cached run look nearly free and an uncached one look the same as a cached one.
 */
export interface SessionUsage {
  provider: string;
  rounds: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function sumUsage(provider: string, usages: readonly (UsageLike | undefined)[]): SessionUsage {
  const total = { provider, rounds: usages.length, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const usage of usages) {
    const read = usage?.cache_read_input_tokens ?? 0;
    const write = usage?.cache_creation_input_tokens ?? 0;
    total.cacheRead += read;
    total.cacheWrite += write;
    total.input += (usage?.input_tokens ?? 0) + read + write;
    total.output += usage?.output_tokens ?? 0;
  }
  return total;
}

export const DEFAULT_MAX_ROUNDS = 12;

export async function runSession(options: SessionOptions): Promise<string> {
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  if (llmProvider() === "gemini") return runOnGemini(options, maxRounds);
  const primary = modelId();
  try {
    return await runOnClaude(options, maxRounds, primary);
  } catch (error) {
    // One retry, on a different model, only when the provider itself failed. A retried turn
    // is safe: reads repeat, a pending approval is not asked twice, and writes are op-keyed.
    const status = (error as { status?: unknown } | undefined)?.status;
    const fallback = fallbackModelId();
    if (typeof status !== "number" || !RETRYABLE_STATUS.has(status) || !fallback || fallback === primary) throw error;
    options.onFallback?.({ from: primary, to: fallback, status });
    return runOnClaude(options, maxRounds, fallback);
  }
}

async function runOnClaude(options: SessionOptions, maxRounds: number, model: string): Promise<string> {
  const provider = llmProvider();
  const runner = anthropic().beta.messages.toolRunner({
    model,
    max_tokens: options.maxTokens,
    system: options.system,
    // The SDK passes its own context as run()'s second argument. Only the policy layer may
    // hand a tool context (who approved it), so the SDK's is dropped here, never forwarded.
    tools: options.tools.map((tool) => betaZodTool({ ...tool, run: (input: unknown) => tool.run(input) })),
    messages: [{ role: "user", content: options.prompt }],
    max_iterations: maxRounds,
    // Every round resends the same system prompt and tool list; caching them is most of a
    // multi-round loop's input cost. First-party API only — Vertex is not assumed to take it.
    ...(provider === "anthropic" ? { cache_control: { type: "ephemeral" as const } } : {}),
  });

  // Iterated, not just awaited, so every round's usage is counted — the final message
  // carries only the last round's.
  // Reported even when the loop throws: rounds already spent are spent, and a fallback that
  // reruns the turn must not make the first attempt free.
  const usages: Array<UsageLike | undefined> = [];
  let finalMessage: Awaited<typeof runner>;
  try {
    if (typeof (runner as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function") {
      for await (const message of runner) usages.push((message as { usage?: UsageLike }).usage);
      finalMessage = await runner.done();
    } else {
      finalMessage = await runner;
      usages.push((finalMessage as { usage?: UsageLike }).usage);
    }
  } finally {
    options.onUsage?.(sumUsage(provider, usages));
  }

  // Judge the stop reason BEFORE the text: a truncated or capped turn can still carry text.
  switch (finalMessage.stop_reason) {
    case "tool_use":
      // The runner stopped at max_iterations with a tool call still outstanding.
      throw new SessionError("round-cap", `Tool loop hit its ${maxRounds}-round cap without producing an answer.`);
    case "max_tokens":
      throw new SessionError("truncated", "The reply was cut off at the token limit, so it is not an answer.");
    case "refusal":
      throw new SessionError("refused", "The model declined to answer.");
  }

  const text = finalMessage.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (!text) throw new SessionError("empty", "The model produced no text.");
  return text;
}

async function runOnGemini(options: SessionOptions, maxRounds: number): Promise<string> {
  // Counted like Claude's: without it a Gemini deployment's token caps never moved, and
  // no `llm.usage` line was written to seed them after a restart.
  const usages: UsageLike[] = [];
  try {
    const text = await runGeminiToolLoop({ system: options.system, prompt: options.prompt, tools: options.tools, maxTokens: options.maxTokens, maxRounds, onRound: (usage) => usages.push(usage) });
    if (!text.trim()) throw new SessionError("empty", "The model produced no text.");
    return text;
  } catch (error) {
    if (error instanceof SessionError) throw error;
    if (error instanceof Error && /round cap/.test(error.message)) throw new SessionError("round-cap", error.message);
    throw error;
  } finally {
    options.onUsage?.(sumUsage("gemini", usages));
  }
}
