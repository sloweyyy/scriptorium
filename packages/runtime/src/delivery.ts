import type { ChatMessage, ChatOutbound, ChatTarget } from "./surface";

/**
 * One acknowledgement becomes one answer, on any chat surface. Progress is best-effort,
 * throttled, and drained before the final edit: a slow retry must never erase an answer.
 * The caller owns the durable placeholder record and closes it only after finish succeeds.
 */
export function chatDelivery(outbound: ChatOutbound, target: ChatTarget, placeholderId?: string) {
  let finished = false;
  let lastProgress = -Infinity;
  const inFlight = new Set<Promise<unknown>>();

  return {
    progress(message: ChatMessage): void {
      const now = Date.now();
      if (finished || !placeholderId || now - lastProgress < 2_000) return;
      lastProgress = now;
      // Catch both a synchronous SDK failure and a rejected promise. Neither drops a turn.
      const update = Promise.resolve().then(() => outbound.update(target, placeholderId, message)).catch(() => undefined);
      inFlight.add(update);
      void update.finally(() => inFlight.delete(update));
    },
    async finish(message: ChatMessage): Promise<string> {
      finished = true;
      await Promise.all(inFlight);
      if (placeholderId && await outbound.update(target, placeholderId, message).catch(() => false)) return placeholderId;
      // A platform that cannot edit still gets a reply in the original thread. A failed
      // post throws, leaving the caller's placeholder record open for restart recovery.
      return outbound.post(target, message);
    },
  };
}
