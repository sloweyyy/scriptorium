import { describe, expect, it } from "vitest";
import { answerBlocks, progressLine, toSlackMrkdwn } from "@scriptorium/agents";

/**
 * Slack's dialect, pinned.
 *
 * The model writes GitHub-flavoured markdown and Slack renders its own thing, so an answer
 * passed through untouched arrives with its syntax showing. That is not cosmetic: a correct
 * answer that reads "there are **6** documents" looks like a broken bot, and the reader has
 * no way to tell which of the two it is looking at.
 *
 * The other half of this file is the rule that must not be converted away: code is quoted
 * text. A user who asks to see `**` verbatim gets `**`.
 */

interface SectionBlock {
  type: string;
  text?: { type: string; text: string };
  elements?: Array<{ type: string; text: string }>;
}

describe("markdown to slack mrkdwn", () => {
  it("converts the bold that shipped as literal asterisks", () => {
    // The regression that started this: reported verbatim from a real answer.
    expect(toSlackMrkdwn("there are **6** documents in the vault")).toBe("there are *6* documents in the vault");
    expect(toSlackMrkdwn("__also bold__")).toBe("*also bold*");
    expect(toSlackMrkdwn("***both***")).toBe("*_both_*");
  });

  it("turns headings into bold, because Slack has no headings", () => {
    expect(toSlackMrkdwn("## Overview\n\nBody text.")).toBe("*Overview*\n\nBody text.");
    expect(toSlackMrkdwn("# Title")).toBe("*Title*");
  });

  it("rewrites links and bullets into Slack's forms", () => {
    expect(toSlackMrkdwn("see [the docs](https://example.com/x)")).toBe("see <https://example.com/x|the docs>");
    expect(toSlackMrkdwn("- one\n- two")).toBe("• one\n• two");
    expect(toSlackMrkdwn("* starred\n* bullets")).toBe("• starred\n• bullets");
    expect(toSlackMrkdwn("~~gone~~")).toBe("~gone~");
  });

  it("renders wikilinks as paths — vault syntax means nothing to a Slack reader", () => {
    expect(toSlackMrkdwn("as documented in [[docs/scheduled-maintenance]]")).toBe(
      "as documented in `docs/scheduled-maintenance`",
    );
  });

  it("leaves code alone, fenced or inline", () => {
    // A user asking how to write bold markdown must get the asterisks back unchanged.
    const fenced = "Use this:\n\n```\n**not bold here**\n- not a bullet\n```\n\nDone.";
    expect(toSlackMrkdwn(fenced)).toContain("**not bold here**");
    expect(toSlackMrkdwn(fenced)).toContain("- not a bullet");
    // ...while text outside the fence is still converted.
    expect(toSlackMrkdwn("**yes** and `**no**`")).toBe("*yes* and `**no**`");
  });

  it("drops the model's own trailing sources line", () => {
    // Citations are rendered from the parsed list, so the model's version would duplicate
    // them — and its version is the one carrying raw wikilink syntax.
    const answer = "The window is quoted in UTC.\n\nSources: [[docs/maintenance]]";
    expect(toSlackMrkdwn(answer)).toBe("The window is quoted in UTC.");
    expect(toSlackMrkdwn("Answer.\n\n_**Sources:** [[a]], [[b]]_")).toBe("Answer.");
  });
});

describe("answer blocks", () => {
  it("puts the answer in a section and its provenance in a context block", () => {
    const blocks = answerBlocks({
      markdown: "Maintenance windows are quoted in **UTC**.",
      citations: ["docs/scheduled-maintenance-announcements"],
    }) as SectionBlock[];

    expect(blocks[0]?.type).toBe("section");
    expect(blocks[0]?.text?.text).toBe("Maintenance windows are quoted in *UTC*.");
    // A context block renders small and muted: always present, never competing.
    expect(blocks[1]?.type).toBe("context");
    expect(blocks[1]?.elements?.[0]?.text).toContain("docs/scheduled-maintenance-announcements");
  });

  it("counts rather than repeats when the answer already cites inline", () => {
    // The case from the real thread: a six-item list, each item carrying its own path, with
    // all six repeated underneath. That duplication is what pushed the message past Slack's
    // "Show less" fold — a correct answer made to look unwieldy by its own footnotes.
    const listed = [
      "There are **6** documents:",
      "1. **Vault index** [[index]]",
      "2. **Maintenance** [[docs/scheduled-maintenance-announcements]]",
    ].join("\n");
    const blocks = answerBlocks({
      markdown: listed,
      citations: ["index", "docs/scheduled-maintenance-announcements"],
    }) as SectionBlock[];

    const footer = blocks[1]?.elements?.[0]?.text ?? "";
    expect(footer).toBe("📚 Answered from 2 notes in the vault, cited above.");
    // The paths still appear — in the answer, once.
    expect(blocks[0]?.text?.text).toContain("`docs/scheduled-maintenance-announcements`");
  });

  it("names the sources when the answer does not show them", () => {
    const blocks = answerBlocks({
      markdown: "Maintenance windows are quoted in UTC.",
      citations: ["docs/scheduled-maintenance-announcements"],
    }) as SectionBlock[];
    expect(blocks[1]?.elements?.[0]?.text).toBe("📚 `docs/scheduled-maintenance-announcements`");
  });

  it("caps the chips so the footer stays a glance", () => {
    const many = ["a", "b", "c", "d", "e", "f"];
    const blocks = answerBlocks({ markdown: "An answer citing nothing visibly.", citations: many }) as SectionBlock[];
    const footer = blocks[1]?.elements?.[0]?.text ?? "";
    expect(footer).toContain("`a`");
    expect(footer).toContain("`d`");
    expect(footer).not.toContain("`e`");
    expect(footer).toContain("+2 more");
  });

  it("says so when nothing was cited, rather than showing an empty footer", () => {
    const blocks = answerBlocks({ markdown: "Something.", citations: [] }) as SectionBlock[];
    // An uncited answer is the fail-closed rule having been broken. Silence would hide it.
    expect(blocks[1]?.elements?.[0]?.text).toContain("No source cited");
  });

  it("clamps an over-long answer instead of losing the whole message", () => {
    const blocks = answerBlocks({ markdown: "x".repeat(5_000), citations: ["a"] }) as SectionBlock[];
    const text = blocks[0]?.text?.text ?? "";
    // Slack rejects an mrkdwn object over 3000 chars, which would drop the answer entirely.
    expect(text.length).toBeLessThanOrEqual(3_000);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("progress line", () => {
  it("names what it is doing, not just that it is busy", () => {
    // Still "searching" after several attempts is the shape of a question the vault does
    // not cover — a different thing to be waiting on than a long read.
    expect(progressLine({ searches: 3, reads: 0, elapsedMs: 9_000 })).toBe("⏳ Searching the vault… 3 searches · 9s");
    expect(progressLine({ searches: 1, reads: 1, elapsedMs: 4_000 })).toBe("⏳ Reading the vault… 1 search · 1 note read · 4s");
  });

  it("pluralises and formats long waits in minutes", () => {
    expect(progressLine({ searches: 2, reads: 3, elapsedMs: 95_000 })).toBe("⏳ Reading the vault… 2 searches · 3 notes read · 1m 35s");
  });

  it("still reports elapsed time before any tool has run", () => {
    expect(progressLine({ searches: 0, reads: 0, elapsedMs: 2_600 })).toBe("⏳ Searching the vault… 3s");
  });
});
