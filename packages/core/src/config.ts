import path from "node:path";
import { config as loadDotenv } from "dotenv";

loadDotenv({ quiet: true });

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function envNumber(name: string, fallback: number): number {
  const parsed = Number(env(name));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface SlackAppTokens {
  botToken?: string;
  appToken?: string;
}

export interface JiraSettings {
  baseUrl?: string;
  email?: string;
  apiToken?: string;
  projectKey?: string;
  /** Overrides the default "every unfinished issue in this project" query. */
  jql?: string;
  /**
   * The auto-draft label — no longer the visibility gate.
   *
   * The agent watches the whole project so that a mention on any ticket gets an answer;
   * this label is what makes it draft *unasked* (HELP + a proactive draft on first sight).
   * An unlabelled ticket is mention-only: adopted quietly, silent until a human asks.
   */
  label: string;
  issueType: string;
  approvedStatus: string;
  pollMs: number;
  /** Resume state (processed comment ids, working drafts) — gitignored, not part of the record. */
  stateDir: string;
}

export interface DocsRepoSettings {
  /** SSH remote, e.g. git@github.com:owner/name.git */
  url?: string;
  /** Branch the external PR targets, and the branch the internal tree pushes to. */
  base: string;
  /** Deploy key — repo-scoped write, which is all pushing needs. */
  sshKey?: string;
  /** API token, only needed to OPEN a pull request; a deploy key cannot. */
  token?: string;
  /** Local clone the agent works in; lives beside the poller state, never in the vault. */
  workDir: string;
  /** "owner/name", derived from the URL, for the REST calls. */
  slug?: string;
}

export interface WebhookSettings {
  /** High-entropy path segment: Jira Cloud cannot sign webhook payloads, so the URL is the credential. */
  jiraSecret?: string;
  /** GitHub signs with HMAC-SHA256, so this is a real shared secret. */
  githubSecret?: string;
}

export interface AppConfig {
  model: string;
  /** True when either provider is configured — an API key or a Vertex project. */
  hasModelAccess: boolean;
  provider: "vertex" | "anthropic" | "none";
  vertexProject?: string;
  vertexRegion: string;
  repoRoot: string;
  vaultDir: string;
  auditFile: string;
  port: number;
  scribe: SlackAppTokens;
  curator: SlackAppTokens;
  jira: JiraSettings;
  docsRepo: DocsRepoSettings;
  webhook: WebhookSettings;
}

export function docsRepoReady(docs: DocsRepoSettings): boolean {
  return Boolean(docs.url && docs.workDir);
}

/** git@github.com:owner/name.git and https://github.com/owner/name(.git) both yield owner/name. */
export function repoSlugFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const match = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  const owner = match?.[1];
  const name = match?.[2];
  return owner && name ? `${owner}/${name}` : undefined;
}

export function jiraReady(jira: JiraSettings): boolean {
  return Boolean(jira.baseUrl && jira.email && jira.apiToken && jira.projectKey);
}

/**
 * Default JQL: every unfinished issue in the project, oldest touch first.
 *
 * Deliberately not filtered by `jira.label`: a reviewer's first instinct is to open any
 * ticket and type `@Scribe`, and a query the ticket doesn't match produces permanent
 * silence — no code path ever runs. The label decides whether the agent *drafts*
 * unasked (see `JiraSettings.label`), not whether it can see the ticket at all.
 */
/**
 * The approval-status clause is load-bearing: approval by workflow transition is only
 * observable while the issue is still in the result set after it moves. When the approval
 * status sits in the Done category — `JIRA_APPROVED_STATUS=Done`, the default on a
 * team-managed project with no "Approved" column — a bare `statusCategory != Done` filter
 * drops the issue at the exact moment a human approves it.
 */
export function defaultJql(jira: JiraSettings): string {
  if (jira.jql) return jira.jql;
  return `project = "${jira.projectKey}" AND (statusCategory != Done OR status = "${jira.approvedStatus}") ORDER BY updated ASC`;
}

export function loadConfig(repoRoot = process.cwd()): AppConfig {
  const vertexProject = env("VERTEX_PROJECT_ID");
  const provider = vertexProject ? "vertex" : env("ANTHROPIC_API_KEY") ? "anthropic" : "none";
  return {
    model: env("MODEL") ?? "claude-opus-5",
    hasModelAccess: provider !== "none",
    provider,
    vertexProject,
    vertexRegion: env("VERTEX_REGION") ?? "global",
    repoRoot,
    vaultDir: path.resolve(repoRoot, env("VAULT_DIR") ?? "vault"),
    auditFile: path.resolve(repoRoot, env("AUDIT_FILE") ?? "audit/log.jsonl"),
    port: envNumber("PORT", 8080),
    scribe: {
      botToken: env("SCRIBE_SLACK_BOT_TOKEN"),
      appToken: env("SCRIBE_SLACK_APP_TOKEN"),
    },
    curator: {
      botToken: env("CURATOR_SLACK_BOT_TOKEN"),
      appToken: env("CURATOR_SLACK_APP_TOKEN"),
    },
    jira: {
      baseUrl: env("JIRA_BASE_URL"),
      email: env("JIRA_EMAIL"),
      apiToken: env("JIRA_API_TOKEN"),
      projectKey: env("JIRA_PROJECT_KEY"),
      jql: env("JIRA_JQL"),
      label: env("JIRA_LABEL") ?? "doc-request",
      issueType: env("JIRA_ISSUE_TYPE") ?? "Task",
      approvedStatus: env("JIRA_APPROVED_STATUS") ?? "Approved",
      pollMs: envNumber("JIRA_POLL_MS", 15_000),
      stateDir: path.resolve(repoRoot, env("STATE_DIR") ?? ".scriptorium-state"),
    },
    webhook: {
      jiraSecret: env("JIRA_WEBHOOK_SECRET"),
      githubSecret: env("GITHUB_WEBHOOK_SECRET"),
    },
    docsRepo: {
      url: env("DOCS_REPO_URL"),
      base: env("DOCS_REPO_BRANCH") ?? "main",
      sshKey: env("DOCS_REPO_SSH_KEY"),
      token: env("DOCS_REPO_TOKEN"),
      workDir: path.resolve(repoRoot, env("DOCS_REPO_WORKDIR") ?? path.join(env("STATE_DIR") ?? ".scriptorium-state", "docs-repo")),
      slug: repoSlugFromUrl(env("DOCS_REPO_URL")),
    },
  };
}
