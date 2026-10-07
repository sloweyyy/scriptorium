import type { Vault } from "@scriptorium/core";
import { answerQuestion, buildRetrievalIndex, qaTools } from "@scriptorium/curator";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * The org's knowledge as an MCP server (ADR-001 slice 7) — read-only, cite-or-refuse.
 *
 * Claude Code, Claude Desktop or an IDE can search and read the vault, and `ask` a
 * question that comes back cited or refused — the same `enforceGrounding` as every other
 * surface. Nothing here writes: no gap notes, no tickets, no lessons. A client that wants
 * a change goes through an agent and its approvals, never through this door.
 */
/** A question, not a document: the model gets at most this much from a client. */
const QUESTION_CHARS = 4_000;

export async function createKnowledgeMcpServer(vault: Vault, options: { withAsk?: boolean } = {}): Promise<McpServer> {
  const server = new McpServer({ name: "scriptorium-knowledge", version: "0.1.0" });

  // The index is built per call, as `answerQuestion` does for Slack. Built once at startup,
  // the server kept serving what an erase had removed, or a rejected lesson as merely
  // proposed, until it was restarted.
  const current = async (name: string) => qaTools(vault, await buildRetrievalIndex(vault)).find((tool) => tool.name === name);
  for (const tool of qaTools(vault, await buildRetrievalIndex(vault))) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema, annotations: { readOnlyHint: true, openWorldHint: false } },
      async (input: unknown) => ({ content: [{ type: "text" as const, text: await ((await current(tool.name)) ?? tool).run(input) }] }),
    );
  }

  if (options.withAsk ?? true) {
    server.registerTool(
      "ask",
      {
        description: "Ask a question about the product or the team's documentation. The answer cites the notes it came from, or says the knowledge base does not cover it.",
        inputSchema: z.object({ question: z.string().min(1).max(QUESTION_CHARS) }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ question }: { question: string }) => {
        const answer = await answerQuestion(vault, question);
        const text = answer.gap
          ? `NOT_IN_KB: ${answer.gap}`
          : answer.ungrounded
            ? "REFUSED: no answer could be tied to a note in the knowledge base."
            : answer.handoff
              ? `NOT_MY_JOB: ${answer.handoff} — changes go through an agent and a human approval, not this read-only server.`
              : answer.text;
        return { content: [{ type: "text" as const, text }] };
      },
    );
  }

  return server;
}
