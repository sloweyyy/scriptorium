import type { SlackClient } from "@scriptorium/connectors";
import { keys, type AgentEvent } from "@scriptorium/runtime";
import { toSlackMrkdwn } from "../slack-format";
import type { TeammateReply } from "../teammate";
import { stripMentions } from "../util";

/**
 * What the Teammate reads from Slack and writes back, as pure functions: a mention as an
 * event, the thread as context, the help card, the progress line, the reply's footer.
 */

export interface SlackMention {
  type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  channel: string;
  event_ts?: string;
  client_msg_id?: string;
}

/**
 * The longest question a turn takes. A pasted log or a 30k-character comment is not a
 * question, and every character of it is paid for on every model round.
 */
export const MAX_QUESTION_CHARS = 4_000;

export function capQuestion(text: string): string {
  return text.length > MAX_QUESTION_CHARS ? `${text.slice(0, MAX_QUESTION_CHARS)}\n\n[…the rest of this message (${text.length - MAX_QUESTION_CHARS} characters) was cut off]` : text;
}

/** A Slack `app_mention` as the platform's event. Pure, so the mapping is pinned by evals. */
export function mentionToEvent(mention: SlackMention): AgentEvent<{ channel: string; threadTs: string; text: string; ts: string }> {
  const threadTs = mention.thread_ts ?? mention.ts;
  return {
    id: mention.client_msg_id ?? `${mention.channel}:${mention.event_ts ?? mention.ts}`,
    source: "slack",
    key: keys.slackThread(mention.channel, threadTs),
    kind: "slack.mention",
    actor: { id: `slack:${mention.user ?? mention.bot_id ?? "unknown"}`, isBot: Boolean(mention.bot_id) },
    payload: { channel: mention.channel, threadTs, text: capQuestion(stripMentions(mention.text)), ts: mention.ts },
    receivedAt: new Date().toISOString(),
  };
}

/**
 * The thread so far, for context: "make a ticket for this" is meaningless without it. Only
 * the thread the agent was mentioned in (Slack's terms: no bulk reads), capped, oldest
 * first, the triggering message left out. It is handed to the model as data.
 */
export async function threadContext(slack: SlackClient, channel: string, threadTs: string, triggerTs: string, limit = 20): Promise<string | undefined> {
  if (threadTs === triggerTs) return undefined;
  // Replies page oldest-first: one page of a long thread is its beginning, and "file a
  // ticket for this" is about its end. Page through (bounded), keep the parent + the latest.
  type Reply = { ts?: string; user?: string; text?: string };
  let parent: Reply | undefined;
  let recent: Reply[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const replies = await slack.conversations.replies({ channel, ts: threadTs, limit: 200, ...(cursor ? { cursor } : {}) });
    for (const message of (replies.messages ?? []) as Reply[]) {
      if (message.ts === threadTs) parent = message;
      else recent.push(message);
    }
    recent = recent.slice(-(limit + 1));
    cursor = replies.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  const usable = (message: Reply) => message.ts !== triggerTs && Boolean(message.text);
  const head = parent && usable(parent) ? [parent] : [];
  const lines = [...head, ...recent.filter(usable).slice(-(limit - head.length))]
    .map((message) => `${message.user ? `<@${message.user}>` : "bot"}: ${(message.text ?? "").slice(0, 1_000)}`);
  return lines.length ? lines.join("\n") : undefined;
}

/** Message subtypes that are still a person asking something (the file itself is not read). */
export const ASKING_SUBTYPES = new Set(["file_share", "thread_broadcast"]);

/** "help", "what can you do", or an empty mention: answered from a fixed card, no model call. */
export function isHelpRequest(text: string): boolean {
  return !text.trim() || /^(help|\?|what can you do\??|how do (i|you) use (this|you)\??)$/i.test(text.trim());
}

/**
 * The capabilities card: what to ask, and the one rule a new user must know — writes wait
 * for a named approver. Fixed text, so first contact never depends on a model.
 */
export function helpText(settings: { approvers?: readonly string[]; channels: readonly string[] }): string {
  const approvers = (settings.approvers ?? []).map((id) => `<@${id}>`).join(", ") || "nobody yet (writes are off)";
  return [
    "*I'm the Teammate.* I answer from our docs, Confluence and Jira — always with sources — and I can file and update things for you.",
    "",
    "Try:",
    "• _When do digest emails go out?_",
    "• _Is DOC-42 ready to start?_",
    "• _Make a ticket for this_ (in a thread — I read it first)",
    "• _Remember that release notes go out on Thursdays_",
    "",
    `Anything I *write* (a ticket, a comment, a page, a memory) waits for an approver: ${approvers}. If our docs don't cover something, I say so instead of guessing, and ask for it to be written.`,
  ].join("\n");
}

/** What the agent is doing, in the words a person would use, for the progress line. */
const TOOL_PROGRESS: Record<string, string> = {
  search_vault: "Searching our docs",
  read_note: "Reading a doc",
  vault_overview: "Looking at what the docs cover",
  confluence_search: "Searching Confluence",
  confluence_read_page: "Reading a Confluence page",
  jira_search: "Searching Jira",
  jira_recent: "Checking recent Jira activity",
  jira_children: "Reading the epic's issues",
  jira_get_issue: "Reading a Jira issue",
  slack_read_thread: "Reading the thread",
  slack_read_channel: "Reading the channel",
  github_get_pull: "Reading the pull request",
  github_list_merged: "Listing merged pull requests",
};

export function progressText(tool: string): string {
  return `🔎 ${TOOL_PROGRESS[tool] ?? "Working on it"}…`;
}

/**
 * The reply as posted. Every agent-written message says so and names its run: the footer is
 * the thread a reader pulls to find the trigger, tool calls and approvals behind it.
 */
export function formatReply(reply: TeammateReply, runId?: string, viewer?: { baseUrl?: string; token?: string }): string {
  const body = toSlackMrkdwn(reply.text);
  const ticket = reply.kind === "gap" && reply.ticket ? `\nRequest: <${reply.ticket.url}|${reply.ticket.key}>` : "";
  const run = runId?.slice(0, 8);
  // With a viewer configured, the run id is a link to everything the run did.
  const runLabel = run
    ? viewer?.baseUrl && viewer.token
      ? ` · <${viewer.baseUrl.replace(/\/$/, "")}/runs/${run}?token=${encodeURIComponent(viewer.token)}|view run ${run}>`
      : ` · run \`${run}\``
    : "";
  return `${body}${ticket}\n_AI-generated — verify before acting${runLabel}_`;
}
