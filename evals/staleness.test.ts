import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Vault, sourceHash } from "@scriptorium/core";
import { checkStaleness } from "@scriptorium/curator";
import { stageVault } from "@scriptorium/publish";
import { publishDoc } from "@scriptorium/scribe";

/**
 * The page that quietly went stale. A doc records its source PRD's hash when approved; the
 * check compares every doc against its source as it is now.
 */
const exec = promisify(execFile);
let tmpRoot: string;
let vault: Vault;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-stale-"));
  await exec("git", ["init", "-q"], { cwd: tmpRoot });
  await exec("git", ["config", "user.name", "Test"], { cwd: tmpRoot });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: tmpRoot });
  vault = new Vault(path.join(tmpRoot, "vault"));
  await vault.ensure();
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const publish = (slug: string) =>
  publishDoc({ vault, auditFile: path.join(tmpRoot, "audit.jsonl"), repoRoot: tmpRoot, markdown: `# ${slug}\n\nBody.`, approvedBy: "PM", sourcePrd: `prd/${slug}`, slug });

describe("staleness", () => {
  it("a doc is fresh until its PRD's body changes — and stays fresh through Curator's frontmatter edits", async () => {
    await vault.writeNote("prd/maintenance.md", "# Maintenance\n\nReminder 1 hour before start.", { feature: "Maintenance" });
    await publish("maintenance");
    expect(await checkStaleness(vault)).toEqual([{ doc: "docs/maintenance.md", status: "fresh", source: "prd/maintenance" }]);

    // Curator re-files the PRD: new frontmatter, same body. Not stale.
    await vault.writeNote("prd/maintenance.md", "# Maintenance\r\n\r\nReminder 1 hour before start.", { feature: "Maintenance", filed: "2026-09-27", related: ["[[docs/maintenance]]"] });
    expect((await checkStaleness(vault))[0]?.status).toBe("fresh");

    // The product changed: the reminder moved to 24 hours. Stale.
    await vault.writeNote("prd/maintenance.md", "# Maintenance\n\nReminder 24 hours before start.", { feature: "Maintenance" });
    expect((await checkStaleness(vault))[0]?.status).toBe("stale");
  });

  it("reports docs with no baseline as unbaselined — never as stale — and a vanished source as missing", async () => {
    await vault.writeNote("docs/old.md", "# Old\n\nPublished before baselines.", { kind: "doc", source: "[[prd/old]]" });
    await vault.writeNote("prd/gone.md", "# Gone", {});
    await publish("gone");
    await vault.deleteFile("prd/gone.md");
    expect(await checkStaleness(vault)).toEqual([
      { doc: "docs/gone.md", status: "source-missing", source: "prd/gone" },
      { doc: "docs/old.md", status: "unbaselined", source: "prd/old" },
    ]);
  });

  it("the baseline never reaches the public site", async () => {
    await vault.writeNote("prd/maintenance.md", "# Maintenance\n\nBody.", {});
    await publish("maintenance");
    expect((await vault.readNote("docs/maintenance.md")).frontmatter.source_hash).toBe(sourceHash("# Maintenance\n\nBody."));
    const dest = path.join(tmpRoot, "public");
    await stageVault({ vault, target: "external", destDir: dest });
    const staged = await fs.readFile(path.join(dest, "docs", "maintenance.md"), "utf8");
    expect(staged).toContain("Body.");
    expect(staged).not.toContain("source_hash");
  });
});
