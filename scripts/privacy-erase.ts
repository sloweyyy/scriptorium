/**
 * `pnpm privacy:erase <person> --by <operator> [--dry-run]` — remove one person from what this
 * deployment keeps, on request: audit lines about them, memories about them, their pending
 * requests, and delegations to or from them. `<person>` is a Slack user id, or `jira:<id>` /
 * `github:<login>`; everything linked to it in TEAMMATE_PEOPLE goes too.
 *
 * Run it with the service stopped: the audit log is rewritten in place, and a concurrent
 * append makes it stop without writing. Always run --dry-run first; the plan it prints is
 * what will happen. Who approved a write is kept, and what it can't reach is listed.
 */
import { Vault, loadConfig, verifyAudit } from "@scriptorium/core";
import { eraseSubject, formatErasure } from "@scriptorium/agents";
import fs from "node:fs/promises";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const byIndex = args.indexOf("--by");
const by = byIndex >= 0 ? args[byIndex + 1] : undefined;
const subject = args.find((arg, index) => !arg.startsWith("--") && index !== byIndex + 1);
if (!subject || !by) {
  console.error("usage: pnpm privacy:erase <person> --by <operator> [--dry-run]");
  process.exit(2);
}

const config = loadConfig();
const plan = await eraseSubject(config, new Vault(config.vaultDir), subject, { by, dryRun });
console.log(formatErasure(plan, dryRun));
if (!dryRun) {
  const verdict = verifyAudit(await fs.readFile(config.auditFile, "utf8").catch(() => ""));
  console.log(verdict.ok ? `\n✓ audit chain holds (${verdict.redacted} erased line(s) in all).` : `\n✗ audit chain broken at line ${verdict.line}: ${verdict.reason}`);
  if (!verdict.ok) process.exitCode = 1;
}
