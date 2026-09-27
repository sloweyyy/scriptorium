# scriptorium

**Two agents that turn PRDs and wireframes into governed product documentation — with
humans as the quality gate, and every learned behaviour auditable.**

- **Scribe (Agent A)** works a **Jira** ticket end to end: reads the PRD and wireframes off
  the issue, checks them against an input contract, posts a draft in the comment thread,
  revises from plain-English feedback, publishes only on human approval — then proposes a
  **lesson**, a house rule that improves every future doc, which a human also approves.
- **Curator (Agent B)** watches the incoming PRDs, designs and published docs; organizes
  them into an Obsidian-compatible **vault** (frontmatter, wikilinks, index); answers
  questions in **Slack** only from the vault, **with citations** — and when it cannot, files
  a gap note *and opens a Jira doc request*, which becomes Scribe's next job.

Two agents, one chassis: one process, one vault, one append-only audit log, two identities.
The split sits exactly where the permission boundary is — Scribe may author product claims,
under a human gate; Curator may never author, only organize and retrieve. Author ≠ archivist
≠ approver.

**And underneath both, a governed-teammate platform.** Scribe and Curator are the first
jobs; the engine is general. A third agent, the **Teammate**, answers from Confluence, Jira
and the vault with citations in Slack, turns a thread into a ticket, and checks a ticket for
readiness. The same guarantees hold for every agent: every tool call passes one policy check,
every write waits for a named approver, and every factual answer cites a record a tool
actually returned. See [The platform](#the-platform).

---

## The two repositories

The system is deliberately split into the **agents** and the **content they produce**, so
that the boundary between "what the code may do" and "what is published" is a repository
permission and not a convention inside one tree.

| Repository | What it holds | Who writes it |
|---|---|---|
| **[`sloweyyy/scriptorium`](https://github.com/sloweyyy/scriptorium)** (this repo) | The two agents, the pipeline, the guardrails, the eval suite, the deployment. Plus the working `vault/` and the demo corpus. | humans (the engineer) |
| **[`sloweyyy/scriptorium-vault`](https://github.com/sloweyyy/scriptorium-vault)** | The published output: the public docs tree, the internal vault tree, and the two static sites that serve them. No application code. | the agent, by `git push` — and a human, by merging its pull request |

Both are private. The content repo's README covers the branch layout, the two site builds
and the Basic-auth gate:
**[scriptorium-vault → README](https://github.com/sloweyyy/scriptorium-vault#readme)**.

```
   scriptorium (this repo)                          scriptorium-vault (content)
   ───────────────────                          ───────────────────────
   Scribe   ─── approved doc ──▶ per-ticket branch ─▶ PR ─▶ human merges ─▶ main
   Curator  ─── vault notes ───────────────────────────────────────────▶ vault-live
                                                        │                    │
                                                Astro Starlight        Quartz (wikilinks,
                                                 public site           backlinks, graph)
                                                                       behind Basic auth
```

## See it running

| Surface | Where | Note |
|---|---|---|
| Public docs site | https://scriptorium-vault.vercel.app/ | 13 docs, every one published through a human-merged pull request |
| Internal vault site | https://scriptorium-vault-internal.vercel.app/ | PRDs, gap notes, house rules, graph view. HTTP Basic — credentials come with the invite, never in a repo |
| Jira board (project `DOC`) | https://slowey.atlassian.net/jira/software/projects/DOC/boards/1 | Where Scribe works. This is the surface to exercise |
| Pull requests | https://github.com/sloweyyy/scriptorium-vault/pulls?q=is%3Apr+is%3Aclosed | 14 merged: 12 opened by the agent's own GitHub App identity, all 14 merged by a human |
| Source history | https://github.com/sloweyyy/scriptorium/commits/main/ | |

Agent A runs continuously on Cloud Run, so a ticket worked at any hour gets an answer
without anyone starting a process.

## Try it yourself in five minutes

Nothing to install — this is the reviewer's path, on the live Jira board.

1. **Create an issue** in project `DOC` and label it **`doc-request`**. Give it a PRD in
   whichever form is natural (checked in this order):
   - a `.md` file attached to the ticket,
   - a **Confluence page** linked to the ticket, or its URL in the description,
   - the PRD written straight into the issue description.

   Wherever it lives, it must state `feature`, `audience` and `user_goal` — as YAML
   frontmatter, as labelled lines (`Audience: workspace admins`), or as headings with the
   answer underneath. Nothing else is guessed. Wireframes attach as PNG/JPEG/WEBP/GIF and
   are actually read.
2. **Within ~15 seconds**, Scribe comments: the contract questions if the PRD is incomplete,
   otherwise a draft (in the comment *and* attached as `.md`), its lint result, and which
   house rules it applied. Leave out `user_goal` on purpose to see the refusal — it names
   what is missing instead of guessing.
3. **Comment feedback** in plain English — "the timezone is never stated", "warn before the
   irreversible step". It revises and posts again.
4. **Comment `approve`**, or drag the issue to **Done**. Only then does it publish: the doc
   lands in the vault, Curator cross-links and re-indexes it, a pull request opens against
   the content repo, and the commit records *your* name as the approver.
5. **It then proposes a lesson** distilled from your feedback. `approve lesson L-007` makes
   it a house rule applied to every future draft; `reject lesson L-007` marks it rejected and
   records who rejected it, keeping the note as evidence that the rule was judged rather than
   silently dropped. The next ticket's draft comment lists the rules it applied — that is the
   learning loop, visible.

`help` in a comment prints the same list. **Nothing publishes without step 4.**

## How it works

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

The bottom line of that diagram is the part worth watching, because it is the part that
usually does not exist. A question Curator cannot ground in a citation does not get a
plausible answer: it produces a gap note in `_gaps/`, opens a Jira doc request, and Scribe
picks that up on the other surface with nobody prompting it. That round trip has run live —
question asked in Slack, ticket opened, draft posted, doc published — and the gap notes that
are still open are visible on the internal site.

## The platform

The docs pipeline's guarantees, generalized so any agent inherits them. An agent is
configuration — identity, a tool → tier map, skills, triggers — not a new bot.

```
 Slack · Jira · Confluence · GitHub · cron
        │  verify signature · normalize
        ▼
  AgentEvent ──▶ Gate (every refusal logged with its reason)
        ▼
  one lane per conversation (thread · ticket · page · PR), parallel across them
        ▼
  agent = config + skills/*.md ──▶ runSession (Claude | Gemini, fails closed)
        ▼
  POLICY: allow · approve · deny — per agent, per tool
        │                         └──▶ approval card (Slack) → named approver → run once
        ▼
  connectors (allow-listed, reads included) · exactly-once effects (op-keys)
        ▼
  grounding check: no retrieved citation → no claim   ·   audit log + git
```

| Guarantee | Where it is enforced |
|---|---|
| Every tool call passes one policy check; unlisted tools are denied and not even offered | `packages/policy` (`runUnderPolicy`, `guard`), `packages/runtime/src/agent.ts` |
| An approval belongs to a named, listed human, is single-use, and covers only the exact arguments shown | `packages/policy/src/approvals.ts` |
| No citation, no claim — for vault notes, `confluence:<id>` and `jira:<KEY>` alike | `packages/curator/src/qa-contract.ts` (`enforceGrounding`) |
| A capped, truncated, refused or empty model turn is an error with a reason, never half an answer | `packages/runtime/src/session.ts` |
| A crash between "did it" and "recorded it" never doubles a write | `packages/runtime/src/effects.ts` + op-keys on Jira comments / Slack replies |
| Connectors see only allow-listed projects, spaces and channels; the model writes words, never JQL/CQL | `packages/connectors` |
| Tool output is data, never instructions — in every agent's system prompt, whatever its skills say | `packages/runtime/src/agent.ts` |

The full threat model, layer by layer and with the eval behind each control, is in
[`docs/security-model.md`](docs/security-model.md); the invariants and package map in
[`docs/architecture.md`](docs/architecture.md); adding a skill, tool, connector or agent in
[`docs/extending.md`](docs/extending.md); operating it in [`docs/runbook.md`](docs/runbook.md).

**The Teammate** (`apps/agents/src/teammate-bot.ts`, `slack-manifests/teammate.yaml`) is the
general agent on it. Skills are markdown in [`skills/`](skills/). It answers only in
`TEAMMATE_SLACK_CHANNELS`, and every write — a Jira comment, issue or edit, a Confluence page, a
memory — posts an approval card that a `TEAMMATE_APPROVERS` click carries out exactly once.

| Job | How |
|---|---|
| Cited answers across the vault, Confluence and Jira | `answer-with-citations`; uncited claims are refused, misses become gap tickets (deduped) |
| What did I miss? | `channel-catchup`; reads the channel it was asked in (up to 72h, on demand, nothing kept): decided / still open / waiting on you, each point cited to its message |
| Thread → Jira ticket | `thread-to-ticket`; reads the thread it was asked in, proposes the issue on a card |
| Is this ticket ready? | `readiness-check`; verdict plus what is missing, cited |
| Remember this | `remember`; scoped memory (person / channel / global), human-approved, never reaches published docs |
| Weekly digest | `weekly-digest`; what moved in Jira and which doc gaps opened, posted once per week to `TEAMMATE_DIGEST_CHANNEL` |
| Find the right spec page | `confluence_page_children` walks a page tree; every child is checked against the allowed spaces, so a page moved elsewhere isn't even listed |
| Docs into Confluence | `confluence_create_page` / `confluence_update_page`, approve-tier, allowed spaces only |
| Move, assign, label, link Jira issues | `jira_transition` / `jira_assign` / `jira_labels` / `jira_link`, approve-tier, allowed projects only (both ends of a link); an assignee must match exactly one person |
| Status update for an epic | `status-update`; what shipped, what's in flight, what's at risk — every line cited, posted only on approval |
| Triage new tickets | `triage`; in `TEAMMATE_TRIAGE_PROJECTS`, a new issue gets one reply: ready or not, what's missing, likely duplicates (cited); rate-capped per project, changes nothing |
| Ready to start? (on assignment) | assigning a ticket to the Teammate runs `readiness-check` and replies on the ticket |
| Release notes | `release-notes`; what merged into an allowed repo since a date (`github_list_merged`), grouped new / improved / fixed, every line cited to its PR; published only on approval |
| Check a PR against its ticket | `pr-check`; on request or automatically when a PR opens, acceptance criteria covered or not, doc drift flagged, one advisory comment behind a card |

**What keeps the docs honest after they ship.** A published doc records its PRD's hash; if
the PRD changes later, the ticket it was approved on gets one notice per change. A house rule
can carry a check (`check_present` / `check_absent`), so a draft shows `L-001 ✓, L-002 ✗`
— applied is not the same as obeyed — and `revoke lesson L-00N` withdraws a rule on the
record. With `SCRIPTORIUM_SIGNING_KEY` set, approvals are signed and a restore from the
docs repo cannot forge one.

**MCP.** `pnpm mcp` serves the vault read-only over stdio — `search_vault`, `read_note`,
`vault_overview`, and a grounded `ask` — for Claude Code, Claude Desktop or an IDE:

```bash
claude mcp add scriptorium -- pnpm --dir /path/to/scriptorium mcp
```

**Tracing.** Every agent reply ends with its run id; `pnpm trace 3f2a9c1b` prints what that
run did — trigger, policy decisions, tool calls, approvals, reply — from the audit log.

## Why it is built this way

- **Learning = human-gated lessons, not fine-tuning.** Feedback that generalizes becomes a
  markdown rule with provenance (author, source ticket, date, scope) in `vault/_lessons/`,
  applied to future drafts and listed in each draft's comment. Auditable, revocable (delete
  the file), reviewable (a human approves what the system is allowed to learn). Six have been
  proposed and judged so far — three approved, two rejected, one still waiting — and each file
  names the ticket and the person it came from. The rejections matter as much as the
  approvals: they are what a gate that is actually load-bearing looks like.
- **Machines gate the deterministic; humans gate claims.** Lint catches placeholders,
  missing sections and glossary violations — and gets one automatic self-correction round
  before a human is asked to read anything. Humans approve publishes. Fail-closed.
- **Input contract before generation.** A PRD missing `feature`/`audience`/`user_goal` gets
  questions back, not a guessed draft.
- **Grounded Q&A or nothing.** Curator answers only from retrieved notes, cites each one,
  and files a gap note instead of improvising.
- **Files + git as the system of record.** The vault is a plain Obsidian folder; `git log`
  is the tamper-evident history of who approved what. No database.
- **Surfaces are adapters, not architecture.** Jira and Slack are transports around the same
  pipeline; `packages/jira` is ~500 lines and the pipeline did not change to gain it.

### Why Jira for Agent A and Slack for Agent B

Documentation work is ticketed work: it has one owner, a review thread, an approval state and
attachments — all of which Jira already models, so the approval gate is a workflow transition
instead of something this system invents. Q&A is conversational and belongs where people
already ask, which is Slack. The loop closes across both: an unanswered Slack question becomes
a Jira doc request automatically.

**Polling, not webhooks.** A 15s JQL poll needs no public endpoint, so the agent runs
identically on a laptop, in a container, or behind a corporate firewall — which matters for
regulated deployments. Webhooks are a latency optimization the same handler can take later
(both are registered and verified in production); idempotency — a processed-comment ledger —
is what makes either safe, and that is already there.

### Why two agents rather than one

Identity is split exactly where the permission boundary is. Scribe may author product claims,
under a human gate; Curator may never author, only organize and retrieve. Same chassis, same
vault, same audit log — the second identity costs one manifest and a handful of lines, and
buys segregation of duties that an auditor can see.

### Why the output lives in a second repository

An agent that can push to the repository holding its own code can change its own guardrails.
Splitting the content out means the publish path is a repo-scoped deploy key that reaches
nothing but documentation, and the boundary is enforced by GitHub rather than by good
behaviour. It also gives the reviewable artifact a natural home: approved docs land on a
per-ticket branch and reach the public site only when a human merges the pull request. The
agent never pushes `main`.

## What is verified, and how

**413 scripted checks, none of which need a model or a credential:** `git clone`,
`pnpm install`, `pnpm eval`, green (`RUN_LLM_EVALS=1` adds five live grounded-Q&A checks on
whichever provider is configured). They cover the guardrails rather than the prose — contract
refusal, the lint, the ledger and its restart behaviour, the board transitions, the publish
allowlist and its divergence refusal, the ingress signatures, the Slack dialect, citation
resolution, the boot restore.

**Live in production, not only in tests.** A ticket worked end to end from PRD to a published
page and a pull request; an approval recorded against a named human; a question answered in
Slack with citations; an unanswerable question that filed a gap note, opened a Jira ticket,
and was picked up by Scribe on the other surface with nobody prompting it. Concretely, today:
13 docs on the public site, each arriving through a merged pull request; 14 merged pull
requests, 12 of them opened by the agent's own GitHub App identity and every one merged by a
human; six house rules proposed and judged (3 approved, 2 rejected, 1 pending); four gap
notes, each carrying the Jira ticket it opened (`DOC-9`, `DOC-21`, `DOC-30`, `DOC-33`); both
webhooks answering signed requests from the public internet; and the board driving
`To Do → In Progress → In Review → Done`.

What is **not** done: the demo video.

### On the model provider

The system runs on Gemini through Vertex AI. It was designed around Claude and still supports
it — Anthropic's API and Claude on Vertex are both wired — but this project's per-base-model
quota for the Anthropic models was requested and **denied**, so Claude on Vertex cannot serve
a request here regardless of waiting.

That is worth stating as a design outcome rather than an apology. Every guarantee in this repo
— the input contract, the deterministic lint, the approval gate, the allowlisted publish, the
human-approved lesson store, cite-or-refuse retrieval — is a property of the pipeline, not of
the model, and all of them hold with a different model underneath. Curator's grounded Q&A was
written against Claude's tool runner; adding Gemini meant a second transport of about eighty
lines, because the prompt, both retrieval tools, the read cap, the citation rule and the
refusal rule live in one shared module. Switching back is one line of configuration.

## Repo map

| Path | What |
|---|---|
| `packages/core` | LLM client (Anthropic API, Claude on Vertex, or Gemini), vault (frontmatter/wikilinks), append-only audit log, config |
| `packages/scribe` | contract → draft → lint → revise → publish; lesson store + distiller |
| `packages/curator` | inbox watcher, organizer/MOC, BM25 index, tool-runner Q&A, gap notes |
| `packages/jira` | REST v2 client, wiki-markup translation, comment commands, poller state |
| `packages/policy` | allow / approve / deny per agent and tool; approvals bound to the exact arguments |
| `packages/runtime` | event model, gate, per-conversation queue, exactly-once effects, the fail-closed session loop, agents-as-config |
| `packages/connectors` | Confluence, Jira and Slack as allow-listed agent tools; the Slack approval card |
| `skills/` | what agents know how to do, as reviewable markdown |
| `apps/agents` | the surfaces: Jira poller (Scribe), Socket-Mode bots (Curator, Teammate, thin Scribe), the MCP server |
| `vault/` | the knowledge vault — open it in Obsidian |
| `samples/` | fictional "Beacon" PRDs + wireframes for the demo |
| `evals/` | scripted checks for every guardrail |

## Run it locally

```bash
pnpm install
cp .env.example .env          # provider key + the Jira block (Slack optional)
pnpm jira:doctor              # verifies auth, JQL, comments, attachments, transitions
pnpm seed:corpus              # optional: load a reference corpus from corpus/ into the vault
pnpm dev                      # vault watcher + Jira poller + any Slack bot with tokens
```

No tokens at all? `pnpm dev` runs in **local mode**: drop a file into `vault/_inbox/` and
watch Curator classify, file, link and re-index it.

Run the Scribe pipeline with no surface attached:

```bash
pnpm render:wireframes        # SVG -> PNG (once)
pnpm draft samples/prd-001-scheduled-maintenance.md samples/wireframes/*.png
pnpm draft samples/prd-003-incomplete.md   # → refused: the contract asks for what is missing
```

Checks:

```bash
pnpm typecheck
pnpm eval                     # 413 checks, no API key needed
RUN_LLM_EVALS=1 pnpm eval     # + live checks (grounded Q&A, handoff, red team, hybrid golden set)
```

### Jira setup (Agent A, ~5 minutes)

1. Create a free Jira Cloud site and a project (key `DOC` in the examples).
2. Create a dedicated service account for the agent, display-named **Scribe** — the name is
   what every ticket thread shows, and the agent must be able to tell its own comments from a
   human's, which a shared account makes impossible. Create its API token at
   [id.atlassian.com → Security → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
   and put `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY` in `.env`.
3. Add a status named **Approved** to the project's workflow (optional — an `approve` comment
   does the same thing; set `JIRA_APPROVED_STATUS` if you name it differently). The agent also
   drives the columns in between when they exist: `JIRA_IN_PROGRESS_STATUS` (default
   `In Progress`) while it is drafting or revising, and `JIRA_IN_REVIEW_STATUS` (default
   `In Review`) once a draft is posted and the next move is a human's. Every move is
   best-effort — a workflow without those columns still gets its draft, in a comment.
4. `pnpm jira:doctor` — it reports which search endpoint your site answers on, what the
   poller's JQL matches, and whether the approval transition exists. `pnpm jira:doctor --write`
   also proves comment + attachment permissions.
5. `pnpm dev`. The poller picks up every issue in the project labelled `doc-request`.

A Confluence PRD is read with the same API token, so the agent's account needs Confluence
access on the site; a later edit to the page is picked up by commenting `draft`.

### Slack setup (Agent B, ~3 minutes)

1. Use a **fresh demo workspace** (not a work workspace).
2. https://api.slack.com/apps → *Create New App* → *From a manifest* → paste
   `slack-manifests/curator.yaml`. (`scribe.yaml` is optional — the Slack Scribe is a thin
   contract-check surface; Jira is where Agent A actually works.)
3. **Install to workspace**; copy the *Bot User OAuth Token* (`xoxb-…`); under *Basic
   Information → App-Level Tokens* create one with `connections:write` (`xapp-…`). Fill
   `CURATOR_SLACK_BOT_TOKEN` / `CURATOR_SLACK_APP_TOKEN` in `.env`.
4. `pnpm dev`, invite Curator to a channel, then `@Curator <question>` → a grounded answer
   with `[[citations]]`, or a filed gap note **plus a new Jira doc request**.

Live behaviour worth watching: an `:eyes:` acknowledgement, a progress line that updates in
place and is deleted when the answer lands, Slack's own mrkdwn dialect, and citations that
resolve — a retrieved page to its `source_url`, an approved doc to the public site, a PRD or
house rule to the internal one.

## Reference material

Curator can also answer from retrieved reference pages. Put markdown files in `corpus/`,
each with a `title` and the `source_url` it came from, and `pnpm seed:corpus` files them into
`vault/reference/` — deliberately **not committed**, since the retrieved pages are the record
and the vault copy is derived. No corpus ships with this repo; without one, Curator answers
from the Beacon docs, PRDs and lessons in the vault, and anything they do not cover becomes a
gap note and a Jira doc request.

## Deploy it

The container runs both surfaces in one process; neither needs inbound traffic for Slack
(Socket Mode dials out), and the health port plus the Jira/GitHub webhooks are the only things
served.

```bash
docker build -t scriptorium .
docker run --env-file .env -p 8080:8080 scriptorium
```

### Cloud Run

Three properties matter and are easy to get wrong:

- **`--max-instances=1`.** The processed-comment ledger is per-instance state. Two instances
  means two ledgers, duplicate drafts and duplicate publishes.
- **`--no-cpu-throttling`.** Cloud Run throttles CPU between requests, so a warm instance is
  not a running one and the `setInterval` poller would only fire when a request happened to
  wake it. This bills continuously — that is the cost of having a reconciler.
- **Workload identity, not a key file.** The service runs as a service account holding
  `roles/aiplatform.user`, so the model on Vertex authenticates with no credentials file in the
  image. `GOOGLE_APPLICATION_CREDENTIALS` is a local-development convenience only.

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

The GCS volume is what makes the ledger survive a restart: without it, every ticket looks like
first sight again and the agent re-greets and re-drafts work it already did.

**Do not put the docs-repo work tree on that volume.** `DOCS_REPO_WORKDIR` must point at local
disk (`/tmp/docs-repo`). A GCS FUSE mount has no hardlinks and weak rename/lock semantics, so
`git clone` into it fails — and the failure surfaces as a publish that wrote the vault copy but
never reached the repo. The clone is scratch: it is re-created from the remote on every boot, so
it needs no persistence at all.

**The deploy key is mounted read-only 0444,** and ssh refuses a private key that is group- or
world-readable — `chmod` on a Secret Manager mount is not available. The agent copies the key
once per process to a 0600 path under `TMPDIR` and points `GIT_SSH_COMMAND` at the copy. Nothing
to configure; it is noted because the failure surfaces as `Permission denied (publickey)`, which
reads like a wrong key.

**Claude on Vertex** additionally requires the Anthropic models to be enabled in Model Garden
for the project, and online-prediction quota for the base model
(`aiplatform.googleapis.com/global_online_prediction_requests_per_base_model`, dimension
`base_model=anthropic-claude-opus`). A fresh project starts at zero and the increase is
requested per base model — `gcloud alpha quotas preferences create`.

## Where the docs land

[`sloweyyy/scriptorium-vault`](https://github.com/sloweyyy/scriptorium-vault) holds the output as two
branches, each owning exactly one content tree and one site build:

| Branch | Content | Site | Who writes it |
|---|---|---|---|
| `main` | `docs/` — approved, public | Astro Starlight, public | a human merging a pull request |
| `vault-live` | `internal/` — PRDs, gap notes, house rules, index | Quartz, Basic-auth gated | the agent, on approval |

The agent never pushes `main`. Approved docs land on a per-ticket branch and reach `main` only
when a human merges — GitHub offers no branch protection on a private repo on the free plan, so
making the merge gate a property of what the agent *does* is stronger than relying on what its
token is forbidden to do.

**A doc therefore exists twice in that repo**, transformed for the public site and untransformed
for the graph. Those are two derived renderings of one vault note, not two sources: the vault is
the source, and a human edit to either copy is detected by the divergence gate and reported on
the originating ticket rather than absorbed. Publishing once and filtering at build time would
give a single copy, but then the only thing keeping internal notes off the public site is a build
script — today `main` physically contains none of them.

Each branch carries the site it serves plus a deployments-off stub of the other, because
Vercel clones *both* projects on every push and a project whose root directory is missing
fails before any ignore rule can run. The stub is three lines of `vercel.json` and a README
explaining itself.

One known cost remains, and it is deliberate: cross-target publishes are not atomic. One
target can land while the other refuses, and each divergence gate only compares a copy
against what the agent last published for that target — so neither can see the mismatch. The
ticket comment says so explicitly when it happens.

It disappears in the end state recorded in the design doc: two content repositories, one
public-safe and one private, each with a single branch, so the boundary is a repository
permission rather than a branch convention.

The site builds, the Vercel settings, the Basic-auth gate and the human steps involved in any of
it are documented where they live:
**[scriptorium-vault → README](https://github.com/sloweyyy/scriptorium-vault#readme)**.

## Conventions

TypeScript strict, ESM, no build step — `tsx` runs source; workspace packages export
`./src/index.ts`. `pnpm typecheck` and `pnpm eval` stay green before every commit. Sample
content is the fictional "Beacon" product; no
employer-internal or customer content is in this repo or the vault.
