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
   The agent also drives the columns in between when they exist: `JIRA_IN_PROGRESS_STATUS`
   (default `In Progress`) while it is drafting or revising, and `JIRA_IN_REVIEW_STATUS`
   (default `In Review`) once a draft is posted and the next move is a human's. Every move
   is best-effort — a workflow without those columns still gets its draft, in a comment.
4. `pnpm jira:doctor` — it reports which search endpoint your site answers on, what the
   poller's JQL matches, and whether the approval transition exists.
   `pnpm jira:doctor --write` also proves comment + attachment permissions.
5. `pnpm dev`. The poller picks up every issue in the project labelled `doc-request`.

### Working a ticket (what a reviewer does)

1. Create an issue, label it **`doc-request`**, and give it a PRD in whichever of these
   is natural (checked in this order):
   - a `.md` file attached to the ticket,
   - a **Confluence page** linked to the ticket, or its URL in the description — read
     with the same API token, so the agent's account needs Confluence access on the
     site; a later edit to the page is picked up by commenting `draft`,
   - the PRD written straight into the issue description.

   Wherever it lives, it must state `feature`, `audience` and `user_goal` — as YAML
   frontmatter, as labeled lines (`Audience: workspace admins`), or as headings with the
   answer underneath. Nothing else is guessed. Wireframes attach as PNG/JPEG/WEBP/GIF.
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

The container runs both surfaces in one process; neither needs inbound traffic for Slack
(Socket Mode dials out), and the health port plus the Jira/GitHub webhooks are the only
things served.

```bash
docker build -t scriptorium .
docker run --env-file .env -p 8080:8080 scriptorium
```

### Cloud Run

Three properties matter and are easy to get wrong:

- **`--max-instances=1`.** The processed-comment ledger is per-instance state. Two
  instances means two ledgers, duplicate drafts and duplicate publishes.
- **`--no-cpu-throttling`.** Cloud Run throttles CPU between requests, so a warm instance
  is not a running one and the `setInterval` poller would only fire when a request
  happened to wake it. This bills continuously — that is the cost of having a reconciler.
- **Workload identity, not a key file.** The service runs as a service account holding
  `roles/aiplatform.user`, so Claude on Vertex authenticates with no credentials file in
  the image. `GOOGLE_APPLICATION_CREDENTIALS` is a local-development convenience only.

```bash
PROJECT=your-project
SA=scriptorium-agent@$PROJECT.iam.gserviceaccount.com

gcloud run deploy scriptorium \
  --source . --project "$PROJECT" --region us-central1 \
  --service-account "$SA" \
  --min-instances=1 --max-instances=1 --no-cpu-throttling \
  --set-env-vars "VERTEX_PROJECT_ID=$PROJECT,VERTEX_REGION=global,MODEL=claude-opus-5,JIRA_BASE_URL=https://your-site.atlassian.net,JIRA_EMAIL=you@example.com,JIRA_PROJECT_KEY=DOC,JIRA_IN_PROGRESS_STATUS=In Progress,JIRA_IN_REVIEW_STATUS=In Review,JIRA_APPROVED_STATUS=Done,STATE_DIR=/state" \
  --set-secrets "JIRA_API_TOKEN=jira-api-token:latest,CURATOR_SLACK_BOT_TOKEN=curator-slack-bot-token:latest,CURATOR_SLACK_APP_TOKEN=curator-slack-app-token:latest" \
  --add-volume=name=state,type=cloud-storage,bucket=$PROJECT-state \
  --add-volume-mount=volume=state,mount-path=/state
```

The GCS volume is what makes the ledger survive a restart: without it, every ticket looks
like first sight again and the agent re-greets and re-drafts work it already did.

**Do not put the docs-repo work tree on that volume.** `DOCS_REPO_WORKDIR` must point at
local disk (`/tmp/docs-repo`). A GCS FUSE mount has no hardlinks and weak rename/lock
semantics, so `git clone` into it fails — and the failure surfaces as a publish that wrote
the vault copy but never reached the repo. The clone is scratch: it is re-created from the
remote on every boot, so it needs no persistence at all.

**The deploy key is mounted read-only 0444,** and ssh refuses a private key that is
group- or world-readable — `chmod` on a Secret Manager mount is not available. The agent
copies the key once per process to a 0600 path under `TMPDIR` and points
`GIT_SSH_COMMAND` at the copy. Nothing to configure; it is noted because the failure
surfaces as `Permission denied (publickey)`, which reads like a wrong key.

**Claude on Vertex** additionally requires the Anthropic models to be enabled in Model
Garden for the project, and online-prediction quota for the base model
(`aiplatform.googleapis.com/global_online_prediction_requests_per_base_model`,
dimension `base_model=anthropic-claude-opus`). A fresh project starts at zero and the
increase is requested per base model — `gcloud alpha quotas preferences create`.

## How the docs repo is laid out

Two branches, each owning exactly one content tree and one site build:

| Branch | Content | Site | Who writes it |
|---|---|---|---|
| `main` | `docs/` — approved, public | Astro Starlight, public | a human merging a pull request |
| `vault-live` | `internal/` — PRDs, gap notes, house rules, index | Quartz, basic-auth gated | the agent, on approval |

The agent never pushes `main`. Approved docs land on a per-ticket branch and reach `main`
only when a human merges — GitHub offers no branch protection on a private repo on the free
plan, so making the merge gate a property of what the agent *does* is stronger than relying
on what its token is forbidden to do.

