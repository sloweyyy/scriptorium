import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { audit, eraseFromAudit, type AppConfig, type Vault } from "@scriptorium/core";
import { FileApprovalStore } from "@scriptorium/policy";
import { MEMORY_DIR } from "@scriptorium/runtime";
import { readControl, writeControl } from "./teammate-bot/control";

/**
 * `pnpm privacy:erase`: remove one person from what the deployment keeps, on request.
 *
 * What goes: memories about them, and every audit line about them (each becomes a tombstone
 * that keeps the chain, see `eraseFromAudit`). Their pending requests are cancelled, their
 * requester id on past ones is replaced by a pseudonym, and delegations to or from them end.
 *
 * What stays, on purpose: who approved a write. Erasing an approver would let erasure undo
 * separation of duties and the approver record the project rests on. What it can't reach is
 * listed in `outside`: Slack's, Jira's and Confluence's own copies, git history, and audit
 * extracts exported earlier.
 */
export interface ErasurePlan {
  /** Every id the person has, as given and as linked in TEAMMATE_PEOPLE. */
  ids: string[];
  /** Stands in for them where a record must keep a requester. */
  pseudonym: string;
  auditLines: number;
  approvalsKept: number;
  memories: string[];
  pendingCancelled: string[];
  requestsPseudonymized: number;
  delegations: number;
  /** Vault notes that mention them and aren't removed by this (docs, house rules): review by hand. */
  mentions: string[];
  outside: string[];
}

const OUTSIDE = [
  "Slack, Jira and Confluence keep their own copies of messages, comments and pages: remove those there.",
  "Git history (this repo's vault and the vault repo) still holds deleted memories and earlier text.",
  "Audit extracts exported before now (pnpm auditlog export) still hold the erased lines.",
];

/** `slack:U1`, `U1`, `jira:abc`, `github:dev` → bare ids, with everything linked to them in TEAMMATE_PEOPLE. */
export function subjectIds(subject: string, people: readonly (readonly string[])[] = []): string[] {
  const qualified = subject.includes(":") ? subject : `slack:${subject}`;
  const group = people.find((linked) => linked.some((id) => id.toLowerCase() === qualified.toLowerCase())) ?? [qualified];
  return [...new Set([qualified, ...group].map((id) => id.slice(id.indexOf(":") + 1)).filter(Boolean))].sort();
}

export async function eraseSubject(
  config: AppConfig,
  vault: Vault,
  subject: string,
  options: { by: string; dryRun?: boolean; now?: Date },
): Promise<ErasurePlan> {
  const ids = subjectIds(subject, config.teammate.people);
  const digest = createHash("sha256").update(ids.join("\n")).digest("hex").slice(0, 12);
  const pseudonym = `erased:${digest}`;
  const now = options.now ?? new Date();
  const matches = (value: string | undefined) => Boolean(value && ids.some((id) => value.toLowerCase() === id.toLowerCase() || value.toLowerCase().endsWith(`:${id.toLowerCase()}`)));

  // The audit log: tombstones in place. Written whole, and only if nothing was appended meanwhile.
  const auditFile = path.resolve(config.auditFile);
  const before = await fs.readFile(auditFile, "utf8").catch(() => "");
  const erased = eraseFromAudit(before, ids);

  // Memories about them. A memory they only approved is an approval record, and stays.
  const memories: string[] = [];
  for (const relPath of await vault.listNotes(MEMORY_DIR).catch(() => [] as string[])) {
    const scope = (await vault.readNote(relPath)).frontmatter.scope;
    if (typeof scope === "string" && scope.startsWith("person:") && matches(scope.slice("person:".length))) memories.push(relPath);
  }

  // Their requests: pending ones cancelled, the requester replaced on all of them.
  const store = new FileApprovalStore(path.join(config.jira.stateDir, "approvals.json"));
  const theirs = (await store.all()).filter((request) => matches(request.requestedBy));
  const pendingCancelled = theirs.filter((request) => request.status === "pending").map((request) => request.id);

  // Delegations to or from them end. The control file is signed, so it is rewritten through writeControl.
  const controlFile = path.join(config.jira.stateDir, "control.json");
  const control = await readControl(controlFile, config.signingKey);
  const keptDelegations = (control.delegations ?? []).filter((entry) => !matches(entry.from) && !matches(entry.to));
  const delegations = (control.delegations ?? []).length - keptDelegations.length;

  // Everything else in the vault that names them: reported, not edited (published docs and house rules are reviewed work).
  const pattern = new RegExp(`(^|[^A-Za-z0-9_-])(${ids.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})($|[^A-Za-z0-9_-])`, "i");
  const mentions: string[] = [];
  for (const relPath of await vault.listNotes().catch(() => [] as string[])) {
    if (memories.includes(relPath)) continue;
    const raw = await fs.readFile(vault.abs(relPath), "utf8").catch(() => "");
    if (pattern.test(raw)) mentions.push(relPath);
  }

  const plan: ErasurePlan = {
    ids,
    pseudonym,
    auditLines: erased.redacted,
    approvalsKept: erased.approvals,
    memories,
    pendingCancelled,
    requestsPseudonymized: theirs.length,
    delegations,
    mentions,
    outside: OUTSIDE,
  };
  if (options.dryRun) return plan;

  if (erased.redacted) {
    const current = await fs.readFile(auditFile, "utf8").catch(() => "");
    if (current !== before) throw new Error("the audit log changed while erasing (is the service running?): nothing was written; stop it and run again");
    const tmp = `${auditFile}.${process.pid}.erase.tmp`;
    await fs.writeFile(tmp, erased.text);
    await fs.rename(tmp, auditFile);
  }
  for (const relPath of memories) await vault.deleteFile(relPath);
  for (const request of theirs) {
    await store.update(request.id, (current) => ({
      ...current,
      requestedBy: pseudonym,
      ...(current.status === "pending" ? { status: "expired" as const, expiresAt: now.toISOString() } : {}),
    }));
  }
  if (delegations) await writeControl(controlFile, { ...control, delegations: keptDelegations }, config.signingKey);
  // On the record, without the person: who ran it, a hash for the subject, and what it did.
  // `lines` is what verifyAudit accounts erased lines against.
  await audit(config.auditFile, {
    type: "privacy.erased",
    actor: "operator",
    by: options.by,
    subject: digest,
    lines: erased.redacted,
    memories: memories.length,
    requests: theirs.length,
    delegations,
  });
  return plan;
}

export function formatErasure(plan: ErasurePlan, dryRun: boolean): string {
  const verb = dryRun ? "would" : "did";
  return [
    `${dryRun ? "(dry run) " : ""}Erasing ${plan.ids.join(", ")} (recorded as ${plan.pseudonym}):`,
    `- audit: ${verb} erase ${plan.auditLines} line(s); ${plan.approvalsKept} kept where they are only the approver of a write`,
    `- memories about them: ${verb} delete ${plan.memories.length}${plan.memories.length ? ` (${plan.memories.join(", ")})` : ""}`,
    `- their requests: ${verb} cancel ${plan.pendingCancelled.length} pending, and replace the requester on ${plan.requestsPseudonymized}`,
    `- delegations to or from them: ${verb} end ${plan.delegations}`,
    ...(plan.mentions.length ? [`- review by hand, not changed: ${plan.mentions.join(", ")}`] : []),
    "",
    "Kept on purpose: who approved a write (the approver record separation of duties depends on).",
    "Not reachable from here:",
    ...plan.outside.map((line) => `- ${line}`),
  ].join("\n");
}
