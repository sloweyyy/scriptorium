import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Vault } from "@scriptorium/core";

/**
 * The platform's model loop fails closed (ADR-001 slice 3). A capped, truncated, refused
 * or empty turn is an error with a reason, never a partial string that reads like an
 * answer — on both providers.
 */

let provider: "anthropic" | "gemini" = "anthropic";
let finalMessage: { stop_reason?: string; content: Array<{ type: string; text?: string }> };
let geminiResult: (args: { onRound?: (usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number }) => void }) => Promise<string>;
let runnerParams: Record<string, unknown> | undefined;
/** Models that answer with this HTTP status instead of a message. */
let failFor: Record<string, number> = {};

vi.mock("@scriptorium/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scriptorium/core")>()),
  llmProvider: () => provider,
  anthropic: () => ({
    beta: {
      messages: {
        toolRunner: async (params: Record<string, unknown>) => {
          runnerParams = params;
          const failure = failFor[String(params.model)];
          if (failure) throw Object.assign(new Error(`HTTP ${failure}`), { status: failure });
          return finalMessage;
        },
      },
    },
  }),
  runGeminiToolLoop: (args: Parameters<typeof geminiResult>[0]) => geminiResult(args),
}));

const { runSession, SessionError } = await import("@scriptorium/runtime");
const { answerQuestion } = await import("@scriptorium/curator");

const options = { system: "s", prompt: "p", tools: [], maxTokens: 100 };
const text = (value: string) => [{ type: "text", text: value }];

beforeEach(() => {
  provider = "anthropic";
  runnerParams = undefined;
  failFor = {};
});

describe("runSession on Claude", () => {
  it("returns the text of a finished turn, and passes the round budget to the runner", async () => {
    finalMessage = { stop_reason: "end_turn", content: text("Answer.") };
    expect(await runSession({ ...options, maxRounds: 5 })).toBe("Answer.");
    expect(runnerParams?.max_iterations).toBe(5);
  });

  for (const [stop, failure] of [["tool_use", "round-cap"], ["max_tokens", "truncated"], ["refusal", "refused"]] as const) {
    it(`stop_reason ${stop} is a ${failure} failure, even when the turn carries text`, async () => {
      finalMessage = { stop_reason: stop, content: text("Half an ans") };
      await expect(runSession(options)).rejects.toMatchObject({ name: "SessionError", failure });
    });
  }

  it("an empty reply is a failure, not an empty answer", async () => {
    finalMessage = { stop_reason: "end_turn", content: [] };
    await expect(runSession(options)).rejects.toMatchObject({ failure: "empty" });
  });
});

describe("runSession on Gemini", () => {
  it("maps the Gemini loop's round cap to the same failure", async () => {
    provider = "gemini";
    geminiResult = async () => {
      throw new Error("Gemini tool loop hit its 12-round cap without producing an answer.");
    };
    const error = await runSession(options).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionError);
    expect(error).toMatchObject({ failure: "round-cap" });
  });
});

describe("Curator on the platform loop", () => {
  let tmpRoot: string;
  let vault: Vault;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-session-"));
    vault = new Vault(tmpRoot);
    await vault.ensure();
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5 });
  });

  it("a Claude loop that runs out of rounds becomes NOT_IN_KB — the rescue used to be Gemini-only", async () => {
    finalMessage = { stop_reason: "tool_use", content: text("still searching") };
    const answer = await answerQuestion(vault, "What is the pricing for SSO?");
    expect(answer.gap).toBeTruthy();
  });

  it("a truncated Claude reply fails loudly instead of being posted", async () => {
    finalMessage = { stop_reason: "max_tokens", content: text("Severity can be Min") };
    await expect(answerQuestion(vault, "Which severities exist?")).rejects.toMatchObject({ failure: "truncated" });
  });
});

