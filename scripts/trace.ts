/**
 * `pnpm trace <run-id-prefix>` — everything one agent run did, from the audit log.
 *
 * Every Teammate reply ends with "run `3f2a9c1b`"; this is where that leads: the trigger,
 * each policy decision and tool call, approvals, the reply — in order, one line each.
 * `pnpm trace` with no argument lists the most recent runs.
 */
import fs from "node:fs/promises";
import { formatLine, linesForRun, loadConfig, parseAudit, recentRuns } from "@scriptorium/core";

export { formatLine, linesForRun, parseAudit, recentRuns };

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const lines = parseAudit(await fs.readFile(config.auditFile, "utf8").catch(() => ""));
  const prefix = process.argv[2];
  if (!prefix) {
    for (const run of recentRuns(lines)) console.log(`${run.run.slice(0, 8)}  ${run.started}  ${String(run.events).padStart(3)} events  last: ${run.last}`);
  } else {
    const matched = linesForRun(lines, prefix);
    if (!matched.length) {
      console.error(`no audit lines for run ${prefix}`);
      process.exitCode = 1;
    }
    for (const line of matched) console.log(formatLine(line));
  }
}
