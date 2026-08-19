# scriptorium

Two agents that turn PRDs + designs into governed product documentation — with humans
as the quality gate, and every learned behavior auditable.

- **Scribe (Agent A)** — works a **Jira** ticket end to end: reads the PRD and wireframes
  off the issue, checks them against an input contract, posts a draft as a comment,
  revises from PM/support feedback, publishes only on human approval, then proposes a
  **lesson** — a house rule that improves every future doc, which a human also approves.
- **Curator (Agent B)** — watches the incoming PRDs, designs, and published docs;
  organizes them into an Obsidian-compatible **vault** (frontmatter, wikilinks, index);
  answers questions in **Slack** only from the vault, **with citations** — and when it
  can't, files a gap note *and opens a Jira doc request*, which is Scribe's next job.

```
      JIRA  ── doc-request issue (PRD + wireframes attached)
        │
        ▼
   SCRIBE: contract check → draft (vision) → lint → comment thread review
        │        ▲ feedback comments │              │ approve = transition or comment
        │        └───── revise ──────┘              ▼
        │                                    THE VAULT (markdown + git = audit trail)
        │                                           ▲          │
        │ lesson proposed ──▶ human approves ──────▶│          │
        ▼                                           │          ▼
   _lessons/ shape every future draft     CURATOR: organize, link, index → Slack Q&A
                                                               │ with citations
      JIRA ◀── doc request opened automatically ◀── gap note ◀──┘ (nothing to cite)
```

Two agents, one chassis: one process, one vault, one audit log, two identities. The
split is where the permission boundary is — Scribe may author (gated), Curator may only
organize and retrieve. Author ≠ archivist ≠ approver.

## Quickstart

```bash
pnpm install
cp .env.example .env          # ANTHROPIC_API_KEY + the Jira block (Slack optional)
pnpm jira:doctor              # verifies auth, JQL, comments, attachments, transitions
pnpm seed:corpus              # load the reference corpus into the vault (Curator's demo knowledge)
pnpm dev                      # vault watcher + Jira poller + any Slack bot with tokens
```

No tokens at all? `pnpm dev` runs in **local mode**: drop a file into `vault/_inbox/`
and watch Curator classify, file, link, and re-index it.

Run the Scribe pipeline without any surface:

```bash
pnpm render:wireframes        # SVG -> PNG (once)
pnpm draft samples/prd-001-scheduled-maintenance.md samples/wireframes/*.png
pnpm draft samples/prd-003-incomplete.md   # → refused: the input contract asks for the missing fields
```

Checks:

```bash
pnpm typecheck
pnpm eval                     # contract / lint / organizer / jira / gap-loop evals (no API key needed)
RUN_LLM_EVALS=1 pnpm eval     # + live grounded-Q&A evals
```

## Jira setup (Agent A, ~5 minutes)

1. Create a free Jira Cloud site and a project (key `DOC` in the examples).
2. Create an API token at
   [id.atlassian.com → Security → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
   for the account the agent posts as, and put `JIRA_BASE_URL`, `JIRA_EMAIL`,
   `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY` in `.env`.
3. Add a status named **Approved** to the project's workflow (optional — an `approve`
   comment does the same thing; set `JIRA_APPROVED_STATUS` if you name it differently).
4. `pnpm jira:doctor` — it reports which search endpoint your site answers on, what the
   poller's JQL matches, and whether the approval transition exists.
   `pnpm jira:doctor --write` also proves comment + attachment permissions.
5. `pnpm dev`. The poller picks up every issue in the project labelled `doc-request`.

### Working a ticket (what a reviewer does)

1. Create an issue, label it **`doc-request`**, attach the PRD as a `.md` file
   (frontmatter must carry `feature`, `audience`, `user_goal`) and any wireframes as
   PNG/JPEG/WEBP/GIF. A PRD pasted into the description works too.
2. Scribe comments within ~15s: the contract questions if the PRD is incomplete,
   otherwise a draft (in the comment and attached as `.md`), its lint result, and which
   house rules it applied.
3. Comment feedback in plain English → it revises and posts again.
4. Comment `approve`, or move the issue to **Approved** → it publishes to the vault,
   Curator cross-links and re-indexes, and the commit records the approver.
5. It then proposes a lesson from your feedback. `approve lesson L-001` makes it a house
   rule for every future draft; `reject lesson L-001` deletes it.

`help` in a comment prints the same list. Nothing publishes without step 4.

## Slack setup (Agent B, ~3 minutes)

1. Use a **fresh demo workspace** (not a work workspace).
2. https://api.slack.com/apps → *Create New App* → *From a manifest* → paste
   `slack-manifests/curator.yaml`. (`scribe.yaml` is optional — the Slack Scribe is a
   thin contract-check surface; Jira is where Agent A actually works.)
3. **Install to workspace**; copy the *Bot User OAuth Token* (`xoxb-…`); under
   *Basic Information → App-Level Tokens* create one with `connections:write` (`xapp-…`).
   Fill `CURATOR_SLACK_BOT_TOKEN` / `CURATOR_SLACK_APP_TOKEN` in `.env`.
