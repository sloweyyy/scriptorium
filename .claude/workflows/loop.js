export const meta = {
  name: 'loop',
  description: 'One loop-engineering iteration: pick the next backlog item toward the multi-channel Teammate, build it with evals and mutants, review it adversarially, open a PR (never merge)',
  whenToUse: 'Once per iteration, by hand, from /loop, or on a schedule. args: {date: "YYYY-MM-DD", base?: "main", mode?: "auto"|"build"|"harden", item?: "B-001", ship?: true, maxFixRounds?: 2, thorPath?: string}. Playbook: docs/loop/README.md',
  phases: [
    { title: 'Orient', detail: 'backlog + log, hardening sweep since the last base, refute each finding' },
    { title: 'Select', detail: 'one item with acceptance criteria' },
    { title: 'Build', detail: 'plan doc, change, evals red-without, mutants, gates (worktree)' },
    { title: 'Review', detail: 'correctness / design / tests lenses, each blocking finding refuted' },
    { title: 'Fix', detail: 'address confirmed blocking findings, re-review' },
    { title: 'Ship', detail: 'backlog + log, push as sloweyyy, PR (draft if anything is open)' },
  ],
}

// ---------- arguments ----------
const A = args || {}
if (!A.date || !/^\d{4}-\d{2}-\d{2}$/.test(A.date)) {
  throw new Error('loop needs args.date as YYYY-MM-DD (workflows cannot read the clock)')
}
const DATE = A.date
const MODE = A.mode || 'auto'
if (!['auto', 'build', 'harden'].includes(MODE)) throw new Error(`unknown mode ${MODE}`)
const SHIP = A.ship !== false
const BASE = A.base || "main"
const MAX_FIX = typeof A.maxFixRounds === 'number' ? A.maxFixRounds : 2
const THOR = A.thorPath
  ? `A Thor checkout is at ${A.thorPath}.`
  : 'If Thor\'s take on this would help, clone it read-only: `GH_TOKEN=$(gh auth token --user sloweyyy) gh repo clone sloweyyy/thor "$(mktemp -d)/thor" -- --depth 1`.'

// ---------- shared context ----------
const CONTEXT = `You are one stage of scriptorium's loop-engineering workflow (playbook: docs/loop/README.md).
North star (docs/loop/NORTH_STAR.md): a policy-first teammate that lives in Slack, Discord, Teams or any chat tool and does work for the whole team. Every write is approved, every claim cited, every action audited.
Backlog: docs/loop/BACKLOG.md. Log: docs/loop/LOG.md (its newest "base:" line is the last iteration's base commit).
Gates for every change: \`pnpm typecheck\` clean, \`pnpm eval\` green, and for touched files \`MUTATE_CHANGED="$(git diff --name-only origin/${BASE}...HEAD)" pnpm mutate\` with no survivors.
Definition of done: each acceptance criterion has an eval that goes RED without the change. Every new safety control has a mutant in scripts/mutate.ts (MUTANTS registry: {control, file, find, replace, also?, evals}; the find string must be unique in the file).
Never regress CLAUDE.md "Design decisions (do not regress)". Never commit secrets, .env, or employer/customer content (samples are the fictional Beacon product).
Reference design: Thor (sloweyyy/thor), a mature Slack teammate. Borrow its behaviour, not its Slack coupling. ${THOR}`

const GIT_RULES = `Git rules:
- Commit message: "<type>(<scope>): <behavioural description>" like the repo's history, ending with exactly this trailer block:
  Co-Authored-By: Truong Le Vinh Phuc <truonglevinhphuc2006@gmail.com>
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
- After your last commit run \`git checkout --detach\` so the branch is free for the next stage's worktree.
- Never push, never merge, never touch main or ${BASE}.
- A fresh worktree has no node_modules: run \`pnpm install --frozen-lockfile --prefer-offline\` first. If \`pnpm\` isn't on PATH, use \`corepack pnpm\` everywhere (the repo pins pnpm@10.32.1).`

