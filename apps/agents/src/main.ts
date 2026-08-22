import { docsRepoReady, jiraReady, loadConfig, Vault } from "@scriptorium/core";
import { updateMoc, watchInbox } from "@scriptorium/curator";
import { startIngress } from "./ingress";
import { syncFromDocsRepo } from "./docs-repo";
import { startCuratorBot } from "./curator-bot";
import { startScribeBot } from "./scribe-bot";
import { startScribeJira, type ScribeJiraHandle } from "./scribe-jira";

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
let scribe: ScribeJiraHandle | undefined;

if (jiraReady(config.jira)) {
  try {
    scribe = await startScribeJira(config, vault);
    stops.push(() => scribe?.stop());
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

// One HTTP surface: health plus the two webhooks. The Jira webhook is a latency
// optimisation over the poller — same handler, same ledger — and the GitHub webhook is the
// inbound half of the round trip.
const ingress = startIngress({
  config,
  hooks: {
    nudge: scribe ? (issueKey) => scribe!.nudge(issueKey) : undefined,
    docsChanged: docsRepoReady(config.docsRepo)
      ? async ({ paths, commitUrl }) => {
          const change = await syncFromDocsRepo(config, vault, paths);
          if (change.vaultUpdated.length) {
            await updateMoc(vault);
            console.log(`[docs] pulled ${change.vaultUpdated.length} internal note(s) back into the vault`);
          }
          // A human edited a published doc: tell the ticket, don't overwrite the vault note
          // with its own published projection.
          for (const edited of change.externalEdited) {
            if (!edited.issueKey || !scribe) continue;
            await scribe.comment(
              edited.issueKey,
              [
                `**A human edited the published doc** \`${edited.repoPath}\` in the docs repo.`,
                "",
                commitUrl ? `- Commit: ${commitUrl}` : "",
                "- I did not import it: the published copy has its wikilinks rewritten and its internal frontmatter stripped, so importing it back would overwrite the vault note with a lossy projection of itself.",
                "- Fold the change into the vault note and comment `approve` to republish, or leave it as a site-only edit.",
              ]
                .filter(Boolean)
                .join("\n"),
            );
          }
        }
      : undefined,
  },
});
stops.push(() => {
  ingress.close();
});

if (!jiraReady(config.jira) && !config.curator.botToken) {
  console.log("[scriptorium] local mode: drop a PRD or design into vault/_inbox and watch Curator file it. Ctrl+C to stop.");
}

process.on("SIGINT", () => {
  void Promise.allSettled(stops.map((stop) => stop())).finally(() => process.exit(0));
});
