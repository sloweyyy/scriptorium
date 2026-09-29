/**
 * `pnpm doctor` — is this deployment set up the way its safety depends on?
 *
 * Checks the model, signing, where the audit log lives, approvers and admins, spend caps,
 * the Slack app (token, scopes against the manifest, channel membership), Confluence spaces,
 * the GitHub App's repos, and where docs are published. Read-only: it posts nothing and
 * changes nothing. Exits 1 if any check fails. (`pnpm jira:doctor` covers the Jira side.)
 */
import path from "node:path";
import { WebClient } from "@slack/web-api";
import { loadConfig } from "@scriptorium/core";
import { installationToken } from "@scriptorium/publish";
import { formatChecks, manifestBotScopes, runDoctor, type DoctorProbes } from "@scriptorium/agents";

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (error) {
  // A setting that can't be read refuses to start; the doctor names it instead of a stack.
  console.log(`✗ config: ${error instanceof Error ? error.message : error}\n\n✗ 1 to fix.`);
  process.exit(1);
}
const teammate = config.teammate;
const probes: DoctorProbes = { deployed: Boolean(process.env.K_SERVICE), manifestScopes: () => manifestBotScopes(path.join(config.repoRoot, "slack-manifests/teammate.yaml")) };

if (teammate.botToken) {
  const slack = new WebClient(teammate.botToken);
  probes.slackIdentity = async () => {
    const auth = await slack.auth.test();
    return { userId: String(auth.user_id), scopes: auth.response_metadata?.scopes ?? [] };
  };
  probes.slackIsMember = async (channel) => Boolean((await slack.conversations.info({ channel })).channel?.is_member);
}

if (config.jira.baseUrl && teammate.atlassianEmail && teammate.atlassianToken) {
  const auth = `Basic ${Buffer.from(`${teammate.atlassianEmail}:${teammate.atlassianToken}`).toString("base64")}`;
  probes.confluenceCanRead = async (space) => {
    const response = await fetch(`${config.jira.baseUrl?.replace(/\/$/, "")}/wiki/api/v2/spaces?keys=${encodeURIComponent(space)}`, { headers: { Authorization: auth, Accept: "application/json" } });
    return response.ok && ((await response.json()) as { results?: unknown[] }).results?.length === 1;
  };
}

if (teammate.githubAppId && teammate.githubAppKey) {
  const appId = teammate.githubAppId;
  const privateKey = teammate.githubAppKey;
  probes.githubCanAccess = async (repo) => Boolean(await installationToken({ appId, privateKey, repo }));
}

const checks = await runDoctor(config, probes);
console.log(formatChecks(checks));
const failed = checks.filter((check) => check.level === "fail").length;
const warned = checks.filter((check) => check.level === "warn").length;
console.log(`\n${failed ? `✗ ${failed} to fix` : "✓ nothing to fix"}${warned ? `, ⚠ ${warned} to review` : ""}.`);
if (failed) process.exitCode = 1;
