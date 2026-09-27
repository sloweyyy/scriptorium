/**
 * `pnpm trace <run-id-prefix>` — everything one agent run did, from the audit log.
 *
 * Every Teammate reply ends with "run `3f2a9c1b`"; this is where that leads: the trigger,
 * each policy decision and tool call, approvals, the reply — in order, one line each.
 * `pnpm trace` with no argument lists the most recent runs.
 */
import fs from "node:fs/promises";
import { loadConfig } from "@scriptorium/core";

export interface AuditLine {
  ts: string;
  run?: string;
  type: string;
  [key: string]: unknown;
}

export function parseAudit(text: string): AuditLine[] {
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as AuditLine];
      } catch {
        return [];
      }
    });
}

export function linesForRun(lines: AuditLine[], prefix: string): AuditLine[] {
  return lines.filter((line) => line.run?.startsWith(prefix));
}

export function recentRuns(lines: AuditLine[], limit = 10): Array<{ run: string; started: string; events: number; last: string }> {
  const runs = new Map<string, { run: string; started: string; events: number; last: string }>();
  for (const line of lines) {
    if (!line.run) continue;
    const entry = runs.get(line.run) ?? { run: line.run, started: line.ts, events: 0, last: line.type };
    entry.events += 1;
    entry.last = line.type;
    runs.set(line.run, entry);
  }
  return [...runs.values()].sort((a, b) => b.started.localeCompare(a.started)).slice(0, limit);
}

export function formatLine(line: AuditLine): string {
  const { ts, run: _run, type, ...rest } = line;
  const detail = Object.entries(rest)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" ");
  return `${ts}  ${type.padEnd(28)} ${detail}`;
}

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