// ---------- schemas ----------
const CANDIDATES = {
  type: 'object',
  properties: {
    base: { type: 'string', description: 'base commit from the newest LOG.md entry' },
    open_loop_prs: { type: 'array', items: { type: 'string' }, description: 'open PRs on loop/* branches, "#N title (backlog ids)"' },
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' }, title: { type: 'string' }, size: { type: 'string' },
          ready: { type: 'boolean', description: 'dependencies done and not blocked by an open PR' },
          why_now: { type: 'string' },
        },
        required: ['id', 'title', 'size', 'ready', 'why_now'],
      },
    },
  },
  required: ['base', 'open_loop_prs', 'candidates'],
}

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['High', 'Medium', 'Low'] },
          file: { type: 'string' }, line: { type: 'number' },
          failure_scenario: { type: 'string', description: 'concrete input/state -> wrong output' },
          fix: { type: 'string' },
        },
        required: ['title', 'severity', 'file', 'line', 'failure_scenario', 'fix'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT = {
  type: 'object',
  properties: { refuted: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['refuted', 'reason'],
}

const SELECTION = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['build', 'harden'] },
    ids: { type: 'array', items: { type: 'string' }, description: 'backlog ids covered; new H ids for fresh findings' },
    title: { type: 'string' },
    slug: { type: 'string', description: 'kebab-case, <= 40 chars' },
    goal: { type: 'string' },
    acceptance: { type: 'array', items: { type: 'string' }, description: 'each one becomes an eval' },
    files: { type: 'array', items: { type: 'string' } },
    out_of_scope: { type: 'array', items: { type: 'string' } },
    split: { type: 'array', items: { type: 'string' }, description: 'new backlog rows if an L item was split; else empty' },
    findings: { type: 'array', items: { type: 'object' }, description: 'harden only: the confirmed findings being fixed' },
    rationale: { type: 'string' },
  },
  required: ['kind', 'ids', 'title', 'slug', 'goal', 'acceptance', 'files', 'out_of_scope', 'split', 'rationale'],
}

const BUILD = {
  type: 'object',
  properties: {
    branch: { type: 'string' }, head: { type: 'string' },
    summary: { type: 'string' },
    plan_doc: { type: 'string' },
    evals: { type: 'array', items: { type: 'string' }, description: 'eval files/cases added or changed' },
    red_without_change: { type: 'boolean', description: 'true only if you reverted the change and saw each new eval fail' },
    mutants_added: { type: 'number' },
    typecheck: { type: 'string', enum: ['pass', 'fail'] },
    eval: { type: 'string', enum: ['pass', 'fail'] },
    eval_count: { type: 'string', description: 'e.g. "812 passed"' },
    mutate: { type: 'string', enum: ['pass', 'fail', 'none-touched'] },
    diff_lines: { type: 'number', description: 'non-test lines changed' },
    followups: { type: 'array', items: { type: 'string' }, description: 'new backlog rows this exposed' },
    notes: { type: 'string' },
  },
  required: ['branch', 'head', 'summary', 'evals', 'red_without_change', 'mutants_added', 'typecheck', 'eval', 'eval_count', 'mutate', 'diff_lines', 'followups', 'notes'],
}

const SHIPPED = {
  type: 'object',
  properties: {
    pushed: { type: 'boolean' }, pr_url: { type: 'string' }, draft: { type: 'boolean' }, notes: { type: 'string' },
  },
  required: ['pushed', 'pr_url', 'draft', 'notes'],
}

