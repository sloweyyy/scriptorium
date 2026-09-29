// What an approval card shows. A leaf module: guard.ts and plan.ts both need it.

/**
 * What an approver reads on the card: every argument, in full. Each was once capped at 400
 * characters "for display only" while the card said "Approves exactly these arguments", so
 * the rest of a page body or a comment was approved unseen. Now nothing is cut: a multi-line
 * value keeps its lines, the card spreads the text over as many sections as it needs, and a
 * change too long for one card is refused before a card is ever posted (CARD_TEXT_CHARS).
 */
export function summarizeArgs(input: unknown): string {
  const entries = input && typeof input === "object" && !Array.isArray(input) ? Object.entries(input as Record<string, unknown>) : [["input", input] as const];
  return entries
    .map(([key, value]) => {
      const text = (typeof value === "string" ? value : JSON.stringify(value)) ?? "";
      return text.includes("\n") ? `• ${key}:\n${text.trimEnd()}` : `• ${key}: ${text}`;
    })
    .join("\n");
}

/** The most text one approval card shows, as Slack counts it (after `&<>` are escaped). */
export const CARD_TEXT_CHARS = 24_000;

/** Length after Slack's escaping, which is what its limits count. */
export function escapedLength(text: string): number {
  return text.length + (text.match(/&/g)?.length ?? 0) * 4 + (text.match(/[<>]/g)?.length ?? 0) * 3;
}
