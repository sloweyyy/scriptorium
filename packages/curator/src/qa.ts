import type { ToolSpec, Vault } from "@scriptorium/core";
import { runSession, SessionError } from "@scriptorium/runtime";
import { buildIndex } from "./search";
import { QA_MAX_TOKENS, QA_SYSTEM_PROMPT, enforceGrounding, parseQaAnswer, qaTools, type QaAnswer } from "./qa-contract";

/**
 * Grounded Q&A: two transports, one contract.
 *
 * The prompt, the tools, the read cap and the citation/gap parsing all come from
 * `qa-contract`; the loop itself is the platform's `runSession`, which runs on Claude or
 * Gemini and fails closed on both. This file only wires the two together and judges the
 * answer against what was retrieved.
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
    const text = await runSession({ system: QA_SYSTEM_PROMPT, prompt: question, tools, maxTokens: QA_MAX_TOKENS });
    return await enforceGrounding(vault, parseQaAnswer(text, question), { usedOverview: used.has("vault_overview"), retrieved });
  } catch (error) {
    // A retrieval loop that exhausts its round cap has searched hard and concluded
    // nothing — which is NOT_IN_KB with extra steps, not a crash. A question whose terms
    // brush against many notes ("pricing" against a marketing corpus) can keep the model
    // sweeping synonyms past the prompt's give-up-early rule; the productive failure is
    // a gap note that becomes a documentation ticket, not an error a user cannot act on.
    // Everything else (truncation, transport failures) still fails loudly.
    if (error instanceof SessionError && error.failure === "round-cap") {
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
