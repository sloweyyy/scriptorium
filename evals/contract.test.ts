import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { checkContract } from "@scriptorium/scribe";

describe("input contract", () => {
  it("passes a complete PRD", async () => {
    const prd = await fs.readFile("samples/prd-001-scheduled-maintenance.md", "utf8");
    const result = checkContract(prd);
    expect(result.ok).toBe(true);
    expect(result.missing).toHaveLength(0);
    expect(result.frontmatter.feature).toBe("Scheduled maintenance announcements");
  });

  it("rejects an incomplete PRD and asks for exactly the missing fields", async () => {
    const prd = await fs.readFile("samples/prd-003-incomplete.md", "utf8");
    const result = checkContract(prd);
    expect(result.ok).toBe(false);
    expect(result.missing.map((field) => field.key).sort()).toEqual(["audience", "user_goal"]);
    for (const field of result.missing) {
      expect(field.question.length).toBeGreaterThan(10);
    }
  });

  it("treats empty-string fields as missing", () => {
    const result = checkContract(`---\nfeature: ""\naudience: admins\nuser_goal: do a thing\n---\n# X`);
    expect(result.ok).toBe(false);
    expect(result.missing.map((field) => field.key)).toEqual(["feature"]);
  });
});
