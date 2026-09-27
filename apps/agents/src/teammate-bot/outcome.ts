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
  // A plan that stopped part-way: some of it happened, so neither "done" nor "nothing changed".
  if (ran !== undefined && /^PARTIAL:/.test(ran)) {
    const first = ran.replace(/^PARTIAL:\s*/, "").split("\n")[0];
    return {
      text: `${who.asker}⚠️ Approved by ${who.approverMention}, but only partly done: ${first}`,
      origin: `⚠️ ${who.approver} approved this, but it was only partly done: ${first}`,
      notRun: "partial",
    };
  }
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
  const partial = "reason" in outcome ? outcome.reason?.match(/^PARTIAL: (\d+) of (\d+) steps done before step (\d+) failed\./) : undefined;
  if (partial) {
    const [, done, total, step] = partial;
    return {
      text: `${who.asker}⚠️ Approved, but step ${step} failed: ${done} of ${total} steps are done. The approval is kept: an approver can retry, and the done steps won't repeat.`,
      origin: `⚠️ ${who.approver} approved this; ${done} of ${total} steps are done, and step ${step} failed — it can be retried.`,
      notRun: outcome.kind,
    };
  }
  return {
    text: `${who.asker}⚠️ Approved, but I couldn't carry it out — nothing was changed. The approval is kept: an approver can retry.`,
    origin: `⚠️ ${who.approver} approved this, but I couldn't carry it out yet — nothing was changed.`,
    notRun: outcome.kind,
  };
}
