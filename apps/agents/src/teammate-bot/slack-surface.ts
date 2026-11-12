import type { SlackClient } from "@scriptorium/connectors";
import type { ChatInbound, ChatMessage, ChatPostTag, ChatTarget, TaggedChatOutbound } from "@scriptorium/runtime";
import { mentionToEvent, threadContext, type SlackMention } from "./messages";
import { renderSlackMessage } from "./slack-message";

/** Replies and edits use Slack ids only inside this adapter. */
export function slackOutbound(slack: SlackClient): TaggedChatOutbound {
  const post = async (target: ChatTarget, message: ChatMessage, tag?: ChatPostTag): Promise<string> => {
    const rendered = renderSlackMessage(message);
    const posted = await slack.chat.postMessage({
      channel: target.channel,
      ...(target.threadId ? { thread_ts: target.threadId } : {}),
      text: rendered.text,
      ...(rendered.blocks ? { blocks: rendered.blocks as never } : {}),
      ...(tag ? { metadata: { event_type: tag.type, event_payload: tag.data } } : {}),
    });
    if (!posted.ok || !posted.ts) throw new Error("Slack did not confirm the reply");
    return posted.ts;
  };
  return {
    surface: "slack",
    post,
    postTagged: (target, message, tag) => post(target, message, tag),
    async update(target, messageId, message) {
      const rendered = renderSlackMessage(message);
      const updated = await slack.chat.update({ channel: target.channel, ts: messageId, ...rendered, blocks: (rendered.blocks ?? []) as never });
      return updated.ok === true;
    },
    async findTagged(target, tag, since) {
      if (!tag.type || !Object.keys(tag.data).length) throw new Error("A scheduled post needs a nonempty correlation tag");
      const cursors = new Set<string>();
      let cursor: string | undefined;
      for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
        const args = { channel: target.channel, include_all_metadata: true, limit: 200, ...(cursor ? { cursor } : {}), ...(since === undefined ? {} : { oldest: String(since / 1000) }) };
        const page = target.threadId
          ? await slack.conversations.replies({ ...args, ts: target.threadId })
          : await slack.conversations.history(args);
        if (page.ok === false || !Array.isArray(page.messages)) throw new Error("Slack did not confirm the post search");
        const found = page.messages.find((message) => {
          const payload = message.metadata?.event_payload as Record<string, unknown> | undefined;
          return message.metadata?.event_type === tag.type && Object.entries(tag.data).every(([key, value]) => payload?.[key] === value);
        });
        if (found) {
          if (!found.ts) throw new Error("Slack found a tagged post without a message id");
          return found.ts;
        }
        const next = page.response_metadata?.next_cursor?.trim();
        if (!page.has_more && !next) return undefined;
        if (!next || cursors.has(next)) throw new Error("Slack post search pagination is incomplete");
        cursors.add(next);
        cursor = next;
      }
      throw new Error("Slack post search exceeded its page limit");
    },
  };
}

/** Slack as a chat surface, inbound: a mention or DM in, its thread, and who can read it. */
export function slackInbound(slack: SlackClient): ChatInbound<SlackMention> {
  /**
   * Whether not everyone in the workspace can read this conversation: a DM, a group DM or a
   * private channel (private channels have C ids too). Unreadable counts as private.
   * Cached per channel for a while (a channel can be made private later); a failed lookup
   * isn't cached, so the next turn asks again — except a missing scope, which no retry fixes:
   * that is cached like an answer and warned about once (the app needs reinstalling).
   */
  const channelPrivacy = new Map<string, { at: number; private: Promise<boolean> }>();
  const PRIVACY_TTL_MS = 10 * 60_000;
  let warnedMissingScope = false;
  const isPrivate = (channel: string): Promise<boolean> => {
    if (channel.startsWith("D")) return Promise.resolve(true);
    const cached = channelPrivacy.get(channel);
    if (cached && Date.now() - cached.at < PRIVACY_TTL_MS) return cached.private;
    const looked = slack.conversations.info({ channel }).then(
      (info) => {
        const kind = info.channel as { is_private?: boolean; is_im?: boolean; is_mpim?: boolean } | undefined;
        return !kind || kind.is_private !== false || Boolean(kind.is_im || kind.is_mpim);
      },
      (error: unknown) => {
        if ((error as { data?: { error?: string } } | undefined)?.data?.error === "missing_scope") {
          if (!warnedMissingScope) console.warn("[teammate] can't tell private channels from public ones — the Slack app lacks channels:read/groups:read/mpim:read (reinstall it from slack-manifests/teammate.yaml); every channel's gap is kept private until then");
          warnedMissingScope = true;
        } else channelPrivacy.delete(channel);
        return true;
      },
    );
    channelPrivacy.set(channel, { at: Date.now(), private: looked });
    return looked;
  };

  return {
    surface: "slack",
    toEvent: mentionToEvent,
    threadContext: (turn) => threadContext(slack, turn.channel, turn.threadTs, turn.ts),
    // A Slack thread is exactly as readable as its channel.
    isPrivate: (turn) => isPrivate(turn.channel),
  };
}
