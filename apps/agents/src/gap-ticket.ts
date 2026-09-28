import { createHash } from "node:crypto";
import { jiraReady, type AppConfig } from "@scriptorium/core";
import type { GapInput } from "@scriptorium/curator";
import { jiraClient, markdownToJira, type JiraClient } from "@scriptorium/jira";

/**
 * Slack's markup as the words it stands for: `<!here>` → `@here`, `<#C1|release>` →
 * `#release`, `<@U1>` → `@U1`, `<https://x|docs>` → `docs (https://x)`. Left in, a question
 * asked in Slack carried live channel pings and disguised links into the Jira ticket.
 */
export function slackMarkupToPlain(text: string): string {
  return text
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_match, name?: string) => `@${name ?? "group"}`)
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<#([A-Z0-9]+)>/g, "#$1")
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<((?:https?|mailto):[^|>\s]+)\|([^>]*)>/g, "$2 ($1)")
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1");
}

/**
 * Asker-written (or model-written) text as a Jira code block: nothing inside renders, so no
 * link goes live, no heading or `**Asked by:**` line can be forged from a multi-line
 * question, and a fence inside can't close the block early.
 */
function quoted(text: string): string {
  const inert = slackMarkupToPlain(text).replace(/```/g, "ˋˋˋ").replace(/\{(code|noformat)/gi, "{\u200b$1");
  return ["```", inert.trim(), "```"].join("\n");
}

/** A Jira summary is one plain line. */
function summaryLine(question: string): string {
  return slackMarkupToPlain(question).replace(/\s+/g, " ").trim().slice(0, 180);
}

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
        quoted(gap.question),
        "",
        "**Missing documentation**",
        quoted(gap.missing),
        `**Asked by:** ${gap.askedBy}`,
        `**Gap note:** \`${gap.relPath}\``,
        "",
        "To turn this into documentation: attach the PRD as a `.md` file (with `feature`, `audience` and `user_goal` in its frontmatter), attach any wireframes, then comment `draft`.",
      ].join("\n"),
    );

    return client.createIssue({
      summary: `Doc request: ${summaryLine(gap.question)}`,
      description,
      issueType: config.jira.issueType,
      labels: [config.jira.label, "from-curator", label],
    });
  };
}
