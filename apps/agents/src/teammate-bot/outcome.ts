/**
 * What an approver and a requester are told after an approved action ran — or didn't.
 * Pure, so every case is pinned by evals: a tool's refusal (`NOT_ALLOWED: …`) returns
 * normally but is not "done", and a failure never shows its error text to a reader.
 */
export type ApprovedOutcome = { kind: "ran"; result: string } | { kind: string; reason?: string };

export function outcomeMessages(
  outcome: ApprovedOutcome,
  who: { asker: string; approver: string; approverMention: string },
): { text: string; origin: string; notRun?: string } {
  const ran = outcome.kind === "ran" && "result" in outcome ? outcome.result : undefined;
  if (ran !== undefined && !/^NOT_ALLOWED\b/.test(ran)) {
    const first = ran.split("\n")[0];
    return { text: `${who.asker}✅ Done, approved by ${who.approverMention}: ${first}`, origin: `✅ Done, approved by ${who.approver}: ${first}` };
  }
  if (ran !== undefined) {
    const reason = ran.replace(/^NOT_ALLOWED:\s*/, "").split("\n")[0];
    return {
      text: `${who.asker}⚠️ Approved, but it isn't allowed here, so nothing was done: ${reason}`,
      origin: `⚠️ ${who.approver} approved this, but it isn't allowed here, so nothing was done: ${reason}`,
      notRun: "refused",
    };
  }
  return {
    text: `${who.asker}⚠️ Approved, but I couldn't carry it out — nothing was changed. The approval is kept: an approver can retry.`,
    origin: `⚠️ ${who.approver} approved this, but I couldn't carry it out yet — nothing was changed.`,
    notRun: outcome.kind,
  };
}
