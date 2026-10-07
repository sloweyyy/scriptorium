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

  it("passes the second sample PRD, the one that demonstrates lesson transfer", async () => {
    const prd = await fs.readFile("samples/prd-002-subscriber-management.md", "utf8");
    const result = checkContract(prd);
    expect(result.ok).toBe(true);
    expect(result.frontmatter.feature).toBe("Status page subscriber management");
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

  it("treats a placeholder as unanswered, in front matter or in the body", () => {
    for (const placeholder of ["TBD", "TODO", "n/a", "?", "...", "—"]) {
      const result = checkContract(`---\nfeature: Digest emails\naudience: "${placeholder}"\nuser_goal: one email a day\n---\n# X`);
      expect(result.missing.map((field) => field.key), placeholder).toEqual(["audience"]);
    }
    const labeled = checkContract("# Digest emails\n\n**Feature:** Digest emails\n**Audience:** TBD\n**User goal:** one email a day");
    expect(labeled.missing.map((field) => field.key)).toEqual(["audience"]);
    // A real answer that happens to contain the word is an answer.
    expect(checkContract("---\nfeature: Todo list reminders\naudience: workspace admins\nuser_goal: never miss a todo\n---\n# X").ok).toBe(true);
    expect(checkContract("---\nfeature: Digest emails\naudience: admins (TBD which tier)\nuser_goal: one email a day\n---\n# X").missing.map((field) => field.key)).toEqual(["audience"]);
    for (const audience of ["tbd (ask PM)", "admins (tbd which tier)"]) {
      expect(checkContract(`---\nfeature: Digest emails\naudience: ${audience}\nuser_goal: one email a day\n---\n# X`).missing.map((field) => field.key), audience).toEqual(["audience"]);
    }
    // A real answer that mentions nothing of the kind still passes.
    expect(checkContract("---\nfeature: Digest emails\naudience: workspace admins\nuser_goal: one email a day\n---\n# X").ok).toBe(true);
  });
});

describe("contract fields written the way humans write them", () => {
  it("accepts labeled lines in the body — PMs do not write YAML", () => {
    // The shape a PM actually types into a Jira description or a Confluence page.
    const prd = [
      "# Incident timeline embed",
      "",
      "**Feature:** Incident timeline embed",
      "Audience: workspace admins",
      "- user goal — embed a read-only incident timeline in a status page",
      "",
      "The widget shows...",
    ].join("\n");

    const result = checkContract(prd);
    expect(result.ok).toBe(true);
    // Found values are folded into the frontmatter, so the slug and the seeded vault
    // note see one answer regardless of where the author put it.
    expect(result.frontmatter.feature).toBe("Incident timeline embed");
    expect(result.frontmatter.audience).toBe("workspace admins");
    expect(result.frontmatter.user_goal).toContain("read-only incident timeline");
  });

  it("accepts a heading with the answer under it", () => {
    const prd = ["# PRD", "", "## Audience", "", "Workspace admins.", "", "feature: Timeline", "goal: embed it"].join("\n");
    const result = checkContract(prd);
    expect(result.ok).toBe(true);
    expect(result.frontmatter.audience).toBe("Workspace admins.");
  });

  it("does not mine an answer out of prose — explicit or missing, nothing between", () => {
    // "audience" appearing mid-sentence is not a declaration, and an empty section is
    // not an answer. Fail-closed did not get softer; only the spelling of "present" did.
    const prd = ["# PRD", "", "We should think about the audience for this feature.", "", "## User goal", "", "## Next section", "content"].join("\n");
    const result = checkContract(prd);
    expect(result.ok).toBe(false);
    expect(result.missing.map((field) => field.key).sort()).toEqual(["audience", "feature", "user_goal"]);
  });

  it("frontmatter still wins over a conflicting body label", () => {
    const prd = ["---", "audience: integrators", "feature: X", "user_goal: y", "---", "", "Audience: admins"].join("\n");
    const result = checkContract(prd);
    expect(result.ok).toBe(true);
    expect(result.frontmatter.audience).toBe("integrators");
  });
});