// ---------- Orient ----------
phase('Orient')
const [scout, sweep] = await parallel([
  () => agent(`${CONTEXT}

Task: list what the loop could do next. Read docs/loop/BACKLOG.md and docs/loop/LOG.md, run \`git log --oneline -30 origin/${BASE}\`, and list open PRs with \`GH_TOKEN=$(gh auth token --user sloweyyy) gh pr list --state open --json number,title,headRefName\`.
Return the newest LOG "base:" commit, the open loop/* PRs and the backlog ids they cover, and up to 6 candidate items (todo, or in-review without a PR), top of the backlog first. Mark ready=false if a dependency isn't done or an open PR touches the same files. Read-only: change nothing.`,
    { label: 'scout:backlog', phase: 'Orient', schema: CANDIDATES }),
  () => MODE === 'build' ? { findings: [] } : agent(`${CONTEXT}

Task: hardening sweep. Find the base commit in the newest docs/loop/LOG.md entry. Review \`git diff <base>..origin/${BASE} -- packages apps scripts\` (if that's empty, review the three most recently changed source files under packages/ and apps/agents/src instead).
Find up to 5 defects: wrong behaviour, a guardrail that can be bypassed, fail-open paths, exactly-once violations, policy tiers wrong, a channel-specific assumption in neutral code. Also check that every H item in BACKLOG.md with status todo still reproduces.
Include a finding only when you have read the code path end to end and can state concrete input -> wrong output. No style or speculative findings. Read-only: change nothing.`,
    { label: 'scout:sweep', phase: 'Orient', schema: FINDINGS }),
])
if (!scout) throw new Error('backlog scout failed; nothing to select from')

const rawFindings = (sweep && sweep.findings) || []
const verdicts = await parallel(rawFindings.map((f, i) => () => agent(`${CONTEXT}

A reviewer claims this defect. Try to REFUTE it: read the code, trace the path, look for a guard elsewhere that prevents it, and check whether an existing eval already covers it. If you're uncertain, refuted=true.
${JSON.stringify(f, null, 2)}`, { label: `refute:${i + 1}`, phase: 'Orient', schema: VERDICT })))
const confirmed = rawFindings.filter((f, i) => verdicts[i] && !verdicts[i].refuted)
log(`sweep: ${rawFindings.length} found, ${confirmed.length} survived refutation; ${scout.candidates.filter(c => c.ready).length} backlog items ready`)

// ---------- Select ----------
phase('Select')
const selection = await agent(`${CONTEXT}

Task: choose exactly ONE unit of work for this iteration (${DATE}). Mode: ${MODE}.${A.item ? ` The human asked for ${A.item}: pick it unless it's not ready, and if so say why in rationale and pick the next ready item.` : ''}
Rules:
- mode=harden: bundle up to 4 confirmed findings (prefer the same subsystem) into one fix PR.
- mode=build: the top ready B item.
- mode=auto: a confirmed High finding beats every B item; otherwise the top ready item (H or B).
- Size L must be split: write the new rows into "split" (e.g. "B-007a | Discord inbound + fake gateway | M") and build only the first.
- Acceptance criteria are behavioural and testable, one eval each. Keep the diff <= ~800 non-test lines.
- Open loop PRs: ${JSON.stringify(scout.open_loop_prs)}. Don't pick work that depends on them.

Backlog candidates: ${JSON.stringify(scout.candidates, null, 2)}
Confirmed findings: ${JSON.stringify(confirmed, null, 2)}

Read the files involved before writing acceptance criteria, so the criteria name real functions and paths.`,
  { label: 'select', phase: 'Select', schema: SELECTION })
if (!selection) throw new Error('selection failed')
const BRANCH = `loop/${DATE}-${selection.slug}`
log(`picked ${selection.ids.join(', ')}: ${selection.title} -> ${BRANCH}`)

// ---------- Build ----------
phase('Build')
const build = await agent(`${CONTEXT}

${GIT_RULES}

Task: implement this unit of work on a new branch \`${BRANCH}\` created from ${BASE} (\`git fetch origin ${BASE} && git checkout -b ${BRANCH} origin/${BASE}\`).
${JSON.stringify(selection, null, 2)}

Steps:
1. ${selection.kind === 'build' ? `Write the plan doc docs/plan/${DATE.replace(/-/g, '')}NN_${selection.slug}.md (NN = next free 2-digit number for the day). Sections: Goal, Scope (in/out), Design, Phases with exit criteria, Decision log table (D1.. decision | rationale), Out of scope. Read docs/extending.md and docs/architecture.md first.` : 'No plan doc for a harden PR. Reproduce each finding with a failing eval before you fix it.'}
2. Implement. Follow docs/extending.md for connectors/skills/agents. Use SDK types; don't redefine shapes. New interfaces get a test double for a second surface in the evals.
3. For every acceptance criterion, add or extend an eval under evals/. Prove each goes RED without the change: stash or revert only the non-test change, run the eval, see it fail, restore. Report red_without_change honestly.
4. For each new safety control, add a mutant to scripts/mutate.ts.
5. Gates: pnpm typecheck; pnpm eval; MUTATE_CHANGED="$(git diff --name-only origin/${BASE}...HEAD)" pnpm mutate. Fix until green. If a gate can't go green within reason, stop, commit what you have with "wip:" and report the gate as fail.
6. If you added a new env var, update every place config is documented (README, .env example, doctor) in the same change.
7. Commit (one commit per phase is fine), then \`git checkout --detach\`.
Report the branch, head sha, gates, eval count (from vitest output), non-test diff size (\`git diff --stat origin/${BASE}...${BRANCH} -- . ':!evals'\`) and follow-up backlog rows.`,
  { label: `build:${selection.slug}`, phase: 'Build', schema: BUILD, isolation: 'worktree' })
