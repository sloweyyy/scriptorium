import { afterEach, describe, expect, it } from "vitest";
import { parseMarkdown } from "@scriptorium/core";
import { checkContract } from "@scriptorium/scribe";

/**
 * A PRD is untrusted input, and its frontmatter is parsed before any human or model sees
 * it. gray-matter's default engines include JavaScript: a `---js` fence is evaluated, with
 * `require` and `process` in reach. Each payload below sets a global sentinel if it runs.
 */

const SENTINEL = "__scriptorium_frontmatter_executed__";
const globals = globalThis as Record<string, unknown>;

afterEach(() => {
  delete globals[SENTINEL];
});

const payload = (fence: string) =>
  [`---${fence}`, `{ feature: (globalThis["${SENTINEL}"] = true, "x"), audience: "a", user_goal: "b" }`, "---", "# PRD"].join("\n");

describe("frontmatter never executes", () => {
  for (const fence of ["js", "javascript", " js", "coffee"]) {
    it(`refuses a \`---${fence}\` fence without running it`, () => {
      expect(() => parseMarkdown(payload(fence))).toThrow();
      expect(globals[SENTINEL]).toBeUndefined();
    });
  }

  it("refuses it on the contract path a Jira attachment takes, too", () => {
    expect(() => checkContract(payload("js"))).toThrow(/must be YAML/);
    expect(globals[SENTINEL]).toBeUndefined();
  });

  it("still reads ordinary YAML frontmatter", () => {
    const { frontmatter, body } = parseMarkdown("---\nfeature: Digest emails\n---\n# Digest");
    expect(frontmatter.feature).toBe("Digest emails");
    expect(body).toBe("# Digest");
  });

  it("judges malformed YAML the same way every time", () => {
    // gray-matter caches by input string: the first parse threw, and every later parse of
    // the same PRD quietly returned `{}` — two different verdicts on consecutive polls.
    const bad = "---\nfeature: [unclosed\n---\n# PRD";
    expect(() => parseMarkdown(bad)).toThrow();
    expect(() => parseMarkdown(bad)).toThrow();
  });
});
