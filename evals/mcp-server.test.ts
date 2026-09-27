import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Vault } from "@scriptorium/core";

/**
 * The knowledge MCP server, driven by a real MCP client over an in-memory transport:
 * every tool is read-only, `ask` is cite-or-refuse, and nothing it does writes the vault.
 */

let reply = "";
vi.mock("@scriptorium/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scriptorium/core")>()),
  llmProvider: () => "anthropic",
  anthropic: () => ({
    beta: {
      messages: {
        toolRunner: async (params: { tools: Array<{ name: string; run: (input: unknown) => Promise<unknown> }> }) => {
          await params.tools.find((tool) => tool.name === "search_vault")?.run({ query: "digest" });
          return { stop_reason: "end_turn", content: [{ type: "text", text: reply }] };
        },
      },
    },
  }),
}));

const { createKnowledgeMcpServer } = await import("@scriptorium/agents");

let tmpRoot: string;
let vault: Vault;
let client: Client;

async function tree(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { recursive: true });
  return entries.map(String).sort();
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-mcp-"));
  vault = new Vault(tmpRoot);
  await vault.ensure();
  await vault.writeNote("docs/digest-emails.md", "# Digest emails\n\nSubscribers get one email a day.", { feature: "Digest emails" });
  const server = await createKnowledgeMcpServer(vault);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: "eval", version: "0" });
  await client.connect(clientSide);
});

afterEach(async () => {
  await client.close();
  await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5 });
});

const text = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as Array<{ text: string }>)[0]?.text ?? "";

describe("knowledge MCP server", () => {
  it("exposes only read-only tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["ask", "read_note", "search_vault", "vault_overview"]);
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true);
  });

  it("searches and reads the vault", async () => {
    expect(text(await client.callTool({ name: "search_vault", arguments: { query: "digest" } }))).toContain("docs/digest-emails");
    expect(text(await client.callTool({ name: "read_note", arguments: { path: "docs/digest-emails" } }))).toContain("one email a day");
  });

  it("ask answers cited, refuses uncited, and files nothing for a gap", async () => {
    const before = await tree(tmpRoot);
    reply = "One email a day [[docs/digest-emails]].";
    expect(text(await client.callTool({ name: "ask", arguments: { question: "How often are digests sent?" } }))).toContain("[[docs/digest-emails]]");
    reply = "Digests are sent hourly.";
    expect(text(await client.callTool({ name: "ask", arguments: { question: "How often?" } }))).toMatch(/^REFUSED:/);
    reply = "NOT_IN_KB: nothing about SSO";
    expect(text(await client.callTool({ name: "ask", arguments: { question: "SSO?" } }))).toMatch(/^NOT_IN_KB:/);
    // Read-only means read-only: no gap note, no ticket, no index file changed.
    expect(await tree(tmpRoot)).toEqual(before);
  });
});
