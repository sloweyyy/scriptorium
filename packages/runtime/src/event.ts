/**
 * One shape for everything that can wake an agent (ADR-001).
 *
 * A Slack mention, a Jira comment, a Confluence edit, a GitHub review request and a cron
 * tick all become an `AgentEvent`. Everything downstream — gate, queue, runner, policy —
 * sees this and never the source's own payload shape, so a new source is one adapter,
 * not a new bot.
 */

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
  /**
   * The surface it came from, by name (`slack`, `jira`, `discord`, `cron`…). Open, not a
   * closed list: a new surface is a new adapter, never a change to the runtime.
   */
  source: string;
  /**
   * The external key of the conversation on its surface (`slack:thread:C1/1.0`,
   * `jira:issue:DOC-7`): an alias of the conversation's anchor.
   */
  key: string;
  /**
   * The conversation's opaque anchor (see anchor.ts), looked up at intake; only a conversation
   * that has joined another surface has one. Events with the same
   * anchor — or, without one, the same key — are handled one at a time, in order; others
   * run in parallel. A Slack thread and the ticket it filed share one anchor.
   */
  anchor?: string;
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
  /** A thread on any chat surface: `slack:thread:C1/1.0`, `discord:thread:G1/2.0`. */
  thread: (surface: string, channel: string, threadTs: string) => `${surface}:thread:${channel}/${threadTs}`,
  jiraIssue: (issueKey: string) => `jira:issue:${issueKey.toUpperCase()}`,
  confluencePage: (pageId: string) => `confluence:page:${pageId}`,
  githubPull: (repo: string, number: number) => `github:pull:${repo.toLowerCase()}#${number}`,
  cron: (job: string) => `cron:${job}`,
} as const;

/**
 * A well-formed external key: `<surface>:<kind>:<value>`, surface and kind lowercase. The
 * one shape every alias of an anchor has. `cron:<job>` is a key but not an alias.
 */
const ALIAS = /^([a-z][a-z0-9_-]*):[a-z][a-z0-9_-]*:\S+$/;

export function isAlias(key: string): boolean {
  return ALIAS.test(key);
}

/** Which surface a key belongs to — so a surface can be picked from the key alone. */
export function sourceOfKey(key: string): string | undefined {
  return /^([a-z][a-z0-9_-]*):\S/.exec(key)?.[1];
}
