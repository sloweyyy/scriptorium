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
 *   there is no "search Slack" tool at all: an agent reads the one thread it was asked in.
 * - A reply carries its op-key in message metadata, so a retry finds the reply it already
 *   made (exactly-once, same pattern as Jira comment properties).
 * - `SlackApprovalChannel` is the policy layer's approval card: posted in the thread the
 *   request came from, decided by whoever clicks — and "whoever" is then checked against
 *   the envelope's approver rules, never assumed. The card is replaced once decided.
 */

export const OP_EVENT_TYPE = "scriptorium_op";
export const APPROVE_ACTION = "policy_approve";
export const REJECT_ACTION = "policy_reject";

export interface SlackToolSettings {
  client: SlackClient;
  /** Channel ids the agent may read and post in. Empty: none. */
  allowedChannels: readonly string[];
  ledger: EffectLedger;
}

export class SlackAccessError extends Error {}

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

/** Where a request's card goes: its own thread when it came from Slack, else the fallback. */
function cardTarget(request: ApprovalRequest, fallbackChannel?: string): { channel: string; thread_ts?: string } | undefined {
  const thread = request.key.match(/^slack:thread:([^/]+)\/(.+)$/);
  if (thread) return { channel: thread[1] as string, thread_ts: thread[2] };
  return fallbackChannel ? { channel: fallbackChannel } : undefined;
}

export class SlackApprovalChannel implements ApprovalChannel {
  constructor(
    private readonly client: SlackClient,
    /** For requests that did not start in Slack (a Jira-triggered write, say). */
    private readonly fallbackChannel?: string,
  ) {}

  async post(request: ApprovalRequest): Promise<void> {
    const target = cardTarget(request, this.fallbackChannel);
    // Nowhere to show it means nobody can approve it: throw, and the tool does not run.
    if (!target) throw new Error("no Slack channel to post the approval card in");
    const posted = await this.client.chat.postMessage({ ...target, text: `Approval needed: ${escapeMrkdwn(request.tool)}`, blocks: approvalBlocks(request) as never });
    if (!posted.ok) throw new Error(`Slack refused the approval card: ${posted.error ?? "unknown error"}`);
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

export function approvalBlocks(request: ApprovalRequest): unknown[] {
  // Fenced as well as escaped: inside a code block nothing is formatted, linked or mentioned,
  // so what the approver reads is exactly the text that will run.
  const shown = escapeMrkdwn(request.summary).replace(/```/g, "ˋˋˋ");
  return [
    { type: "section", text: { type: "mrkdwn", text: `*Approval needed* — ${escapeMrkdwn(request.agent)} wants to run \`${escapeMrkdwn(request.tool)}\`\n\`\`\`${shown}\`\`\`` } },
    {
      type: "actions",
      elements: [
        { type: "button", style: "primary", text: { type: "plain_text", text: "Approve" }, action_id: APPROVE_ACTION, value: request.id },
        { type: "button", style: "danger", text: { type: "plain_text", text: "Reject" }, action_id: REJECT_ACTION, value: request.id },
      ],
    },
    { type: "context", elements: [{ type: "mrkdwn", text: `Request ${request.id} · approves exactly these arguments (sha256 ${request.argsHash.slice(0, 12)}…), once · expires ${request.expiresAt}` }] },
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
  if (!result.ok) return { ok: false, message: `Not recorded: ${result.reason}.` };

  const verdict = decision === "approved" ? "✅ Approved" : "🚫 Rejected";
  if (click.channel && click.messageTs) {
    await client.chat.update({
      channel: click.channel,
      ts: click.messageTs,
      text: `${verdict} by ${escapeMrkdwn(click.userName ?? click.userId ?? "")}: ${escapeMrkdwn(request.tool)}`,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: `${verdict} by <@${click.userId}> — \`${escapeMrkdwn(request.tool)}\`\n\`\`\`${escapeMrkdwn(request.summary).replace(/```/g, "ˋˋˋ")}\`\`\`` } }] as never,
    });
  }
  return { ok: true, message: `${verdict}.` };
}
