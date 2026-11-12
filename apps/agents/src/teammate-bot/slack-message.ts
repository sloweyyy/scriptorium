import type { ChatMessage } from "@scriptorium/runtime";
import { answerBlocks, contextBlocks, toSlackMrkdwn } from "../slack-format";

/** Slack owns all markup and Block Kit conversion for a chat reply. */
export function renderSlackMessage(message: ChatMessage): { text: string; blocks?: unknown[] } {
  // Only explicit accounts from configuration may notify. Markdown from the model still
  // goes through escaping; another surface's account or mass mention is inert.
  const mentions = (message.notify ?? []).map((id) => id.match(/^slack:([A-Z0-9]+)$/)?.[1]).filter(Boolean).map((id) => `<@${id}>`).join(", ");
  const body = `${toSlackMrkdwn(message.text)}${mentions ? ` ${mentions}` : ""}`;
  const request = message.request ? `\nRequest: <${message.request.url}|${message.request.key}>` : "";
  const footer = message.footer
    ? `_${message.footer.text}${message.footer.link ? ` · <${message.footer.link.url}|${message.footer.link.label}>` : ""}_`
    : undefined;
  const text = `${body}${request}${footer ? `\n${footer}` : ""}`;
  const blocks = message.sources
    ? [...answerBlocks({ markdown: message.text, ...message.sources }), ...(mentions ? contextBlocks(mentions) : []), ...(footer ? contextBlocks(footer) : [])]
    : undefined;
  return { text, ...(blocks ? { blocks } : {}) };
}
