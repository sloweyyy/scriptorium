import { anthropic, llmProvider, modelId, runGeminiToolLoop, type ToolSpec, type Vault } from "@scriptorium/core";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { buildIndex } from "./search";
import { QA_MAX_TOKENS, QA_SYSTEM_PROMPT, enforceGrounding, parseQaAnswer, qaTools, type QaAnswer } from "./qa-contract";

/**
 * Grounded Q&A: two transports, one contract.
 *
 * The prompt, the tools, the read cap and the citation/gap parsing all come from
 * `qa-contract` — this file only picks a dialect and runs its loop. Claude remains the
 * default; Gemini exists because a Vertex project with zero Anthropic quota should still be
 * able to demonstrate cite-or-refuse retrieval rather than wait on a quota queue.
 */
export interface AnswerOptions {
  /**
   * Called as each retrieval happens, so a surface can show what the agent is doing while
   * it does it. Wrapped around the shared specs rather than added to them: the contract
   * decides what the tools ARE, and observing them is not part of that. Both transports
   * get it for free, and a throwing observer cannot break a retrieval.
   */
  onTool?: (name: string) => void;
}

export async function answerQuestion(vault: Vault, question: string, options: AnswerOptions = {}): Promise<QaAnswer> {
  // The evidence the answer is judged against: which tools ran, and what they returned.
  const used = new Set<string>();
  const retrieved: string[] = [];
  const tools = record(observe(qaTools(vault, await buildIndex(vault)), options.onTool), used, retrieved);
  try {
    const text = llmProvider() === "gemini" ? await askGemini(tools, question) : await askClaude(tools, question);
    return await enforceGrounding(vault, parseQaAnswer(text, question), { usedOverview: used.has("vault_overview"), retrieved });
  } catch (error) {
    // A retrieval loop that exhausts its round cap has searched hard and concluded
    // nothing — which is NOT_IN_KB with extra steps, not a crash. A question whose terms
    // brush against many notes ("pricing" against a marketing corpus) can keep the model
    // sweeping synonyms past the prompt's give-up-early rule; the productive failure is
    // a gap note that becomes a documentation ticket, not an error a user cannot act on.
    // Everything else (truncation, transport failures) still fails loudly.
    if (error instanceof Error && /round cap/.test(error.message)) {
      return parseQaAnswer(`NOT_IN_KB: ${question}`, question);
    }
    throw error;
  }
}

function observe(tools: ToolSpec[], onTool: ((name: string) => void) | undefined): ToolSpec[] {
  if (!onTool) return tools;
  return tools.map((tool) => ({
    ...tool,
    run: async (input) => {
      try {
        onTool(tool.name);
      } catch {
        // Progress reporting is decoration. It never decides whether a question is answered.
      }
      return tool.run(input);
    },
  }));
}

/** Keep every tool result, so the answer can be checked against what was actually retrieved. */
function record(tools: ToolSpec[], used: Set<string>, retrieved: string[]): ToolSpec[] {
  return tools.map((tool) => ({
    ...tool,
    run: async (input) => {
      used.add(tool.name);
      const result = await tool.run(input);
      retrieved.push(typeof result === "string" ? result : JSON.stringify(result));
      return result;
    },
  }));
}

/** Anthropic dialect: the SDK's tool runner drives the loop and throws on truncation. */
async function askClaude(tools: ToolSpec[], question: string): Promise<string> {
  const finalMessage = await anthropic().beta.messages.toolRunner({
    model: modelId(),
    max_tokens: QA_MAX_TOKENS,
    system: QA_SYSTEM_PROMPT,
    // Same specs, projected into the SDK's zod tool helper — no second description, no
    // second implementation; only the wrapper differs.
    tools: tools.map((tool) => betaZodTool(tool)),
    messages: [{ role: "user", content: question }],
  });

  return finalMessage.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/** Vertex dialect: functionCall out, functionResponse back, capped rounds. */
async function askGemini(tools: ToolSpec[], question: string): Promise<string> {
  return runGeminiToolLoop({ system: QA_SYSTEM_PROMPT, prompt: question, tools, maxTokens: QA_MAX_TOKENS });
}
