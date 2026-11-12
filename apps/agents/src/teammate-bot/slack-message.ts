import type { ChatMessage } from "@scriptorium/runtime";
import { answerBlocks, contextBlocks, toSlackMrkdwn } from "../slack-format";

/** Slack owns all markup and Block Kit conversion for a chat reply. */
export function renderSlackMessage(message: ChatMessage): { text: string; blocks?: unknown[] } {
  const body = toSlackMrkdwn(message.text);
  const request = message.request ? `\nRequest: <${message.request.url}|${message.request.key}>` : "";
  const footer = message.footer
    ? `_${message.footer.text}${message.footer.link ? ` · <${message.footer.link.url}|${message.footer.link.label}>` : ""}_`
    : undefined;
  const text = `${body}${request}${footer ? `\n${footer}` : ""}`;
  const blocks = message.sources
    ? [...answerBlocks({ markdown: message.text, ...message.sources }), ...(footer ? contextBlocks(footer) : [])]
    : undefined;
  return { text, ...(blocks ? { blocks } : {}) };
}
