import type { ToolSpec } from "@scriptorium/core";
import { decideApproval, type ApprovalChannel, type ApprovalRequest, type ApprovalStore, type Envelope } from "@scriptorium/policy";
import { once, opKey, type EffectLedger } from "@scriptorium/runtime";
import type { WebClient } from "@slack/web-api";

/**
 * The slice of the Slack client the connector uses. Narrowed on purpose: Bolt bundles its
 * own `@slack/web-api` major, and the full class types differ between majors even where the
 * two methods used here do not.
 */
export type SlackClient = Pick<WebClient, "chat" | "conversations">;
import { z } from "zod";

/**
 * Slack as tools, and Slack as the place a human approves (ADR-001 slice 4c).
 *
 * - Channels are allow-listed, reads included. Slack's terms rule out bulk indexing, so
 *   there is no "search Slack" tool at all: an agent reads, on demand, the thread or the
 *   channel it was asked in (bindToTurn holds it to that), and keeps nothing.
 * - A reply carries its op-key in message metadata, so a retry finds the reply it already
 *   made (exactly-once, same pattern as Jira comment properties).
 * - `SlackApprovalChannel` is the policy layer's approval card: posted in the thread the
 *   request came from, decided by whoever clicks — and "whoever" is then checked against
 *   the envelope's approver rules, never assumed. The card is replaced once decided.
 */

export const OP_EVENT_TYPE = "scriptorium_op";
export const APPROVE_ACTION = "policy_approve";
export const REJECT_ACTION = "policy_reject";
/** Run an approved request again after its connector failed. Decides nothing new. */
export const RETRY_ACTION = "policy_retry";

export interface SlackToolSettings {
  client: SlackClient;
  /** Channel ids the agent may read and post in. Empty: none. */
  allowedChannels: readonly string[];
  ledger: EffectLedger;
}

export class SlackAccessError extends Error {}

/** A Slack message as a citable record: `slack:<channel>/<ts>` — no "#", which wikilinks read as a heading. */
export function slackRecord(channel: string, ts: string): string {
  return `slack:${channel}/${ts}`;
}

export function slackTools(settings: SlackToolSettings): ToolSpec[] {
  const check = (channel: string): string => {
    if (!settings.allowedChannels.includes(channel)) throw new SlackAccessError(`Channel ${channel} is outside the Slack channels this agent may use.`);
    return channel;
  };

  return [
    {
      name: "slack_read_thread",
      description: "Read the messages of one Slack thread you were asked in.",
      inputSchema: z.object({ channel: z.string(), thread_ts: z.string() }),
      run: (input) =>
        refusalOr(async () => {
          const { channel, thread_ts } = z.object({ channel: z.string(), thread_ts: z.string() }).parse(input);
          const replies = await settings.client.conversations.replies({ channel: check(channel), ts: thread_ts, limit: 50 });
          return (replies.messages ?? []).map((message) => `${message.user ?? message.bot_id ?? "someone"}: ${message.text ?? ""}`).join("\n");
        }),
    },
    {
      name: "slack_read_channel",
      description:
        "Read the recent messages of the channel you were asked in (up to 72 hours back), to catch someone up. Cite a message as [[slack:<channel>/<ts>]], using the id at the start of its line.",
      inputSchema: z.object({ channel: z.string(), hours: z.number().int().min(1).max(72).default(24) }),
      run: (input) =>
        refusalOr(async () => {
          const { channel, hours } = z.object({ channel: z.string(), hours: z.number().int().min(1).max(72).default(24) }).parse(input);
          const oldest = String(Math.floor(Date.now() / 1000) - hours * 3600);
          const history = await settings.client.conversations.history({ channel: check(channel), oldest, limit: 200 });
          const messages = [...(history.messages ?? [])].filter((message) => message.ts && message.text).reverse();
          if (!messages.length) return `No messages in ${channel} in the last ${hours} hours.`;
          // One message per line, its id first, its text flattened: text is DATA, and a message
          // that contains a newline and "slack:C1/…" must not become a record it isn't.
          return messages
            .map((message) => `${slackRecord(channel, message.ts as string)} — ${message.bot_id ? "(bot) " : ""}<@${message.user ?? message.bot_id ?? "someone"}>: ${(message.text ?? "").replace(/\s+/g, " ").slice(0, 600)}`)
            .join("\n");
        }),
      records: (input, output) => {
        const channel = (input as { channel?: unknown } | undefined)?.channel;
        if (typeof channel !== "string") return [];
        return output
          .split("\n")
          .map((line) => line.match(/^(slack:[A-Z0-9]+\/\d+\.\d+) — /)?.[1])
          .filter((id): id is string => Boolean(id) && (id as string).startsWith(`slack:${channel}/`));
      },
    },
    {
      name: "slack_reply",
      description: "Reply in a Slack thread.",
      inputSchema: z.object({ channel: z.string(), thread_ts: z.string(), text: z.string().min(1) }),
      run: (input) =>
        refusalOr(async () => {
          const { channel, thread_ts, text } = z.object({ channel: z.string(), thread_ts: z.string(), text: z.string().min(1) }).parse(input);
          check(channel);
          const op = opKey("slack.reply", channel, thread_ts, text);
          const { result, replayed } = await once(
            settings.ledger,
            op,
            async () => {
              const posted = await settings.client.chat.postMessage({
                channel,
                thread_ts,
                text,
                metadata: { event_type: OP_EVENT_TYPE, event_payload: { op } },
              });
              return posted.ts ?? "";
            },
            { probe: () => findReplyByOp(settings.client, channel, thread_ts, op), meta: { tool: "slack_reply", channel } },
          );
          return `${replayed ? "Already replied" : "Replied"} in the thread (${result}).`;
        }),
    },
  ];
}

