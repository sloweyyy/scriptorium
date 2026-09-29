import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "@scriptorium/core";

/**
 * Settings fail closed. A setting that is set but unreadable stops the process at start,
 * instead of meaning "no limit" or "the default"; an empty list means empty, not "inherit".
 */
const saved = new Map<string, string | undefined>();
function setEnv(values: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(values)) {
    if (!saved.has(name)) saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
});

describe("settings fail closed", () => {
  it("a token cap that is not a number refuses to start, instead of meaning no cap", () => {
    setEnv({ TEAMMATE_DAILY_TOKENS: "50k" });
    expect(() => loadConfig()).toThrow(/TEAMMATE_DAILY_TOKENS/);
    setEnv({ TEAMMATE_DAILY_TOKENS: undefined, TEAMMATE_DAILY_TOKENS_TOTAL: "-1" });
    expect(() => loadConfig()).toThrow(/TEAMMATE_DAILY_TOKENS_TOTAL/);
    setEnv({ TEAMMATE_DAILY_TOKENS: "50000", TEAMMATE_DAILY_TOKENS_TOTAL: undefined });
    expect(loadConfig().teammate.dailyTokens).toBe(50_000);
    setEnv({ TEAMMATE_DAILY_TOKENS: undefined });
    expect(loadConfig().teammate.dailyTokens).toBeUndefined();
  });

  it("a documented 0 means 0: never nudge, Sunday, midnight", () => {
    setEnv({ TEAMMATE_APPROVAL_NUDGE_HOURS: "0", TEAMMATE_DIGEST_WEEKDAY: "0", TEAMMATE_DIGEST_HOUR: "0" });
    const { teammate } = loadConfig();
    expect(teammate.approvalNudgeHours).toBe(0);
    expect(teammate.digestWeekday).toBe(0);
    expect(teammate.digestHour).toBe(0);
    setEnv({ TEAMMATE_DIGEST_HOUR: "24" });
    expect(() => loadConfig()).toThrow(/TEAMMATE_DIGEST_HOUR/);
  });

  it("an empty Scribe space list is empty, not the Teammate's spaces", () => {
    setEnv({ TEAMMATE_CONFLUENCE_SPACES: "ENG,OPS", SCRIBE_CONFLUENCE_SPACES: "" });
    expect(loadConfig().jira.prdSpaces).toEqual([]);
    setEnv({ SCRIBE_CONFLUENCE_SPACES: undefined });
    expect(loadConfig().jira.prdSpaces).toEqual(["ENG", "OPS"]);
  });

  it("a vault repo that is the docs repo is refused, whatever the URL form", () => {
    setEnv({ DOCS_REPO_URL: "git@github.com:acme/docs.git", VAULT_REPO_URL: "https://github.com/Acme/docs" });
    expect(() => loadConfig()).toThrow(/VAULT_REPO_URL/);
    setEnv({ VAULT_REPO_URL: "git@github.com:acme/vault.git" });
    expect(loadConfig().docsRepo.vaultSlug).toBe("acme/vault");
  });
});