if (!build) throw new Error('build agent failed')
const gatesGreen = () => build.typecheck === 'pass' && build.eval === 'pass' && build.mutate !== 'fail' && build.red_without_change

// ---------- Review ⇄ Fix ----------
const LENSES = [
  { key: 'correctness', ask: 'Does the change meet every acceptance criterion? Look for logic bugs, edge cases (empty, unicode, restart mid-way, duplicate delivery), and exactly-once or idempotency breaks.' },
  { key: 'design', ask: 'Does it regress any CLAUDE.md design decision? Check: every write goes through runUnderPolicy/guard; fail-closed on missing approval or citation; Curator never authors; files+git stay the record; no Slack/Bolt types or <@U..> syntax leaking into channel-neutral packages; no new unvalidated input at a boundary; no secrets.' },
  { key: 'tests', ask: 'Are the new evals behaviour tests that would catch a regression? Find an acceptance criterion with no eval, an eval that would still pass with the change reverted, or a safety control with no mutant in scripts/mutate.ts. Ignore coverage of trivial code.' },
]

async function review(round) {
  const per = await pipeline(
    LENSES,
    (lens) => agent(`${CONTEXT}

Review branch \`${BRANCH}\` against ${BASE} through the ${lens.key} lens (round ${round}). Read-only: use \`git fetch origin ${BASE} && git diff origin/${BASE}...${BRANCH}\` and \`git show ${BRANCH}:<path>\`, and don't check anything out.
Acceptance criteria: ${JSON.stringify(selection.acceptance)}
${lens.ask}
Report only BLOCKING findings: ones that would make a careful maintainer refuse the merge. Severity High or Medium. Skip nits.`,
      { label: `review:${lens.key}:r${round}`, phase: 'Review', schema: FINDINGS }),
    (res, lens) => parallel(((res && res.findings) || []).map((f, i) => () =>
      agent(`${CONTEXT}

A ${lens.key} reviewer says this blocks merging branch \`${BRANCH}\`. Try to REFUTE it by reading the branch's code (git show ${BRANCH}:<path>). If you're uncertain, refuted=true.
${JSON.stringify(f, null, 2)}`, { label: `refute:${lens.key}:${i + 1}:r${round}`, phase: 'Review', schema: VERDICT })
        .then(v => (v && !v.refuted ? { ...f, lens: lens.key } : null)))),
  )
  return per.flat().filter(Boolean)
}

