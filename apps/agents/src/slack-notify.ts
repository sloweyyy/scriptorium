import type { AppConfig } from "@scriptorium/core";
import { WebClient } from "@slack/web-api";

/**
 * Publish announcements, posted by Curator.
 *
 * Deliberately Curator's job, not Scribe's: announcing that the vault gained a note is
 * librarian work — reporting what exists. Approving or authoring product claims is not,
 * and that boundary is why there are two identities at all. The approval buttons live in
 * Scribe's app (see scribe-bot.ts), which is the identity allowed to publish.
 */

export interface PublishedAnnouncement {
  relPath: string;
  feature: string;
  issueKey: string;
  issueUrl: string;
  approvedBy: string;
  pullRequestUrl?: string;
  appliedLessons?: string[];
}

let client: WebClient | undefined;

function curatorClient(config: AppConfig): WebClient | undefined {
  if (!config.curator.botToken || !config.slack.notifyChannel) return undefined;
  client ??= new WebClient(config.curator.botToken);
  return client;
}

/** Never throws: a missing announcement must not fail a publish that already happened. */
export async function announcePublished(config: AppConfig, input: PublishedAnnouncement): Promise<boolean> {
  const slack = curatorClient(config);
  const channel = config.slack.notifyChannel;
  if (!slack || !channel) return false;

  const lines = [
    `*${input.feature}* is in the vault — approved by ${input.approvedBy} on <${input.issueUrl}|${input.issueKey}>.`,
    `• Note: \`${input.relPath}\``,
    input.pullRequestUrl ? `• Pull request: <${input.pullRequestUrl}|merge to publish to the site>` : undefined,
    input.appliedLessons?.length ? `• House rules applied: ${input.appliedLessons.join(", ")}` : undefined,
    "Ask me about it and I'll answer from this note, with the citation.",
  ].filter((line): line is string => Boolean(line));

  try {
    await slack.chat.postMessage({ channel, text: lines.join("\n"), unfurl_links: false });
    return true;
  } catch (error) {
    console.warn(`[curator] announcement failed: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

export interface DraftAnnouncement {
  issueKey: string;
  issueUrl: string;
  feature: string;
  lintSummary: string;
  appliedLessons?: string[];
}

/**
 * Draft-ready message WITH approval buttons, posted by Scribe's own app.
 *
 * The buttons carry the issue key in `value`, so the action handler needs no state of its
 * own — and the click still lands in the same `runPublish` the ticket's `approve` comment
 * reaches. One gate, two doorways.
 */
export async function announceDraftForApproval(config: AppConfig, input: DraftAnnouncement): Promise<boolean> {
  const token = config.scribe.botToken;
  const channel = config.slack.notifyChannel;
  if (!token || !channel) return false;

  try {
    await new WebClient(token).chat.postMessage({
      channel,
      text: `Draft ready for ${input.issueKey}: ${input.feature}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: [
              `*Draft ready* — <${input.issueUrl}|${input.issueKey}>: ${input.feature}`,
              `Lint: ${input.lintSummary}`,
              input.appliedLessons?.length ? `House rules applied: ${input.appliedLessons.join(", ")}` : "House rules applied: none yet",
            ].join("\n"),
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              style: "primary",
              text: { type: "plain_text", text: "Approve & publish" },
              action_id: "approve_doc",
              value: input.issueKey,
              // A publish is not undoable from Slack, so make the click deliberate.
              confirm: {
                title: { type: "plain_text", text: "Publish this doc?" },
                text: { type: "mrkdwn", text: `Publishes the current draft on ${input.issueKey} to the vault and the docs repo, with you recorded as the approver.` },
                confirm: { type: "plain_text", text: "Publish" },
                deny: { type: "plain_text", text: "Cancel" },
              },
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Open the ticket" },
              url: input.issueUrl,
              action_id: "open_ticket",
            },
          ],
        },
      ],
    });
    return true;
  } catch (error) {
    console.warn(`[scribe] draft announcement failed: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}