**A doc therefore exists twice in that repo**, transformed for the public site and
untransformed for the graph. Those are two derived renderings of one vault note, not two
sources: the vault is the source, and a human edit to either copy is detected by the
divergence gate and reported on the originating ticket rather than absorbed. Publishing once
and filtering at build time would give a single copy, but then the only thing keeping
internal notes off the public site is a build script — today `main` physically contains
none of them.

Two known costs, both deliberate:

- Pushing either branch makes the *other* branch's Vercel project fail instantly, because
  the root directory it wants is not there. Cosmetic, no build minutes, nothing served.
- Cross-target publishes are not atomic. One target can land while the other refuses, and
  each divergence gate only compares a copy against what the agent last published for that
  target — so neither can see the mismatch. The ticket comment says so explicitly when it
  happens.

Both disappear in the end state recorded in the design doc: two repositories, one
public-safe and one private, each with a single branch, so the boundary is a repository
permission rather than a branch convention.

## Status

- [x] Core: vault, LLM client (Anthropic API **or** Claude on Vertex AI), audit log, config
- [x] Scribe: contract, draft (vision), lint, revise, lesson store/distiller, publish
- [x] Scribe on Jira: poll → contract → draft → feedback → approve → publish → lesson gate
- [x] Mention-only intake: the poller watches the whole project; the `doc-request` label
      decides whether Scribe drafts unprompted, and an unlabelled ticket is adopted in
      silence until someone mentions it
- [x] Self-healing ledger: a restart reconstructs from the ticket instead of re-greeting,
      and only comments newer than the agent's own last comment are replayed
- [x] Curator: organizer + MOC, watcher, grounded Q&A with citations, gap notes
- [x] Cross-surface loop: gap note → Jira doc request
- [x] Publish → organize hook (cross-link + re-index on approval)
- [x] Egress: allowlisted push to the docs repo, fail-closed staging, divergence refusal,
      per-ticket branch + pull request whose merge publishes
- [x] Ingress: `/health`, `/jira/webhook/<secret>`, `/github/webhook` (HMAC), with the
      poller as the reconciler behind it
- [x] Round trip: internal notes come back into the vault; an edit to a published doc is
      reported on its ticket rather than imported over the source
- [x] Slack: publish announcements (Curator) and draft-approval buttons (Scribe)
- [x] Second sample PRD demonstrating lesson transfer (`samples/prd-002-subscriber-management.md`)
- [x] Docs repo + both site builds: Astro Starlight (external, `docs/`) and Quartz
      (internal, `internal/` — wikilinks, backlinks, graph). Both builds verified locally;
      settings and the human steps are in `sloweyyy/scriptorium-vault`'s README
- [x] Deployed: Cloud Run, one instance, CPU always allocated, GCS-mounted state, secrets
      from Secret Manager, no credential file in the image
- [x] Webhooks live in production: GitHub's signed `ping` delivered `202`, and the Jira
      route answers a probe from the public internet while doing no work
- [x] Both sites live: public docs at the base branch, internal graph behind HTTP Basic
      (Vercel's own Deployment Protection is a paid feature, so the gate is in the project)
- [x] Jira webhook registered in the UI, HMAC-signed and verified in production
- [x] The board is the state machine: To Do → In Progress → In Review → Done, driven by
      the agent, best-effort so a workflow missing a column still gets its draft
- [x] Slack, live: an `:eyes:` acknowledgement, a progress line that updates in place and
      is deleted when the answer lands, Slack's own mrkdwn dialect, and citations that
      resolve — a retrieved page to its `source_url`, an approved doc to the public site,
      a PRD or house rule to the internal one
- [x] `vault_overview`: questions about the knowledge base itself are answered from an
      inventory, not refused. A librarian is the authority on its own shelves, and "how
      many docs do you have?" is not a documentation gap
- [ ] Demo video

### On the model provider

The system runs on Gemini through Vertex AI. It was designed around Claude and still
supports it — Anthropic's API and Claude on Vertex are both wired — but this project's
per-base-model quota for the Anthropic models was requested and **denied**, so Claude on
Vertex cannot serve a request here regardless of waiting.

That is worth stating as a design outcome rather than an apology. Every guarantee in this
repo — the input contract, the deterministic lint, the approval gate, the allowlisted
publish, the human-approved lesson store, cite-or-refuse retrieval — is a property of the
pipeline, not of the model, and all of them hold with a different model underneath.
Curator's grounded Q&A was written against Claude's tool runner; adding Gemini meant a
second transport of about eighty lines, because the prompt, both retrieval tools, the read
cap, the citation rule and the refusal rule live in one shared module. Switching back is
one line of configuration.

### What is verified, and how

119 evals, none of which need a model or a credential: `git clone`, `pnpm install`,
`pnpm eval`, green. They cover the guardrails — contract refusal, the lint, the ledger and
its restart behaviour, the board transitions, the publish allowlist and its divergence
refusal, the ingress signatures, the Slack dialect, citation resolution, the boot restore.

Live in production, not just in tests: a ticket worked end to end from PRD to a published
doc and a pull request; an approval recorded against a named human; a question answered in
Slack with citations; and an unanswerable question that filed a gap note, opened a Jira
ticket, and was picked up by Scribe on the other surface without anyone prompting it.
