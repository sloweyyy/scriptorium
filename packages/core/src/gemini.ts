import { GoogleAuth } from "google-auth-library";
import { z } from "zod";
import type { GenerateOptions, ToolSpec } from "./llm";

/**
 * Gemini on Vertex, as a *fallback* generation provider.
 *
 * Why this exists: the pipeline's guarantees — the input contract, the deterministic lint,
 * the human approval gate, the allowlisted publish, the human-approved lesson store, and
 * Curator's cite-or-refuse retrieval — are properties of the pipeline, not of the model.
 * Claude is the default and the intended model. But a project whose Anthropic partner-model
 * quota is zero can still exercise every one of those guarantees against Google's own
 * models, which is the difference between a demo that runs and a demo that waits on
 * someone else's queue.
 *
 * This file is *dialect only*: how Vertex spells a request, a function call, and a tool
 * result. Both entry points below — single-shot generation and the tool loop — are
 * deliberately ignorant of what the tools do and what the answer must look like. The
 * grounded-Q&A contract (system prompt, tool implementations, citation and NOT_IN_KB
 * parsing) lives in exactly one place, `@scriptorium/curator`'s qa-contract, so that adding
 * this second transport could not fork the part that must not drift.
 */

const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });

export function geminiModel(): string {
  return process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash";
}

interface GeminiFunctionCall {
  name: string;
  args?: Record<string, unknown>;
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: GeminiFunctionCall;
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiRequest {
  systemInstruction: { parts: GeminiPart[] };
  contents: GeminiContent[];
  tools?: Array<{ functionDeclarations: GeminiFunctionDeclaration[] }>;
  generationConfig: { maxOutputTokens: number; temperature: number };
}

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  error?: { message?: string; status?: string };
}

/**
 * One Vertex `:generateContent` round trip. Auth, endpoint and error shape live here only.
 *
 * `accessToken` lets a caller supply its own bearer token instead of resolving Application
 * Default Credentials. Production never passes it — ADC is the point of running on Vertex —
 * but it makes the dialect testable without credentials, and lets the loop run somewhere
 * that already holds a short-lived token and has no ADC to find.
 */
async function callGemini(body: GeminiRequest, accessToken?: string): Promise<GeminiResponse> {
  const project = process.env.VERTEX_PROJECT_ID?.trim();
  if (!project) throw new Error("VERTEX_PROJECT_ID is required for the Gemini provider.");
  const region = process.env.VERTEX_REGION?.trim() || "global";
  const host = region === "global" ? "aiplatform.googleapis.com" : `${region}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1/projects/${project}/locations/${region}/publishers/google/models/${geminiModel()}:generateContent`;

  const token = accessToken ?? (await auth.getAccessToken());
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "x-goog-user-project": project },
    body: JSON.stringify(body),
  });

  const data = (await response.json()) as GeminiResponse;
  if (!response.ok || data.error) {
    throw new Error(`Gemini ${response.status}: ${data.error?.message ?? response.statusText}`);
  }
  return data;
}

/**
 * Same fail-loud contract as the Anthropic path: a truncated or blocked answer is an
 * error, never a partial document that quietly reaches a human as if it were finished.
 */
function assertUsableCandidate(finishReason: string | undefined): void {
  if (finishReason === "MAX_TOKENS") {
    throw new Error("Gemini response truncated (MAX_TOKENS) — raise maxTokens.");
  }
  if (finishReason && finishReason !== "STOP") {
    throw new Error(`Gemini stopped early (${finishReason}).`);
  }
}

function textOf(parts: GeminiPart[]): string {
  return parts
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

export async function generateWithGemini({ system, prompt, images = [], maxTokens = 16_000 }: GenerateOptions): Promise<string> {
  const parts: GeminiPart[] = [
    ...images.map((image) => ({ inlineData: { mimeType: image.mediaType, data: image.base64 } })),
    { text: prompt },
  ];

  const data = await callGemini({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts }],
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.2 },
  });

  const candidate = data.candidates?.[0];
  assertUsableCandidate(candidate?.finishReason);
  const text = textOf(candidate?.content?.parts ?? []);
  if (!text) throw new Error("Gemini returned no text.");
  return text;
}

