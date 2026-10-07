import fs from "node:fs/promises";
import path from "node:path";
import { docsRepoReady, jiraReady, previousSigningKeys, repoSlugFromUrl, vaultRepoReady, type AppConfig } from "@scriptorium/core";

/**
 * `pnpm doctor`: is this deployment set up the way its safety depends on? Every check names
 * what is wrong and the one thing to do about it. The checks are pure over injected probes,
 * so each one is pinned by evals without a live Slack, Confluence or GitHub; the script wires
 * the real clients in.
 */
export type Level = "ok" | "warn" | "fail";

export interface Check {
  area: string;
  level: Level;
  detail: string;
  /** What to do, when it isn't ok. */
  fix?: string;
}

/** What the doctor can ask the outside world. Each is optional: a missing probe skips its checks. */
export interface DoctorProbes {
  /** Slack `auth.test` for the Teammate's bot token: who it is and the scopes it has. */
  slackIdentity?: () => Promise<{ userId: string; scopes: string[] }>;
  /** Is the bot a member of this channel? */
  slackIsMember?: (channel: string) => Promise<boolean>;
  /** Can the Teammate's Atlassian account read this Confluence space? */
  confluenceCanRead?: (spaceKey: string) => Promise<boolean>;
  /** Can the GitHub App mint an installation token for this repo? */
  githubCanAccess?: (repo: string) => Promise<boolean>;
  /** The bot scopes the manifest asks for. */
  manifestScopes?: () => Promise<string[]>;
  /** This is the deployed service (Cloud Run sets K_SERVICE), where the container disk is lost at every revision. */
  deployed?: boolean;
}

