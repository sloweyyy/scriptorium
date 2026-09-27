import Anthropic from "@anthropic-ai/sdk";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import type { z } from "zod";
import { generateWithGemini } from "./gemini";

/**
 * Two ways in, one surface. The first-party client wants an API key; the Vertex client
 * wants a GCP project and Google credentials (ADC or a service-account key) and no key
 * at all. Both expose the same `messages.create` and `beta.messages.toolRunner`, so the
 * pipeline never learns which one it is talking to.
 */
export type LlmClient = Anthropic | AnthropicVertex;

let client: LlmClient | undefined;

export function llmProvider(): "gemini" | "vertex" | "anthropic" | "none" {
  // Explicit opt-in only: Claude stays the default even when a Vertex project is set.
  if (process.env.LLM_PROVIDER?.trim() === "gemini" && process.env.VERTEX_PROJECT_ID?.trim()) return "gemini";
  if (process.env.VERTEX_PROJECT_ID?.trim()) return "vertex";
  return process.env.ANTHROPIC_API_KEY?.trim() ? "anthropic" : "none";
}

export function anthropic(): LlmClient {
  if (client) return client;

  if (llmProvider() === "gemini") {
    // Every model call in the pipeline now has a Gemini transport — single-shot generation
    // via `generateText`, agentic retrieval via `runGeminiToolLoop`. Reaching for the
    // Anthropic client under LLM_PROVIDER=gemini therefore means a caller skipped the
    // dispatch, which would silently send a "Gemini run" to Claude. Fail loudly instead.
    throw new Error(
      "LLM_PROVIDER=gemini: no Anthropic client is available. Route this call through generateText() or a provider-dispatching entry point.",
    );
  }

  if (llmProvider() === "vertex") {
    client = new AnthropicVertex({
      projectId: process.env.VERTEX_PROJECT_ID!.trim(),
      // "global" is the recommended default; a specific region pins where inference runs.
      region: process.env.VERTEX_REGION?.trim() || "global",
    });
    return client;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "No model access configured — set ANTHROPIC_API_KEY, or VERTEX_PROJECT_ID (+ GOOGLE_APPLICATION_CREDENTIALS) to use Claude on Vertex AI.",
    );
  }
  client = new Anthropic();
  return client;
}

export function modelId(): string {
  return process.env.MODEL?.trim() || "claude-opus-5";
}

export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

/**
 * A tool, described once, in neither provider's dialect.
 *
 * Anthropic's tool runner and Vertex's `functionDeclarations` disagree about everything
 * except this much: a name, a description, an argument shape, and something to run. Both
 * transports project *from* this shape, which is what keeps the behaviour a tool encodes
 * (see `@scriptorium/curator`'s qa-contract) from existing twice.
 *
 * `run` takes `unknown` on purpose: it validates with `inputSchema` itself, so arguments
 * arriving from either dialect are checked in exactly one place.
 */
/**
 * What the platform tells a tool about the call beyond its arguments. Set by the policy
 * layer only: a tool never learns who approved it from its own input, which the model wrote.
 */
export interface ToolRunContext {
  approval?: { id: string; approvedBy?: string };
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: z.ZodObject;
  run(input: unknown, context?: ToolRunContext): Promise<string>;
  /**
   * The records this call actually fetched — `docs/x`, `confluence:123`, `jira:DOC-7` —
   * derived from the validated input or from JSON the tool itself built, never from the
   * CONTENT it returned. Grounding checks citations against this set, so a page, comment
   * or thread that merely contains the text "jira:DOC-99" cannot pass as evidence for it.
   * A tool without it contributes no evidence.
   */
  records?(input: unknown, output: string): string[];
}

export interface ImageInput {
  mediaType: ImageMediaType;
  base64: string;
}

export interface GenerateOptions {
  system: string;
  prompt: string;
  images?: ImageInput[];
  maxTokens?: number;
}

/** Single grounded generation call. Throws on refusal/truncation instead of returning partial output. */
export async function generateText(options: GenerateOptions): Promise<string> {
  if (llmProvider() === "gemini") return generateWithGemini(options);
  return generateWithClaude(options);
}

async function generateWithClaude({ system, prompt, images = [], maxTokens = 16_000 }: GenerateOptions): Promise<string> {
  const content: Anthropic.ContentBlockParam[] = [
    ...images.map(
      (image): Anthropic.ImageBlockParam => ({
        type: "image",
        source: { type: "base64", media_type: image.mediaType, data: image.base64 },
      }),
    ),
    { type: "text", text: prompt },
  ];

  const response = await anthropic().messages.create({
    model: modelId(),
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("The model declined this request (stop_reason: refusal).");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("Response truncated (stop_reason: max_tokens) — raise maxTokens.");
  }

  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}
