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
}

export const DEFAULT_MAX_ROUNDS = 12;

export async function runSession(options: SessionOptions): Promise<string> {
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  return llmProvider() === "gemini" ? runOnGemini(options, maxRounds) : runOnClaude(options, maxRounds);
}

async function runOnClaude(options: SessionOptions, maxRounds: number): Promise<string> {
  const finalMessage = await anthropic().beta.messages.toolRunner({
    model: modelId(),
    max_tokens: options.maxTokens,
    system: options.system,
    // The SDK passes its own context as run()'s second argument. Only the policy layer may
    // hand a tool context (who approved it), so the SDK's is dropped here, never forwarded.
    tools: options.tools.map((tool) => betaZodTool({ ...tool, run: (input: unknown) => tool.run(input) })),
    messages: [{ role: "user", content: options.prompt }],
    max_iterations: maxRounds,
  });

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
  try {
    const text = await runGeminiToolLoop({ system: options.system, prompt: options.prompt, tools: options.tools, maxTokens: options.maxTokens, maxRounds });
    if (!text.trim()) throw new SessionError("empty", "The model produced no text.");
    return text;
  } catch (error) {
    if (error instanceof SessionError) throw error;
    if (error instanceof Error && /round cap/.test(error.message)) throw new SessionError("round-cap", error.message);
    throw error;
  }
}
