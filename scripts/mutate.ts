/**
 * `pnpm mutate` — are the guardrail evals still guarding anything?
 *
 * Each mutant below sabotages ONE safety control with a one-line edit. For each, the named
 * evals must go red. A mutant that survives means the eval that was supposed to catch it no
 * longer does — the control could silently break and the build would stay green. Every
 * file is restored afterwards, even on failure.
 *
 * Deterministic, no API key, no extra dependencies. Weekly in CI (.github/workflows/mutation.yml).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

interface Mutant {
  control: string;
  file: string;
  find: string;
  replace: string;
  /** Further edits in the same file, for a control enforced in more than one place. */
  also?: Array<{ find: string; replace: string }>;
  evals: string[];
}

export const MUTANTS: Mutant[] = [
  {
    control: "YAML-only frontmatter (no ---js execution)",
    file: "packages/core/src/vault.ts",
    find: "const parsed = matter(raw, MATTER_OPTIONS);",
    replace: "const parsed = matter(raw);",
    evals: ["evals/frontmatter-safety.test.ts"],
  },
  {
    control: "an edited audit line breaks the chain",
    file: "packages/core/src/audit.ts",
    find: "    if (prev !== expected && !(chained === 0 && index === 0 && prev === \"genesis\")) {",
    replace: "    if (false) {",
    evals: ["evals/audit-chain.test.ts"],
  },
  {
    control: "vault path-escape guard",
    file: "packages/core/src/vault.ts",
    find: "if (resolved !== rootAbs && !resolved.startsWith(rootAbs + path.sep)) {",
    replace: "if (false) {",
    evals: ["evals/publish-record.test.ts"],
  },
  {
    control: "an agent never approves its own action",
    file: "packages/policy/src/policy.ts",
    find: "if (envelope.selfAccountIds.includes(approver.accountId)) {",
    replace: "if (false) {",
    evals: ["evals/policy.test.ts"],
  },
  {
    control: "an empty approver list means nobody",
    file: "packages/policy/src/policy.ts",
    find: 'if (!rule.approvers?.length) return { ok: false, reason: "no approvers are configured for this action" };',
    replace: "",
    evals: ["evals/policy.test.ts"],
  },
  {
    control: "separation of duties holds across surfaces (one person, several accounts)",
    file: "packages/policy/src/policy.ts",
    find: "return a === b || (envelope.people ?? []).some((person) => person.includes(a) && person.includes(b));",
    replace: "return a === b;",
    evals: ["evals/policy.test.ts"],
  },
  {
    control: "a plan can't include a step that needs a different approval",
    file: "packages/policy/src/plan.ts",
    find: "    if (!sameRule(envelope.tools[step.tool], rule)) return",
    replace: "    if (false) return",
    evals: ["evals/plan.test.ts"],
  },
  {
    control: "a plan's card shows every step's arguments",
    file: "packages/policy/src/guard.ts",
    find: "(tool.name === PLAN_TOOL ? summarizePlan(input) : summarizeArgs(input))",
    replace: "summarizeArgs(input)",
    evals: ["evals/plan.test.ts"],
  },
  {
    control: "a control file that doesn't verify means paused",
    file: "apps/agents/src/teammate-bot/control.ts",
    find: "return { ...OPEN, paused: true, reason: \"the control file's signature does not match\" };",
    replace: "return control;",
    evals: ["evals/control.test.ts"],
  },
  {
    control: "every model must refuse everything the vault doesn't say",
    file: "packages/curator/src/answer-grade.ts",
    find: "  const floors: AnswerScores = { ...baseline, unanswerable: { pass: 1, n: now.unanswerable?.n ?? 0 } };",
    replace: "  const floors: AnswerScores = { ...baseline };",
    evals: ["evals/answer-golden.test.ts"],
  },
  {
    control: "only a 👎 on one of its own replies is recorded as feedback",
    file: "apps/agents/src/teammate-bot.ts",
    find: " || itemUser !== selfUserId || ",
    replace: " || ",
    evals: ["evals/teammate-e2e.test.ts"],
  },
  {
    control: "/metrics is closed without its own token",
    file: "apps/agents/src/ingress.ts",
    find: "        // 404 whether metrics are off or the token is wrong, like the run viewer.\n        if (!token || !secretMatches(provided, token)) {",
    replace: "        // 404 whether metrics are off or the token is wrong, like the run viewer.\n        if (false) {",
    evals: ["evals/ingress.test.ts"],
  },
  {
    control: "an erased audit line must be accounted for by a privacy.erased record",
    file: "packages/core/src/audit.ts",
    find: "  if (redacted > accounted) return",
    replace: "  if (false) return",
    evals: ["evals/privacy-erase.test.ts"],
  },
  {
    control: "an erased audit line still has to follow the line before it",
    file: "packages/core/src/audit.ts",
    find: "    if (prev !== expected && !(chained",
    replace: "    if (!line.includes('\"redacted\":true') && prev !== expected && !(chained",
    evals: ["evals/privacy-erase.test.ts"],
  },
  {
    control: "erasing a person never erases who approved a write",
    file: "packages/core/src/audit.ts",
    find: "!ACCOUNTABILITY.has(key) && key !== \"prev\"",
    replace: "key !== \"prev\"",
    evals: ["evals/privacy-erase.test.ts"],
  },
  {
    control: "a gap's ticket is found by its label before one is filed (a lost response never files a second)",
    file: "apps/agents/src/gap-ticket.ts",
    find: "    if (found) return { key: found.key, url: client.issueUrl(found.key) };",
    replace: "    if (false) return { key: found!.key, url: \"\" };",
    evals: ["evals/gaps.test.ts"],
  },
  {
    control: "one gap filing at a time per question",
    file: "packages/curator/src/gaps.ts",
    find: "  if (!key) return fileGapNoteNow(vault, input, key);",
    replace: "  return fileGapNoteNow(vault, input, key);",
    evals: ["evals/gaps.test.ts"],
  },
  {
    control: "Scribe publishes only the draft that is on the ticket",
    file: "apps/agents/src/scribe-jira/publishing.ts",
    find: "    if (known?.postedDraftHash !== hashDraft(draft)) {",
    replace: "    if (false) {",
    evals: ["evals/jira-board.test.ts"],
  },
  {
    control: "every comment on a long ticket is read, not just the first page",
    file: "packages/jira/src/client.ts",
    find: "      startAt += page.length;\n",
    replace: "      break;\n",
    evals: ["evals/jira.test.ts"],
  },
  {
    control: "a publish's lesson proposal is owed until it happens, even if a step before it failed",
    file: "apps/agents/src/scribe-jira/publishing.ts",
    find: "  if (ctx.state.get(key)?.lessonPending) {",
    replace: "  if (!alreadyPublished) {",
    evals: ["evals/jira-board.test.ts"],
  },
  {
    control: "a status change made while a tick ran is left for the next tick to see",
    file: "apps/agents/src/scribe-jira/issue.ts",
    find: "    lastStatus: unseen ? agentsOwn : now,",
    replace: "    lastStatus: now,",
    evals: ["evals/jira-board.test.ts"],
  },
  {
    control: "a drag to Approved older than the draft on the ticket is not its approval",
    file: "apps/agents/src/scribe-jira/issue.ts",
    find: "    } else if (revisedThisTick || !approvesCurrentDraft(mover?.created, ctx.state.get(key)?.draftPostedAt)) {",
    replace: "    } else if (revisedThisTick) {",
    evals: ["evals/jira-board.test.ts"],
  },
  {
    control: "the agent's own board move never undoes a human's drag to Approved",
    file: "apps/agents/src/scribe-jira/context.ts",
    find: "    if (live?.toLowerCase() === approved && (currentStatus",
    replace: "    if (false && live?.toLowerCase() === approved && (currentStatus",
    evals: ["evals/jira-board.test.ts"],
  },
  {
    control: "a design is sent as what its bytes are, never what its name claims",
    file: "apps/agents/src/scribe-jira/source.ts",
    find: "    const actual = sniffImage(bytes);",
    replace: "    const actual = sniffImage(bytes) ?? mediaType;",
    evals: ["evals/jira-board.test.ts"],
  },
  {
    control: "an oversized PRD file is left out, not downloaded and sent whole",
    file: "apps/agents/src/scribe-jira/source.ts",
    find: "      if ((attachment.size ?? 0) > MAX_PRD_BYTES) {",
    replace: "      if (false) {",
    evals: ["evals/jira-board.test.ts"],
  },
  {
    control: "a comment with no words triggers nothing",
    file: "packages/jira/src/commands.ts",
    find: "  if (!/[\\p{L}\\p{N}]/u.test(words)) return { kind: \"ignore\", reason: \"no-words\" };",
    replace: "  if (false) return { kind: \"ignore\", reason: \"no-words\" };",
    evals: ["evals/jira.test.ts"],
  },
  {
    control: "a wall of text is not revised from",
    file: "packages/jira/src/commands.ts",
    find: "  if (text.length > MAX_FEEDBACK_CHARS) return",
    replace: "  if (false) return",
    evals: ["evals/jira.test.ts"],
  },
  {
    control: "a first draft whose comment failed is posted on the next poll",
    file: "apps/agents/src/scribe-jira/issue.ts",
    find: "  if (wanted && saved?.hasDraft && saved.draftUnposted) {",
    replace: "  if (false) {",
    evals: ["evals/jira-board.test.ts"],
  },
  {
    control: "a transient 5xx is retried for reads only, never for a write",
    file: "packages/core/src/http.ts",
    find: "(TRANSIENT.has(response.status) && READS.has((init.method ?? \"GET\").toUpperCase()))",
    replace: "TRANSIENT.has(response.status)",
    evals: ["evals/backoff.test.ts"],
  },
  {
    control: "a revise retried after its comment failed posts the revision, not a second revise",
    file: "apps/agents/src/scribe-jira/drafting.ts",
    find: "  if (known0?.revisedFrom === fromThis && known0.postedDraftHash !== hashDraft(draft)) {",
    replace: "  if (false) {",
    evals: ["evals/jira-board.test.ts"],
  },
  {
    control: "a draft is attached once, not once per retry",
    file: "apps/agents/src/scribe-jira/drafting.ts",
    find: "    if (already && already.toString(\"utf8\").trim() === markdown.trim()) return;",
    replace: "    if (false) return;",
    evals: ["evals/jira-board.test.ts"],
  },
  {
    control: "a private memory can't be read however its path is spelled (.., case, backslashes)",
    file: "packages/curator/src/search.ts",
    find: "  const normalized = normalizeVaultPath(relPath).toLowerCase();",
    replace: "  const normalized = relPath.replace(/^\\.?\\/+/, \"\");",
    evals: ["evals/memory.test.ts"],
  },
  {
    control: "a gap, inbox or memory note is never evidence, however its path is spelled",
    file: "packages/curator/src/qa-contract.ts",
    find: "    const resolved = EXTERNAL_CITATION.test(relPath) ? relPath : normalizeVaultPath(relPath);",
    replace: "    const resolved = relPath;",
    evals: ["evals/grounding.test.ts"],
  },
  {
    control: "an expired approval is never carried out",
    file: "packages/policy/src/guard.ts",
    find: "  if (!request || effectiveStatus(request) !== \"approved\") return { kind: \"not-runnable\"",
    replace: "  if (!request || request.status !== \"approved\") return { kind: \"not-runnable\"",
    evals: ["evals/policy.test.ts"],
  },
  {
    control: "carrying out an approval never files a new one",
    file: "packages/policy/src/guard.ts",
    find: "  if (deps.approvalId) {\n    await audit(deps.auditFile, { type: \"policy.approval.unspendable\"",
    replace: "  if (false) {\n    await audit(deps.auditFile, { type: \"policy.approval.unspendable\"",
    evals: ["evals/policy.test.ts"],
  },
  {
    control: "a card Slack won't update never stops a given approval from being carried out",
    file: "packages/connectors/src/slack.ts",
    find: "    }).catch((error: unknown) => {\n      console.warn(`[approvals] ${request.id}: decided, but the card could not be updated",
    replace: "    }).then(undefined, (error: unknown) => { throw error;\n      console.warn(`[approvals] ${request.id}: decided, but the card could not be updated",
    evals: ["evals/slack-connector.test.ts"],
  },
  {
    control: "paused, it sends no approval nudges",
    file: "apps/agents/src/teammate-bot.ts",
    find: "        if (!paused && nudgeMs > 0",
    replace: "        if (nudgeMs > 0",
    evals: ["evals/teammate-e2e.test.ts"],
  },
  {
    control: "a request cancelled outright has its card closed",
    file: "apps/agents/src/teammate-bot.ts",
    find: "        if (request.status === \"expired\" || Date.parse(request.expiresAt) <= now.getTime()) {",
    replace: "        if (Date.parse(request.expiresAt) <= now.getTime()) {",
    evals: ["evals/teammate-e2e.test.ts"],
  },
  {
    control: "a Slack retry after a restart is still a duplicate",
    file: "apps/agents/src/teammate-bot.ts",
    find: "  }, 5_000, new FileSeenIds(path.join(stateDir, \"seen-deliveries.json\")));",
    replace: "  }, 5_000);",
    evals: ["evals/teammate-e2e.test.ts"],
  },
  {
    control: "a delegation ends by itself",
    file: "apps/agents/src/teammate-bot/control.ts",
    find: "  const active = (control.delegations ?? []).filter((entry) => Date.parse(entry.until) > now);",
    replace: "  const active = control.delegations ?? [];",
    evals: ["evals/control.test.ts"],
  },
  {
    control: "paused, the Teammate answers and carries out nothing",
    file: "apps/agents/src/teammate-bot.ts",
    find: "        if ((await refreshControl()).paused) {\n          await audit(",
    replace: "        if (false) {\n          await audit(",
    evals: ["evals/teammate-e2e.test.ts"],
  },
  {
    control: "approvals bind to the exact arguments",
    file: "packages/policy/src/approvals.ts",
    find: "request.argsHash === hash &&\n        request.status === \"approved\" &&",
    replace: "request.status === \"approved\" &&",
    // Checked again inside the atomic update; both must go for the control to be gone.
    also: [{ find: 'live(current, now).status === "approved" && current.argsHash === hash', replace: 'live(current, now).status === "approved"' }],
    evals: ["evals/policy.test.ts"],
  },
  {
    control: "exactly-once: probe on retry",
    file: "packages/runtime/src/effects.ts",
    find: 'if (existing?.status === "in-progress" && options.probe) {',
    replace: "if (false) {",
    evals: ["evals/effects.test.ts"],
  },
  {
    control: "the model loop fails closed on truncation",
    file: "packages/runtime/src/session.ts",
    find: '    case "max_tokens":\n      throw new SessionError("truncated", "The reply was cut off at the token limit, so it is not an answer.");\n',
    replace: "",
    evals: ["evals/session.test.ts"],
  },
  {
    control: "no citation, no claim (grounding enforced on answers)",
    file: "packages/curator/src/qa.ts",
    find: "return await enforceGrounding(",
    replace: "return parseQaAnswer(text, question); await enforceGrounding(",
    evals: ["evals/grounding.test.ts"],
  },
  {
    control: "only approved lessons shape a draft",
    file: "packages/scribe/src/pipeline.ts",
    find: 'const lessons = await listLessons(vault, { status: "approved" });\n  const markdown = await generateText({\n    system: DOC_SYSTEM_PROMPT,\n    prompt: buildDraftPrompt(',
    replace: "const lessons = await listLessons(vault);\n  const markdown = await generateText({\n    system: DOC_SYSTEM_PROMPT,\n    prompt: buildDraftPrompt(",
    evals: ["evals/lesson-gate.test.ts"],
  },
  {
    control: "a quoted `approve` is not an approval",
    file: "packages/jira/src/commands.ts",
    find: "const head = commandHead(plainText(withoutQuotedBlocks(body)));",
    replace: "const head = commandHead(text);",
    evals: ["evals/jira.test.ts"],
  },
  {
    control: "another agent's move or comment never approves a Scribe publish",
    file: "apps/agents/src/scribe-jira/context.ts",
    find: "  if (otherAgentIds.includes(accountId)) return",
    replace: "  if (false) return",
    evals: ["evals/jira.test.ts"],
  },
  {
    control: "Confluence reads are space-allow-listed",
    file: "packages/connectors/src/confluence.ts",
    find: "    if (!space) throw new ConfluenceAccessError(",
    replace: "    if (false) throw new ConfluenceAccessError(",
    evals: ["evals/confluence-connector.test.ts"],
  },
  {
    control: "a Confluence page tree lists only children in allowed spaces",
    file: "packages/connectors/src/confluence.ts",
    find: "      .filter((child) => allowed.has(child.spaceId ?? parent.spaceId))\n",
    replace: "",
    evals: ["evals/confluence-connector.test.ts"],
  },
  {
    control: "a Confluence attachment is read only from a page in an allowed space",
    file: "packages/connectors/src/confluence.ts",
    find: "    if (!allowed.has(page.spaceId)) throw new ConfluenceAccessError(",
    replace: "    if (false) throw new ConfluenceAccessError(",
    evals: ["evals/confluence-connector.test.ts"],
  },
  {
    control: "you can forget only your own memories (the rest need an admin)",
    file: "packages/runtime/src/memory.ts",
    find: "  if (!own && !who.mayCurate) return",
    replace: "  if (false) return",
    evals: ["evals/teammate-e2e.test.ts"],
  },
  {
    control: "memories are invisible to retrieval",
    file: "packages/curator/src/search.ts",
    find: "    if (isPrivateNote(relPath)) continue;",
    replace: "",
    evals: ["evals/memory.test.ts"],
  },
  {
    control: "a tool's refusal is never citation evidence",
    file: "packages/curator/src/qa-contract.ts",
    find: "evidence.retrieved.some((result) => !REFUSAL.test(result) && mentions(result, relPath))",
    replace: "evidence.retrieved.some((result) => mentions(result, relPath))",
    evals: ["evals/grounding.test.ts"],
  },
  {
    control: "approval cards escape Slack markup",
    file: "packages/connectors/src/slack.ts",
    find: 'return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");',
    replace: "return text;",
    evals: ["evals/slack-connector.test.ts"],
  },
  {
    control: "slack_read_thread reads only the turn's own thread",
    file: "apps/agents/src/teammate.ts",
    find: "if (channel !== turn.channel || thread_ts !== turn.threadTs) return",
    replace: "if (false) return",
    evals: ["evals/teammate-bot.test.ts"],
  },
  {
    control: "a reminder is set only in the channel that asked",
    file: "apps/agents/src/teammate.ts",
    find: "if ((input as { channel?: unknown } | undefined)?.channel !== turn.channel) return \"NOT_ALLOWED: reminders",
    replace: "if (false) return \"NOT_ALLOWED: reminders",
    evals: ["evals/teammate-e2e.test.ts"],
  },
  {
    control: "a plan's steps are held to the per-turn bounds",
    file: "apps/agents/src/teammate.ts",
    find: "          if (refusal) return `${refusal.replace(",
    replace: "          if (false) return `${refusal.replace(",
    evals: ["evals/teammate-bot.test.ts"],
  },
  {
    control: "slack_read_channel reads only the turn's own channel",
    file: "apps/agents/src/teammate.ts",
    find: "if ((input as { channel?: unknown } | undefined)?.channel !== turn.channel) return \"NOT_ALLOWED: you may read only the channel",
    replace: "if (false) return \"NOT_ALLOWED: you may read only the channel",
    evals: ["evals/teammate-bot.test.ts"],
  },
  {
    control: "the Teammate writes to Atlassian only as itself",
    file: "apps/agents/src/teammate-bot/tools.ts",
    find: "tools.push(...(ownIdentity ? atlassian : atlassian.filter((tool) => !ATLASSIAN_WRITES.has(tool.name))));",
    replace: "tools.push(...atlassian);",
    evals: ["evals/teammate-bot.test.ts"],
  },
  {
    control: "the Teammate answers on Jira only when it is mentioned",
    file: "apps/agents/src/teammate-bot.ts",
    find: "if (!jira || !mentionsAccount(body, jira.accountId) || authorId === jira.accountId) return;",
    replace: "if (!jira || authorId === jira.accountId) return;",
    evals: ["evals/teammate-e2e.test.ts"],
  },
  {
    control: "a reply to a restricted Jira comment keeps its restriction",
    file: "apps/agents/src/teammate-bot.ts",
    find: "(await jira.client.addComment(issueKey, body, { op, restriction })).id",
    replace: "(await jira.client.addComment(issueKey, body, { op })).id",
    evals: ["evals/teammate-e2e.test.ts"],
  },
  {
    control: "every Teammate write is approve-tier",
    file: "apps/agents/src/agents/teammate.ts",
    find: "      jira_create_issue: write,",
    replace: '      jira_create_issue: "allow",',
    evals: ["evals/agent-policy.test.ts"],
  },
];