/**
 * Vertex accepts a strict OpenAPI subset, so an allowlist — not a denylist — is what keeps
 * a future zod feature from turning into an opaque 400. Notably `$schema` and
 * `additionalProperties`, both emitted by `z.toJSONSchema`, are rejected.
 */
const ALLOWED_SCHEMA_KEYS = new Set([
  "type", "format", "title", "description", "nullable", "enum",
  "items", "properties", "required", "minimum", "maximum",
  "minItems", "maxItems", "anyOf",
]);

function toVertexSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toVertexSchema);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (!ALLOWED_SCHEMA_KEYS.has(key)) continue;
    // `properties` is a map of names to schemas, not a schema — recurse into its values.
    out[key] = key === "properties" && child && typeof child === "object" && !Array.isArray(child)
      ? Object.fromEntries(Object.entries(child as Record<string, unknown>).map(([name, sub]) => [name, toVertexSchema(sub)]))
      : toVertexSchema(child);
  }
  return out;
}

function declare(tool: ToolSpec): GeminiFunctionDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    parameters: toVertexSchema(z.toJSONSchema(tool.inputSchema)) as Record<string, unknown>,
  };
}

export interface GeminiToolLoopOptions {
  system: string;
  prompt: string;
  tools: ToolSpec[];
  /**
   * Backstop, not the primary limiter. The contract's prompt tells the model to give up
   * after two or three dry keyword attempts, so a healthy question resolves in a few
   * rounds; this exists so a model that ignores that instruction fails loudly instead of
   * searching forever. Headroom matters: if the cap binds first, a legitimately harder
   * question dies with an error where it should have refused with a gap note.
   */
  maxRounds?: number;
  maxTokens?: number;
  /** Bearer token to use instead of Application Default Credentials. See `callGemini`. */
  accessToken?: string;
}

/**
 * Agentic loop in Vertex's dialect: `functionCall` parts out, `functionResponse` parts back
 * in, until a turn arrives with no calls left. The transport equivalent of Anthropic's
 * `beta.messages.toolRunner` — and, like it, it throws rather than hand back a half-finished
 * answer, because a Curator answer that stopped mid-retrieval is indistinguishable from one
 * that searched and found nothing.
 */
export async function runGeminiToolLoop({
  system,
  prompt,
  tools,
  maxRounds = 12,
  maxTokens = 4_096,
  accessToken,
}: GeminiToolLoopOptions): Promise<string> {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const contents: GeminiContent[] = [{ role: "user", parts: [{ text: prompt }] }];

  for (let round = 0; round < maxRounds; round += 1) {
    const data = await callGemini(
      {
        systemInstruction: { parts: [{ text: system }] },
        contents,
        tools: [{ functionDeclarations: tools.map(declare) }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.2 },
      },
      accessToken,
    );

    const candidate = data.candidates?.[0];
    assertUsableCandidate(candidate?.finishReason);
    const parts = candidate?.content?.parts ?? [];
    const calls = parts.filter((part): part is GeminiPart & { functionCall: GeminiFunctionCall } =>
      Boolean(part.functionCall),
    );

    // Termination is "no calls left", never "there is text": a turn can carry both a
    // preamble and a call, and stopping on the text would drop the retrieval it announced.
    if (calls.length === 0) {
      const text = textOf(parts);
      if (!text) throw new Error("Gemini returned neither text nor a tool call.");
      return text;
    }

    contents.push({ role: "model", parts });
    const results: GeminiPart[] = [];
    for (const { functionCall } of calls) {
      const tool = byName.get(functionCall.name);
      // One functionResponse per functionCall, in order: Vertex rejects a mismatched turn.
      results.push({
        functionResponse: {
          name: functionCall.name,
          response: {
            result: tool
              ? await tool.run(functionCall.args ?? {})
              : `ERROR: no such tool "${functionCall.name}"`,
          },
        },
      });
    }
    contents.push({ role: "user", parts: results });
  }

  throw new Error(`Gemini tool loop hit its ${maxRounds}-round cap without producing an answer.`);
}
