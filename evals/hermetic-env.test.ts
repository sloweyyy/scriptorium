import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { providerSettings } from "./hermetic-env";

/** An operator's .env must not change what a guardrail eval sees; only the model provider passes. */
describe("hermetic evals", () => {
  const dotenv = [
    "# a real deployment's .env",
    "SCRIPTORIUM_SIGNING_KEY=0123abcd",
    "JIRA_API_TOKEN=secret",
    "TEAMMATE_APPROVERS=U012AB",
    "LLM_PROVIDER=anthropic",
    "ANTHROPIC_API_KEY='sk-test'",
    'MODEL="claude-opus-5"  # the default',
    "VERTEX_PROJECT_ID=my-project # comment",
    "export GEMINI_MODEL=gemini-3.5-flash",
    "MODEL_FALLBACK=",
  ].join("\n");

  it("passes the model provider settings and nothing else", () => {
    expect(providerSettings(dotenv, {})).toEqual({
      LLM_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-test",
      MODEL: "claude-opus-5",
      VERTEX_PROJECT_ID: "my-project",
      GEMINI_MODEL: "gemini-3.5-flash",
    });
  });

  it("leaves a setting the environment already has alone, as dotenv does", () => {
    expect(providerSettings(dotenv, { ANTHROPIC_API_KEY: "from-the-shell" })).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("runs every eval with .env loading off", () => {
    expect(process.env.SCRIPTORIUM_DOTENV).toBe("off");
  });

  describe("the config loader honours the switch", () => {
    let dir: string;
    const config = pathToFileURL(path.resolve("packages/core/src/config.ts")).href;
    const tsx = path.resolve("node_modules/.bin/tsx");
    const signingKeyIn = (extra: Record<string, string>): string =>
      execFileSync(tsx, ["-e", `import(${JSON.stringify(config)}).then(({ loadConfig }) => console.log(loadConfig().signingKey ?? "none"))`], {
        cwd: dir,
        // Not the eval's own environment: that already has the switch off.
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...extra },
        encoding: "utf8",
      }).trim();

    beforeAll(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-dotenv-"));
      await fs.writeFile(path.join(dir, ".env"), "SCRIPTORIUM_SIGNING_KEY=from-dotenv\n");
    });
    afterAll(async () => {
      if (dir) await fs.rm(dir, { recursive: true, force: true });
    });

    it("reads .env normally", () => {
      expect(signingKeyIn({})).toBe("from-dotenv");
    });

    it("ignores it when the evals turn it off", () => {
      expect(signingKeyIn({ SCRIPTORIUM_DOTENV: "off" })).toBe("none");
    });
  });
});
