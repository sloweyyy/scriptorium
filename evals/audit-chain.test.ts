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
    expect(verdict).toEqual({ ok: true, lines: 20, chained: 20 });
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
    expect(verifyAudit(await fs.readFile(file, "utf8"))).toEqual({ ok: true, lines: 2, chained: 1 });
    await fs.appendFile(file, `${JSON.stringify({ ts: "2026-01-02", type: "sneaked in" })}\n`);
    expect(verifyAudit(await fs.readFile(file, "utf8"))).toMatchObject({ ok: false, line: 3 });
  });
});
