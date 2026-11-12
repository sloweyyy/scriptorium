import { afterEach, describe, expect, it, vi } from "vitest";
import { replyMessage, slackOutbound } from "@scriptorium/agents";
import type { SlackClient } from "@scriptorium/connectors";
import { chatDelivery, type ChatMessage, type ChatOutbound, type ChatTarget } from "@scriptorium/runtime";

interface Posted {
  id: string;
  target: ChatTarget;
  text: string;
  blocks?: unknown[];
}

function world(surface: "slack" | "rooms") {
  const posts: Posted[] = [];
  const state = { failPost: false, failEdit: false, rejectEdit: false };
  const post = async (target: ChatTarget, text: string, blocks?: unknown[]): Promise<string> => {
    if (state.failPost) throw new Error("offline");
    const id = `message-${posts.length + 1}`;
    posts.push({ id, target, text, blocks });
    return id;
  };
  const edit = async (target: ChatTarget, id: string, text: string, blocks?: unknown[]): Promise<boolean> => {
    if (state.rejectEdit) throw new Error("edit rejected");
    if (state.failEdit) return false;
    const message = posts.find((message) => message.id === id && message.target.channel === target.channel);
    if (!message) return false;
    Object.assign(message, { text, blocks });
    return true;
  };
  // The SDK boundary is mocked, not the adapter's rendering or delivery methods.
  const slack = {
    chat: {
      postMessage: async (input: { channel: string; thread_ts?: string; text: string; blocks?: unknown[] }) => ({ ok: true, ts: await post({ channel: input.channel, threadId: input.thread_ts }, input.text, input.blocks) }),
      update: async (input: { channel: string; ts: string; text: string; blocks?: unknown[] }) => ({ ok: await edit({ channel: input.channel }, input.ts, input.text, input.blocks) }),
    },
  } as unknown as SlackClient;
  // A second implementation speaks ordinary Markdown and has no Slack payload fields.
  const render = (message: ChatMessage) => [
    message.text,
    message.request ? `Request: [${message.request.key}](${message.request.url})` : undefined,
    message.sources?.citations.map((id) => `[${id}](${message.sources?.links?.get(id) ?? id})`).join(" "),
    message.footer ? `${message.footer.text}${message.footer.link ? ` · [${message.footer.link.label}](${message.footer.link.url})` : ""}` : undefined,
  ].filter(Boolean).join("\n");
  const rooms: ChatOutbound = {
    surface: "rooms",
    post: (target, message) => post(target, render(message)),
    update: (target, id, message) => edit(target, id, render(message)),
  };
  return { outbound: surface === "slack" ? slackOutbound(slack) : rooms, posts, state };
}

afterEach(() => vi.restoreAllMocks());

const target: ChatTarget = { channel: "room-7", threadId: "thread-42" };
const answer: ChatMessage = {
  ...replyMessage({ kind: "answer", text: "**Digest** is sent at 09:00 [[docs/digest]].", citations: ["docs/digest"] }, "run-12345678", { baseUrl: "https://runs.example", token: "never-send-this" }),
  sources: { citations: ["docs/digest"], links: new Map([["docs/digest", "https://docs.example/digest"]]) },
};

