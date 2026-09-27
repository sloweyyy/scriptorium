import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Vault } from "@scriptorium/core";
import { organizeInboxFile } from "@scriptorium/curator";

let vault: Vault;
let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-vault-"));
  vault = new Vault(tmpRoot);
  await vault.ensure();
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5 });
});

describe("curator organizer", () => {
  it("trusts an explicit kind over body heuristics, so a PRD never lands in docs/", async () => {
    // Scribe seeds the ticket's PRD into _inbox with kind: prd. Without that, a PRD with
    // no "## Requirements" heading would be filed to docs/<slug>.md — the exact path the
    // approved doc is published to.
    await vault.writeNote("_inbox/DOC-7-source.md", "# Scheduled maintenance\n\nA short brief with no requirements heading.", {
      kind: "prd",
      feature: "Scheduled maintenance",
      audience: "admins",
      user_goal: "announce downtime",
      jira_issue: "DOC-7",
    });

    const result = await organizeInboxFile(vault, "_inbox/DOC-7-source.md");
    expect(result.action).toBe("filed-prd");
    expect(result.to).toBe("prd/scheduled-maintenance.md");
    expect(await vault.exists("docs/scheduled-maintenance.md")).toBe(false);
  });

  it("files a PRD from _inbox into prd/ with normalized frontmatter", async () => {
    await vault.writeNote("_inbox/dropped-prd.md", "# Widget exports\n\n## Requirements\n1. Export as CSV.", {
      kind: "prd",
      feature: "Widget exports",
      audience: "admins",
      user_goal: "export widgets",
    });

    const result = await organizeInboxFile(vault, "_inbox/dropped-prd.md");
    expect(result.action).toBe("filed-prd");
    expect(result.to).toBe("prd/widget-exports.md");
    expect(await vault.exists("prd/widget-exports.md")).toBe(true);
    expect(await vault.exists("_inbox/dropped-prd.md")).toBe(false);

    const filed = await vault.readNote("prd/widget-exports.md");
    expect(filed.frontmatter.kind).toBe("prd");
    expect(filed.frontmatter.filed).toBeTruthy();

    const moc = await vault.readNote("index.md");
    expect(moc.body).toContain("[[prd/widget-exports|Widget exports]]");
  });

  it("cross-links a doc and its PRD when slugs match", async () => {
    await vault.writeNote("prd/widget-exports.md", "# Widget exports", { kind: "prd", feature: "Widget exports" });
    await vault.writeNote("_inbox/widget-exports-doc.md", "# Widget exports\n\nHow to export.", {
      kind: "doc",
      feature: "Widget exports",
    });

    const result = await organizeInboxFile(vault, "_inbox/widget-exports-doc.md");
    expect(result.action).toBe("filed-doc");

    const doc = await vault.readNote("docs/widget-exports.md");
    const prd = await vault.readNote("prd/widget-exports.md");
    expect(doc.frontmatter.related).toContain("[[prd/widget-exports]]");
    expect(prd.frontmatter.related).toContain("[[docs/widget-exports]]");
  });

  it("files an image into design/ with a linkable sidecar note", async () => {
    await fs.writeFile(vault.abs("_inbox/form.png"), Buffer.from([137, 80, 78, 71]));
    const result = await organizeInboxFile(vault, "_inbox/form.png");
    expect(result.action).toBe("filed-design");
    expect(await vault.exists("design/form.png")).toBe(true);
    const sidecar = await vault.readNote("design/form.md");
    expect(sidecar.body).toContain("![[form.png]]");
  });
});
