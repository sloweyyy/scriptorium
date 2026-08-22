import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Vault } from "@scriptorium/core";
import { lastPublishCommit, publishVault, stageVault } from "@scriptorium/publish";

const exec = promisify(execFile);

/** Test-side git: identity and signing pinned so this runs on any dev machine or CI box. */
async function run(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd },
  );
  return stdout.trim();
}

let tmpRoot: string;
let vault: Vault;
let stageDir: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-publish-"));
  vault = new Vault(path.join(tmpRoot, "vault"));
  await vault.ensure();
  stageDir = path.join(tmpRoot, "staged");
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function stagedFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (prefix: string): Promise<void> => {
    for (const entry of await fs.readdir(path.join(dir, prefix), { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(rel);
      else found.push(rel);
    }
  };
  await walk("");
  return found.sort();
}

describe("publish include-list", () => {
  it("never stages reference/** even though it sits on disk next to docs/", async () => {
    // vault/reference/ is gitignored but present — a recursive copy would ship third-party
    // retrieved content. This is the failure the include-list exists to prevent.
    await vault.writeNote("reference/whatever.md", "# Some vendor page\n\nRetrieved copy.", {
      kind: "reference",
      source_url: "https://example.com/whatever",
    });
    await vault.writeNote("_inbox/pending.md", "# Not filed yet", { kind: "doc" });
    await vault.writeNote("docs/widget-exports.md", "# Widget exports\n\nHow to export.", { kind: "doc" });
    await vault.writeNote("prd/widget-exports.md", "# Widget exports", { kind: "prd" });

    const external = await stageVault({ vault, target: "external", destDir: stageDir });
    expect(external.files).toEqual(["docs/widget-exports.md"]);
    expect(await stagedFiles(stageDir)).toEqual(["docs/widget-exports.md"]);

    const internalDir = path.join(tmpRoot, "staged-internal");
    const internal = await stageVault({ vault, target: "internal", destDir: internalDir });
    expect(internal.files).toContain("prd/widget-exports.md");
    expect(internal.files).toContain("index.md");
    const internalStaged = await stagedFiles(internalDir);
    expect(internalStaged.some((f) => f.startsWith("reference/"))).toBe(false);
    expect(internalStaged.some((f) => f.startsWith("_inbox/"))).toBe(false);
  });

  it("rejects a file carrying source_url even when its path is allowlisted", async () => {
    // Gate 2 keys on content, not path: a reference note misfiled into docs/ is still
    // retrieved third-party material and must stop the whole publish.
    await vault.writeNote("docs/sneaky.md", "# Vendor page\n\nRetrieved copy filed wrong.", {
      kind: "doc",
      source_url: "https://example.com/sneaky",
    });

    await expect(stageVault({ vault, target: "external", destDir: stageDir })).rejects.toThrow(/source_url/);
    await expect(
      stageVault({ vault, target: "internal", destDir: path.join(tmpRoot, "staged-internal") }),
    ).rejects.toThrow(/source_url/);
  });
});

describe("publish link transform", () => {
  beforeEach(async () => {
    await vault.writeNote("docs/csv-format.md", "# CSV format\n\nColumns.", { kind: "doc" });
    await vault.writeNote("prd/widget-exports.md", "# Widget exports", { kind: "prd" });
    await vault.writeNote(
      "docs/widget-exports.md",
      "# Widget exports\n\nSee [[docs/csv-format|the CSV format]].\n\nBackground: [[prd/widget-exports|the PRD]].\n",
      {
        kind: "doc",
        jira_issue: "DOC-7",
        source: "[[prd/widget-exports]]",
        applied_lessons: ["[[_lessons/no-marketing-voice]]"],
        approved_by: "pm@example.com",
        related: ["[[prd/widget-exports]]", "[[docs/csv-format]]"],
      },
    );
  });

  it("rewrites an allowlisted wikilink to a working relative link", async () => {
    const result = await stageVault({ vault, target: "external", destDir: stageDir });
    const staged = new Vault(stageDir);
    const doc = await staged.readNote("docs/widget-exports.md");

    expect(doc.body).toContain("[the CSV format](./csv-format.md)");
    expect(doc.body).not.toContain("[[");
    // The link resolves to a file that is actually in the staged tree — not a dead link.
    expect(result.files).toContain("docs/csv-format.md");
    expect(await staged.exists("docs/csv-format.md")).toBe(true);
  });

  it("emits no link at all for a prd/** target the external allowlist excludes", async () => {
    const result = await stageVault({ vault, target: "external", destDir: stageDir });
    const doc = await new Vault(stageDir).readNote("docs/widget-exports.md");

    expect(doc.body).toContain("Background: the PRD.");
    expect(doc.body).not.toMatch(/prd\//);
    expect(result.droppedLinks).toContain("prd/widget-exports");
    // Internal-only provenance is stripped, and the leftover `related` entry pointing at
    // prd/** goes with it. jira_issue stays — it is the round-trip join key.
    expect(doc.frontmatter.source).toBeUndefined();
    expect(doc.frontmatter.approved_by).toBeUndefined();
    expect(doc.frontmatter.applied_lessons).toBeUndefined();
    expect(doc.frontmatter.related).toEqual(["[[docs/csv-format]]"]);
    expect(doc.frontmatter.jira_issue).toBe("DOC-7");
  });

  it("leaves the internal target untransformed for Quartz", async () => {
    const internalDir = path.join(tmpRoot, "staged-internal");
    await stageVault({ vault, target: "internal", destDir: internalDir });
    const doc = await new Vault(internalDir).readNote("docs/widget-exports.md");

    expect(doc.body).toContain("[[prd/widget-exports|the PRD]]");
    expect(doc.frontmatter.approved_by).toBe("pm@example.com");
  });
});

describe("publish divergence gate", () => {
  let bare: string;
  let agentClone: string;
  let humanClone: string;

  beforeEach(async () => {
    bare = path.join(tmpRoot, "docs-repo.git");
    agentClone = path.join(tmpRoot, "agent-clone");
    humanClone = path.join(tmpRoot, "human-clone");
    await fs.mkdir(bare, { recursive: true });
    await run(tmpRoot, ["init", "--bare", "-b", "main", bare]);
    await run(tmpRoot, ["clone", bare, agentClone]);
    await run(agentClone, ["checkout", "-B", "main"]);
    await run(agentClone, ["config", "user.name", "Scribe"]);
    await run(agentClone, ["config", "user.email", "scribe@example.com"]);
    await run(agentClone, ["config", "commit.gpgsign", "false"]);
    // Docs repos exist before the agent publishes into them.
    await fs.writeFile(path.join(agentClone, "README.md"), "# Docs repo\n");
    await run(agentClone, ["add", "README.md"]);
    await run(agentClone, ["commit", "-m", "chore: init docs repo"]);
    await run(agentClone, ["push", "-u", "origin", "main"]);
  });

  it("refuses when a human commit sits on top of the blob the agent last published", async () => {
    await vault.writeNote("docs/widget-exports.md", "# Widget exports\n\nFirst published body.", { kind: "doc" });
    const first = await publishVault({ vault, target: "external", repoDir: agentClone, approvedBy: "pm@example.com" });
    expect(first.push.status).toBe("published");
    const baseline = await lastPublishCommit(agentClone, "external");
    expect(baseline).toBeTruthy();

    // A human edits the published doc in GitHub and merges.
    await run(tmpRoot, ["clone", bare, humanClone]);
    await run(humanClone, ["config", "user.name", "Human"]);
    await run(humanClone, ["config", "user.email", "human@example.com"]);
    const humanBody = "# Widget exports\n\nHand-edited by a human reviewer.\n";
    await fs.writeFile(path.join(humanClone, "docs/widget-exports.md"), humanBody);
    await run(humanClone, ["commit", "-am", "docs: tighten the intro"]);
    await run(humanClone, ["push", "origin", "main"]);
    const remoteTip = await run(bare, ["rev-parse", "refs/heads/main"]);

    // The agent revises the same doc in the vault. A pull --rebase would succeed here and
    // the wholesale rewrite would silently erase the human's edit — that is the bug.
    await vault.writeNote("docs/widget-exports.md", "# Widget exports\n\nSecond published body.", { kind: "doc" });
    const second = await publishVault({ vault, target: "external", repoDir: agentClone, approvedBy: "pm@example.com" });

    expect(second.push.status).toBe("conflict");
    if (second.push.status !== "conflict") throw new Error("expected a conflict");
    expect(second.push.diverged.map((d) => d.path)).toEqual(["docs/widget-exports.md"]);
    expect(second.push.diverged[0]?.reason).toBe("modified-by-human");
    expect(second.push.committed).toBe(false);
    expect(second.push.pushed).toBe(false);

    // Nothing committed, nothing pushed, and the human's bytes are still the ones on disk.
    expect(await run(bare, ["rev-parse", "refs/heads/main"])).toBe(remoteTip);
    expect(await run(agentClone, ["rev-parse", "HEAD"])).toBe(remoteTip);
    expect(await run(agentClone, ["status", "--porcelain"])).toBe("");
    expect(await fs.readFile(path.join(agentClone, "docs/widget-exports.md"), "utf8")).toContain("Hand-edited");
    const publishCommits = await run(agentClone, [
      "log",
      "--format=%H",
      "--fixed-strings",
      "--grep=Scriptorium-Publish: external",
    ]);
    expect(publishCommits.split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("refuses to overwrite a path it has never published (no baseline commit)", async () => {
    // Fail-closed first publish: whatever is already at a target path is somebody else's.
    await fs.mkdir(path.join(agentClone, "docs"), { recursive: true });
    await fs.writeFile(path.join(agentClone, "docs/widget-exports.md"), "# Widget exports\n\nHuman-authored.\n");
    await run(agentClone, ["add", "docs/widget-exports.md"]);
    await run(agentClone, ["commit", "-m", "docs: hand-written page"]);
    await run(agentClone, ["push", "origin", "main"]);
    const remoteTip = await run(bare, ["rev-parse", "refs/heads/main"]);

    await vault.writeNote("docs/widget-exports.md", "# Widget exports\n\nAgent body.", { kind: "doc" });
    const result = await publishVault({
      vault,
      target: "external",
      repoDir: agentClone,
      approvedBy: "pm@example.com",
    });

    expect(result.push.status).toBe("conflict");
    if (result.push.status !== "conflict") throw new Error("expected a conflict");
    expect(result.push.baseline).toBeUndefined();
    expect(result.push.diverged[0]?.reason).toBe("created-by-human");
    expect(await run(bare, ["rev-parse", "refs/heads/main"])).toBe(remoteTip);
  });

  it("publishes both include-lists and stamps a findable baseline commit", async () => {
    await vault.writeNote("docs/widget-exports.md", "# Widget exports\n\nBody.", { kind: "doc" });
    await vault.writeNote("prd/widget-exports.md", "# Widget exports", { kind: "prd" });
    await vault.writeNote("_lessons/no-marketing-voice.md", "# No marketing voice", { kind: "lesson" });
    await vault.writeNote("reference/vendor.md", "# Vendor", { source_url: "https://example.com" });

    const external = await publishVault({
      vault,
      target: "external",
      repoDir: agentClone,
      subdir: "site/src/content/docs",
      approvedBy: "pm@example.com",
    });
    expect(external.push.status).toBe("published");
    if (external.push.status !== "published") throw new Error("expected a publish");
    expect(external.push.changed).toEqual(["site/src/content/docs/docs/widget-exports.md"]);

    const internal = await publishVault({
      vault,
      target: "internal",
      repoDir: agentClone,
      branch: "main",
      approvedBy: "pm@example.com",
    });
    expect(internal.push.status).toBe("published");
    if (internal.push.status !== "published") throw new Error("expected a publish");
    expect(internal.push.changed).toContain("_lessons/no-marketing-voice.md");
    expect(internal.push.changed).toContain("prd/widget-exports.md");
    expect(internal.push.changed.some((p) => p.startsWith("reference/"))).toBe(false);

    // Baselines are per-target: the internal publish must not become the external baseline.
    expect(await lastPublishCommit(agentClone, "external")).toBe(external.push.commit);
    expect(await lastPublishCommit(agentClone, "internal")).toBe(internal.push.commit);

    // A re-publish with an unchanged vault is a no-op, not an empty commit.
    const again = await publishVault({ vault, target: "external", repoDir: agentClone, subdir: "site/src/content/docs", approvedBy: "pm@example.com" });
    expect(again.push.status).toBe("unchanged");
  });
});
