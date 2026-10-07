import { describe, expect, it } from "vitest";
import type { AppConfig } from "@scriptorium/core";
import { curatorAdmits, curatorChannels, runDoctor } from "@scriptorium/agents";

/** Curator answers people, in its channels, and nowhere when none are listed. */
describe("where Curator answers", () => {
  it("another app's mention is never a question, wherever it comes from", () => {
    expect(curatorAdmits({ channel: "C1", bot_id: "B9" }, ["C1"])).toEqual({ ok: false });
    expect(curatorAdmits({ channel: "C1", subtype: "bot_message" }, ["C1"])).toEqual({ ok: false });
  });

  it("only its listed channels; none listed means nowhere, and it says where to ask", () => {
    expect(curatorAdmits({ channel: "C1" }, ["C1"])).toEqual({ ok: true });
    expect(curatorAdmits({ channel: "CGUEST" }, ["C1"])).toMatchObject({ ok: false, reply: expect.stringContaining("<#C1>") });
    expect(curatorAdmits({ channel: "C1" }, [])).toMatchObject({ ok: false, reply: expect.stringContaining("CURATOR_SLACK_CHANNELS") });
    expect(curatorAdmits({ channel: "C1" })).toMatchObject({ ok: false });
  });

  it("unset, it answers in the notify channel, where it announces docs and invites questions", () => {
    const base = { curator: {}, slack: { notifyChannel: "CNOTIFY" } } as unknown as AppConfig;
    expect(curatorChannels(base)).toEqual(["CNOTIFY"]);
    expect(curatorChannels({ ...base, curator: { channels: ["C1"] } } as AppConfig)).toEqual(["C1"]);
    expect(curatorChannels({ curator: {}, slack: {} } as unknown as AppConfig)).toEqual([]);
  });

  it("the doctor names a Curator with no channels and no cap", async () => {
    const config = { hasModelAccess: true, provider: "anthropic", model: "m", repoRoot: "/srv/app", auditFile: "/state/audit/log.jsonl", signingKey: "k", jira: { stateDir: "/state" }, docsRepo: {}, webhook: {}, curator: { botToken: "xoxb" }, teammate: { channels: [], approvers: [], admins: [], jiraProjects: [], confluenceSpaces: [], githubRepos: [], allowDms: false, digestWeekday: 1, digestHour: 9 } } as unknown as AppConfig;
    const warned = (await runDoctor(config, {})).filter((check) => check.level === "warn").map((check) => check.detail).join("\n");
    expect(warned).toContain("CURATOR_SLACK_CHANNELS is empty and there is no notify channel");
    expect(warned).toContain("Curator has no daily token cap");
  });
});
