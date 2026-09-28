/**
 * `pnpm feedback` — answers someone flagged with 👎 in Slack, newest first: the review queue
 * for new answer golden cases (evals/golden/answers.json).
 *
 * Each line is a pointer: when it was flagged, by how many people, and the run that produced
 * the answer. `pnpm trace <run>` shows what that run did. No Slack text is kept for this.
 */
import fs from "node:fs/promises";
import { feedbackCandidates, loadConfig, parseAudit } from "@scriptorium/core";

const config = loadConfig();
const candidates = feedbackCandidates(parseAudit(await fs.readFile(config.auditFile, "utf8").catch(() => "")));
if (!candidates.length) console.log("No flagged answers.");
for (const item of candidates) {
  const run = item.run ? `pnpm trace ${item.run.slice(0, 8)}` : "(no run recorded)";
  console.log(`${item.lastFlagged}  👎×${item.flaggedBy.length}  ${(item.kind ?? "?").padEnd(8)} ${item.channel}/${item.message}  ${run}`);
}
