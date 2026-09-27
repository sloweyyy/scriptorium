import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { audit, currentRunId, withRun } from "@scriptorium/core";
import { formatReply } from "@scriptorium/agents";

/** One id per run, on every audit line the run writes — and on the reply people see. */

let tmpRoot: string;
let file: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-run-"));
  file = path.join(tmpRoot, "audit.jsonl");
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5 });
});

const lines = async () => (await fs.readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));

describe("run trace", () => {
  it("tags every audit line inside a run, and nothing outside one", async () => {
    await audit(file, { type: "before" });
    await withRun(async () => {
      await audit(file, { type: "trigger" });
      await new Promise((resolve) => setTimeout(resolve, 1));
      await audit(file, { type: "tool" });
    }, "run-A");
    const [before, trigger, tool] = await lines();
    expect(before.run).toBeUndefined();
    expect(trigger.run).toBe("run-A");
    expect(tool.run).toBe("run-A");
  });

  it("parallel runs never mix their records", async () => {
    await Promise.all(
      ["run-1", "run-2", "run-3"].map((id) =>
        withRun(async () => {
          for (let step = 0; step < 3; step += 1) {
            await new Promise((resolve) => setTimeout(resolve, Math.random() * 3));
            await audit(file, { type: "step", expected: currentRunId() });
          }
        }, id),
      ),
    );
    const all = await lines();
    expect(all).toHaveLength(9);
    for (const line of all) expect(line.run).toBe(line.expected);
  });

  it("every Teammate reply says it is AI-generated and names its run", () => {
    const text = formatReply({ kind: "answer", text: "One email a day [[docs/digest]].", citations: ["docs/digest"] }, "3f2a9c1b-0000-0000-0000-000000000000");
    expect(text).toContain("AI-generated — verify before acting");
    expect(text).toContain("run `3f2a9c1b`");
  });
});
