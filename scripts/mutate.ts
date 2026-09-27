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
    control: "Confluence reads are space-allow-listed",
    file: "packages/connectors/src/confluence.ts",
    find: "    if (!space) throw new ConfluenceAccessError(",
    replace: "    if (false) throw new ConfluenceAccessError(",
    evals: ["evals/confluence-connector.test.ts"],
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
    control: "the Teammate writes to Atlassian only as itself",
    file: "apps/agents/src/teammate-bot.ts",
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
