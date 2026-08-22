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
export function defaultJql(jira: JiraSettings): string {
  if (jira.jql) return jira.jql;
  return `project = "${jira.projectKey}" AND statusCategory != Done ORDER BY updated ASC`;
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
  };
}