async function findReplyByOp(client: SlackClient, channel: string, threadTs: string, op: string): Promise<string | undefined> {
  const replies = await client.conversations.replies({ channel, ts: threadTs, include_all_metadata: true, limit: 200 });
  const match = (replies.messages ?? []).find(
    (message) => message.metadata?.event_type === OP_EVENT_TYPE && (message.metadata.event_payload as { op?: string } | undefined)?.op === op,
  );
  return match?.ts;
}

async function refusalOr(work: () => Promise<string>): Promise<string> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SlackAccessError) return `NOT_ALLOWED: ${error.message}`;
    throw error;
  }
}

/** Where approval cards go when the request did not start in a channel thread anyone can see. */
export interface CardRouting {
  /** Default: requests from Jira, from a DM, or from anywhere without a visible thread. */
  fallbackChannel?: string;
  /** Requests about a GitHub pull request. */
  prChannel?: string;
  /** The thread a conversation already has in its channel (a PR check's summary), if any. */
  threadFor?: (key: string) => string | undefined;
  /** Told where each card landed, so it can be linked to later (an approvals inbox). */
  onPosted?: (request: ApprovalRequest, where: { channel: string; ts: string }) => Promise<void> | void;
}

/**
 * Where a request's card goes. A channel thread keeps it in that thread. A DM does NOT —
 * only the requester can see a DM, and the requester is rarely the approver — so it goes to
 * the fallback channel, like a request from Jira. A PR goes to the PR channel, under the
 * check's summary when there is one, so the card sits next to the reasoning it asks about.
 */
export function cardTarget(request: ApprovalRequest, routing: CardRouting): { channel: string; thread_ts?: string } | undefined {
  const thread = request.key.match(/^slack:thread:([^/]+)\/(.+)$/);
  if (thread && !(thread[1] as string).startsWith("D")) return { channel: thread[1] as string, thread_ts: thread[2] };
  if (request.key.startsWith("github:pull:") && routing.prChannel) {
    const threadTs = routing.threadFor?.(request.key);
    return threadTs ? { channel: routing.prChannel, thread_ts: threadTs } : { channel: routing.prChannel };
  }
  return routing.fallbackChannel ? { channel: routing.fallbackChannel } : undefined;
}

export class SlackApprovalChannel implements ApprovalChannel {
  private readonly routing: CardRouting;
  constructor(
    private readonly client: SlackClient,
    /** A channel id (the fallback for everything) or full routing. */
    routing?: string | CardRouting,
  ) {
    this.routing = typeof routing === "string" ? { fallbackChannel: routing } : (routing ?? {});
  }

