# The docs pipeline: Scribe and Curator

scriptorium began as two agents that turn PRDs and wireframes into governed product
documentation. They still ship, running on the same engine as the Teammate.

- **Scribe** works a **Jira** ticket end to end. It reads the PRD and wireframes off the
  issue, checks them against an input contract, and posts a draft in the comment thread. It
  revises from plain-English feedback and publishes only after a human approves. Then it
  proposes a **house rule** that improves every future doc, which a human also approves.
- **Curator** watches incoming PRDs, designs and published docs, and organizes them into an
  Obsidian-compatible **vault** (frontmatter, wikilinks, an index). It answers questions in
  **Slack** only from the vault, **with citations**. When it can't answer, it files a gap
  note *and opens a Jira doc request*, which becomes Scribe's next job.

The split sits where the permission boundary is. Scribe may author product claims, under a
human gate. Curator may never author; it only organizes and retrieves.

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

The bottom line of that diagram is the part worth watching, because it usually doesn't
exist. When Curator can't ground an answer in a citation, it doesn't give a plausible guess.
It writes a gap note in `_gaps/` and opens a Jira doc request, and Scribe picks that up on the
other surface without anyone prompting it.

## Working a ticket

1. **Create an issue** in your docs project and label it **`doc-request`**. Give it a PRD in
   whichever form is natural. Scribe checks them in this order:
   - a `.md` file attached to the ticket,
   - a **Confluence page** linked to the ticket, or its URL in the description. The link must be
     on your own Atlassian site, and the page in a space listed in `SCRIBE_CONFLUENCE_SPACES`
     (falling back to `TEAMMATE_CONFLUENCE_SPACES`). With neither set, no Confluence page is
     read, so a ticket can't make Scribe quote a page its author can't see,
   - the PRD written straight into the issue description.

   Wherever it lives, the PRD must state `feature`, `audience` and `user_goal`. Any of these
   forms works: YAML frontmatter, labelled lines (`Audience: workspace admins`), or headings
   with the answer underneath. Nothing else is guessed. Wireframes attach as
   PNG/JPEG/WEBP/GIF, and Scribe reads them.
2. **Within about 15 seconds**, Scribe comments. If the PRD is incomplete, it asks the contract
   questions and names what is missing. Otherwise it posts a draft (in the comment *and*
   attached as `.md`), its lint result, and the house rules it applied.
3. **Comment feedback** in plain English, for example "the timezone is never stated" or "warn
   before the irreversible step". Scribe revises and posts again.
4. **Comment `approve`**, or move the issue to your approved status. Only then does it
   publish:
   - the doc lands in the vault;
   - Curator cross-links it and re-indexes;
   - a pull request opens against the content repo;
   - the commit records the approver's name.
5. **Scribe then proposes a lesson** distilled from the feedback. `approve lesson L-007` makes
   it a house rule applied to every future draft. `reject lesson L-007` records who rejected
   it and keeps the note as evidence that the rule was judged, not silently dropped.

`help` in a comment prints the commands. **Nothing publishes without step 4.**

## What keeps the docs honest after they ship

- **PRD changes are noticed.** A published doc records its PRD's hash. If the PRD changes
  later, the ticket it was approved on gets one notice per change.
- **Applied is not the same as obeyed.** A house rule can carry a check (`check_present` /
  `check_absent`), so a draft shows `L-001 ✓, L-002 ✗`.
- **Rules can be withdrawn.** `revoke lesson L-00N` withdraws a rule, on the record.
- **Approvals can't be forged.** With `SCRIPTORIUM_SIGNING_KEY` set, approvals are signed,
  so restoring from the docs repo can't create one.

## Why it is built this way

- **Learning means human-gated lessons, not fine-tuning.** Feedback that generalizes becomes
  a markdown rule in `vault/_lessons/`. Each rule records where it came from (author, source
  ticket, date, scope). Rules are applied to future drafts and listed in each draft's comment.
  They are auditable, revocable, and a human approves what the system is allowed to learn.
- **Machines gate the deterministic; humans gate claims.** Lint catches placeholders, missing
  sections and glossary violations, and gets one automatic self-correction round before a
  human reads anything. Humans approve publishes.
