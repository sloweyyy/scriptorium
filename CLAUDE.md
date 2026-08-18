# scriptorium — working notes

Two-agent documentation pipeline: **Scribe** (Agent A) drafts user docs from PRDs +
designs with a human-gated feedback/lesson loop; **Curator** (Agent B) organizes
everything into an Obsidian-compatible vault and answers questions from it with
citations. Both run on one chassis (one process, one vault, one audit log) with
separate Slack identities and separate permission envelopes.

## Commands

```bash
pnpm dev                # vault watcher + any Slack bot with tokens in .env; local mode without tokens
pnpm typecheck          # tsc --noEmit (strict) — must stay clean
pnpm eval               # contract / lint / organizer evals, no API key needed
RUN_LLM_EVALS=1 pnpm eval   # + live grounded-Q&A evals (needs ANTHROPIC_API_KEY)
pnpm draft <prd.md> [images...]   # full Scribe pipeline from the CLI
pnpm render:wireframes  # samples/wireframes/*.svg -> .png
```

## Architecture

| Path | Owns |
|---|---|
| `packages/core` | Anthropic client (`claude-opus-5` default, `MODEL` env), Vault (frontmatter/wikilinks, path-escape guard), append-only audit JSONL + `commitVault` git helper, config |
| `packages/scribe` | input contract → draft (vision) → deterministic lint → revise → publish (fail-closed); lesson store + distiller |
| `packages/curator` | `_inbox` watcher, organizer + MOC (idempotent regen), BM25 index (minisearch), tool-runner Q&A (`search_vault` + `read_note`), gap notes |
| `apps/slack` | two Bolt Socket-Mode bots; manifests in `slack-manifests/` |
| `vault/` | the knowledge plane — plain Obsidian folder, git history = audit trail |
| `evals/` | vitest checks for every guardrail |

## Design decisions (do not regress)

- **Two agents, one system.** Separate identities where the permission boundary is
  (Scribe may author, gated; Curator may only organize/retrieve — never author
  product claims), shared chassis everywhere else. Do not merge the bots.
- **Learning = human-gated lessons.** Feedback that generalizes becomes a markdown
  rule in `vault/_lessons/` with provenance (author, thread, scope); a human approves
  it before it applies. No fine-tuning, no opaque memory. Curator's behavior must
  never drift with lessons — taxonomy changes by config only.
- **Fail-closed everywhere.** No approval → no publish. No citation → no claim
  (Curator answers `NOT_IN_KB:` and files a gap note instead of improvising).
  Gap notes feed Scribe's queue — that loop is the point of the system.
- **Files + git are the system of record.** Every publish/approval commits with the
  approver recorded. No database.
- **Contract before generation.** PRDs missing `feature`/`audience`/`user_goal` get
  questions back, never a guessed draft.

## Conventions

- TypeScript strict, ESM, no build step — `tsx` runs source; workspace packages
  export `./src/index.ts`. Keep `pnpm typecheck` and `pnpm eval` green before commit.
- Use SDK types (`Anthropic.*`, Bolt's) — don't redefine shapes.
- Sample content is the fictional "Beacon" product only. Never put real product,
  customer, or employer-internal content in this repo or the vault.
- Commit trailer block (both lines):
  `Co-Authored-By: Truong Le Vinh Phuc <truonglevinhphuc2006@gmail.com>`
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## Engineering TODO (in order)

> **Pivot (reviewer request): Agent A (Scribe) demos through JIRA, not Slack.**
> Curator stays on Slack. The reviewer will be invited to the Jira project and
> will exercise Scribe himself — the Scribe surface must survive unsupervised use.

1. **`packages/jira` adapter** — REST v2 (plain-text/wiki bodies; avoid v3 ADF),
   API-token auth. Poll (~15s JQL) for new "Doc Request" issues + new comments;
   read description + attachments (PRD .md, wireframe images); post comments.
   Polling is the transport (no public endpoint needed, runs anywhere); a system
   webhook fast-path can be added later behind the same handler.
2. **Scribe Jira flow** — issue created → contract check (comment asks for missing
   fields) → draft posted as comment (+ .md attachment) → feedback comments →
   revise → **approve = workflow transition to "Approved"** (or `approve` comment)
   → `publishDoc` → distill lesson → lesson proposal comment → `approve lesson`
   comment → `approveLesson`. Idempotency: track processed comment ids in
   `audit/`-adjacent state file; never double-post.
3. **Publish → organize hook** — call `linkRelated` + `updateMoc` after `publishDoc`
   (watcher only covers `_inbox`).
4. **Cross-surface loop** — Curator's `fileGapNote` also opens a Jira "Doc Request"
   issue: Agent B's unanswered Slack question becomes Agent A's Jira ticket.
5. Hosting for the reviewer's async testing — single always-on container (Cloud Run
   min-instances=1) running the Jira poller + Curator socket-mode; vault persistence
   via push to a `vault-live` branch (or run locally during an announced window).
6. `samples/prd-002-*` (second PRD to demo lesson transfer) + full demo run.
7. README: "Design note: one agent or two?" + Jira-vs-Slack transport note; demo video.

Slack Scribe bot (`apps/slack/src/scribe-bot.ts`) stays as a thin secondary surface —
do not extend it further; Jira is Agent A's primary interface now.

If `NOTES.local.md` exists in the repo root, read it at session start — it carries
local working context that is not committed.
