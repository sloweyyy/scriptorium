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
  /** Overrides the default "open doc requests in this project" query. */
  jql?: string;
  label: string;
  issueType: string;
  approvedStatus: string;
  pollMs: number;
  /** Resume state (processed comment ids, working drafts) — gitignored, not part of the record. */
  stateDir: string;
}

export interface AppConfig {
  model: string;
  hasAnthropicKey: boolean;
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

/** Default JQL: every unfinished doc request in the project, oldest touch first. */
export function defaultJql(jira: JiraSettings): string {
  if (jira.jql) return jira.jql;
  return `project = "${jira.projectKey}" AND labels = "${jira.label}" AND statusCategory != Done ORDER BY updated ASC`;
}

export function loadConfig(repoRoot = process.cwd()): AppConfig {
  return {
    model: env("MODEL") ?? "claude-opus-5",
    hasAnthropicKey: Boolean(env("ANTHROPIC_API_KEY")),
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