- **Input contract before generation.** A PRD missing `feature`/`audience`/`user_goal` gets
  questions back, never a guessed draft.
- **Files and git are the system of record.** The vault is a plain Obsidian folder, and
  `git log` is the tamper-evident history of who approved what. No database.
- **Jira for authoring, Slack for questions.** Documentation work is ticketed work: one
  owner, a review thread, an approval state, attachments. Jira already models all of that, so
  the approval gate is a workflow transition. Q&A is conversational and belongs where people
  already ask. The loop closes across both surfaces.
- **Polling first, webhooks as an optimization.** A 15-second JQL poll needs no public
  endpoint, so the agent runs the same on a laptop, in a container, or behind a corporate
  firewall. Signed webhooks are also supported. Idempotency (a processed-comment ledger) is
  what makes either safe.
- **The output lives in two other repositories.** An agent that can push to the repository
  holding its own code can change its own guardrails. So published docs go to a docs repo,
  which may be public, and the internal plane (PRDs, gaps, house rules) goes to a separate
  private vault repo. Each repo gets its own repo-scoped deploy key, which reaches nothing but
  that repo. Approved docs reach the public site only when a human merges the pull request;
  the agent never pushes the docs repo's `main`. See [deploy.md](deploy.md#where-the-docs-land).

## Setup

### Jira (Scribe, about 5 minutes)

1. Create a Jira Cloud site and a project (key `DOC` in the examples).
2. Create a dedicated service account for the agent, with the display name **Scribe**. The
   name is what every ticket thread shows. The agent must also tell its own comments from a
   human's, which a shared account makes impossible. Create its API token at
   [id.atlassian.com → Security → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens),
   and put `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` and `JIRA_PROJECT_KEY` in `.env`.
3. Optionally, add a status named **Approved** to the project's workflow. An `approve`
   comment does the same thing. Set `JIRA_APPROVED_STATUS` if you name it differently.
   The agent also moves tickets through the columns in between when they exist:
   - `JIRA_IN_PROGRESS_STATUS` (default `In Progress`) while it is drafting or revising;
   - `JIRA_IN_REVIEW_STATUS` (default `In Review`) once a draft is posted and a human needs
     to act.

   These moves are best-effort: a workflow without those columns still gets its draft, in a
   comment.
4. Run `pnpm jira:doctor`. It reports which search endpoint your site uses, what the poller's
   JQL matches, and whether the approval transition exists. `pnpm jira:doctor --write` also
   proves comment and attachment permissions.
5. Run `pnpm dev`. The poller picks up every issue in the project labelled `doc-request`.

Scribe reads a Confluence PRD with the same API token, so its account needs Confluence access
on the site. To pick up a later edit to the page, comment `draft`.

### Slack (Curator, about 3 minutes)

1. Use a workspace you can install apps in. A fresh demo workspace is easiest.
2. Go to https://api.slack.com/apps → *Create New App* → *From a manifest*, and paste
   `slack-manifests/curator.yaml`.
3. **Install to workspace** and copy the *Bot User OAuth Token* (`xoxb-…`). Under *Basic
   Information → App-Level Tokens*, create one with `connections:write` (`xapp-…`). Put them
   in `CURATOR_SLACK_BOT_TOKEN` and `CURATOR_SLACK_APP_TOKEN` in `.env`.
4. Run `pnpm dev`, invite Curator to a channel, then ask `@Curator <question>`. You get a
   grounded answer with citations, or a gap note **plus a new Jira doc request**.

### Reference material

Curator can also answer from retrieved reference pages. Put markdown files in `corpus/`, each
with a `title` and the `source_url` it came from. `pnpm seed:corpus` files them into
`vault/reference/`. That folder is not committed, because the retrieved pages are the record
and the vault copy is derived from them.

### Without a surface

```bash
pnpm render:wireframes        # SVG -> PNG (once)
pnpm draft samples/prd-001-scheduled-maintenance.md samples/wireframes/*.png
pnpm draft samples/prd-003-incomplete.md   # refused: the contract asks for what is missing
```

With no tokens at all, `pnpm dev` runs in local mode. Drop a file into `vault/_inbox/` and
watch Curator classify, file, link and re-index it.
