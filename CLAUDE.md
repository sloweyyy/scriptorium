# scriptorium — working notes

Two-agent documentation pipeline: **Scribe** (Agent A) drafts user docs from PRDs +
designs with a human-gated feedback/lesson loop, working **Jira** tickets end to end;
**Curator** (Agent B) organizes everything into an Obsidian-compatible vault and answers
questions from it with citations in **Slack**. Both run on one chassis (one process, one
vault, one audit log) with separate identities and separate permission envelopes.

## Commands

```bash
pnpm dev                # vault watcher + Jira poller + any Slack bot with tokens in .env
pnpm jira:doctor        # verify Jira auth/JQL/comments/attachments/transitions (--write for write access)
pnpm typecheck          # tsc --noEmit (strict) — must stay clean
pnpm eval               # contract / lint / organizer evals, no API key needed
RUN_LLM_EVALS=1 pnpm eval   # + live grounded-Q&A evals, on whichever provider is configured
RUN_LLM_EVALS=1 LLM_PROVIDER=gemini pnpm eval   # same contract, Gemini transport
pnpm draft <prd.md> [images...]   # full Scribe pipeline from the CLI
pnpm render:wireframes  # samples/wireframes/*.svg -> .png
pnpm seed:corpus        # corpus/*.md -> vault/reference/ (--inbox to let the watcher file them)
```

## Architecture

| Path | Owns |
|---|---|
| `packages/core` | Anthropic client (`claude-opus-5` default, `MODEL` env), Vault (frontmatter/wikilinks, path-escape guard), append-only audit JSONL + `commitVault` git helper, config |
| `packages/scribe` | input contract → draft (vision) → deterministic lint → revise → publish (fail-closed); lesson store + distiller |
| `packages/curator` | `_inbox` watcher, organizer + MOC (idempotent regen), BM25 index (minisearch), tool-runner Q&A (`search_vault` + `read_note`), gap notes |
| `packages/jira` | REST v2 client (search fallback, attachments, transitions), markdown↔wiki markup, comment commands, poller state (gitignored `.scriptorium-state/`) |
| `apps/agents` | the surfaces: `scribe-jira.ts` (poller + full flow), Bolt Socket-Mode bots, `gap-ticket.ts` (cross-surface loop); manifests in `slack-manifests/` |
| `corpus/` | retrieved public Acme pages, each with `source_url`; seeded into `vault/reference/` (gitignored, regenerate with `pnpm seed:corpus`) |
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
- Sample content is the fictional "Beacon" product, plus `corpus/` — public
  Acme web pages, retrieved read-only for the demo, each carrying its `source_url`.
  Never put employer-internal or customer content in this repo or the vault.
- Commit trailer block (both lines):
  `Co-Authored-By: Truong Le Vinh Phuc <truonglevinhphuc2006@gmail.com>`
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## Engineering TODO (in order)

> **Pivot (reviewer request): Agent A (Scribe) demos through JIRA, not Slack.**
> Curator stays on Slack. The reviewer will be invited to the Jira project and
> will exercise Scribe himself — the Scribe surface must survive unsupervised use.

1. [x] **`packages/jira` adapter** — REST v2, API-token auth, `/search/jql` with legacy
   fallback, comments, attachment download (auth-stripped redirect) + upload,
   transitions, changelog approver lookup, markdown↔wiki markup, comment commands.
2. [x] **Scribe Jira flow** (`apps/agents/src/scribe-jira.ts`) — poll → first-sight
   seeding → contract check → draft comment + `.md` attachment → feedback → revise →
   approve (comment or transition) → `publishDoc` → lesson proposal → `approve lesson`.
   Idempotency: processed-comment ledger + own-accountId filter in `.scriptorium-state/`.
3. [x] **Publish → organize hook** — `organizePublishedDoc` (linkRelated + updateMoc)
   after every publish; PRD/designs from the ticket are dropped into `_inbox` so the
   watcher files them for Curator.
4. [x] **Cross-surface loop** — `fileGapNote` takes an injected `openTicket`; the Slack
   Curator wires it to Jira, so an unanswered question becomes Agent A's ticket.
5. [x] **Verify against the real instance** — `pnpm jira:doctor`, then Cloud Run
   (`min-instances=1 --no-cpu-throttling`, GCS-mounted ledger). Both webhooks verified
   live (Jira HMAC-signed, GitHub `x-hub-signature-256`); both sites deploy from the
   docs repo — `main`/`docs/` public, `vault-live`/`internal/` basic-auth gated. The
   board chain drives all four DOC columns. The deploy key is copied off its 0444
   secret mount, proved against the real remote.
   Left: one live `approve` -> push -> PR round trip on the current revision.
6. `samples/prd-002-*` exists — the full demo run (lesson transfer across two PRDs) does not.
7. Demo video.

Slack Scribe bot (`apps/agents/src/scribe-bot.ts`) stays as a thin secondary surface —
do not extend it further; Jira is Agent A's primary interface now.

If `NOTES.local.md` exists in the repo root, read it at session start — it carries
local working context that is not committed.
