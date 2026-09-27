import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OPEN, applyAdminCommand, narrowTools, readControl, writeControl } from "@scriptorium/agents";

/** Runtime controls: narrow only, and a control file that fails means paused. */

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-control-"));
});
afterEach(async () => fs.rm(dir, { recursive: true, force: true }));

describe("runtime controls", () => {
  it("never set is open; unreadable, corrupt or forged is paused", async () => {
    const file = path.join(dir, "control.json");
    expect(await readControl(file, "k")).toEqual(OPEN);
    await fs.writeFile(file, "{ not json");
    expect((await readControl(file, "k")).paused).toBe(true);
    await writeControl(file, { ...OPEN, denyTools: ["jira_comment"] }, "k");
    expect((await readControl(file, "k")).denyTools).toEqual(["jira_comment"]);
    // Someone edits the file to switch the tool back on without the key: paused, not "on".
    const edited = JSON.parse(await fs.readFile(file, "utf8"));
    await fs.writeFile(file, JSON.stringify({ ...edited, denyTools: [] }));
    expect(await readControl(file, "k")).toMatchObject({ paused: true, reason: "the control file's signature does not match" });
  });

  it("narrows only: denied tools go, read-only drops every write, nothing is added", () => {
    const tools = { search_vault: "allow", jira_comment: { tier: "approve" }, memory_save: { tier: "approve" } } as const;
    expect(Object.keys(narrowTools(tools, { ...OPEN, denyTools: ["jira_comment", "not_a_tool"] }))).toEqual(["search_vault", "memory_save"]);
    expect(Object.keys(narrowTools(tools, { ...OPEN, readOnly: true }))).toEqual(["search_vault"]);
  });

  it("admin commands: pause with a reason, deny only known tools, status says what's on", () => {
    const now = new Date("2026-09-27T12:00:00Z");
    const paused = applyAdminCommand(OPEN, " pause bad answers in #eng", "slack:UADMIN", now, ["jira_comment"]);
    expect("control" in paused && paused.control).toMatchObject({ paused: true, reason: "bad answers in #eng", by: "slack:UADMIN" });
    expect(applyAdminCommand(OPEN, "deny delete_everything", "slack:UADMIN", now, ["jira_comment"])).not.toHaveProperty("control");
    expect(applyAdminCommand({ ...OPEN, denyTools: ["jira_comment"] }, "status", "slack:UADMIN", now, []).message).toContain("off: jira_comment");
  });
});
