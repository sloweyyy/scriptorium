import { describe, expect, it } from "vitest";
import { DailyBudget } from "@scriptorium/runtime";

/** Spend caps: bounded cost per channel per day, surviving a restart. */
describe("daily budget", () => {
  const at = (iso: string) => () => new Date(iso);

  it("is exhausted once a scope's day is spent, per scope, and resets the next UTC day", () => {
    let now = "2026-09-28T10:00:00Z";
    const budget = new DailyBudget(1_000, () => new Date(now));
    budget.add("C1", 600);
    expect(budget.exhausted("C1")).toBe(false);
    budget.add("C1", 500);
    expect(budget.exhausted("C1")).toBe(true);
    expect(budget.exhausted("C2")).toBe(false);
    now = "2026-09-29T00:00:01Z";
    expect(budget.exhausted("C1")).toBe(false);
  });

  it("unset means unlimited", () => {
    const budget = new DailyBudget(undefined, at("2026-09-28T10:00:00Z"));
    budget.add("C1", 10_000_000);
    expect(budget.exhausted("C1")).toBe(false);
  });

  it("a restart is not a fresh budget: today's usage is rebuilt from the audit log", () => {
    const budget = new DailyBudget(1_000, at("2026-09-28T18:00:00Z"));
    budget.seed([
      { ts: "2026-09-28T09:00:00Z", type: "llm.usage", scope: "C1", input: 900, output: 200 },
      { ts: "2026-09-27T09:00:00Z", type: "llm.usage", scope: "C2", input: 5_000, output: 0 },
      { ts: "2026-09-28T09:00:00Z", type: "teammate.answer", scope: "C2" },
    ]);
    expect(budget.exhausted("C1")).toBe(true);
    expect(budget.exhausted("C2")).toBe(false);
  });
});
