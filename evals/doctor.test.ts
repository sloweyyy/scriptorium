import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "@scriptorium/core";
import { formatChecks, manifestBotScopes, runDoctor } from "@scriptorium/agents";

/** `pnpm doctor`: each misconfiguration a deployment's safety depends on is named, with its fix. */

function config(overrides: { teammate?: Partial<AppConfig["teammate"]>; docsRepo?: Partial<AppConfig["docsRepo"]>; top?: Partial<AppConfig> } = {}): AppConfig {
  return {
    hasModelAccess: true,
    provider: "anthropic",
    model: "claude-opus-5",
    repoRoot: "/srv/app",
    auditFile: "/state/audit/log.jsonl",
    signingKey: "k",
    jira: { stateDir: "/state", baseUrl: "https://x.atlassian.net", email: "s@x", apiToken: "t", projectKey: "DOC" },
    docsRepo: { base: "main", internalBranch: "vault-live", workDir: "/tmp/docs-repo", commitName: "a", commitEmail: "a@x", ...overrides.docsRepo },
    teammate: { botToken: "xoxb", channels: ["C1"], approvers: ["UPM"], admins: ["UADMIN"], people: [["slack:UPM", "jira:acc-1"]], jiraProjects: [], confluenceSpaces: [], githubRepos: [], allowDms: false, digestWeekday: 1, digestHour: 9, dailyTokens: 1_000_000, ...overrides.teammate },
    ...overrides.top,
  } as unknown as AppConfig;
}

const slack = (scopes: string[], members: string[] = ["C1"]) => ({
  slackIdentity: async () => ({ userId: "UBOT", scopes }),
  slackIsMember: async (channel: string) => members.includes(channel),
  manifestScopes: async () => ["app_mentions:read", "chat:write", "commands"],
});

const levels = (checks: Awaited<ReturnType<typeof runDoctor>>, area: string) => checks.filter((check) => check.area === area).map((check) => check.level);

describe("pnpm doctor", () => {
  it("a well-set-up deployment has nothing to fix", async () => {
    const checks = await runDoctor(config(), slack(["app_mentions:read", "chat:write", "commands"]));
    expect(checks.filter((check) => check.level === "fail")).toEqual([]);
    expect(checks.filter((check) => check.level === "warn")).toEqual([]);
  });

  it("names a missing scope, a channel it isn't in, and each fix", async () => {
    const checks = await runDoctor(config({ teammate: { channels: ["C1", "C2"] } }), slack(["app_mentions:read", "chat:write"]));
    const text = formatChecks(checks);
    expect(text).toMatch(/✗ slack\s+the app is missing scope\(s\) commands/);
    expect(text).toContain("reinstall the app from slack-manifests/teammate.yaml");
    expect(text).toMatch(/✗ slack\s+not a member of C2/);
    expect(text).toContain("/invite @Teammate in C2");
  });

  it("warns about unsigned approvals, an ephemeral audit log, and nobody who can approve or pause", async () => {
    const checks = await runDoctor(
      config({ top: { signingKey: undefined, auditFile: "/srv/app/audit/log.jsonl" }, teammate: { approvers: [], admins: [] } }),
      slack(["app_mentions:read", "chat:write", "commands"]),
    );
    expect(levels(checks, "signing")).toEqual(["warn"]);
    expect(levels(checks, "audit")).toEqual(["warn"]);
    expect(checks.find((check) => check.area === "audit")?.fix).toBe("set AUDIT_FILE=/state/audit/log.jsonl");
    expect(levels(checks, "approvals")).toEqual(["warn"]);
    expect(levels(checks, "controls")).toEqual(["warn"]);
  });

  it("fails a vault repo that is the docs repo, and warns when there is none", async () => {
    const same = await runDoctor(config({ docsRepo: { url: "git@github.com:o/docs.git", vaultUrl: "https://github.com/O/docs" } }), {});
    expect(levels(same, "publishing")).toEqual(["fail"]);
    const none = await runDoctor(config({ docsRepo: { url: "git@github.com:o/docs.git" } }), {});
    expect(levels(none, "publishing")).toEqual(["warn"]);
    const sharedKey = await runDoctor(config({ docsRepo: { url: "git@github.com:o/docs.git", vaultUrl: "git@github.com:o/vault.git", sshKey: "/keys/k", vaultSshKey: "/keys/k" } }), {});
    expect(levels(sharedKey, "publishing")).toEqual(["ok", "fail"]);
  });

  it("checks each Confluence space and GitHub repo it is told to use", async () => {
    const checks = await runDoctor(config({ teammate: { confluenceSpaces: ["BEACON", "HR"], githubRepos: ["o/app"] } }), {
      ...slack(["app_mentions:read", "chat:write", "commands"]),
      confluenceCanRead: async (space) => space === "BEACON",
      githubCanAccess: async () => false,
    });
    expect(levels(checks, "confluence")).toEqual(["ok", "fail"]);
    expect(levels(checks, "github")).toEqual(["fail"]);
  });

  it("reads the manifest's bot scopes", async () => {
    const scopes = await manifestBotScopes(path.resolve("slack-manifests/teammate.yaml"));
    expect(scopes).toEqual(expect.arrayContaining(["app_mentions:read", "chat:write", "commands", "channels:history", "im:read"]));
  });
});