4. `pnpm dev`, invite Curator to a channel, then `@Curator <question>` → a grounded
   answer with `[[citations]]`, or a filed gap note **plus a new Jira doc request**.

## The demo knowledge base

`corpus/` holds 63 pages retrieved from Acme's public website and its
public developer documentation (product, channels, API reference, security/compliance,
policies). Every file carries the `source_url` it came from and the date it was
retrieved; nothing in it is generated. `pnpm seed:corpus` files them into
`vault/reference/`, which is deliberately **not committed** — the retrieved corpus is the
record, the vault copy is derived, and the assignment's own artifacts (PRDs, published
docs, lessons, gaps) stay the visible content of the vault.

That gives Curator a real knowledge base to be graded on: ask it about rate limits,
iMessage onboarding, retention deletion or an ethical wall and it answers from those
notes, citing each one — and when the corpus doesn't cover something, that question
becomes a gap note and a Jira doc request.

Scribe's PRDs stay the fictional **Beacon** product on purpose. A PRD describes behavior
that does not exist yet; writing one about someone else's real product would mean
publishing invented requirements as documentation, which is exactly what the guardrails
in this repo exist to prevent.

## Design decisions (short version)

- **Learning = human-gated lessons, not fine-tuning.** Feedback that generalizes becomes
  a markdown rule with provenance (author, source ticket, date, scope) in
  `vault/_lessons/`, applied to future drafts and listed in each draft's comment.
  Auditable, revocable (delete the file), reviewable (a human approves what the system
  is allowed to learn).
- **Machines gate the deterministic; humans gate claims.** Lint catches placeholders,
  missing sections, glossary violations — and gets one automatic self-correction round
  before a human is asked to read anything. Humans approve publishes. Fail-closed.
- **Input contract before generation.** A PRD missing `feature`/`audience`/`user_goal`
  gets questions back, not a guessed draft.
- **Grounded Q&A or nothing.** Curator answers only from retrieved notes, cites each one,
  and files a gap note instead of improvising.
- **Files + git as the system of record.** The vault is a plain Obsidian folder; `git log`
  is the tamper-evident history of who approved what. No database.
- **Surfaces are adapters, not architecture.** Jira and Slack are transports around the
  same pipeline; `packages/jira` is ~500 lines and the pipeline did not change to gain it.

### Why Jira for Agent A and Slack for Agent B

Documentation work is ticketed work: it has one owner, a review thread, an approval
state, and attachments — all of which Jira already models, so the approval gate is a
workflow transition instead of something this system invents. Q&A is conversational and
belongs where people already ask, which is Slack. The loop closes across both: an
unanswered Slack question becomes a Jira doc request automatically.

**Polling, not webhooks.** A 15s JQL poll needs no public endpoint, so the agent runs
identically on a laptop, in a container, or behind a corporate firewall — which matters
for regulated deployments. Webhooks are a latency optimization the same handler can take
later; idempotency (a processed-comment ledger) is what makes either safe, and that is
already there.

### Why two agents rather than one

Identity is split exactly where the permission boundary is. Scribe may author product
claims, under a human gate; Curator may never author, only organize and retrieve. Same
chassis, same vault, same audit log — the second identity costs one manifest and a
handful of lines, and buys segregation of duties that an auditor can see.

## Repo map

| Path | What |
|---|---|
| `packages/core` | LLM client, vault (frontmatter/wikilinks), append-only audit log, config |
| `packages/scribe` | contract → draft → lint → revise → publish; lesson store + distiller |
| `packages/curator` | inbox watcher, organizer/MOC, BM25 index, tool-runner Q&A, gap notes |
| `packages/jira` | REST v2 client, wiki-markup translation, comment commands, poller state |
| `apps/agents` | the surfaces: Jira poller (Scribe) + Socket-Mode bots (Curator, thin Scribe) |
| `vault/` | the knowledge vault (open it in Obsidian) |
| `corpus/` | retrieved public Acme pages (read-only, each with `source_url`) |
| `samples/` | fictional "Beacon" PRDs + wireframes for the demo |
| `evals/` | scripted checks for every guardrail |

## Running it always-on

The container runs both surfaces in one process; neither needs inbound traffic, and the
health port exists only to satisfy platforms that insist on one.

```bash
docker build -t scriptorium .
docker run --env-file .env -p 8080:8080 scriptorium
```

## Status

- [x] Core: vault, LLM client, audit log, config
- [x] Scribe: contract, draft (vision), lint, revise, lesson store/distiller, publish
- [x] Scribe on Jira: poll → contract → draft → feedback → approve → publish → lesson gate
- [x] Curator: organizer + MOC, watcher, grounded Q&A with citations, gap notes
- [x] Cross-surface loop: gap note → Jira doc request
- [x] Publish → organize hook (cross-link + re-index on approval)
- [ ] Second sample PRD demonstrating lesson transfer
- [ ] Demo video
