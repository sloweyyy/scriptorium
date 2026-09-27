import { describeRequest, escapeMrkdwn } from "@scriptorium/connectors";
import type { ApprovalRequest } from "@scriptorium/policy";

/**
 * The Teammate's App Home: an approver's inbox. What is waiting for THIS person's
 * approval, each linked to its card — the card is where it is decided, so a decision never
 * leaves a stale card with live buttons behind — and what they asked for recently.
 * Read-only on purpose. Pure, so what one person can see is pinned by evals.
 */
export function homeBlocks(input: {
  /** `hidden`: the card is in a private channel or a DM — its text stays there, with its members. */
  waiting: ReadonlyArray<{ request: ApprovalRequest; link?: string; hidden?: boolean }>;
  mine: readonly ApprovalRequest[];
  help: string;
}): unknown[] {
  const line = (request: ApprovalRequest) => escapeMrkdwn(describeRequest(request));
  const expires = (request: ApprovalRequest) => {
    const at = Math.floor(Date.parse(request.expiresAt) / 1000);
    return Number.isFinite(at) ? ` · expires <!date^${at}^{date_short_pretty}|${request.expiresAt.slice(0, 10)}>` : "";
  };
  const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text } });
  const waiting = input.waiting.length
    ? input.waiting.slice(0, 20).map(({ request, link, hidden }) =>
        section(
          hidden
            ? `• A request in a private conversation — only its members can see what it is${expires(request)} · ${link ? `<${link}|open the card>` : "card not found"}`
            : `• ${line(request)}\nRequested by ${requester(request)}${expires(request)} · ${link ? `<${link}|open the card>` : "card not found"}`,
        ),
      )
    : [section("Nothing is waiting for your approval.")];
  const mine = input.mine.length
    ? input.mine.slice(0, 5).map((request) => section(`• ${line(request)} — *${statusOf(request)}*`))
    : [section("You haven't asked me to change anything yet.")];
  return [
    { type: "header", text: { type: "plain_text", text: `Waiting for your approval (${input.waiting.length})` } },
    ...waiting,
    { type: "divider" },
    { type: "header", text: { type: "plain_text", text: "What you asked for" } },
    ...mine,
    { type: "divider" },
    section(input.help),
  ];
}

const STATUS: Record<string, string> = { pending: "waiting", approved: "approved, not yet done", consumed: "done", rejected: "declined", expired: "expired" };

/** A pending request past its expiry is expired, whatever the stored status says. */
function statusOf(request: ApprovalRequest, now = Date.now()): string {
  if ((request.status === "pending" || request.status === "approved") && Date.parse(request.expiresAt) <= now) return STATUS.expired as string;
  return STATUS[request.status] ?? request.status;
}

function requester(request: ApprovalRequest): string {
  return request.requestedBy?.startsWith("slack:") ? `<@${request.requestedBy.slice("slack:".length)}>` : escapeMrkdwn(request.requestedBy ?? "someone");
}
