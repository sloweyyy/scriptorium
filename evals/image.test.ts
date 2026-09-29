import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What goes into the container image. `docker build .` copies the working directory: with
 * no .dockerignore it baked the local .env (every secret), state, the audit log and local
 * notes into an image anyone who can pull it can read. Both build paths are pinned here.
 */
const lines = async (file: string) =>
  (await fs.readFile(path.resolve(file), "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

const MUST_EXCLUDE = [".env", ".env.*", ".scriptorium-state", "audit", "vault/_memory", "NOTES.local.md", "scratchpad", "node_modules"];

describe("the container image", () => {
  it("docker build leaves secrets, state, records and local notes out", async () => {
    const ignored = await lines(".dockerignore");
    for (const pattern of MUST_EXCLUDE) expect(ignored, pattern).toContain(pattern);
    // The example stays: it is documentation, and holds no secret.
    expect(ignored).toContain("!.env.example");
  });

  it("gcloud's source upload leaves out the same secrets and records", async () => {
    const ignored = await lines(".gcloudignore");
    for (const pattern of [".env", ".env.*", ".scriptorium-state", "audit", "vault/_memory", "NOTES.local.md", "scratchpad"]) expect(ignored, pattern).toContain(pattern);
  });

  it("the process doesn't run as root, and the image says when it's healthy", async () => {
    const dockerfile = await fs.readFile(path.resolve("Dockerfile"), "utf8");
    const user = dockerfile.match(/^USER\s+(\S+)/m)?.[1];
    expect(user).toBeDefined();
    expect(user).not.toBe("root");
    expect(user).not.toBe("0");
    // USER comes before the process starts, not after.
    expect(dockerfile.indexOf("USER ")).toBeLessThan(dockerfile.indexOf("CMD "));
    expect(dockerfile).toMatch(/^HEALTHCHECK /m);
  });
});