let blocking = gatesGreen() ? await review(1) : []
let round = 1
while (gatesGreen() && blocking.length && round <= MAX_FIX) {
  phase('Fix')
  log(`round ${round}: ${blocking.length} confirmed blocking finding(s)`)
  const fixed = await agent(`${CONTEXT}

${GIT_RULES}

Task: fix these confirmed blocking review findings on branch \`${BRANCH}\` (\`git checkout ${BRANCH}\`).
${JSON.stringify(blocking, null, 2)}
For each finding: add an eval that fails because of it, then fix it. Re-run all gates (typecheck, eval, mutate for changed files) and commit "fix(...): ..." with the trailer block, then \`git checkout --detach\`.
Return the same report shape as the build stage, cumulative for the whole branch.`,
    { label: `fix:r${round}`, phase: 'Fix', schema: BUILD, isolation: 'worktree' })
  if (!fixed) break
  Object.assign(build, fixed, { followups: [...build.followups, ...(fixed.followups || [])] })
  round++
  blocking = gatesGreen() ? await review(round) : []
}

// ---------- Ship ----------
phase('Ship')
const report = { date: DATE, branch: BRANCH, selection, build, open_blocking: blocking, sweep_confirmed: confirmed.length }
if (!gatesGreen()) {
  log(`gates not green (typecheck=${build.typecheck} eval=${build.eval} mutate=${build.mutate} red_without=${build.red_without_change}); branch kept local, nothing pushed`)
  return { ...report, shipped: null }
}
if (!SHIP) {
  log('ship=false: branch kept local for a human to look at')
  return { ...report, shipped: null }
}

const unconfirmedFindings = confirmed.filter(f => !(selection.findings || []).some(s => s.title === f.title))
const shipped = await agent(`${CONTEXT}

${GIT_RULES.replace("Never push, never merge", "Push only this branch. Never merge")}

Task: finish and publish branch \`${BRANCH}\` (\`git checkout ${BRANCH}\`).
1. docs/loop/BACKLOG.md:
   - Set ${selection.ids.join(', ')} to "in-review (#PR)". Step 4 fills in the number.
   - Add the split rows ${JSON.stringify(selection.split)} and follow-up rows ${JSON.stringify(build.followups)}.
   - Add every confirmed sweep finding this PR does NOT fix as a new H row (next free id, source "${DATE} sweep"): ${JSON.stringify(unconfirmedFindings)}.
   - Add every open blocking review finding as a row too: ${JSON.stringify(blocking)}.
2. docs/loop/LOG.md: insert a new entry at the top, under the "entries" comment:
   "## ${DATE} · ${selection.kind}: ${selection.title} (#PR)", then bullets for Kind, Result (one line per acceptance criterion), Gates (${build.eval_count}, mutants +${build.mutants_added}), Open (anything left), and "base:" = \`git rev-parse origin/${BASE}\`.
3. Commit "docs(loop): ${DATE} iteration" with the trailer block. Then:
   export GH_TOKEN=$(gh auth token --user sloweyyy)
   git push -u origin ${BRANCH}
   gh pr create --base ${BASE} --head ${BRANCH} ${blocking.length ? '--draft ' : ''}--title "<type>: <behavioural summary>" --body-file <file>
   PR body: one paragraph of what changed and why (name the milestone or the sweep), then a table | | Severity/Milestone | Change | with one row per acceptance criterion or finding, then gates ("pnpm typecheck is clean and pnpm eval passes N tests; mutants +M"), then any open findings, then the plan doc link if any. End the body with:
   🤖 Generated with [Claude Code](https://claude.com/claude-code)
4. Write the PR number into BACKLOG.md and LOG.md, commit, and push.
Return pushed, pr_url, draft.`,
  { label: 'ship', phase: 'Ship', schema: SHIPPED, isolation: 'worktree' })

log(shipped && shipped.pr_url ? `PR: ${shipped.pr_url}${shipped.draft ? ' (draft: open findings)' : ''}` : 'ship stage did not open a PR')
return { ...report, shipped }
