import { once, opKey, type EffectLedger } from "./effects";
import type { ChatMessage, ChatPostTag, ChatTarget, TaggedChatOutbound } from "./surface";

/**
 * Produce and post only after a retry has checked whether the earlier send landed.
 * The surface and destination are part of the op, so a second adapter never replays the
 * first one's result. Existing Slack schedules can retain their pre-adapter op keys.
 */
export async function postChatOnce(
  ledger: EffectLedger,
  outbound: TaggedChatOutbound,
  target: ChatTarget,
  tag: ChatPostTag,
  produce: () => Promise<ChatMessage>,
  options: { since?: number; legacySlackOp?: string } = {},
): Promise<{ posted: boolean; messageId?: string }> {
  const fields = Object.entries(tag.data).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (!tag.type || !fields.length) throw new Error("A scheduled post needs a nonempty correlation tag");
  const op = outbound.surface === "slack" && options.legacySlackOp
    ? options.legacySlackOp
    : opKey("chat.post", outbound.surface, target.channel, target.threadId, tag.type, JSON.stringify(fields));
  const { result, replayed } = await once<unknown>(
    ledger,
    op,
    async () => outbound.postTagged(target, await produce(), tag),
    { probe: () => outbound.findTagged(target, tag, options.since) },
  );
  // Legacy digests and nudges recorded `true`, not a message id. They still mean done.
  return { posted: !replayed, ...(typeof result === "string" ? { messageId: result } : {}) };
}
