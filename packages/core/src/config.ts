import path from "node:path";
import { config as loadDotenv } from "dotenv";

loadDotenv({ quiet: true });

/** Comma-separated env value → trimmed, non-empty items. */
function list(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

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
  /** Slack user ids allowed to approve from this app's buttons. Empty: nobody. */
  approvers?: string[];
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
  /**
   * The board is the state machine, so the agent drives it: In Progress while it works,
   * In Review while a human decides, Done once published. Every move is best-effort — a
   * workflow without one of these columns simply does not get that move, and the ticket
   * comments remain the authoritative narration.
   */
  inProgressStatus: string;
  inReviewStatus: string;
  approvedStatus: string;
  /**
   * Jira account ids whose `approve` (comment or board move) publishes. Empty: any human
   * on the ticket, never the agent. Set it: a project's commenters are not its approvers.
   */
  approvers?: string[];
  pollMs: number;
  /** Resume state (processed comment ids, working drafts) — gitignored, not part of the record. */
  stateDir: string;
}

export interface DocsRepoSettings {
  /** SSH remote, e.g. git@github.com:owner/name.git */
  url?: string;
  /** Branch the external PR targets. The agent never pushes here — a human merges. */
  base: string;
  /**
   * Branch the internal tree pushes to, deliberately NOT the base.
   *
   * GitHub does not offer branch protection on a private repo on the free plan, so nothing
   * on the platform stops this credential from writing `main`. Keeping every agent push on
   * its own branches means the merge gate is a property of what the agent does, not merely
   * of what its token is forbidden to do — and the residual risk is one line of policy
   * instead of the whole publication gate.
   */
  internalBranch: string;
  /** Deploy key — repo-scoped write, which is all pushing needs. */
  sshKey?: string;
  /** API token, only needed to OPEN a pull request; a deploy key cannot. */
  token?: string;
  /**
   * GitHub App credentials — the preferred way to get PR-opening rights. Installed on
   * one repo, two permissions, hour-lived tokens, its own [bot] identity on the PR.
   * When both are set they win over `token`.
   */
  githubAppId?: string;
  /** PEM private key, or a path to it (a Secret Manager mount is a path). */
  githubAppKey?: string;
  /** Local clone the agent works in; lives beside the poller state, never in the vault. */
  workDir: string;
  /** "owner/name", derived from the URL, for the REST calls. */
  slug?: string;
  /**
   * Identity the agent commits as in the docs repo.
   *
   * Not cosmetic: Vercel refuses to build a commit whose author email GitHub cannot
   * associate with a user (`COMMIT_AUTHOR_REQUIRED`), so an unassociated address means
   * every published doc is blocked from ever reaching the site. The GitHub noreply form
   * `<id>+<login>@users.noreply.github.com` always associates.
   */
  commitName: string;
  commitEmail: string;
}

/** The general Teammate agent (ADR-001). Every list is an allow-list: empty means none. */
export interface TeammateSettings extends SlackAppTokens {
  /** Slack channel ids the Teammate may read and post in. Empty: it answers nowhere. */
  channels: string[];
  /** Jira project keys it may search and read (and, with approval, write). */
  jiraProjects: string[];
  /** Confluence space keys it may search and read. */
  confluenceSpaces: string[];
  /**
   * The Teammate's OWN Atlassian account (a service account). Without it the Teammate may
   * read Jira and Confluence with the shared token, but it may not write: two agents on one
   * token are one identity, and every write would be attributed to the other agent.
   */
  atlassianEmail?: string;
  atlassianToken?: string;
  /** The Teammate's OWN GitHub App (not the docs repo's), and the repos it may read. */
  githubAppId?: string;
  githubAppKey?: string;
  githubRepos: string[];
  /** Where an automatic PR check posts its summary and the approval card for its comment. */
  prChannel?: string;
  /** Answer direct messages too (off by default: a DM is a channel nobody else can see). */
  allowDms: boolean;
  /** Model tokens per channel (or DM) per UTC day. Unset: unlimited. */
  dailyTokens?: number;
  /** Channel for the weekly digest. Unset: no digest. */
  digestChannel?: string;
  /** When it goes out, UTC: weekday 1–7 (Mon–Sun) and hour. Default Monday 09:00. */
  digestWeekday: number;
  digestHour: number;
}

