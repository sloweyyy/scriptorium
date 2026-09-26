/**
 * One shape for everything that can wake an agent (ADR-001).
 *
 * A Slack mention, a Jira comment, a Confluence edit, a GitHub review request and a cron
 * tick all become an `AgentEvent`. Everything downstream — gate, queue, runner, policy —
 * sees this and never the source's own payload shape, so a new source is one adapter,
 * not a new bot.
 */

export type EventSource = "slack" | "jira" | "confluence" | "github" | "cron";

export interface Actor {
  /** The source's stable account id — what approvals and memory are keyed on. */
  id: string;
  name?: string;
  /** True for any bot or integration account, ours or not. */
  isBot?: boolean;
}

export interface AgentEvent<Payload = unknown> {
  /**
   * Unique per delivery source-side (Slack event_id, Jira webhook identifier, comment id).
   * Two deliveries with the same id are the same event: the gate drops the second.
   */
  id: string;
  source: EventSource;
  /**
   * The conversation this belongs to. Events with the same key are handled one at a time,
   * in order; different keys run in parallel.
   */
  key: string;
  /** What happened, source-namespaced: `slack.mention`, `jira.comment`, `confluence.page_updated`. */
  kind: string;
  actor: Actor;
  payload: Payload;
  receivedAt: string;
}

/**
 * Correlation keys. Deliberately coarse: a thread, a ticket, a page, a pull request — the
 * unit a human would call "one conversation".
 */
export const keys = {
  slackThread: (channel: string, threadTs: string) => `slack:thread:${channel}/${threadTs}`,
  jiraIssue: (issueKey: string) => `jira:issue:${issueKey.toUpperCase()}`,
  confluencePage: (pageId: string) => `confluence:page:${pageId}`,
  githubPull: (repo: string, number: number) => `github:pull:${repo.toLowerCase()}#${number}`,
  cron: (job: string) => `cron:${job}`,
} as const;

/** Which source a key belongs to — so a surface can be picked from the key alone. */
export function sourceOfKey(key: string): EventSource | undefined {
  const prefix = key.split(":")[0];
  return prefix === "slack" || prefix === "jira" || prefix === "confluence" || prefix === "github" || prefix === "cron" ? prefix : undefined;
}
