# Loop engineering

Each iteration moves scriptorium one reviewable PR closer to the [north star](NORTH_STAR.md):
a policy-first teammate that lives in any chat tool and works for the whole team. The loop
never merges. A human reviews and merges every PR, the same way a human approves every write the
agents make.

| File | What it holds |
|---|---|
| [NORTH_STAR.md](NORTH_STAR.md) | The goal, milestones M1–M6 with an eval-shaped exit check each, and what we take from Thor |
| [BACKLOG.md](BACKLOG.md) | Ranked H (hardening) and B (build) items. The loop picks from here and adds what it finds |
| [LOG.md](LOG.md) | One entry per iteration. Its `base:` line is what the next sweep diffs against |
| [`.claude/workflows/loop.js`](../../.claude/workflows/loop.js) | The iteration itself, as a Claude Code workflow |

## One iteration

```
Orient ──► Select ──► Build ──► Review ⇄ Fix ──► Ship
```

1. **Orient** runs these in parallel:
   - Read the backlog and log, recent commits and open PRs.
   - Run a **hardening sweep** over code changed since the last `base:`, ranked by severity.
   - Have a skeptic try to refute each finding. Only the ones that survive count.
2. **Select** picks one item and writes its acceptance criteria:
   - A confirmed High-severity bug beats every build item.
   - Otherwise the top `todo` B item whose dependencies are done.
   - An `L` item is split into rows first, and the first part is built.
   - `args.item` or `args.mode` overrides the choice.
3. **Build** runs in an isolated worktree on `loop/<date>-<slug>`:
   - A plan doc in `docs/plan/YYYYMMDDNN_<slug>.md` (B items only): goal, scope, phases with exit
     criteria, a decision log, and what's out of scope. This is Thor's format.
   - The change, plus an eval for each acceptance criterion that **goes red without the change**.
     The builder proves it by reverting the change and running the eval.
   - A mutant in `scripts/mutate.ts` for every new safety control.
   - Gates: `pnpm typecheck`, `pnpm eval`, and `MUTATE_CHANGED=1 pnpm mutate` for the touched files.
4. **Review** uses three lenses, and a skeptic checks each blocking finding:
   - **correctness:** does it meet the acceptance criteria?
   - **design:** CLAUDE.md "do not regress", fail-closed, every write through policy, no Slack
     leaking into neutral code.
   - **tests:** are they behaviour tests, and would they catch a regression?
5. **Fix** handles confirmed blocking findings, then reviews again (up to `maxFixRounds`, default 2).
6. **Ship:**
   - Update the BACKLOG status and append to LOG.
   - Push as `sloweyyy` and open the PR with the severity/fix table the earlier sweeps used (#33, #34).
   - The PR is a **draft** if a blocking finding is still open. If a gate is red, nothing is pushed.

## Running it

In Claude Code, from the repo root:

```
run the loop workflow with date 2026-10-22
```

Or with arguments, passed as the workflow's `args`:

| arg | default | meaning |
|---|---|---|
| `date` | required | `YYYY-MM-DD`. Names the branch and the log entry (workflows can't read the clock) |
| `base` | `main` | Branch to build on and open the PR against. Set it to the previous loop branch to stack iterations while they wait for review |
| `mode` | `auto` | `auto` (bugs first, then build) · `build` · `harden` (a sweep-only PR like #33/#34) |
| `item` | | Force a backlog id, e.g. `B-001` |
| `ship` | `true` | `false` stops after review: a local branch and no push |
| `maxFixRounds` | `2` | review/fix cycles before shipping as a draft |
| `thorPath` | | A local Thor checkout for the builder to consult. Otherwise it clones `sloweyyy/thor` if it needs one |

**Cadence.** One iteration a day is about right while M1 is open, because each PR needs a human review
before the next one builds on it. To repeat it, `/loop 24h run the loop workflow with today's date`
in a long-lived session, or `/schedule` a cloud routine. The loop does not stack PRs: if an earlier
`loop/*` PR is still open, Select only picks items that don't depend on it.

## Rules the loop keeps

- **One item, one PR.** Diff ≤ ~800 lines excluding tests, or the item gets split.
- **Evals are the definition of done.** No eval that goes red without the change means not done. A safety
  control without a mutant is not done.
- **No regressions in "Design decisions".** Curator never authors. Writes are approve-tier. Fail-closed.
  Files + git are the record.
- **Generalize with a second case in sight.** Every interface built for M1 needs a fake second
  surface in its evals. An abstraction with one implementation and no test double doesn't merge.
- **No secrets, no employer or customer content.** Samples stay on the fictional Beacon product.
- **Commit trailers** are the CLAUDE.md block. PR bodies end with the Claude Code line.
