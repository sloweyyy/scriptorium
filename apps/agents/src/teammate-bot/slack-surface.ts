import type { SlackClient } from "@scriptorium/connectors";
import type { ChatInbound } from "@scriptorium/runtime";
import { mentionToEvent, threadContext, type SlackMention } from "./messages";

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
