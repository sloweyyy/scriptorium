import { GoogleAuth } from "google-auth-library";
import type { GenerateOptions } from "./llm";

/**
 * Gemini on Vertex, as a *fallback* generation provider.
 *
 * Why this exists: the pipeline's guarantees — the input contract, the deterministic lint,
 * the human approval gate, the allowlisted publish, the human-approved lesson store — are
 * properties of the pipeline, not of the model. Claude is the default and the intended
 * model. But a project whose Anthropic partner-model quota is zero can still exercise
 * every one of those guarantees against Google's own models, which is the difference
 * between a demo that runs and a demo that waits on someone else's queue.
 *
 * Deliberately narrow: single-shot generation with optional images, which covers draft,
 * revise and lesson distillation. Curator's grounded Q&A is NOT here — it runs on the
 * Anthropic tool runner, and faking that with a different function-calling dialect would
 * be a second implementation of the part that must not drift.
 */

const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });

export function geminiModel(): string {
  return process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash";
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  error?: { message?: string; status?: string };
}

export async function generateWithGemini({ system, prompt, images = [], maxTokens = 16_000 }: GenerateOptions): Promise<string> {
  const project = process.env.VERTEX_PROJECT_ID?.trim();
  if (!project) throw new Error("VERTEX_PROJECT_ID is required for the Gemini provider.");
  const region = process.env.VERTEX_REGION?.trim() || "global";
  const model = geminiModel();

  const parts: GeminiPart[] = [
    ...images.map((image) => ({ inlineData: { mimeType: image.mediaType, data: image.base64 } })),
    { text: prompt },
  ];

  const token = await auth.getAccessToken();
  const host = region === "global" ? "aiplatform.googleapis.com" : `${region}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1/projects/${project}/locations/${region}/publishers/google/models/${model}:generateContent`;

  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "x-goog-user-project": project },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts }],
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.2 },
    }),
  });

  const data = (await response.json()) as GeminiResponse;
  if (!response.ok || data.error) {
    throw new Error(`Gemini ${response.status}: ${data.error?.message ?? response.statusText}`);
  }

  const candidate = data.candidates?.[0];
  // Same fail-loud contract as the Anthropic path: a truncated or blocked answer is an
  // error, never a partial document that quietly reaches a human as if it were finished.
  if (candidate?.finishReason && !["STOP", "MAX_TOKENS"].includes(candidate.finishReason)) {
    throw new Error(`Gemini stopped early (${candidate.finishReason}).`);
  }
  if (candidate?.finishReason === "MAX_TOKENS") {
    throw new Error("Gemini response truncated (MAX_TOKENS) — raise maxTokens.");
  }

  const text = (candidate?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("")
    .trim();
  if (!text) throw new Error("Gemini returned no text.");
  return text;
}
