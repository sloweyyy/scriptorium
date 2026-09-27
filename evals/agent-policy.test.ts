import { describe, expect, it } from "vitest";
import { teammateConfig, WRITE_TOOLS } from "@scriptorium/agents";
import { envelopeOf } from "@scriptorium/runtime";

/**
 * The agent-policy scanner: a committed, reviewable statement of what every agent may do,
 * checked on every push. A write tool that slips onto the `allow` tier — a one-word config
 * change — would let the model write with no human in the loop; this is the red build that
 * stops it.
 */

const WRITES = [...WRITE_TOOLS].filter((tool) => tool !== "slack_reply");

describe("agent policy", () => {
  const teammate = envelopeOf(teammateConfig({ selfAccountIds: ["slack:UBOT"], approvers: ["slack:UPM"] }));

  it("every write the Teammate can make is approve-tier, never allow", () => {
    for (const tool of WRITES) {
      const rule = teammate.tools[tool];
      if (rule) expect(rule.tier, `${tool} must need a human`).toBe("approve");
    }
  });

  it("every approve-tier tool names who may approve (from config), and none is open to anyone by default", () => {
    for (const [tool, rule] of Object.entries(teammate.tools)) {
      if (rule.tier !== "approve") continue;
      expect(rule.approvers, tool).toEqual(["slack:UPM"]);
      expect(rule.approvers, tool).not.toContain("*");
    }
  });

  it("the Teammate's inventory is exactly what this test says — a change here is a reviewed change", () => {
    const inventory = Object.fromEntries(Object.entries(teammate.tools).map(([tool, rule]) => [tool, rule.tier]));
    expect(inventory).toEqual({
      vault_overview: "allow",
      search_vault: "allow",
      read_note: "allow",
      confluence_search: "allow",
      confluence_read_page: "allow",
      jira_search: "allow",
      jira_recent: "allow",
      jira_get_issue: "allow",
      slack_read_thread: "allow",
      github_get_pull: "allow",
      jira_comment: "approve",
      jira_create_issue: "approve",
      confluence_create_page: "approve",
      confluence_update_page: "approve",
      github_pr_comment: "approve",
      memory_save: "approve",
    });
  });
});
