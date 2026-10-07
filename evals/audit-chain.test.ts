import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { audit, verifyAudit } from "@scriptorium/core";

/** The audit log is hash-chained: an edited, removed or reordered line is found. */

let file: string;
beforeEach(async () => {
  file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-audit-")), "audit.jsonl");
});
afterEach(async () => fs.rm(path.dirname(file), { recursive: true, force: true, maxRetries: 5 }));

describe("the audit chain", () => {
  it("holds across writes, including concurrent ones", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => audit(file, { type: "t", i })));
    const verdict = verifyAudit(await fs.readFile(file, "utf8"));
    expect(verdict).toEqual({ ok: true, lines: 20, chained: 20, redacted: 0 });
  });

  it("finds an edited line, a removed one, and a forged prev", async () => {
    for (const i of [1, 2, 3]) await audit(file, { type: "policy.ran", i, approvedBy: "slack:UPM" });
    const lines = (await fs.readFile(file, "utf8")).trim().split("\n");
    const edited = [lines[0], lines[1]!.replace("slack:UPM", "slack:UEVIL"), lines[2]].join("\n");
    expect(verifyAudit(edited)).toMatchObject({ ok: false, line: 3 });
    expect(verifyAudit([lines[0], lines[2]].join("\n"))).toMatchObject({ ok: false, line: 2 });
    // An event can't choose its own place in the chain.
    await audit(file, { type: "t", prev: "0".repeat(64) });
    expect(verifyAudit(await fs.readFile(file, "utf8")).ok).toBe(true);
  });

  it("accepts lines from before the chain only as a prefix", async () => {
    await fs.writeFile(file, `${JSON.stringify({ ts: "2026-01-01", type: "legacy" })}\n`);
    await audit(file, { type: "t" });
    expect(verifyAudit(await fs.readFile(file, "utf8"))).toEqual({ ok: true, lines: 2, chained: 1, redacted: 0 });
    await fs.appendFile(file, `${JSON.stringify({ ts: "2026-01-02", type: "sneaked in" })}\n`);
    expect(verifyAudit(await fs.readFile(file, "utf8"))).toMatchObject({ ok: false, line: 3 });
  });
});

describe("the audit chain at its edges", () => {
  it("a line longer than any read window still chains: the next line follows all of it", async () => {
    // One revision's feedback batch, in a script that takes 3 bytes a character.
    await audit(file, { type: "jira.draft.revised", feedback: ["タイムゾーン".repeat(10_000), "もっと短く".repeat(10_000)] });
    await audit(file, { type: "after" });
    await audit(file, { type: "and after" });
    expect(verifyAudit(await fs.readFile(file, "utf8"))).toMatchObject({ ok: true, lines: 3 });
  });

  it("an extract verifies on its own from the anchor it was exported with, and not without it", async () => {
    const { auditLineHash } = await import("@scriptorium/core");
    for (const i of [1, 2, 3, 4, 5]) await audit(file, { type: "t", i });
    const lines = (await fs.readFile(file, "utf8")).trim().split("\n");
    const extract = lines.slice(2).join("\n");
    expect(verifyAudit(extract, { anchor: auditLineHash(lines[1]!) })).toMatchObject({ ok: true, lines: 3 });
    expect(verifyAudit(extract).ok).toBe(false);
    expect(verifyAudit(extract, { anchor: auditLineHash(lines[0]!) }).ok).toBe(false);
  });

  it("export refuses a log that doesn't verify, and signs with a key that isn't the signing key", async () => {
    const { auditExportKey } = await import("@scriptorium/core");
    expect(auditExportKey("k")).toMatch(/^[0-9a-f]{64}$/);
    expect(auditExportKey("k")).not.toBe("k");
    expect(auditExportKey(undefined)).toBeUndefined();
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    for (const i of [1, 2]) await audit(file, { type: "t", i });
    const broken = (await fs.readFile(file, "utf8")).replace('"i":1', '"i":9');
    await fs.writeFile(file, broken);
    const run = promisify(execFile)("npx", ["tsx", "scripts/audit.ts", "export", file], { env: { ...process.env, SCRIPTORIUM_SIGNING_KEY: "" } });
    await expect(run).rejects.toMatchObject({ stderr: expect.stringContaining("Not exporting") });
  });
});
