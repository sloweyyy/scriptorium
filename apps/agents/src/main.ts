import path from "node:path";
import { docsRepoReady, geminiModel, jiraReady, loadConfig, Vault } from "@scriptorium/core";
import { jiraClient } from "@scriptorium/jira";
import { FileEffectLedger } from "@scriptorium/runtime";
import { seedCorpusIfEmpty, updateMoc, watchInbox } from "@scriptorium/curator";
import { startIngress } from "./ingress";
import { hydrateVaultFromDocsRepo, syncFromDocsRepo } from "./docs-repo";
import { startCuratorBot } from "./curator-bot";
import { startScribeBot } from "./scribe-bot";
import { startScribeJira, type ScribeJiraHandle } from "./scribe-jira";
import { reportStaleDocs } from "./staleness-watch";
import { startTeammateBot, type TeammateCore } from "./teammate-bot";

/**
 * One process, one vault, one audit log — two agents with separate identities and
 * separate surfaces: Scribe answers on Jira, Curator answers on Slack.
 */
const config = loadConfig();
const vault = new Vault(config.vaultDir);
await vault.ensure();

console.log(`[scriptorium] vault:  ${config.vaultDir}`);
console.log(
  // Every provider gets a branch. A missing one silently reads as "NO PROVIDER
  // CONFIGURED" while the provider is in fact working, which is a log line that costs
  // someone an hour.
  `[scriptorium] model:  ${
    config.provider === "gemini"
      ? `${geminiModel()} via Gemini on Vertex (${config.vertexProject}, ${config.vertexRegion})`
      : config.provider === "vertex"
        ? `${config.model} via Claude on Vertex (${config.vertexProject}, ${config.vertexRegion})`
        : config.provider === "anthropic"
          ? `${config.model} via the Anthropic API`
          : "NO PROVIDER CONFIGURED"
  }`,
);

// A fresh container has an empty vault. Restore it from the docs repo before anything
// answers a question, so Curator can cite notes this instance never watched being written.
if (docsRepoReady(config.docsRepo)) {
  try {
    const restored = await hydrateVaultFromDocsRepo(config, vault);
    if (restored.length) {
      await updateMoc(vault);
      console.log(`[scriptorium] restored ${restored.length} note(s) from ${config.docsRepo.slug ?? "the docs repo"}`);
    }
  } catch (error) {
    console.warn(`[scriptorium] vault restore skipped: ${error instanceof Error ? error.message : error}`);
  }
}

// The reference corpus is derived, not committed, so a fresh container has none of it —
// and a Curator with no reference material answers NOT_IN_KB to every question about the
// product that corpus documents. Seeded here rather than baked into the image so the vault
// stays regenerable from `corpus/`, where each page carries the source_url it came from.
try {
  const seeded = await seedCorpusIfEmpty(vault, "corpus");
  if (seeded) {
    console.log(`[curator] seeded ${seeded.filed}/${seeded.found} reference note(s) from corpus/`);
    for (const name of seeded.skipped) console.warn(`[curator] corpus page skipped (bad frontmatter): ${name}`);
  }
} catch (error) {
  // No corpus is a smaller problem than a process that will not start.
  console.warn(`[scriptorium] corpus seeding skipped: ${error instanceof Error ? error.message : error}`);
}

const stopWatcher = watchInbox(vault, (result) => {
  console.log(`[curator] ${result.action}: ${result.from}${result.to ? ` -> ${result.to}` : ""}${result.note ? ` (${result.note})` : ""}`);
});

const stops: Array<() => void | Promise<unknown>> = [stopWatcher];
let scribe: ScribeJiraHandle | undefined;