export async function runDoctor(config: AppConfig, probes: DoctorProbes = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (area: string, level: Level, detail: string, fix?: string) => checks.push({ area, level, detail, ...(fix ? { fix } : {}) });
  const teammate = config.teammate;

  // Model
  if (config.hasModelAccess) add("model", "ok", `provider ${config.provider}, model ${config.model}`);
  else add("model", "fail", "no model provider is configured, so nothing can answer", "set ANTHROPIC_API_KEY, or LLM_PROVIDER=gemini with VERTEX_PROJECT_ID");

  // Signing
  if (config.signingKey) add("signing", "ok", "approvals are signed and verified where they are used");
  else add("signing", "warn", "approvals are unsigned, so an edited memory or house rule file is trusted", "set SCRIPTORIUM_SIGNING_KEY (openssl rand -hex 32) as a secret, then re-approve existing house rules");

  if (config.signingKey && previousSigningKeys().length) {
    add("signing", "warn", "a key rotation is in progress: previous signing keys are still accepted", "run pnpm resign, then remove SCRIPTORIUM_PREVIOUS_SIGNING_KEYS");
  }

  // Where the record lives
  const stateDir = path.resolve(config.jira.stateDir);
  const audit = path.resolve(config.auditFile);
  const underRepo = (file: string) => file.startsWith(path.resolve(config.repoRoot) + path.sep);
  if (probes.deployed && underRepo(stateDir)) {
    add("state", "fail", `state (${stateDir}) is on the container's disk: the approval ledger and processed-comment record are lost at every revision, so old comments are worked again`, "mount a persistent volume and set STATE_DIR to it");
  }
  // gcsfuse has no hardlinks and weak rename/lock semantics: `git clone` into it fails.
  for (const [name, dir] of [["DOCS_REPO_WORKDIR", config.docsRepo.workDir], ["VAULT_REPO_WORKDIR", config.docsRepo.vaultWorkDir]] as const) {
    if (dir && !underRepo(stateDir) && path.resolve(dir).startsWith(stateDir + path.sep)) {
      add("state", "fail", `${name} (${dir}) is inside the state volume, where git can't clone`, `leave ${name} unset (the default is a scratch directory) or point it outside ${stateDir}`);
    }
  }
  if (!underRepo(stateDir) && underRepo(audit)) {
    add("audit", "warn", `the audit log (${audit}) is in the working directory while state is on ${stateDir}: it won't survive a new revision`, `set AUDIT_FILE=${path.join(stateDir, "audit", "log.jsonl")}`);
  } else {
    add("audit", "ok", `audit log at ${audit}`);
  }

  // Who can approve, and who can stop it
  if (!teammate.approvers?.length) add("approvals", "warn", "TEAMMATE_APPROVERS is empty, so no Teammate write can ever be approved", "list the Slack user ids of your approvers");
  else add("approvals", "ok", `${teammate.approvers.length} approver(s)`);
  const linked = new Set((teammate.people ?? []).flat());
  const unlinked = (teammate.approvers ?? []).filter((id) => !linked.has(`slack:${id}`));
  if (teammate.approvers?.length && unlinked.length && (jiraReady(config.jira) || teammate.githubRepos.length)) {
    add("approvals", "warn", `approver(s) ${unlinked.join(", ")} aren't linked to their Jira/GitHub accounts, so asking on Jira and approving in Slack isn't caught`, "link each approver's accounts in TEAMMATE_PEOPLE (slack:U1=jira:<id>=github:<login>)");
  }
  if (jiraReady(config.jira) && !config.jira.approvers?.length) {
    add("approvals", "warn", "JIRA_APPROVERS is empty, so anyone who can comment on a doc ticket can approve its publish", "list the Jira account ids who may approve docs");
  }
  if (config.webhook?.metricsToken && config.webhook.metricsToken === config.webhook.traceToken) {
    add("controls", "warn", "METRICS_TOKEN and TRACE_TOKEN are the same, so whoever scrapes metrics can also read every run's trace", "give each its own token");
  }
  if (!teammate.admins?.length) add("controls", "warn", "TEAMMATE_ADMINS is empty, so nobody can pause it or switch a tool off without a redeploy", "list the Slack user ids who may run /teammate admin");
  else add("controls", "ok", `${teammate.admins.length} admin(s) can pause it`);

  // Spend
  if (!teammate.dailyTokens && !teammate.dailyTokensTotal) add("spend", "warn", "no daily token cap", "set TEAMMATE_DAILY_TOKENS (per channel) and TEAMMATE_DAILY_TOKENS_TOTAL");

  // Curator's Slack app
  if (config.curator?.botToken) {
    if (!config.curator.channels?.length) add("curator", "warn", "CURATOR_SLACK_CHANNELS is empty, so Curator answers nowhere", "list the channel ids it may answer in");
    else add("curator", "ok", `answers in ${config.curator.channels.length} channel(s)`);
    if (!config.curator.dailyTokens) add("spend", "warn", "Curator has no daily token cap", "set CURATOR_DAILY_TOKENS (per channel)");
  }

  // Slack
  if (teammate.botToken && probes.slackIdentity) {
    try {
      const identity = await probes.slackIdentity();
      add("slack", "ok", `signed in as <@${identity.userId}>`);
      const wanted = probes.manifestScopes ? await probes.manifestScopes() : [];
      const missing = wanted.filter((scope) => !identity.scopes.includes(scope));
      if (missing.length) add("slack", "fail", `the app is missing scope(s) ${missing.join(", ")} that this version needs`, "reinstall the app from slack-manifests/teammate.yaml");
      else if (wanted.length) add("slack", "ok", "every scope the manifest asks for is granted");
    } catch (error) {
      add("slack", "fail", `the bot token doesn't work (${message(error)})`, "check TEAMMATE_SLACK_BOT_TOKEN");
    }
    if (!teammate.channels.length) add("slack", "warn", "TEAMMATE_SLACK_CHANNELS is empty, so it answers nowhere", "list the channel ids it may answer in");
    for (const channel of teammate.channels) {
      if (!probes.slackIsMember) break;
      const member = await probes.slackIsMember(channel).catch(() => false);
      if (member) add("slack", "ok", `member of ${channel}`);
      else add("slack", "fail", `not a member of ${channel}, so mentions there get no reply and cards can't be posted`, `/invite @Teammate in ${channel}`);
    }
  } else if (!teammate.botToken) {
    add("slack", "warn", "no Teammate Slack app is configured", "set TEAMMATE_SLACK_BOT_TOKEN and TEAMMATE_SLACK_APP_TOKEN");
  }

  // Confluence
  if (teammate.confluenceSpaces.length && probes.confluenceCanRead) {
    for (const space of teammate.confluenceSpaces) {
      const readable = await probes.confluenceCanRead(space).catch(() => false);
      if (readable) add("confluence", "ok", `can read space ${space}`);
      else add("confluence", "fail", `can't read space ${space}`, "give the Teammate's Atlassian account access to it, or remove it from TEAMMATE_CONFLUENCE_SPACES");
    }
  }

  // GitHub
  if (teammate.githubRepos.length && probes.githubCanAccess) {
    for (const repo of teammate.githubRepos) {
      const reachable = await probes.githubCanAccess(repo).catch(() => false);
      if (reachable) add("github", "ok", `the GitHub App is installed on ${repo}`);
      else add("github", "fail", `the GitHub App can't access ${repo}`, "install the Teammate's GitHub App on that repo, or remove it from TEAMMATE_GITHUB_REPOS");
    }
  }

  // Where docs are published
  const docs = config.docsRepo;
  if ((docsRepoReady(docs) || teammate.githubRepos.length) && !config.webhook?.githubSecret) {
    add("github", "warn", "GITHUB_WEBHOOK_SECRET is unset, so GitHub events are refused: no merge reaches the ticket and no PR is checked when it opens", "set GITHUB_WEBHOOK_SECRET and the same secret on the repos' webhooks");
  }
  if (docsRepoReady(docs)) {
    const docsSlug = repoSlugFromUrl(docs.url)?.toLowerCase();
    // Pull requests go to api.github.com and merges come back as GitHub webhooks, so another
    // host gets its branches pushed and nothing more.
    if (!docsSlug || !/(^|[@/.])github\.com[:/]/i.test(docs.url ?? "")) {
      add("publishing", "warn", `DOCS_REPO_URL (${docs.url}) isn't a GitHub repo: branches are pushed, but no pull request is opened and no merge reaches the ticket`, "use git@github.com:<owner>/<name>.git, or merge the doc branches by hand");
    }
    if (docs.commitEmail === "agent@scriptorium.local") {
      add("publishing", "warn", "publish commits use the placeholder email agent@scriptorium.local, so GitHub attributes them to nobody", "set DOCS_REPO_COMMIT_EMAIL (and DOCS_REPO_COMMIT_NAME) to the bot account's");
    }
    const vaultSlug = repoSlugFromUrl(docs.vaultUrl)?.toLowerCase();
    if (!vaultRepoReady(docs)) {
      add("publishing", "warn", "no vault repo: internal notes (PRDs, gaps, house rules) are pushed nowhere and not restored on boot", "set VAULT_REPO_URL to a PRIVATE repo, with its own VAULT_REPO_SSH_KEY");
    } else if (docsSlug && docsSlug === vaultSlug) {
      add("publishing", "fail", `the vault repo and the docs repo are the same (${docsSlug}): internal notes would be published with the docs`, "point VAULT_REPO_URL at a separate private repository");
    } else {
      add("publishing", "ok", `docs → ${docsSlug ?? docs.url}, internal → ${vaultSlug ?? docs.vaultUrl}`);
      if (docs.sshKey && docs.sshKey === docs.vaultSshKey) {
        add("publishing", "fail", "both repos use the same deploy key file; GitHub binds a deploy key to one repository", "give each repo its own key (DOCS_REPO_SSH_KEY, VAULT_REPO_SSH_KEY)");
      }
    }
  }

  return checks;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error);
}

/** The bot scopes a Slack manifest asks for (the `oauth_config.scopes.bot` list). */
export async function manifestBotScopes(file: string): Promise<string[]> {
  const text = await fs.readFile(file, "utf8");
  const bot = text.match(/scopes:\s*\n\s*bot:\s*\n((?:\s*(?:-\s*[\w:.]+|#.*)\s*\n)+)/);
  return bot ? [...(bot[1] as string).matchAll(/-\s*([\w:.]+)/g)].map((match) => match[1] as string) : [];
}

export function formatChecks(checks: readonly Check[]): string {
  const mark: Record<Level, string> = { ok: "✓", warn: "⚠", fail: "✗" };
  return checks.map((check) => `${mark[check.level]} ${check.area.padEnd(11)} ${check.detail}${check.fix ? `\n  ${"".padEnd(11)} → ${check.fix}` : ""}`).join("\n");
}
