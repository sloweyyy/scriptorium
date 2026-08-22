import { anthropic, llmProvider, modelId, runGeminiToolLoop, type ToolSpec, type Vault } from "@scriptorium/core";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { buildIndex } from "./search";
import { QA_MAX_TOKENS, QA_SYSTEM_PROMPT, parseQaAnswer, qaTools, type QaAnswer } from "./qa-contract";

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
  const tools = observe(qaTools(vault, await buildIndex(vault)), options.onTool);
  const text = llmProvider() === "gemini" ? await askGemini(tools, question) : await askClaude(tools, question);
  return parseQaAnswer(text, question);
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
