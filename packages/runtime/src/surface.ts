import { keys, type AgentEvent } from "./event";

/**
 * Chat surfaces map incoming messages to turns and render outgoing Markdown/provenance.
 * The runtime owns delivery ordering; adapters own platform payloads and opaque message ids.
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
   * Whether not everyone in the workspace can read the conversation the turn is in. A
   * question asked there is a private turn. Given the whole turn, not only its channel: on
   * some surfaces a thread can be private inside a public channel. A conversation whose
   * privacy can't be read counts as private.
   */
  isPrivate(turn: ChatTurn): Promise<boolean>;
}

/** Where a reply belongs. Message ids are opaque: only the adapter interprets them. */
export interface ChatTarget {
  channel: string;
  threadId?: string;
}

/** Markdown and provenance, before a surface renders them into its own markup or cards. */
export interface ChatMessage {
  text: string;
  sources?: { citations: string[]; links?: Map<string, string> };
  request?: { key: string; url: string };
  footer?: { text: string; link?: { label: string; url: string } };
}

/** Replies and edits. An adapter must throw on a failed post, and report a failed edit. */
export interface ChatOutbound {
  readonly surface: string;
  post(target: ChatTarget, message: ChatMessage): Promise<string>;
  update(target: ChatTarget, messageId: string, message: ChatMessage): Promise<boolean>;
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