  async post(request: ApprovalRequest): Promise<void> {
    const target = cardTarget(request, this.routing);
    // Nowhere to show it means nobody can approve it: throw, and the tool does not run.
    if (!target) throw new Error("no Slack channel to post the approval card in");
    const posted = await this.client.chat.postMessage({ ...target, text: `Approval needed: ${escapeMrkdwn(request.tool)}`, blocks: approvalBlocks(request) as never });
    if (!posted.ok) throw new Error(`Slack refused the approval card: ${posted.error ?? "unknown error"}`);
    // Best-effort bookkeeping: the card is posted either way.
    if (posted.ts) await Promise.resolve(this.routing.onPosted?.(request, { channel: posted.channel ?? target.channel, ts: posted.ts })).catch(() => undefined);
  }
}

/**
 * Slack's three control characters, escaped. The summary is text the MODEL wrote (tool
 * arguments), and unescaped it could render `<https://evil|docs.beacon.example>` as an
 * innocent link on the very card a human approves from, or ping `<!channel>`.
 */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The action in words an approver can judge in a second. Built from the stored arguments
 * (the ones the approval is bound to), not from anything the model phrased.
 */
export function describeRequest(request: ApprovalRequest): string {
  const args = (request.args ?? {}) as Record<string, unknown>;
  const text = (value: unknown, max = 120) => {
    const flat = String(value ?? "").replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
  };
  switch (request.tool) {
    case "jira_create_issue":
      return `Create a Jira issue: “${text(args.summary)}”`;
    case "jira_comment":
      return `Comment on ${text(args.key, 40)}`;
    case "jira_transition":
      return `Move ${text(args.key, 40)} to “${text(args.status, 60)}”`;
    case "jira_assign":
      return `Assign ${text(args.key, 40)} to ${text(args.assignee, 80)}`;
    case "jira_labels": {
      const add = Array.isArray(args.add) ? args.add.map((label) => `+${String(label)}`) : [];
      const remove = Array.isArray(args.remove) ? args.remove.map((label) => `-${String(label)}`) : [];
      return `Change labels on ${text(args.key, 40)}: ${text([...add, ...remove].join(" "), 200)}`;
    }
    case "jira_link":
      return `Link ${text(args.from, 40)} → ${text(args.to, 40)} (${text(args.type ?? "Relates", 20)})`;
    case "confluence_create_page":
      return `Create a Confluence page in ${text(args.space, 40)}: “${text(args.title)}”`;
    case "confluence_update_page":
      return `Replace the body of Confluence page ${text(args.id, 40)}${args.title ? ` (“${text(args.title)}”)` : ""}`;
    case "memory_save":
      return `Remember (${text(args.scope, 60)}): “${text(args.text, 200)}”`;
    case "github_pr_comment":
      return `Comment on pull request ${text(args.repo, 80)}#${text(args.number, 10)}`;
    case "schedule_reminder":
      return `Post a reminder in channel ${text(args.channel, 20)} at ${text(args.at, 40)}: “${text(args.text, 200)}”`;
    case "cancel_reminder":
      return `Cancel reminder ${text(args.id, 20)} in channel ${text(args.channel, 20)}`;
    case "propose_plan": {
      // Every step, in order, from the stored arguments: the approver approves exactly this list.
      const steps = Array.isArray(args.steps) ? (args.steps as Array<{ tool?: unknown; args?: unknown }>) : [];
      const lines = steps.map((step, index) => `${index + 1}. ${describeRequest({ ...request, tool: String(step.tool ?? ""), args: step.args })}`);
      return [`Carry out a ${steps.length}-step plan: “${text(args.title)}”`, ...lines].join("\n");
    }
    default:
      return `Run ${request.tool}`;
  }
}

function requesterMention(request: ApprovalRequest): string {
  return request.requestedBy?.startsWith("slack:") ? `<@${request.requestedBy.slice("slack:".length)}>` : escapeMrkdwn(request.requestedBy ?? "someone");
}

