import { describe, expect, it } from "vitest";
import { formatLine, linesForRun, parseAudit, recentRuns } from "../scripts/trace";

/** `pnpm trace` — from the run id on a reply to what that run did. */
const LOG = [
  '{"ts":"2026-09-27T10:00:00.000Z","run":"3f2a9c1b-1","type":"policy.ran","actor":"Teammate","tool":"search_vault"}',
  '{"ts":"2026-09-27T10:00:01.000Z","run":"3f2a9c1b-1","type":"policy.approval.requested","tool":"jira_create_issue","approval":"a1"}',
  "not json — a torn line is skipped, not fatal",
  '{"ts":"2026-09-27T10:05:00.000Z","run":"9d8e7f6a-2","type":"teammate.answer","key":"slack:thread:C1/1.0"}',
  '{"ts":"2026-09-27T10:06:00.000Z","type":"jira.draft.posted"}',
].join("\n");

describe("trace", () => {
  it("finds a run by the 8-character id on a reply, in order", () => {
    const lines = linesForRun(parseAudit(LOG), "3f2a9c1b");
    expect(lines.map((line) => line.type)).toEqual(["policy.ran", "policy.approval.requested"]);
    expect(formatLine(lines[1]!)).toContain("tool=jira_create_issue approval=a1");
  });

  it("lists recent runs newest first, ignoring lines outside any run", () => {
    expect(recentRuns(parseAudit(LOG)).map((run) => run.run)).toEqual(["9d8e7f6a-2", "3f2a9c1b-1"]);
  });
});
