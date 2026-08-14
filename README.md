# scriptorium

Two agents that turn PRDs + designs into governed product documentation — with humans
as the quality gate, and every learned behavior auditable.

- **Scribe (Agent A)** — drafts user docs from a PRD and design images; revises from
  PM/support feedback in the Slack thread; distills generalizable feedback into
  **lessons** that improve every future doc. Nothing publishes without human approval —
  including the lessons themselves.
- **Curator (Agent B)** — watches the incoming PRDs, designs, and published docs;
  organizes them into an Obsidian-compatible **vault** (frontmatter, wikilinks, index);
  answers questions in Slack **only from the vault, with citations** — and files a gap
  note when it can't, which lands in Scribe's queue.

```
PM drops PRD + designs ──▶ SCRIBE: contract check → draft → lint → thread review
                                     │ feedback loop │ human ✅        │ lesson distilled
                                     ▼                                 ▼ (human-approved)
                              THE VAULT (markdown + git = audit trail)
                                     ▲                                 │
        CURATOR: organize, link, index ◀── watches ──┘   Q&A with citations ──▶ Slack
                                     └── unanswerable question → gap note → Scribe's queue
```

## Quickstart

```bash
pnpm install
cp .env.example .env          # fill in ANTHROPIC_API_KEY (Slack tokens optional)
pnpm dev                      # starts the vault watcher + any bot with tokens configured
```

No Slack tokens yet? `pnpm dev` runs in **local mode**: drop a file into `vault/_inbox/`
and watch Curator classify, file, link, and re-index it.

Run the full Scribe pipeline from the CLI:

```bash
pnpm render:wireframes        # SVG -> PNG (once)
pnpm draft samples/prd-001-scheduled-maintenance.md samples/wireframes/*.png
pnpm draft samples/prd-003-incomplete.md   # → refused: the input contract asks for missing fields
```

Checks:

```bash
pnpm typecheck
pnpm eval                     # contract / lint / organizer evals (no API key needed)
RUN_LLM_EVALS=1 pnpm eval     # + live grounded-Q&A evals
```

## Slack setup (two apps, ~3 minutes)

1. Create a **fresh demo workspace** (do not use a work workspace).
2. https://api.slack.com/apps → *Create New App* → *From a manifest* → paste
   `slack-manifests/scribe.yaml`. Repeat for `curator.yaml`.
3. For each app: **Install to workspace**; copy the *Bot User OAuth Token* (`xoxb-…`);
   under *Basic Information → App-Level Tokens* create a token with `connections:write`
   (`xapp-…`). Fill all four values in `.env`.
4. `pnpm dev`, invite both bots to a channel, then:
   - `@Scribe check` + a fenced ```PRD``` block → input-contract validation
   - `@Curator <question>` → grounded answer with citations, or a filed gap note

## Design decisions (short version)

- **Learning = human-gated lessons, not fine-tuning.** Feedback that generalizes becomes
  a markdown rule with provenance (author, thread, date, scope) in `vault/_lessons/`,
  applied to future drafts and listed in each draft's footer. Auditable, revocable
  (delete the file), reviewable (a human approves what the system learns).
- **Machines gate the deterministic; humans gate claims.** Lint catches placeholders,
  missing sections, glossary violations. Humans approve publishes. Fail-closed.
- **Input contract before generation.** A PRD missing `feature`/`audience`/`user_goal`
  gets questions back, not a guessed draft.
- **Grounded Q&A or nothing.** Curator answers only from retrieved notes, cites each
  one, and files a gap note instead of improvising.
- **Files + git as the system of record.** The vault is a plain Obsidian folder;
  `git log` is the tamper-evident history of who approved what.

## Repo map

| Path | What |
|---|---|
| `packages/core` | LLM client, vault (frontmatter/wikilinks), append-only audit log |
| `packages/scribe` | contract → draft → lint → revise → publish; lesson store + distiller |
| `packages/curator` | inbox watcher, organizer/MOC, BM25 index, tool-runner Q&A, gap notes |
| `apps/slack` | the two Socket-Mode bots |
| `vault/` | the knowledge vault (open it in Obsidian) |
| `samples/` | fictional "Beacon" PRDs + wireframes for the demo |
| `evals/` | scripted checks for the guardrails |

## Status

- [x] Core: vault, LLM client, audit log, config
- [x] Scribe: contract, draft (vision), lint, revise, lesson store/distiller, publish (CLI path)
- [x] Curator: organizer + MOC, watcher, grounded Q&A with citations, gap notes
- [x] Slack: both bots connect; Scribe contract-check; Curator Q&A
- [ ] Slack: full draft→feedback→approve thread flow (buttons)
- [ ] Lesson proposal/approval flow in-thread
- [ ] Demo video

## Acknowledgments

The runtime patterns here (approval-gated writes, versioned instruction files,
append-only audit) follow an MIT-licensed agent chassis — [thor](https://github.com/scoutqa-dot-ai/thor)
by Đào Hoàng Sơn — whose production downstream I co-maintain. This repo is a fresh,
self-contained implementation built for this assignment.
