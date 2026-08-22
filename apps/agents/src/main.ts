import { createServer } from "node:http";
import { jiraReady, loadConfig, Vault } from "@scriptorium/core";
import { watchInbox } from "@scriptorium/curator";
import { startCuratorBot } from "./curator-bot";
import { startScribeBot } from "./scribe-bot";
import { startScribeJira } from "./scribe-jira";

/**
 * One process, one vault, one audit log — two agents with separate identities and
 * separate surfaces: Scribe answers on Jira, Curator answers on Slack.
 */
const config = loadConfig();
const vault = new Vault(config.vaultDir);
await vault.ensure();

console.log(`[scriptorium] vault:  ${config.vaultDir}`);
console.log(
  `[scriptorium] model:  ${config.model} via ${
    config.provider === "vertex" ? `Vertex AI (${config.vertexProject}, ${config.vertexRegion})` : config.provider === "anthropic" ? "Anthropic API" : "NO PROVIDER CONFIGURED"
  }`,
);

const stopWatcher = watchInbox(vault, (result) => {
  console.log(`[curator] ${result.action}: ${result.from}${result.to ? ` -> ${result.to}` : ""}${result.note ? ` (${result.note})` : ""}`);
});

const stops: Array<() => void | Promise<unknown>> = [stopWatcher];

if (jiraReady(config.jira)) {
  try {
    stops.push(await startScribeJira(config, vault));
  } catch (error) {
    console.error(`[scribe] jira poller failed to start: ${error instanceof Error ? error.message : error}`);
    console.error("[scribe] run `pnpm jira:doctor` to see which check fails.");
  }
} else {
  console.log("[scribe]  Jira not configured — set JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN / JIRA_PROJECT_KEY in .env");
}

if (config.scribe.botToken && config.scribe.appToken) {
  await startScribeBot(config, vault);
}

if (config.curator.botToken && config.curator.appToken) {
  await startCuratorBot(config, vault);
} else {
  console.log("[curator] Slack tokens not set — create the app from slack-manifests/curator.yaml, then fill .env");
}

// Cloud Run (and anything else that health-checks a port) needs a listener; locally there is none.
if (process.env.PORT) {
  createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ status: "ok", jira: jiraReady(config.jira), slack: Boolean(config.curator.botToken) }));
  }).listen(config.port, () => console.log(`[scriptorium] health endpoint on :${config.port}`));
}

if (!jiraReady(config.jira) && !config.curator.botToken) {
  console.log("[scriptorium] local mode: drop a PRD or design into vault/_inbox and watch Curator file it. Ctrl+C to stop.");
}

process.on("SIGINT", () => {
  void Promise.allSettled(stops.map((stop) => stop())).finally(() => process.exit(0));
});
