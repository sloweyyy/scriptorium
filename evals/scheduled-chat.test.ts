import { describe, expect, it, vi } from "vitest";
import { slackOutbound } from "@scriptorium/agents";
import type { SlackClient } from "@scriptorium/connectors";
import { MemoryEffectLedger, opKey, postChatOnce, type ChatMessage, type ChatPostTag, type ChatTarget, type TaggedChatOutbound } from "@scriptorium/runtime";

const target: ChatTarget = { channel: "C1", threadId: "1.0" };
const tag: ChatPostTag = { type: "scriptorium_approval_nudge", data: { request: "request-7" } };

interface Post { id: string; target: ChatTarget; tag: ChatPostTag; message: ChatMessage }

function adapter(surface: "slack" | "rooms") {
  const posts: Post[] = [];
  const state = { loseResponse: false, probeError: false, confirmed: true };
  const save = async (where: ChatTarget, message: ChatMessage, marker: ChatPostTag): Promise<string> => {
    const id = `post-${posts.length + 1}`;
    posts.push({ id, target: where, message, tag: marker });
    if (state.loseResponse) { state.loseResponse = false; throw new Error("response lost after send"); }
    return id;
  };
  const matching = (where: ChatTarget) => {
    if (state.probeError) throw new Error("search unavailable");
    return posts.filter((post) => post.target.channel === where.channel && post.target.threadId === where.threadId);
  };
  const sdk = {
    chat: {
      postMessage: async (args: { channel: string; thread_ts?: string; text: string; metadata: { event_type: string; event_payload: Record<string, string> } }) => ({
        ok: state.confirmed,
        ts: await save({ channel: args.channel, threadId: args.thread_ts }, { text: args.text }, { type: args.metadata.event_type, data: args.metadata.event_payload }),
      }),
    },
    conversations: {
      replies: async (args: { channel: string; ts: string }) => ({ ok: true, messages: matching({ channel: args.channel, threadId: args.ts }).map((post) => ({ ts: post.id, metadata: { event_type: post.tag.type, event_payload: post.tag.data } })) }),
      history: async (args: { channel: string }) => ({ ok: true, messages: matching({ channel: args.channel }).map((post) => ({ ts: post.id, metadata: { event_type: post.tag.type, event_payload: post.tag.data } })) }),
    },
  } as unknown as SlackClient;
  const rooms: TaggedChatOutbound = {
    surface,
    post: async () => { throw new Error("scheduled posts must be tagged"); },
    update: async () => false,
    postTagged: save,
    findTagged: async (where, marker) => matching(where).find((post) => post.tag.type === marker.type && Object.entries(marker.data).every(([key, value]) => post.tag.data[key] === value))?.id,
  };
  return { outbound: surface === "slack" ? slackOutbound(sdk) : rooms, posts, state };
}

