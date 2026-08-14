import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["evals/**/*.test.ts"],
    testTimeout: 120_000,
  },
});
