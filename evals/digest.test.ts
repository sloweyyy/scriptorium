import { describe, expect, it } from "vitest";
import { digestDue, isoWeek, postDigestOnce } from "@scriptorium/agents";
import { MemoryEffectLedger } from "@scriptorium/runtime";

/** The weekly digest: due at the right hour, and posted once per week however often it's checked. */
describe("weekly digest", () => {
  it("knows ISO weeks, including the year boundary", () => {
    expect(isoWeek(new Date("2026-09-28T09:00:00Z"))).toBe("2026-W40");
    expect(isoWeek(new Date("2027-01-01T00:00:00Z"))).toBe("2026-W53");
    expect(isoWeek(new Date("2026-01-01T00:00:00Z"))).toBe("2026-W01");
  });

  it("is due from the scheduled weekday and hour until the week ends", () => {
    const monday9 = { weekday: 1, hour: 9 };
    expect(digestDue(new Date("2026-09-28T08:59:00Z"), monday9)).toBe(false);
    expect(digestDue(new Date("2026-09-28T09:00:00Z"), monday9)).toBe(true);
    expect(digestDue(new Date("2026-10-02T15:00:00Z"), monday9)).toBe(true);
  });

  it("posts once per week across repeated checks and restarts, and again next week", async () => {
    const ledger = new MemoryEffectLedger();
    const posts: string[] = [];
    const run = (at: string) => postDigestOnce(ledger, "C1", new Date(at), async () => `digest for ${at}`, async (text) => void posts.push(text));
    await run("2026-09-28T09:00:00Z");
    await run("2026-09-28T10:00:00Z");
    await run("2026-09-30T12:00:00Z");
    expect(posts).toHaveLength(1);
    await run("2026-10-05T09:00:00Z");
    expect(posts).toHaveLength(2);
  });

  it("a digest that failed to produce is retried, not marked done", async () => {
    const ledger = new MemoryEffectLedger();
    const posts: string[] = [];
    await expect(postDigestOnce(ledger, "C1", new Date("2026-09-28T09:00:00Z"), async () => { throw new Error("refused"); }, async (text) => void posts.push(text))).rejects.toThrow();
    await postDigestOnce(ledger, "C1", new Date("2026-09-28T10:00:00Z"), async () => "ok", async (text) => void posts.push(text));
    expect(posts).toEqual(["ok"]);
  });
});