function run(evals: string[]): boolean {
  try {
    execFileSync("npx", ["vitest", "run", ...evals], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // A mutated file must never outlive the run: Ctrl-C or a CI cancel kills the process in
  // the middle of an eval, where `finally` does not run. Restore on the signal instead.
  let active: { file: string; original: string } | undefined;
  const restore = () => {
    if (active) fs.writeFileSync(active.file, active.original);
    active = undefined;
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      restore();
      process.exit(130);
    });
  }
  process.on("exit", restore);

  // Every eval set must be green BEFORE mutation, or "the mutant made it red" means nothing.
  const sets = [...new Set(MUTANTS.map((mutant) => mutant.evals.join(" ")))];
  const red = sets.filter((set) => !run(set.split(" ")));
  if (red.length) {
    console.error(`baseline is red — fix these before mutating:\n${red.map((set) => `  - ${set}`).join("\n")}`);
    process.exit(1);
  }

  const survivors: string[] = [];
  for (const mutant of MUTANTS) {
    const original = fs.readFileSync(mutant.file, "utf8");
    const edits = [{ find: mutant.find, replace: mutant.replace }, ...(mutant.also ?? [])];
    // A find string that matches twice mutates whichever comes first — maybe not the control.
    if (edits.some((edit) => original.split(edit.find).length !== 2)) {
      survivors.push(`${mutant.control} — find string is missing or not unique in ${mutant.file}; update scripts/mutate.ts`);
      continue;
    }
    if (edits.some((edit) => !original.includes(edit.find))) {
      // The guarded line moved: the catalogue is stale, which is itself a failure.
      survivors.push(`${mutant.control} — mutant no longer applies (${mutant.file}); update scripts/mutate.ts`);
      continue;
    }
    try {
      active = { file: mutant.file, original };
      fs.writeFileSync(mutant.file, edits.reduce((text, edit) => text.replace(edit.find, edit.replace), original));
      const green = run(mutant.evals);
      console.log(`${green ? "SURVIVED" : "killed  "}  ${mutant.control}`);
      if (green) survivors.push(`${mutant.control} — ${mutant.evals.join(", ")} stayed green`);
    } finally {
      restore();
    }
  }
  if (survivors.length) {
    console.error(`\n${survivors.length} guardrail(s) not guarded:\n${survivors.map((line) => `  - ${line}`).join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${MUTANTS.length} guardrail mutants killed.`);
  }
}