export interface SlackSettings {
  /** Channel id for publish announcements and draft-approval buttons. Optional. */
  notifyChannel?: string;
}

/**
 * Where a published note can actually be read. Optional: without these a citation still
 * names its note, it just cannot be opened — which is the difference between provenance
 * a reader can trust and provenance a reader can check.
 */
export interface SiteSettings {
  /** Public docs site, built from the docs repo's base branch. Serves `docs/x` at `/x`. */
  external?: string;
  /** Access-controlled internal site, built from the internal branch. Serves paths 1:1. */
  internal?: string;
}

export interface WebhookSettings {
  /** High-entropy path segment. Always required; the URL is the first credential. */
  jiraSecret?: string;
  /**
   * Jira's own webhook secret, set in the WebHooks UI. When present Jira signs the payload
   * (`X-Hub-Signature: sha256=…`) and the ingress verifies it — strictly better than the
   * path segment alone, which is why it is used when configured. The REST webhook API is
   * still Connect/OAuth-only, so registration remains a UI step.
   */
  jiraHmacSecret?: string;
  /**
   * Opens the run viewer (`/runs/<id>?token=…`). Unset: no viewer. The page shows a run's
   * audit trail — questions, tool calls, approvals — so it is a credential, not a nicety.
   */
  traceToken?: string;
  /** Where the ingress is reachable (`https://…run.app`), for "view run" links on replies. */
  publicBaseUrl?: string;
  /** GitHub signs with HMAC-SHA256, so this is a real shared secret. */
  githubSecret?: string;
}

