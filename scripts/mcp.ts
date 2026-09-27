/**
 * `pnpm mcp` — the knowledge vault as a read-only MCP server over stdio.
 *
 *   claude mcp add scriptorium -- pnpm --dir /path/to/scriptorium mcp
 *
 * stdout is the protocol channel, so everything human-readable goes to stderr.
 */
import { loadConfig, Vault } from "@scriptorium/core";
import { createKnowledgeMcpServer } from "@scriptorium/agents";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

console.log = (...args: unknown[]) => console.error(...args);
const config = loadConfig();
const vault = new Vault(config.vaultDir);
await vault.ensure();
const server = await createKnowledgeMcpServer(vault, { withAsk: config.hasModelAccess });
await server.connect(new StdioServerTransport());
console.error(`[mcp] scriptorium-knowledge on stdio — vault ${config.vaultDir}${config.hasModelAccess ? "" : " (no model configured: `ask` disabled)"}`);
