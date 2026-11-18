import { defineConfig } from "vitest/config";
import { evalEnvironment } from "./evals/hermetic-env";

export default defineConfig({
  test: {
    include: ["evals/**/*.test.ts"],
    // Hermetic: of an operator's .env, only the model provider settings reach the evals.
    env: evalEnvironment(),
    testTimeout: 120_000,
    // Setup that builds real git remotes (publish, repo split, hydrate) can take tens of
    // seconds on a loaded machine; the 10s default failed them for being slow, not wrong.
    hookTimeout: 60_000,
  },
});
