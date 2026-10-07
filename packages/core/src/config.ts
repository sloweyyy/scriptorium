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

/**
 * A numeric setting. Unset: the fallback. Set to something that is not a number in range:
 * refuse to start. A typo used to fall back silently — `TEAMMATE_DAILY_TOKENS=50k` meant no
 * cap at all, and a documented `0` ("never", "Sunday", "midnight") meant the default.
 */
function envNumber(name: string, fallback: number, range: { min?: number; max?: number } = {}): number {
  return envOptionalNumber(name, range) ?? fallback;
}

function envOptionalNumber(name: string, { min = 1, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {}): number | undefined {
  const raw = env(name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    const range = max === Number.MAX_SAFE_INTEGER ? `of at least ${min}` : `from ${min} to ${max}`;
    throw new Error(`${name}=${JSON.stringify(raw)} is not a number ${range}; fix or unset it`);
  }
  return parsed;
}

/** Two remotes are the same repo if they name the same owner/name, whatever the URL form. */
function sameRepo(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const slugA = repoSlugFromUrl(a);
  return slugA ? slugA.toLowerCase() === repoSlugFromUrl(b)?.toLowerCase() : a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
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
  /**
   * Confluence spaces Scribe may read a linked PRD from (SCRIBE_CONFLUENCE_SPACES, falling
   * back to the Teammate's). Empty: no Confluence PRDs at all. A ticket author must not be
   * able to make Scribe read, and quote onto the ticket, a page in a space they can't see.
   */
  prdSpaces?: string[];
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
  /** SSH remote of the PUBLIC docs repo, e.g. git@github.com:owner/name.git */
  url?: string;
  /** Branch the external PR targets. The agent never pushes here — a human merges. */
  base: string;
  /** Deploy key for the docs repo — repo-scoped write, which is all pushing needs. */
  sshKey?: string;
  /**
   * SSH remote of the PRIVATE vault repo that carries `internal/` (PRDs, gaps, lessons).
   *
   * A separate repository, not a branch of the docs repo: the docs repo is public, and a
   * branch of a public repo is public. There is deliberately no fallback to `url` — an
   * unset vault remote skips every internal push rather than sending PRDs and house rules
   * to the public repo because one env var was forgotten at deploy time.
   */
  vaultUrl?: string;
  /** Branch of the vault repo the internal tree pushes to, and restores from on boot. */
  internalBranch: string;
  /**
   * Deploy key for the vault repo. Its own key, because GitHub binds a deploy key to
   * exactly one repository.
   */
  vaultSshKey?: string;
  /** Local clone of the vault repo. Defaults to a sibling of `workDir`. */
  vaultWorkDir?: string;
  /** "owner/name" of the vault repo, derived from `vaultUrl`. */
  vaultSlug?: string;
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
  /**
   * One person's accounts across surfaces (`slack:U1`, `jira:<accountId>`, `github:<login>`),
   * so "the requester may not approve" holds when they asked on Jira and click in Slack.
   * `TEAMMATE_PEOPLE="slack:U1=jira:abc=github:dev; slack:U2=jira:def"`.
   */
  people?: string[][];
  /** Hours a request may wait before its approvers are nudged once in the card's thread. 0: never. */
  approvalNudgeHours?: number;
  /** Slack user ids who may pause the Teammate or switch tools off (`/teammate admin …`). Empty: nobody. */
  admins?: string[];
  /** Projects whose new issues the Teammate triages (readiness + likely duplicates). Empty: none. */
  triageProjects?: string[];
  /** At most this many triages per project per hour — a bulk import must not flood the ticket feed. */
  triagePerHour?: number;
  /** Model tokens per channel (or DM) per UTC day. Unset: unlimited. */
  dailyTokens?: number;
  /** Tokens per UTC day across everything, whatever the scope: many DMs can't add up past it. */
  dailyTokensTotal?: number;
  /** Channel for the weekly digest. Unset: no digest. */
  digestChannel?: string;
  /** When it goes out, UTC: weekday 1–7 (Mon–Sun) and hour. Default Monday 09:00. */
  digestWeekday: number;
  digestHour: number;
}

export interface SlackSettings {
  /** Channel id for publish announcements and draft-approval buttons. Optional. */
  notifyChannel?: string;
  /** `https://<workspace>.slack.com` — turns a `slack:<channel>/<ts>` citation into a link. */
  workspaceUrl?: string;
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
   * Opens any run in the viewer (`/runs/<id>` with `Authorization: Bearer …`; a reply's own
   * link is signed for its run instead). Unset: no viewer. The page shows a run's
   * audit trail — questions, tool calls, approvals — so it is a credential, not a nicety.
   */
  traceToken?: string;
  /** Opens `/metrics` (`Authorization: Bearer …`). Unset: no metrics endpoint. */
  metricsToken?: string;
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
  curator: SlackAppTokens & {
    /**
     * Channel ids Curator answers in. Empty: nowhere. It reads prd/** and _lessons/**, the
     * internal plane, so being invited to a channel (a guest or Slack Connect one) is not
     * reason enough to quote them there.
     */
    channels?: string[];
    /** Model tokens per channel per UTC day. Unset: unlimited (the doctor says so). */
    dailyTokens?: number;
  };
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

/** The internal plane has somewhere private to go. Never inferred from the docs repo. */
export function vaultRepoReady(docs: DocsRepoSettings): boolean {
  return Boolean(docs.vaultUrl);
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
  // The internal plane going to the public docs repo is the one leak the split exists to
  // prevent; the same URL in both settings is refused, not published.
  if (sameRepo(env("VAULT_REPO_URL"), env("DOCS_REPO_URL"))) {
    throw new Error("VAULT_REPO_URL names the same repository as DOCS_REPO_URL; internal notes must go to a separate, private repo");
  }
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
      channels: list(env("CURATOR_SLACK_CHANNELS")),
      dailyTokens: envOptionalNumber("CURATOR_DAILY_TOKENS"),
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
      people: parsePeople(env("TEAMMATE_PEOPLE")),
      admins: list(env("TEAMMATE_ADMINS")),
      approvalNudgeHours: envNumber("TEAMMATE_APPROVAL_NUDGE_HOURS", 24, { min: 0 }),
      triageProjects: list(env("TEAMMATE_TRIAGE_PROJECTS")),
      triagePerHour: envNumber("TEAMMATE_TRIAGE_PER_HOUR", 20),
      dailyTokens: envOptionalNumber("TEAMMATE_DAILY_TOKENS"),
      dailyTokensTotal: envOptionalNumber("TEAMMATE_DAILY_TOKENS_TOTAL"),
      digestChannel: env("TEAMMATE_DIGEST_CHANNEL"),
      digestWeekday: envNumber("TEAMMATE_DIGEST_WEEKDAY", 1, { min: 0, max: 6 }),
      digestHour: envNumber("TEAMMATE_DIGEST_HOUR", 9, { min: 0, max: 23 }),
    },
    jira: {
      baseUrl: env("JIRA_BASE_URL"),
      email: env("JIRA_EMAIL"),
      apiToken: env("JIRA_API_TOKEN"),
      projectKey: env("JIRA_PROJECT_KEY"),
      jql: env("JIRA_JQL"),
      label: env("JIRA_LABEL") ?? "doc-request",
      // Set, even to empty, it is Scribe's own list: empty means "no Confluence PRDs", never
      // "whatever the Teammate may read".
      prdSpaces: list(process.env.SCRIBE_CONFLUENCE_SPACES !== undefined ? env("SCRIBE_CONFLUENCE_SPACES") : env("TEAMMATE_CONFLUENCE_SPACES")).map((key) => key.toUpperCase()),
      issueType: env("JIRA_ISSUE_TYPE") ?? "Task",
      inProgressStatus: env("JIRA_IN_PROGRESS_STATUS") ?? "In Progress",
      inReviewStatus: env("JIRA_IN_REVIEW_STATUS") ?? "In Review",
      approvedStatus: env("JIRA_APPROVED_STATUS") ?? "Approved",
      approvers: list(env("JIRA_APPROVERS")),
      pollMs: envNumber("JIRA_POLL_MS", 15_000),
      stateDir: path.resolve(repoRoot, env("STATE_DIR") ?? ".scriptorium-state"),
    },
    slack: { notifyChannel: env("SLACK_NOTIFY_CHANNEL"), workspaceUrl: env("SLACK_WORKSPACE_URL") },
    sites: {
      external: env("EXTERNAL_SITE_URL")?.replace(/\/+$/, ""),
      internal: env("INTERNAL_SITE_URL")?.replace(/\/+$/, ""),
    },
    webhook: {
      jiraSecret: env("JIRA_WEBHOOK_SECRET"),
      jiraHmacSecret: env("JIRA_WEBHOOK_HMAC_SECRET"),
      githubSecret: env("GITHUB_WEBHOOK_SECRET"),
      traceToken: env("TRACE_TOKEN"),
      metricsToken: env("METRICS_TOKEN"),
      publicBaseUrl: env("PUBLIC_BASE_URL"),
    },
    docsRepo: {
      url: env("DOCS_REPO_URL"),
      base: env("DOCS_REPO_BRANCH") ?? "main",
      sshKey: env("DOCS_REPO_SSH_KEY"),
      vaultUrl: env("VAULT_REPO_URL"),
      internalBranch: env("VAULT_REPO_BRANCH") ?? "vault-live",
      vaultSshKey: env("VAULT_REPO_SSH_KEY"),
      vaultWorkDir: path.resolve(repoRoot, env("VAULT_REPO_WORKDIR") ?? ".scriptorium-state/vault-repo"),
      vaultSlug: repoSlugFromUrl(env("VAULT_REPO_URL")),
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

/** `a=b=c; d=e` → `[["a","b","c"],["d","e"]]`. A group of one links nothing and is dropped. */
export function parsePeople(raw: string | undefined): string[][] {
  return (raw ?? "")
    .split(";")
    .map((group) => group.split(/[=,\s]+/).map((id) => id.trim()).filter(Boolean))
    .filter((group) => group.length > 1);
}