describe("what a session cost", () => {
  it("sums every round, counting cached reads and cache writes as input", async () => {
    const { sumUsage } = await import("@scriptorium/runtime");
    const usage = sumUsage("anthropic", [
      { input_tokens: 50, cache_read_input_tokens: 4_800, cache_creation_input_tokens: 0, output_tokens: 212 },
      { input_tokens: 30, cache_read_input_tokens: 4_800, cache_creation_input_tokens: 120, output_tokens: 90 },
      undefined,
    ]);
    expect(usage).toEqual({ provider: "anthropic", rounds: 3, input: 9_800, cacheRead: 9_600, cacheWrite: 120, output: 302 });
  });

  it("reports usage from an iterated tool runner, and asks the first-party API to cache", async () => {
    const rounds = [
      { stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 900 }, content: [] },
      { stop_reason: "end_turn", usage: { input_tokens: 12, output_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 }, content: text("Done.") },
    ];
    let params: Record<string, unknown> | undefined;
    const core = await import("@scriptorium/core");
    const spy = vi.spyOn(core, "anthropic").mockReturnValue({
      beta: {
        messages: {
          toolRunner: (p: Record<string, unknown>) => {
            params = p;
            return {
              async *[Symbol.asyncIterator]() {
                yield* rounds;
              },
              done: async () => rounds.at(-1),
            };
          },
        },
      },
    } as never);
    let reported: unknown;
    expect(await runSession({ ...options, onUsage: (usage) => (reported = usage) })).toBe("Done.");
    expect(reported).toMatchObject({ rounds: 2, input: 1_822, cacheRead: 900, cacheWrite: 900, output: 45 });
    expect(params?.cache_control).toEqual({ type: "ephemeral" });
    spy.mockRestore();
  });
});

describe("every round is counted, on both providers", () => {
  it("a Gemini turn reports its rounds' tokens, even when it then fails", async () => {
    provider = "gemini";
    geminiResult = async ({ onRound }) => {
      onRound?.({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 });
      onRound?.({ input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 0 });
      throw new Error("Gemini tool loop hit its 2-round cap without producing an answer.");
    };
    let reported: unknown;
    await expect(runSession({ ...options, onUsage: (usage) => (reported = usage) })).rejects.toThrow();
    // A turn that failed still spent its rounds: the budget sees them.
    expect(reported).toMatchObject({ provider: "gemini", rounds: 2, input: 270, cacheRead: 50, output: 50 });
  });

  it("a Claude turn that throws mid-loop still reports the rounds it spent", async () => {
    const core = await import("@scriptorium/core");
    const spy = vi.spyOn(core, "anthropic").mockReturnValue({
      beta: {
        messages: {
          toolRunner: () => ({
            async *[Symbol.asyncIterator]() {
              yield { stop_reason: "tool_use", usage: { input_tokens: 40, output_tokens: 8 }, content: [] };
              throw Object.assign(new Error("HTTP 400"), { status: 400 });
            },
            done: async () => undefined,
          }),
        },
      },
    } as never);
    let reported: unknown;
    await expect(runSession({ ...options, onUsage: (usage) => (reported = usage) })).rejects.toThrow();
    expect(reported).toMatchObject({ rounds: 1, input: 40, output: 8 });
    spy.mockRestore();
  });
});

describe("a fallback model", () => {
  it("answers when the primary is overloaded, is reported, and is never used for other failures", async () => {
    const saved = { model: process.env.MODEL, fallback: process.env.MODEL_FALLBACK };
    process.env.MODEL = "claude-opus-5";
    process.env.MODEL_FALLBACK = "claude-sonnet-5";
    try {
      finalMessage = { stop_reason: "end_turn", content: text("From the fallback.") };
      failFor = { "claude-opus-5": 529 };
      const fallbacks: unknown[] = [];
      expect(await runSession({ ...options, onFallback: (info) => fallbacks.push(info) })).toBe("From the fallback.");
      expect(fallbacks).toEqual([{ from: "claude-opus-5", to: "claude-sonnet-5", status: 529 }]);
      expect(runnerParams?.model).toBe("claude-sonnet-5");

      // A bad request is not the provider's fault: a second model would not fix it.
      failFor = { "claude-opus-5": 400 };
      await expect(runSession(options)).rejects.toThrow("HTTP 400");
      // Both down: the fallback's failure is the answer, not a third try.
      failFor = { "claude-opus-5": 503, "claude-sonnet-5": 503 };
      await expect(runSession(options)).rejects.toThrow("HTTP 503");
      // No fallback configured: fails as before.
      delete process.env.MODEL_FALLBACK;
      failFor = { "claude-opus-5": 529 };
      await expect(runSession(options)).rejects.toThrow("HTTP 529");
    } finally {
      for (const [name, value] of [["MODEL", saved.model], ["MODEL_FALLBACK", saved.fallback]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
