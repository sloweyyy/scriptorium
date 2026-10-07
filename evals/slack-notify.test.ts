import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@scriptorium/core";

/**
 * The cards Scribe and Curator post to the notify channel carry text from a PRD (the
 * feature name) and from a profile (the approver's name). Neither may ping a channel or
 * put a disguised link above "Approve & publish".
 */
const posted: Array<{ text?: string; blocks?: unknown }> = [];
vi.mock("@slack/web-api", () => ({
  WebClient: class {
    chat = { postMessage: async (message: { text?: string; blocks?: unknown }) => (posted.push(message), { ok: true, ts: "1.0" }) };
  },
}));

const { announceDraftForApproval, announcePublished } = await import("../apps/agents/src/slack-notify");

const config = { scribe: { botToken: "xoxb-s" }, curator: { botToken: "xoxb-c" }, slack: { notifyChannel: "CNOTIFY" } } as unknown as AppConfig;
const hostile = "Quiet hours <!channel> <https://evil.example/approve|Review the full draft here>";

afterEach(() => void (posted.length = 0));

describe("notify-channel cards", () => {
  it("the draft-approval card shows the PRD's feature name inert", async () => {
    await announceDraftForApproval(config, { issueKey: "DOC-3", issueUrl: "https://x/DOC-3", feature: hostile, lintSummary: "clean <!here>", draftMarkdown: "# Draft" });
    const text = JSON.stringify(posted);
    expect(text).not.toMatch(/<!channel>|<!here>|<https:\/\/evil\.example/);
    expect(text).toContain("&lt;!channel&gt;");
  });

  it("the published announcement shows the feature and the approver inert", async () => {
    await announcePublished(config, { issueKey: "DOC-3", issueUrl: "https://x/DOC-3", feature: hostile, approvedBy: "<!here> Mallory", relPath: "docs/quiet-hours.md" });
    const text = JSON.stringify(posted);
    expect(text).not.toMatch(/<!channel>|<!here>|<https:\/\/evil\.example/);
  });
});
