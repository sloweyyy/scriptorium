import { describe, expect, it, vi } from "vitest";
import { generateText } from "@scriptorium/core";

/**
 * A wobble in judging feedback must read exactly like doc-specific feedback: no rule, no
 * crash. `distillLesson` already had a "could not tell" outcome — `null`, the same value
 * it returns for feedback that's genuinely specific to one document — but a transport
 * failure took the other branch entirely: a thrown error, which reaches `proposeLesson`
 * two publish steps too late to make sense.
 *
 * `proposeLesson` runs AFTER the document is already published, so the ticket got the
 * poller's generic ⚠️ error comment attached to a `runPublish` call that had, in fact,
 * succeeded — leaking the transport's own wording ("raise maxTokens") and telling a human
 * to comment `draft` to retry, which re-drafts the whole document rather than the lesson
 * step, since the feedback that fed the failed call is cleared before it runs.
 *
 * Found by testing the exact combined-feedback shape a real ticket produces — two
 * feedback comments on one ticket, both accumulated since the last publish and joined into
 * one distillation call at approval time — against the live Gemini transport, not by
 * reading the code.
 */

vi.mock("@scriptorium/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scriptorium/core")>()),
  generateText: vi.fn(),
}));

const { distillLesson } = await import("@scriptorium/scribe");

describe("distilling feedback into a lesson", () => {
  it("returns null, not a thrown error, when the classification call itself fails", async () => {
    vi.mocked(generateText).mockRejectedValueOnce(new Error("Gemini response truncated (MAX_TOKENS) — raise maxTokens."));
    await expect(distillLesson("Some feedback.")).resolves.toBeNull();
  });

  it("still returns the rule when the call succeeds", async () => {
    vi.mocked(generateText).mockResolvedValueOnce("LESSON: Always specify the timezone.");
    await expect(distillLesson("Some feedback.")).resolves.toBe("Always specify the timezone.");
  });

  it("still returns null for feedback the model judges doc-specific", async () => {
    vi.mocked(generateText).mockResolvedValueOnce("DOC_ONLY");
    await expect(distillLesson("Fix this one typo.")).resolves.toBeNull();
  });

  it("asks for enough headroom that a real answer isn't mistaken for a truncated one", async () => {
    vi.mocked(generateText).mockResolvedValueOnce("DOC_ONLY");
    await distillLesson("Some feedback.");
    const call = vi.mocked(generateText).mock.calls.at(-1)?.[0];
    // 300 measured too tight against the live transport for perfectly ordinary feedback;
    // pinned here so a future "let's trim the budget" edit has to look at this comment.
    expect(call?.maxTokens).toBeGreaterThanOrEqual(1000);
  });
});
