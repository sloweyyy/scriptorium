import { audit, type Vault } from "@scriptorium/core";
import { checkStaleness } from "@scriptorium/curator";
import { once, opKey, type EffectLedger } from "@scriptorium/runtime";

/**
 * Stale docs, reported where they can be fixed: on the ticket they were approved on.
 *
 * Exactly once per (doc, new source version) — the effects ledger keys on both — so an
 * hourly check never repeats itself, and a SECOND change to the same PRD is a second,
 * separate notice. A stale doc with no ticket is logged, not dropped.
 */
export async function reportStaleDocs(input: {
  vault: Vault;
  ledger: EffectLedger;
  auditFile: string;
  /** Post with this op on the comment, so `landed` can find it. */
  notify: (issueKey: string, markdown: string, op: string) => Promise<void>;
  /** Did a notice with this op already land on the ticket? Asked after an interrupted post. */
  landed?: (issueKey: string, op: string) => Promise<boolean>;
}): Promise<{ notified: string[] }> {
  const notified: string[] = [];
  for (const doc of await checkStaleness(input.vault)) {
    if (doc.status !== "stale" || !doc.currentHash) continue;
    if (!doc.jiraIssue) {
      await audit(input.auditFile, { type: "doc.stale.unrouted", actor: "curator", doc: doc.doc, source: doc.source });
      continue;
    }
    const issueKey = doc.jiraIssue;
    const op = opKey("doc.stale", doc.doc, doc.currentHash);
    // Probed: a notice Jira stored before its response was lost (or before a crash) is found
    // on the ticket, instead of being posted again at the next hourly check.
    const probe = input.landed ? async () => ((await input.landed!(issueKey, op)) ? true : undefined) : undefined;
    const { replayed } = await once(input.ledger, op, async () => {
      await input.notify(
        issueKey,
        [
          `**This doc may be out of date.** Its PRD (\`${doc.source}\`) has changed since \`${doc.doc}\` was approved.`,
          "",
          "Nothing was changed. If the published doc should follow the PRD, comment `draft` to revise it; the revision goes through the usual review and approval.",
        ].join("\n"),
        op,
      );
      await audit(input.auditFile, { type: "doc.stale.notified", actor: "curator", doc: doc.doc, issue: doc.jiraIssue });
      return true;
    }, probe ? { probe } : {});
    if (!replayed) notified.push(doc.doc);
  }
  return { notified };
}
