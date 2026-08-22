import { loadConfig, Vault } from "@scriptorium/core";
import { publishApprovedDoc } from "@scriptorium/agents";
const config = loadConfig();
const outcome = await publishApprovedDoc(config, new Vault(config.vaultDir), {
  issueKey: "DOC-1",
  issueUrl: "https://slowey.atlassian.net/browse/DOC-1",
  slug: "scheduled-maintenance-announcements",
  relPath: "docs/scheduled-maintenance-announcements.md",
  approvedBy: "Truong (smoke test)",
});
console.log(outcome.comment);
