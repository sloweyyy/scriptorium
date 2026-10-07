import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { appendAuditLine, eraseFromAudit, withAuditLock, type AppConfig, type Vault } from "@scriptorium/core";
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
  /** Requests whose arguments or card text named them: emptied, the approver record kept. */
  requestsScrubbed: number;
  /** Reminders they asked for, or whose text names them: cancelled if not yet sent, text removed. */
  reminders: number;
  /** Doc-ticket feedback held for the next lesson that they wrote or that names them: dropped. */
  feedback: number;
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

  const pattern = new RegExp(`(^|[^A-Za-z0-9_-])(${ids.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})($|[^A-Za-z0-9_-])`, "i");
  const names = (value: unknown): boolean => pattern.test(typeof value === "string" ? value : JSON.stringify(value ?? ""));

  // Their requests: pending ones cancelled, the requester replaced on all of them. Requests
  // that name them in their arguments or card (a memory saved about them, a reminder with
  // their words) are emptied too: the pseudonym alone left their text in approvals.json.
  const store = new FileApprovalStore(path.join(config.jira.stateDir, "approvals.json"));
  const all = await store.all();
  const theirs = all.filter((request) => matches(request.requestedBy));
  const scrubbed = all.filter((request) => names(request.args) || names(request.summary) || theirs.includes(request));
  // Not yet carried out: cancelled, approved or not. An approved request of theirs would
  // still run their words after the erasure.
  const pendingCancelled = theirs.filter((request) => request.status === "pending" || request.status === "approved").map((request) => request.id);

  // Reminders: one they asked for has their request's id; one that names them, in its text.
  const remindersFile = path.join(config.jira.stateDir, "reminders.json");
  const reminderRecords = await readJson<Record<string, { status?: string; meta?: { id?: string; text?: string } }>>(remindersFile);
  const requestIds = new Set(theirs.map((request) => request.id));
  const reminderOps = Object.entries(reminderRecords ?? {})
    .filter(([, record]) => (record.meta?.id && requestIds.has(record.meta.id)) || names(record.meta?.text))
    .map(([op]) => op);

  // Doc-ticket feedback waiting to be distilled into a lesson: what they wrote, and what names them.
  const jiraStateFile = path.join(config.jira.stateDir, "jira-state.json");
  const jiraState = await readJson<{ issues?: Record<string, { feedback?: string[]; feedbackAuthors?: Array<string | null> }> }>(jiraStateFile);
  const theirFeedback = (issue: { feedback?: string[]; feedbackAuthors?: Array<string | null> }, index: number) =>
    names(issue.feedback?.[index]) || matches(issue.feedbackAuthors?.[index] ?? undefined);
  const feedback = Object.values(jiraState?.issues ?? {}).reduce((count, issue) => count + (issue.feedback ?? []).filter((_, index) => theirFeedback(issue, index)).length, 0);

  // Delegations to or from them end. The control file is signed, so it is rewritten through writeControl.
  const controlFile = path.join(config.jira.stateDir, "control.json");
  const control = await readControl(controlFile, config.signingKey);
  const keptDelegations = (control.delegations ?? []).filter((entry) => !matches(entry.from) && !matches(entry.to));
  const delegations = (control.delegations ?? []).length - keptDelegations.length;

  // Everything else in the vault that names them: reported, not edited (published docs and house rules are reviewed work).
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
    requestsScrubbed: scrubbed.length,
    reminders: reminderOps.length,
    feedback,
    delegations,
    mentions,
    outside: OUTSIDE,
  };
  if (options.dryRun) return plan;

  // On the record, without the person: who ran it, a hash for the subject, what it did, and
  // the digest of every tombstone it wrote. Written in the SAME rename as the tombstones: a
  // failure between the two used to leave erased lines no record accounted for, and a rerun
  // could not repair it (the lines were already tombstones, so it erased 0 and recorded 0).
  await withAuditLock(auditFile, async () => {
    const current = await fs.readFile(auditFile, "utf8").catch(() => "");
    if (current !== before) throw new Error("the audit log changed while erasing (is the service running?): nothing was written; stop it and run again");
    const record = {
      type: "privacy.erased",
      actor: "operator",
      by: options.by,
      subject: digest,
      lines: erased.redacted,
      tombstones: erased.tombstones,
      memories: memories.length,
      requests: theirs.length,
      delegations,
    };
    const tmp = `${auditFile}.${process.pid}.erase.tmp`;
    await fs.mkdir(path.dirname(auditFile), { recursive: true });
    await fs.writeFile(tmp, appendAuditLine(erased.text, record));
    await fs.rename(tmp, auditFile);
  });
  for (const relPath of memories) await vault.deleteFile(relPath);
  for (const request of scrubbed) {
    const mine = theirs.includes(request);
    await store.update(request.id, (current) => ({
      ...current,
      ...(mine ? { requestedBy: pseudonym } : {}),
      // Who decided stays (an approval record); what was asked goes. The hash still names the action.
      args: undefined,
      summary: "(erased on request)",
      ...(mine && (current.status === "pending" || current.status === "approved") ? { status: "expired" as const, expiresAt: now.toISOString() } : {}),
    }));
  }
  if (reminderRecords && reminderOps.length) {
    for (const op of reminderOps) {
      const record = reminderRecords[op]!;
      reminderRecords[op] = {
        ...record,
        ...(record.status === "in-progress" ? { status: "done", completedAt: now.toISOString(), result: "erased" } : {}),
        meta: { ...record.meta, text: "(erased on request)" },
      };
    }
    await writeJson(remindersFile, reminderRecords);
  }
  if (jiraState?.issues && feedback) {
    for (const issue of Object.values(jiraState.issues)) {
      if (!issue.feedback) continue;
      const keep = issue.feedback.map((_, index) => !theirFeedback(issue, index));
      issue.feedback = issue.feedback.filter((_, index) => keep[index]);
      if (issue.feedbackAuthors) issue.feedbackAuthors = issue.feedbackAuthors.filter((_, index) => keep[index]);
    }
    await writeJson(jiraStateFile, jiraState);
  }
  if (delegations) await writeControl(controlFile, { ...control, delegations: keptDelegations }, config.signingKey);
  return plan;
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`${path.basename(file)} is unreadable, so nothing was erased: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.erase.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2));
  await fs.rename(tmp, file);
}

export function formatErasure(plan: ErasurePlan, dryRun: boolean): string {
  const verb = dryRun ? "would" : "did";
  return [
    `${dryRun ? "(dry run) " : ""}Erasing ${plan.ids.join(", ")} (recorded as ${plan.pseudonym}):`,
    `- audit: ${verb} erase ${plan.auditLines} line(s); ${plan.approvalsKept} kept where they are only the approver of a write`,
    `- memories about them: ${verb} delete ${plan.memories.length}${plan.memories.length ? ` (${plan.memories.join(", ")})` : ""}`,
    `- their requests: ${verb} cancel ${plan.pendingCancelled.length} not yet carried out, and replace the requester on ${plan.requestsPseudonymized}`,
    `- requests naming them: ${verb} empty the arguments and card text of ${plan.requestsScrubbed} (who approved stays)`,
    `- reminders they asked for or that name them: ${verb} cancel or empty ${plan.reminders}`,
    `- doc-ticket feedback waiting for a lesson that they wrote or that names them: ${verb} drop ${plan.feedback}`,
    `- delegations to or from them: ${verb} end ${plan.delegations}`,
    ...(plan.mentions.length ? [`- review by hand, not changed: ${plan.mentions.join(", ")}`] : []),
    "",
    "Kept on purpose: who approved a write (the approver record separation of duties depends on).",
    "Not reachable from here:",
    ...plan.outside.map((line) => `- ${line}`),
  ].join("\n");
}
