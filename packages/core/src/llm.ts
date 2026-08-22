import Anthropic from "@anthropic-ai/sdk";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
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
    // Curator's grounded Q&A needs the Anthropic tool runner; there is no honest way to
    // serve it from here, so say so rather than degrade retrieval silently.
    throw new Error(
      "LLM_PROVIDER=gemini covers drafting only. Grounded Q&A requires Claude — unset LLM_PROVIDER once Anthropic quota or an API key is available.",
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
