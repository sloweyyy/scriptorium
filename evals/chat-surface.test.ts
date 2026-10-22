import { describe, expect, it } from "vitest";
import { slackInbound } from "@scriptorium/agents";
import type { SlackClient } from "@scriptorium/connectors";
import { chatTurnEvent, Gate, type ChatInbound } from "@scriptorium/runtime";

/**
 * What every chat surface does inbound, as one contract: Slack and a second surface that is
 * not Slack must both pass it, so the agent behind them can't tell which one asked.
 */

interface Said {
  ts: string;
  author: string;
  text: string;
}

/** The chat as the surface sees it: threads by "channel/thread", and who can read each channel. */
interface World {
  threads: Record<string, Said[]>;
  privacy: Record<string, "public" | "private" | "unreadable">;
}

interface Asked {
  channel: string;
  ts: string;
  threadTs?: string;
  author: string;
  bot?: boolean;
  question: string;
}

interface Surface {
  inbound: ChatInbound;
  /** The surface's own payload for a message that mentions the agent. */
  raw(asked: Asked): unknown;
}

function slackSurface(world: World): Surface {
  const client = {
    chat: {},
    conversations: {
      // The parent first, then its replies, oldest first, like Slack.
      replies: async ({ channel, ts }: { channel: string; ts: string }) => ({ messages: (world.threads[`${channel}/${ts}`] ?? []).map((said) => ({ ts: said.ts, user: said.author, text: said.text })) }),
      info: async ({ channel }: { channel: string }) => {
        const privacy = world.privacy[channel];
        if (privacy === undefined || privacy === "unreadable") throw Object.assign(new Error("channel_not_found"), { data: { error: "channel_not_found" } });
        return { ok: true, channel: { id: channel, is_private: privacy === "private", is_im: false, is_mpim: false } };
      },
    },
  } as unknown as SlackClient;
  return {
    inbound: slackInbound(client) as ChatInbound,
    raw: (asked) => ({
      channel: asked.channel,
      ts: asked.ts,
      thread_ts: asked.threadTs,
      ...(asked.bot ? { bot_id: asked.author } : { user: asked.author }),
      text: `<@UBOT> ${asked.question}`,
      client_msg_id: `msg-${asked.channel}-${asked.ts}`,
    }),
  };
}

/** A surface that is not Slack: rooms, `@teammate` mentions, its own payload shape. */
interface RoomMessage {
  messageId: string;
  room: string;
  replyTo?: string;
  from: { id: string; bot: boolean };
  body: string;
}

function roomSurface(world: World): Surface {
  const inbound: ChatInbound<RoomMessage> = {
    surface: "rooms",
    toEvent: (message) =>
      chatTurnEvent("rooms", {
        deliveryId: message.messageId,
        channel: message.room,
        threadTs: message.replyTo,
        ts: message.messageId,
        text: message.body.replace(/@teammate\b/g, "").trim(),
        authorId: message.from.id,
        isBot: message.from.bot,
      }),
    threadContext: async (turn) => {
      if (turn.threadTs === turn.ts) return undefined;
      const lines = (world.threads[`${turn.channel}/${turn.threadTs}`] ?? []).filter((said) => said.ts !== turn.ts).map((said) => `${said.author}: ${said.text}`);
      return lines.length ? lines.join("\n") : undefined;
    },
    isPrivate: async (room) => world.privacy[room] !== "public",
  };
  return {
    inbound: inbound as ChatInbound,
    raw: (asked): RoomMessage => ({ messageId: asked.ts, room: asked.channel, replyTo: asked.threadTs, from: { id: asked.author, bot: Boolean(asked.bot) }, body: `@teammate ${asked.question}` }),
  };
}

const world: World = {
  threads: {
    "C1/1.0": [
      { ts: "1.0", author: "U1", text: "The digest should follow the subscriber's timezone" },
      { ts: "1.1", author: "U2", text: "Agreed, configurable per workspace" },
      { ts: "1.2", author: "U1", text: "make a ticket for this" },
    ],
  },
  privacy: { C1: "public", C2: "private", C3: "unreadable" },
};

for (const [name, make] of [["Slack", slackSurface], ["a surface that is not Slack", roomSurface]] as const) {
  describe(`chat surface contract: ${name}`, () => {
    const surface = make(world);
    const { inbound } = surface;
    const event = (asked: Asked) => inbound.toEvent(surface.raw(asked));

    it("keys a message by its surface, channel and thread; a top-level message is its own thread", () => {
      expect(event({ channel: "C1", ts: "1.2", threadTs: "1.0", author: "U1", question: "make a ticket for this" })).toMatchObject({
        source: inbound.surface,
        key: `${inbound.surface}:thread:C1/1.0`,
        kind: `${inbound.surface}.mention`,
        payload: { channel: "C1", threadTs: "1.0", ts: "1.2" },
      });
      expect(event({ channel: "C1", ts: "5.0", author: "U1", question: "hi" }).key).toBe(`${inbound.surface}:thread:C1/5.0`);
    });

    it("names the author by surface, so an approval or a memory can't cross to another surface's account", () => {
      expect(event({ channel: "C1", ts: "1.2", threadTs: "1.0", author: "U1", question: "q" }).actor).toEqual({ id: `${inbound.surface}:U1`, isBot: false });
      expect(event({ channel: "C1", ts: "1.3", threadTs: "1.0", author: "B7", bot: true, question: "q" }).actor).toEqual({ id: `${inbound.surface}:B7`, isBot: true });
    });

    it("leaves the surface's mention syntax out of the question", () => {
      expect(event({ channel: "C1", ts: "1.2", threadTs: "1.0", author: "U1", question: "when do digests go out?" }).payload.text).toBe("when do digests go out?");
    });

    it("gives a redelivery the same id, so the Gate answers it once, and hears only the channels it is scoped to", () => {
      const gate = new Gate({ selfIds: [], scopes: { [inbound.surface]: [`${inbound.surface}:thread:C1/`] } });
      const asked = { channel: "C1", ts: "1.2", threadTs: "1.0", author: "U1", question: "q" };
      expect(gate.check(event(asked)).accepted).toBe(true);
      expect(gate.check(event(asked)).accepted).toBe(false);
      expect(gate.check(event({ ...asked, channel: "C2", ts: "9.0", threadTs: undefined })).accepted).toBe(false);
    });

    it("reads the thread before the message as context, oldest first, without the message; a top-level message has none", async () => {
      const context = await inbound.threadContext(event({ channel: "C1", ts: "1.2", threadTs: "1.0", author: "U1", question: "make a ticket for this" }).payload);
      const lines = context?.split("\n") ?? [];
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("The digest should follow the subscriber's timezone");
      expect(lines[1]).toContain("Agreed, configurable per workspace");
      expect(context).not.toContain("make a ticket for this");
      expect(await inbound.threadContext(event({ channel: "C1", ts: "5.0", author: "U1", question: "hi" }).payload)).toBeUndefined();
    });

    it("says a public channel is public, and a private one or one it can't read is private", async () => {
      expect(await inbound.isPrivate("C1")).toBe(false);
      expect(await inbound.isPrivate("C2")).toBe(true);
      expect(await inbound.isPrivate("C3")).toBe(true);
    });
  });
}
