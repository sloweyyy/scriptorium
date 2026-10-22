import { keys, type AgentEvent } from "./event";

/**
 * A chat surface, inbound: what an agent needs from Slack, Discord, Teams or any other chat
 * tool to take a question. Everything downstream of an adapter sees `ChatTurn` events and
 * these three calls, never the tool's own payloads, so a new chat tool is one adapter.
 */

/** One message that asks the agent something, on any chat surface. */
export interface ChatTurn {
  channel: string;
  /** The thread the message is in; a top-level message is its own thread. */
  threadTs: string;
  /** The question, the surface's mention syntax already removed. */
  text: string;
  /** The message itself. */
  ts: string;
}

export interface ChatInbound<Raw = unknown> {
  /** The surface's name, as in event keys and actor ids: `slack`, `discord`. */
  readonly surface: string;
  /** The surface's message as the platform's event. Pure: the mapping is pinned by evals. */
  toEvent(raw: Raw): AgentEvent<ChatTurn>;
  /**
   * The thread before the message, oldest first, without the message itself, for the model
   * to read as data. Undefined for a top-level message.
   */
  threadContext(turn: ChatTurn): Promise<string | undefined>;
  /**
   * Whether not everyone in the workspace can read the conversation. A question asked there
   * is a private turn. A conversation whose privacy can't be read counts as private.
   */
  isPrivate(channel: string): Promise<boolean>;
}

/**
 * The one way an adapter builds a chat event, so every surface keys a thread, names an
 * author and dedupes a redelivery the same way. `deliveryId` must be the same for a
 * redelivery of the same message: the Gate drops the second.
 */
export function chatTurnEvent(
  surface: string,
  message: { deliveryId: string; channel: string; threadTs?: string; ts: string; text: string; authorId: string; isBot: boolean },
): AgentEvent<ChatTurn> {
  const threadTs = message.threadTs ?? message.ts;
  return {
    id: message.deliveryId,
    source: surface,
    key: keys.thread(surface, message.channel, threadTs),
    kind: `${surface}.mention`,
    actor: { id: `${surface}:${message.authorId}`, isBot: message.isBot },
    payload: { channel: message.channel, threadTs, text: message.text, ts: message.ts },
    receivedAt: new Date().toISOString(),
  };
}