if (jiraReady(config.jira)) {
  try {
    // The Teammate's own Jira account, if it has one: Scribe must not read its conversation
    // (questions to it, answers from it) as feedback on a draft.
    const teammateJiraId =
      config.teammate.atlassianEmail && config.teammate.atlassianToken
        ? await jiraClient({ ...config.jira, email: config.teammate.atlassianEmail, apiToken: config.teammate.atlassianToken })
            .myself()
            .then((me) => me.accountId)
            .catch(() => undefined)
        : undefined;
    scribe = await startScribeJira(config, vault, { otherAgentIds: teammateJiraId ? [teammateJiraId] : [] });
    stops.push(() => scribe?.stop());
  } catch (error) {
    console.error(`[scribe] jira poller failed to start: ${error instanceof Error ? error.message : error}`);
    console.error("[scribe] run `pnpm jira:doctor` to see which check fails.");
  }
} else {
  console.log("[scribe]  Jira not configured — set JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN / JIRA_PROJECT_KEY in .env");
}

if (config.scribe.botToken && config.scribe.appToken) {
  await startScribeBot(config, vault, scribe);
}

if (config.curator.botToken && config.curator.appToken) {
  await startCuratorBot(config, vault);
} else {
  console.log("[curator] Slack tokens not set — create the app from slack-manifests/curator.yaml, then fill .env");
}

// Stale docs: hourly, compare every published doc with its source PRD now; a doc whose PRD
// changed since approval gets ONE notice on the ticket it was approved on.
if (scribe) {
  const staleLedger = new FileEffectLedger(path.join(config.jira.stateDir, "effects.json"));
  const checkStale = (): void =>
    void reportStaleDocs({ vault, ledger: staleLedger, auditFile: config.auditFile, notify: (key, markdown) => scribe!.comment(key, markdown) })
      .then(({ notified }) => notified.length && console.log(`[curator] stale: notified ${notified.join(", ")}`))
      .catch((error) => console.warn(`[curator] staleness check: ${error instanceof Error ? error.message : error}`));
  const staleTimer = setInterval(checkStale, 60 * 60 * 1000);
  stops.push(() => clearInterval(staleTimer));
  checkStale();
}

// The general Teammate (ADR-001). Its own Slack identity, its own envelope; answers only in
// TEAMMATE_SLACK_CHANNELS, and every write waits for a TEAMMATE_APPROVERS click.
let teammate: TeammateCore | undefined;
if (config.teammate.botToken && config.teammate.appToken) {
  try {
    const started = await startTeammateBot(config, vault);
    teammate = started.core;
    stops.push(started.stop);
  } catch (error) {
    console.error(`[teammate] failed to start: ${error instanceof Error ? error.message : error}`);
  }
}

// One HTTP surface: health plus the two webhooks. The Jira webhook is a latency
// optimisation over the poller — same handler, same ledger — and the GitHub webhook is the
// inbound half of the round trip.
const ingress = startIngress({
  config,
  hooks: {
    nudge: scribe ? (issueKey) => scribe!.nudge(issueKey) : undefined,
    pullRequest: (input) => teammate?.onPullRequest(input) ?? Promise.resolve(),
    jiraComment: (input) => teammate?.onJiraComment(input) ?? Promise.resolve(),
    jiraAssigned: (input) => teammate?.onJiraAssigned(input) ?? Promise.resolve(),
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
            if (edited.landed) {
              // The agent's own publish arriving via its PR merge — the loop closing,
              // not a human edit. The ticket gets the good news and the live URL.
              const slug = edited.repoPath.replace(/^docs\//, "").replace(/\.md$/, "");
              await scribe.comment(
                edited.issueKey,
                [
                  "🎉 **The pull request was merged — this doc is now live on the public site.**",
                  "",
                  config.sites.external ? `- ${config.sites.external}/${slug}` : undefined,
                  commitUrl ? `- Merge commit: ${commitUrl}` : undefined,
                ]
                  .filter(Boolean)
                  .join("\n"),
              );
              continue;
            }
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

const shutdown = (signal: string): void => {
  console.log(`[scriptorium] ${signal} — closing the poller, the ingress and the socket`);
  void Promise.allSettled(stops.map((stop) => stop())).finally(() => process.exit(0));
};

// SIGTERM is what Cloud Run actually sends when it replaces a revision; without it the
// process is killed mid-flight and the platform logs a bare command failure.
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
