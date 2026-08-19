import { jiraReady, type AppConfig } from "@scriptorium/core";
import type { GapInput } from "@scriptorium/curator";
import { jiraClient, markdownToJira } from "@scriptorium/jira";

/**
 * The cross-surface loop: a question Curator could not answer in Slack becomes a
 * doc request on Agent A's Jira board, labelled so the Scribe poller picks it up.
 * Returns undefined when Jira isn't configured — the gap note is still filed.
 */
export function gapTicketOpener(config: AppConfig): GapInput["openTicket"] {
  if (!jiraReady(config.jira)) return undefined;
  const client = jiraClient(config.jira);

  return async (gap) => {
    const description = markdownToJira(
      [
        "Filed automatically by **Curator** (Agent B): someone asked this in Slack and the knowledge vault could not answer it.",
        "",
        "**Question**",
        `> ${gap.question}`,
        "",
        `**Missing documentation:** ${gap.missing}`,
        `**Asked by:** ${gap.askedBy}`,
        `**Gap note:** \`${gap.relPath}\``,
        "",
        "To turn this into documentation: attach the PRD as a `.md` file (with `feature`, `audience` and `user_goal` in its frontmatter), attach any wireframes, then comment `draft`.",
      ].join("\n"),
    );

    return client.createIssue({
      summary: `Doc request: ${gap.question.slice(0, 180)}`,
      description,
      issueType: config.jira.issueType,
      labels: [config.jira.label, "from-curator"],
    });
  };
}