for (const surface of ["slack", "rooms"] as const) {
  describe(`scheduled post contract: ${surface}`, () => {
    it("replays a completed post without producing content again", async () => {
      const { outbound, posts } = adapter(surface);
      const ledger = new MemoryEffectLedger();
      const produce = vi.fn(async () => ({ text: "Weekly digest" }));
      const first = await postChatOnce(ledger, outbound, target, tag, produce);
      const replay = await postChatOnce(ledger, outbound, target, tag, produce);
      expect(first).toEqual({ posted: true, messageId: "post-1" });
      expect(replay).toEqual({ posted: false, messageId: "post-1" });
      expect(posts).toHaveLength(1);
      expect(produce).toHaveBeenCalledTimes(1);
    });

    it("finds a send whose response was lost, with no second generation or post", async () => {
      const { outbound, posts, state } = adapter(surface);
      const ledger = new MemoryEffectLedger();
      const produce = vi.fn(async () => ({ text: "Reminder" }));
      state.loseResponse = true;
      await expect(postChatOnce(ledger, outbound, target, tag, produce)).rejects.toThrow("response lost");
      expect(await ledger.inProgress()).toHaveLength(1);
      expect(await postChatOnce(ledger, outbound, target, tag, produce)).toEqual({ posted: false, messageId: "post-1" });
      expect(posts).toHaveLength(1);
      expect(produce).toHaveBeenCalledTimes(1);
      expect(await ledger.inProgress()).toEqual([]);
    });

    it("retries a failure before sending, but a failed probe never authorizes another send", async () => {
      const { outbound, posts, state } = adapter(surface);
      const ledger = new MemoryEffectLedger();
      await expect(postChatOnce(ledger, outbound, target, tag, async () => { throw new Error("no content"); })).rejects.toThrow("no content");
      state.probeError = true;
      const produce = vi.fn(async () => ({ text: "ready" }));
      await expect(postChatOnce(ledger, outbound, target, tag, produce)).rejects.toThrow("search unavailable");
      expect(produce).not.toHaveBeenCalled();
      expect(posts).toEqual([]);
      expect(await ledger.inProgress()).toHaveLength(1);
      state.probeError = false;
      expect((await postChatOnce(ledger, outbound, target, tag, produce)).posted).toBe(true);
      expect(posts).toHaveLength(1);
    });

    it("keeps tags separate by channel, thread, type and every tag field", async () => {
      const { outbound, posts } = adapter(surface);
      const ledger = new MemoryEffectLedger();
      const produce = async () => ({ text: "a post" });
      for (const [where, marker] of [
        [target, tag],
        [{ channel: "C2", threadId: target.threadId }, tag],
        [{ channel: target.channel, threadId: "2.0" }, tag],
        [{ channel: target.channel }, tag],
        [target, { ...tag, type: "scriptorium_reminder" }],
        [target, { ...tag, data: { request: "request-8" } }],
      ] as const) await postChatOnce(ledger, outbound, where, marker, produce);
      expect(posts).toHaveLength(6);
      expect(await outbound.findTagged({ channel: "C3" }, tag)).toBeUndefined();
      expect(await outbound.findTagged(target, { ...tag, data: { request: "request-7", other: "missing" } })).toBeUndefined();
    });

    it("orders tag fields deterministically and coalesces simultaneous sends", async () => {
      const { outbound, posts } = adapter(surface);
      const ledger = new MemoryEffectLedger();
      const produce = vi.fn(async () => ({ text: "one post" }));
      const a = { type: "test", data: { first: "1", second: "2" } };
      const b = { type: "test", data: { second: "2", first: "1" } };
      const results = await Promise.all([postChatOnce(ledger, outbound, target, a, produce), postChatOnce(ledger, outbound, target, b, produce)]);
      expect(posts).toHaveLength(1);
      expect(produce).toHaveBeenCalledTimes(1);
      expect(results.map((result) => result.posted)).toEqual([true, false]);
    });
  });
}

describe("scheduled posts across adapters and upgrades", () => {
  it("never replays another surface's op, even with the same legacy Slack op supplied", async () => {
    const ledger = new MemoryEffectLedger();
    const slack = adapter("slack");
    const rooms = adapter("rooms");
    const legacySlackOp = opKey("teammate.card.nudged", "request-7");
    const produce = async () => ({ text: "nudge" });
    await postChatOnce(ledger, slack.outbound, target, tag, produce, { legacySlackOp });
    await postChatOnce(ledger, rooms.outbound, target, tag, produce, { legacySlackOp });
    expect(slack.posts).toHaveLength(1);
    expect(rooms.posts).toHaveLength(1);
    const second = adapter("rooms");
    await postChatOnce(ledger, { ...second.outbound, surface: "another" }, target, tag, produce);
    expect(second.posts).toHaveLength(1);
  });

  it("preserves old boolean done records, and recovers an in-progress legacy Slack post", async () => {
    for (const oldResult of [true, "old-message-id"]) {
      const { outbound, posts } = adapter("slack");
      const ledger = new MemoryEffectLedger();
      const legacySlackOp = opKey("digest", "C1", "2026-W46");
      await ledger.put({ op: legacySlackOp, status: "done", startedAt: "then", result: oldResult });
      const produce = vi.fn(async () => ({ text: "should not be posted" }));
      expect((await postChatOnce(ledger, outbound, target, tag, produce, { legacySlackOp })).posted).toBe(false);
      expect(posts).toEqual([]);
      expect(produce).not.toHaveBeenCalled();
    }
    const { outbound, posts } = adapter("slack");
    const ledger = new MemoryEffectLedger();
    const legacySlackOp = opKey("teammate.reminder.post", "reminder-1");
    await outbound.postTagged(target, { text: "Already sent" }, tag);
    await ledger.put({ op: legacySlackOp, status: "in-progress", startedAt: "then" });
    expect(await postChatOnce(ledger, outbound, target, tag, async () => ({ text: "duplicate" }), { legacySlackOp })).toEqual({ posted: false, messageId: "post-1" });
    expect(posts).toHaveLength(1);
  });

  it("rejects an empty correlation tag before writing or producing anything", async () => {
    const { outbound, posts } = adapter("rooms");
    const ledger = new MemoryEffectLedger();
    const produce = vi.fn(async () => ({ text: "no" }));
    const invalidTags: ChatPostTag[] = [{ type: "", data: { id: "1" } }, { type: "digest", data: {} }];
    for (const invalid of invalidTags) {
      await expect(postChatOnce(ledger, outbound, target, invalid, produce)).rejects.toThrow("nonempty correlation tag");
    }
    expect(produce).not.toHaveBeenCalled();
    expect(posts).toEqual([]);
    expect(await ledger.inProgress()).toEqual([]);
  });
});