for (const surface of ["slack", "rooms"] as const) {
  describe(`outbound chat contract: ${surface}`, () => {
    it("turns the acknowledgement into a cited answer in the same thread, with its run provenance", async () => {
      const { outbound, posts } = world(surface);
      const id = await outbound.post(target, { text: "Looking into it…" });
      expect(await chatDelivery(outbound, target, id).finish(answer)).toBe(id);
      expect(posts).toHaveLength(1);
      expect(posts[0]?.target).toEqual(target);
      expect(posts[0]?.text).toContain("09:00");
      expect(posts[0]?.text).toContain("AI-generated — verify before acting");
      expect(posts[0]?.text).toContain("https://runs.example/runs/run-12345678?sig=");
      expect(JSON.stringify(posts)).toContain("https://docs.example/digest");
      expect(JSON.stringify(posts)).not.toContain("never-send-this");
      expect(posts[0]?.text).not.toContain("Looking into it");
    });

    it("posts in the original thread when editing is unavailable or fails", async () => {
      for (const failure of ["failEdit", "rejectEdit"] as const) {
        const { outbound, posts, state } = world(surface);
        const id = await outbound.post(target, { text: "Looking into it…" });
        state[failure] = true;
        const delivered = await chatDelivery(outbound, target, id).finish(answer);
        expect(delivered).not.toBe(id);
        expect(posts).toHaveLength(2);
        expect(posts[1]?.target).toEqual(target);
        expect(posts[1]?.text).toContain("09:00");
      }
    });

    it("reports failed delivery so a durable placeholder is not marked answered", async () => {
      const { outbound, state } = world(surface);
      const id = await outbound.post(target, { text: "Looking into it…" });
      state.failEdit = state.failPost = true;
      await expect(chatDelivery(outbound, target, id).finish(answer)).rejects.toThrow("offline");
    });

    it("answers without a placeholder, and sends no progress when there is nothing to edit", async () => {
      const { outbound, posts } = world(surface);
      const delivery = chatDelivery(outbound, target);
      delivery.progress({ text: "Searching…" });
      const id = await delivery.finish(answer);
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({ id, target });
      expect(posts[0]?.text).toContain("09:00");
    });

    it("throttles progress and refuses all progress after the answer starts delivery", async () => {
      const { outbound, posts } = world(surface);
      const id = await outbound.post(target, { text: "Looking into it…" });
      let now = 0;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const edited: string[] = [];
      const original = outbound.update;
      outbound.update = async (where, messageId, message) => {
        edited.push(message.text);
        return original(where, messageId, message);
      };
      const delivery = chatDelivery(outbound, target, id);
      delivery.progress({ text: "Searching…" });
      now = 1_999;
      delivery.progress({ text: "Too soon" });
      now = 2_000;
      delivery.progress({ text: "Reading…" });
      const done = delivery.finish(answer);
      now = 4_000;
      delivery.progress({ text: "Too late" });
      await done;
      expect(edited).toEqual(["Searching…", "Reading…", answer.text]);
      expect(posts[0]?.text).toContain("09:00");
    });

    it("waits for every progress edit, including an earlier slow retry, before the answer", async () => {
      const { outbound, posts } = world(surface);
      const id = await outbound.post(target, { text: "Looking into it…" });
      let now = 0;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const original = outbound.update;
      const edits: string[] = [];
      outbound.update = async (where, messageId, message) => {
        if (message.text === "Slow search") await held;
        edits.push(message.text);
        return original(where, messageId, message);
      };
      const delivery = chatDelivery(outbound, target, id);
      delivery.progress({ text: "Slow search" });
      now = 2_000;
      delivery.progress({ text: "Fast read" });
      const done = delivery.finish(answer);
      await new Promise((resolve) => setImmediate(resolve));
      expect(edits).toEqual(["Fast read"]);
      release();
      await done;
      expect(edits).toEqual(["Fast read", "Slow search", answer.text]);
      expect(posts[0]?.text).toContain("09:00");
    });

    it("a rejected progress edit never prevents the answer", async () => {
      const { outbound, posts } = world(surface);
      const id = await outbound.post(target, { text: "Looking into it…" });
      const original = outbound.update;
      outbound.update = async (where, messageId, message) => {
        if (message.text === "Searching…") throw new Error("rate limited");
        return original(where, messageId, message);
      };
      const delivery = chatDelivery(outbound, target, id);
      delivery.progress({ text: "Searching…" });
      await delivery.finish(answer);
      expect(posts[0]?.text).toContain("09:00");
    });

    it("renders a gap ticket link from neutral content", async () => {
      const { outbound, posts } = world(surface);
      await outbound.post(target, replyMessage({ kind: "gap", text: "Not in the KB.", gapPath: "_gaps/G-1.md", ticket: { key: "DOC-9", url: "https://jira.example/DOC-9" } }));
      expect(posts[0]?.text).toContain("https://jira.example/DOC-9");
      expect(posts[0]?.text).toContain("DOC-9");
      expect(posts[0]?.text).toContain("AI-generated");
    });
  });
}

describe("Slack rendering stays in the adapter", () => {
  it("converts Markdown and defuses untrusted mentions, preserving source and provenance blocks", async () => {
    const { outbound, posts } = world("slack");
    await outbound.post(target, { ...answer, text: "**Digest** <!channel> <@U1> [[docs/digest]]" });
    expect(posts[0]?.text).toContain("*Digest*");
    expect(posts[0]?.text).not.toContain("<!channel>");
    expect(posts[0]?.text).not.toContain("<@U1>");
    const blocks = JSON.stringify(posts[0]?.blocks);
    expect(blocks).toContain("https://docs.example/digest|docs/digest");
    expect(blocks).toContain("AI-generated");
  });

  it("refuses an unconfirmed post and explicitly clears old blocks on a plain edit", async () => {
    const calls: unknown[] = [];
    let response: { ok: boolean; ts?: string } = { ok: false, ts: "unconfirmed-id" };
    const outbound = slackOutbound({ chat: {
      postMessage: async () => response,
      update: async (args: unknown) => { calls.push(args); return { ok: true }; },
    } } as unknown as SlackClient);
    await expect(outbound.post(target, answer)).rejects.toThrow("did not confirm");
    response = { ok: true };
    await expect(outbound.post(target, answer)).rejects.toThrow("did not confirm");
    await outbound.update(target, "msg", { text: "Please ask again." });
    expect(calls).toEqual([{ channel: target.channel, ts: "msg", text: "Please ask again.", blocks: [] }]);
  });

  it("keeps sources and links semantic until the adapter renders them", () => {
    const message = replyMessage({ kind: "answer", text: "**Digest** [[docs/digest]].", citations: ["docs/digest"] }, "run-12345678");
    expect(message.text).toBe("**Digest** [[docs/digest]].");
    expect(message.sources).toEqual({ citations: ["docs/digest"] });
    expect(message.footer?.text).toContain("run `run-1234`");
    expect(message).not.toHaveProperty("blocks");
  });
});