export function approvalBlocks(request: ApprovalRequest): unknown[] {
  // Fenced as well as escaped: inside a code block nothing is formatted, linked or mentioned,
  // so what the approver reads is exactly the text that will run.
  const shown = escapeMrkdwn(request.summary).replace(/```/g, "ˋˋˋ");
  const expires = Math.floor(Date.parse(request.expiresAt) / 1000);
  // Slack refuses a section over 3,000 characters, counted AFTER escaping. The headline is
  // shortened at a line break if it must be; the arguments below always show every step.
  const described = escapeMrkdwn(describeRequest(request));
  const headline = described.length > 2_000 ? `${described.slice(0, Math.max(described.lastIndexOf("\n", 2_000), 0))}\n…` : described;
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Approval needed:* ${headline}\nRequested by ${requesterMention(request)} · *Approve*: done now, as ${escapeMrkdwn(request.agent)} · *Reject*: nothing happens`,
      },
    },
    // Fenced, in its own section: its own 3,000-character budget.
    { type: "section", text: { type: "mrkdwn", text: `\`\`\`${shown}\`\`\`` } },
    {
      type: "actions",
      elements: [
        { type: "button", style: "primary", text: { type: "plain_text", text: "Approve" }, action_id: APPROVE_ACTION, value: request.id },
        { type: "button", style: "danger", text: { type: "plain_text", text: "Reject" }, action_id: REJECT_ACTION, value: request.id },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          // Slack renders the date in the reader's own timezone; the ISO form is the fallback.
          text: `Approves exactly these arguments, once · ${Number.isFinite(expires) ? `<!date^${expires}^expires {date_short_pretty} {time}|expires ${request.expiresAt}>` : `expires ${escapeMrkdwn(request.expiresAt)}`} · request ${request.id.slice(0, 8)} · sha256 ${request.argsHash.slice(0, 12)}`,
        },
      ],
    },
  ];
}

export interface ApprovalClick {
  action: string;
  requestId: string;
  userId?: string;
  userName?: string;
  /** Where the card is, so it can be replaced once decided. */
  channel?: string;
  messageTs?: string;
  /** The thread the card sits in, if any — where the requester is told the outcome. */
  threadTs?: string;
}

/**
 * A button press, decided. Returns what to tell the clicker. On refusal the card stays:
 * someone who IS an approver may still use it. On a decision it is replaced, so the same
 * card cannot decide twice (the store enforces that too; the card just stops inviting it).
 */
export async function handleApprovalClick(
  client: SlackClient,
  store: ApprovalStore,
  envelopeFor: (agent: string) => Envelope | undefined,
  click: ApprovalClick,
): Promise<{ ok: boolean; message: string }> {
  const request = (await store.all()).find((candidate) => candidate.id === click.requestId);
  const envelope = request && envelopeFor(request.agent);
  if (!request || !envelope) return { ok: false, message: "That approval request no longer exists." };

  const decision = click.action === APPROVE_ACTION ? "approved" : "rejected";
  const result = await decideApproval(store, envelope, request.id, decision, click.userId ? { accountId: `slack:${click.userId}`, name: click.userName } : undefined);
  if (!result.ok) {
    const approvers = (envelope.tools[request.tool]?.approvers ?? []).filter((id) => id.startsWith("slack:")).map((id) => `<@${id.slice("slack:".length)}>`);
    return { ok: false, message: `Not recorded: ${result.reason}.${approvers.length ? ` Approvers for this: ${approvers.join(", ")}.` : ""}` };
  }

  const verdict = decision === "approved" ? "✅ Approved" : "🚫 Rejected";
  // The decision is recorded by now. Replacing the card only stops it inviting a second
  // click (the store refuses one anyway), so a Slack error here is logged, never thrown:
  // thrown, it skipped carrying out an approval that had been given, and left it stuck.
  if (click.channel && click.messageTs) {
    await client.chat.update({
      channel: click.channel,
      ts: click.messageTs,
      text: `${verdict} by ${escapeMrkdwn(click.userName ?? click.userId ?? "")}: ${escapeMrkdwn(describeRequest(request))}`,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: `${verdict} by <@${click.userId}> — ${escapeMrkdwn(describeRequest(request))}\n\`\`\`${escapeMrkdwn(request.summary).replace(/```/g, "ˋˋˋ")}\`\`\`` } }] as never,
    }).catch((error: unknown) => {
      console.warn(`[approvals] ${request.id}: decided, but the card could not be updated: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  // The person who asked hears the decision, where they asked. A rejection is final; an
  // approval is followed by the result once it has been carried out.
  if (click.channel && decision === "rejected") {
    await client.chat
      .postMessage({ channel: click.channel, thread_ts: click.threadTs ?? click.messageTs, text: `${requesterMention(request)} 🚫 <@${click.userId}> declined: ${escapeMrkdwn(describeRequest(request))}. Nothing was done.` })
      .catch(() => undefined);
  }
  return { ok: true, message: `${verdict}.` };
}