describe("Slack tagged post searches", () => {
  function sdk(pages: unknown[]) {
    const read = vi.fn(async (_args: unknown) => pages.shift());
    const outbound = slackOutbound({ conversations: { history: read, replies: read } } as unknown as SlackClient);
    return { read, outbound };
  }

  it("follows channel and thread cursors, asking for metadata and the original time bound on every page", async () => {
    for (const where of [target, { channel: "C1" }]) {
      const { outbound, read } = sdk([
        { ok: true, messages: [{ ts: "irrelevant", metadata: { event_type: "other", event_payload: tag.data } }], has_more: true, response_metadata: { next_cursor: "page-2" } },
        { ok: true, messages: [{ ts: "found", metadata: { event_type: tag.type, event_payload: tag.data } }] },
      ]);
      expect(await outbound.findTagged(where, tag, 60_000)).toBe("found");
      expect(read.mock.calls.map(([args]) => args)).toEqual([
        { channel: "C1", include_all_metadata: true, limit: 200, oldest: "60", ...(where.threadId ? { ts: where.threadId } : {}) },
        { channel: "C1", include_all_metadata: true, limit: 200, oldest: "60", cursor: "page-2", ...(where.threadId ? { ts: where.threadId } : {}) },
      ]);
    }
  });

  it("a missing cursor, repeated cursor, rejected response or missing messages is not proof of absence", async () => {
    for (const pages of [
      [{ ok: true, messages: [], has_more: true }],
      [{ ok: true, messages: [], has_more: true, response_metadata: { next_cursor: "same" } }, { ok: true, messages: [], has_more: true, response_metadata: { next_cursor: "same" } }],
      [{ ok: false, messages: [] }],
      [{ ok: true }],
      [{ ok: true, messages: [{ metadata: { event_type: tag.type, event_payload: tag.data } }] }],
    ]) await expect(sdk(pages).outbound.findTagged(target, tag)).rejects.toThrow();
  });

  it("a bounded search that runs out of pages throws instead of authorizing a duplicate", async () => {
    const { outbound, read } = sdk(Array.from({ length: 10 }, (_, index) => ({ ok: true, messages: [], has_more: true, response_metadata: { next_cursor: `next-${index}` } })));
    await expect(outbound.findTagged(target, tag)).rejects.toThrow("page limit");
    expect(read).toHaveBeenCalledTimes(10);
  });

  it("an empty tag is rejected before the platform is queried", async () => {
    const { outbound, read } = sdk([]);
    await expect(outbound.findTagged(target, { type: "digest", data: {} })).rejects.toThrow("nonempty correlation tag");
    expect(read).not.toHaveBeenCalled();
  });

  it("only explicit Slack accounts notify; the message text, foreign accounts and mass mentions remain inert", async () => {
    const postMessage = vi.fn(async (_args: unknown) => ({ ok: true, ts: "sent" }));
    const outbound = slackOutbound({ chat: { postMessage } } as unknown as SlackClient);
    await outbound.postTagged(target, { text: "Waiting <!channel>", notify: ["slack:UPM", "rooms:U2", "slack:<!everyone>"] }, tag);
    const args = postMessage.mock.calls[0]?.[0] as unknown as { text: string; metadata: unknown };
    expect(args.text).toBe("Waiting &lt;!channel&gt; <@UPM>");
    expect(args.metadata).toEqual({ event_type: tag.type, event_payload: tag.data });
  });
});
