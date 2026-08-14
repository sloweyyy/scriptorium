import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | undefined;

export function anthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set — copy .env.example to .env and fill it in.");
  }
  client ??= new Anthropic();
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
export async function generateText({ system, prompt, images = [], maxTokens = 16_000 }: GenerateOptions): Promise<string> {
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
