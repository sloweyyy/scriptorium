import { createHash } from "node:crypto";
import { jiraReady, type AppConfig } from "@scriptorium/core";
import type { GapInput } from "@scriptorium/curator";
import { jiraClient, markdownToJira, type JiraClient } from "@scriptorium/jira";

/** The label that marks a question's ticket: the same for every asking of it, and Jira-safe. */
export function gapLabel(questionKey: string): string {
  return `gap-${createHash("sha256").update(questionKey).digest("hex").slice(0, 12)}`;
}

/**
 * The cross-surface loop: a question Curator could not answer in Slack becomes a
 * doc request on Agent A's Jira board, labelled so the Scribe poller picks it up.
 * Returns undefined when Jira isn't configured — the gap note is still filed.
 */
export function gapTicketOpener(
  config: AppConfig,
  client: Pick<JiraClient, "createIssue" | "searchIssues" | "issueUrl"> | undefined = jiraReady(config.jira) ? jiraClient(config.jira) : undefined,
): GapInput["openTicket"] {
  if (!client) return undefined;

  return async (gap) => {
    // Exactly once: a ticket this question already has (a create whose response was lost,
    // or another instance) is found by its label and returned, never filed again.
    const label = gapLabel(gap.key);
    const [found] = await client.searchIssues(`project = "${config.jira.projectKey}" AND labels = "${label}"`, 1);
    if (found) return { key: found.key, url: client.issueUrl(found.key) };
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
      labels: [config.jira.label, "from-curator", label],
    });
  };
}