export interface AppConfig {
  model: string;
  /** True when either provider is configured — an API key or a Vertex project. */
  hasModelAccess: boolean;
  provider: "gemini" | "vertex" | "anthropic" | "none";
  vertexProject?: string;
  vertexRegion: string;
  repoRoot: string;
  vaultDir: string;
  auditFile: string;
  port: number;
  scribe: SlackAppTokens;
  curator: SlackAppTokens;
  teammate: TeammateSettings;
  jira: JiraSettings;
  docsRepo: DocsRepoSettings;
  webhook: WebhookSettings;
  slack: SlackSettings;
  sites: SiteSettings;
  /**
   * Signs approvals (lessons, memories) so a restore from the docs repo cannot be fed a
   * forged one. Unset: approvals are unsigned and restores trust the branch — see
   * docs/security-model.md.
   */
  signingKey?: string;
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
  const provider =
    env("LLM_PROVIDER") === "gemini" && vertexProject
      ? "gemini"
      : vertexProject
        ? "vertex"
        : env("ANTHROPIC_API_KEY")
          ? "anthropic"
          : "none";
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
      approvers: (env("SCRIBE_SLACK_APPROVERS") ?? "").split(",").map((id) => id.trim()).filter(Boolean),
    },
    curator: {
      botToken: env("CURATOR_SLACK_BOT_TOKEN"),
      appToken: env("CURATOR_SLACK_APP_TOKEN"),
    },
    signingKey: env("SCRIPTORIUM_SIGNING_KEY"),
    teammate: {
      botToken: env("TEAMMATE_SLACK_BOT_TOKEN"),
      appToken: env("TEAMMATE_SLACK_APP_TOKEN"),
      approvers: list(env("TEAMMATE_APPROVERS")),
      channels: list(env("TEAMMATE_SLACK_CHANNELS")),
      jiraProjects: list(env("TEAMMATE_JIRA_PROJECTS")),
      confluenceSpaces: list(env("TEAMMATE_CONFLUENCE_SPACES")),
      atlassianEmail: env("TEAMMATE_ATLASSIAN_EMAIL"),
      atlassianToken: env("TEAMMATE_ATLASSIAN_TOKEN"),
      githubAppId: env("TEAMMATE_GITHUB_APP_ID"),
      githubAppKey: env("TEAMMATE_GITHUB_APP_KEY"),
      githubRepos: list(env("TEAMMATE_GITHUB_REPOS")),
      prChannel: env("TEAMMATE_PR_CHANNEL"),
      allowDms: env("TEAMMATE_ALLOW_DMS") === "true",
      dailyTokens: env("TEAMMATE_DAILY_TOKENS") ? Number(env("TEAMMATE_DAILY_TOKENS")) : undefined,
      digestChannel: env("TEAMMATE_DIGEST_CHANNEL"),
      digestWeekday: envNumber("TEAMMATE_DIGEST_WEEKDAY", 1),
      digestHour: envNumber("TEAMMATE_DIGEST_HOUR", 9),
    },
    jira: {
      baseUrl: env("JIRA_BASE_URL"),
      email: env("JIRA_EMAIL"),
      apiToken: env("JIRA_API_TOKEN"),
      projectKey: env("JIRA_PROJECT_KEY"),
      jql: env("JIRA_JQL"),
      label: env("JIRA_LABEL") ?? "doc-request",
      issueType: env("JIRA_ISSUE_TYPE") ?? "Task",
      inProgressStatus: env("JIRA_IN_PROGRESS_STATUS") ?? "In Progress",
      inReviewStatus: env("JIRA_IN_REVIEW_STATUS") ?? "In Review",
      approvedStatus: env("JIRA_APPROVED_STATUS") ?? "Approved",
      approvers: list(env("JIRA_APPROVERS")),
      pollMs: envNumber("JIRA_POLL_MS", 15_000),
      stateDir: path.resolve(repoRoot, env("STATE_DIR") ?? ".scriptorium-state"),
    },
    slack: { notifyChannel: env("SLACK_NOTIFY_CHANNEL") },
    sites: {
      external: env("EXTERNAL_SITE_URL")?.replace(/\/+$/, ""),
      internal: env("INTERNAL_SITE_URL")?.replace(/\/+$/, ""),
    },
    webhook: {
      jiraSecret: env("JIRA_WEBHOOK_SECRET"),
      jiraHmacSecret: env("JIRA_WEBHOOK_HMAC_SECRET"),
      githubSecret: env("GITHUB_WEBHOOK_SECRET"),
      traceToken: env("TRACE_TOKEN"),
      publicBaseUrl: env("PUBLIC_BASE_URL"),
    },
    docsRepo: {
      url: env("DOCS_REPO_URL"),
      base: env("DOCS_REPO_BRANCH") ?? "main",
      internalBranch: env("DOCS_REPO_INTERNAL_BRANCH") ?? "vault-live",
      sshKey: env("DOCS_REPO_SSH_KEY"),
      token: env("DOCS_REPO_TOKEN"),
      githubAppId: env("DOCS_REPO_GITHUB_APP_ID"),
      githubAppKey: env("DOCS_REPO_GITHUB_APP_KEY"),
      /**
       * Scratch clone, deliberately NOT under STATE_DIR.
       *
       * STATE_DIR is a persistent volume — in production a GCS FUSE mount — and a git work
       * tree does not belong there: gcsfuse has no hardlinks and weak rename/lock
       * semantics, so `git clone` into it fails. The ledger needs persistence; this clone
       * is re-creatable from the remote on every boot.
       */
      workDir: path.resolve(repoRoot, env("DOCS_REPO_WORKDIR") ?? ".scriptorium-state/docs-repo"),
      slug: repoSlugFromUrl(env("DOCS_REPO_URL")),
      commitName: env("DOCS_REPO_COMMIT_NAME") ?? "scriptorium agent",
      commitEmail: env("DOCS_REPO_COMMIT_EMAIL") ?? "agent@scriptorium.local",
    },
  };
}
