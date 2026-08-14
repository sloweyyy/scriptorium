import { loadConfig, Vault } from "@scriptorium/core";
import { watchInbox } from "@scriptorium/curator";
import { startCuratorBot } from "./curator-bot";
import { startScribeBot } from "./scribe-bot";

const config = loadConfig();
const vault = new Vault(config.vaultDir);
await vault.ensure();

console.log(`[scriptorium] vault:  ${config.vaultDir}`);
console.log(`[scriptorium] model:  ${config.model} (ANTHROPIC_API_KEY ${config.hasAnthropicKey ? "present" : "MISSING"})`);

const stopWatcher = watchInbox(vault, (result) => {
  console.log(`[curator] ${result.action}: ${result.from}${result.to ? ` -> ${result.to}` : ""}${result.note ? ` (${result.note})` : ""}`);
});

const scribeReady = Boolean(config.scribe.botToken && config.scribe.appToken);
const curatorReady = Boolean(config.curator.botToken && config.curator.appToken);

if (scribeReady) {
  await startScribeBot(config, vault);
} else {
  console.log("[scribe]  Slack tokens not set — create the app from slack-manifests/scribe.yaml, then fill .env");
}

if (curatorReady) {
  await startCuratorBot(config, vault);
} else {
  console.log("[curator] Slack tokens not set — create the app from slack-manifests/curator.yaml, then fill .env");
}

if (!scribeReady && !curatorReady) {
  console.log("[scriptorium] local mode: drop a PRD or design into vault/_inbox and watch Curator file it. Ctrl+C to stop.");
}

process.on("SIGINT", () => {
  void stopWatcher().finally(() => process.exit(0));
});
