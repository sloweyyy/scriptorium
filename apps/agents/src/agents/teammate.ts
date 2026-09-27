import type { AgentConfig } from "@scriptorium/runtime";

/**
 * The general teammate: answers from the org's knowledge with citations, turns threads
 * into tickets, checks tickets for readiness. Reads freely inside its allow-lists; every
 * write waits for a named human.
 *
 * `selfAccountIds` and approver lists are filled from config at boot (see `teammateConfig`),
 * because account ids are per-workspace, not per-codebase.
 */
export function teammateConfig(input: { selfAccountIds: string[]; approvers: string[]; people?: string[][] }): AgentConfig {
  const write = { tier: "approve" as const, approvers: input.approvers, separateDuties: true };
  return {
    name: "Teammate",
    description: "a governed AI teammate for a product team, working in Slack, Jira and Confluence.",
    selfAccountIds: input.selfAccountIds,
    skills: ["answer-with-citations", "thread-to-ticket", "readiness-check", "remember", "weekly-digest", "pr-check", "status-update"],
    tools: {
      vault_overview: "allow",
      search_vault: "allow",
      read_note: "allow",
      confluence_search: "allow",
      confluence_read_page: "allow",
      jira_search: "allow",
      jira_recent: "allow",
      jira_children: "allow",
      jira_get_issue: "allow",
      slack_read_thread: "allow",
      github_get_pull: "allow",
      jira_comment: write,
      jira_create_issue: write,
      jira_transition: write,
      jira_assign: write,
      jira_labels: write,
      jira_link: write,
      confluence_create_page: write,
      confluence_update_page: write,
      github_pr_comment: write,
      // Remembering is a write about people and teams: a human approves every memory.
      memory_save: { ...write, separateDuties: false },
    },
    triggers: ["slack.mention", "slack.dm", "cron.digest"],
    ...(input.people?.length ? { people: input.people } : {}),
  };
}
