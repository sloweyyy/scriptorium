# Security model

scriptorium's agents read text written by anyone who can reach a Jira ticket, a Confluence
page or a Slack channel. They can also write: comments, tickets, published docs, house rules,
memories. This document says what is trusted, what isn't, and which control stops each way
that could go wrong. Every control is backed by an eval that fails if the control is removed.

## Trust boundaries

| Trusted | Untrusted (data, never instructions) |
|---|---|
| This repository's code, `skills/*.md`, agent configs | PRD attachments, ticket descriptions and comments |
| Environment configuration (allow-lists, approver lists, secrets) | Confluence pages, design images and their filenames |
| A decision recorded by a listed approver, by account id | Slack messages and threads |
| | Anything a model writes, including its tool calls |
| | Webhook payloads, until their signature checks out |

The model is untrusted too. It proposes; the platform decides what runs.

## Layers

### 1. Ingress: only authentic, first-time events get in
- Jira webhooks need a secret path, plus an HMAC signature once one is configured. GitHub
  webhooks need `x-hub-signature-256`. Failures get 404 or 401 and do no work.
  (`apps/agents/src/ingress.ts`; `evals/ingress.test.ts`)
- Redeliveries are deduplicated on `X-Atlassian-Webhook-Identifier` / `X-GitHub-Delivery`,
  after the signature check, so a forgery can't poison a real delivery.
- The `Gate` drops the platform's own events, other bots' events and anything outside a
  source's configured scope, and every refusal is logged with its reason.
  (`packages/runtime/src/gate.ts`; `evals/runtime.test.ts`)

### 2. Parsing: input stays input
- Frontmatter is YAML only. gray-matter's `---js` engine would *execute* a PRD, so it is
  refused. (`packages/core/src/vault.ts`; `evals/frontmatter-safety.test.ts`)
- A PRD's own frontmatter keys are allow-listed before they reach the vault. A design's
  filename comes from its media type, not from what the uploader typed.
  (`evals/jira.test.ts`, "untrusted ticket input stays input")
- Commands are read only from the reviewer's own words. A quoted or code-block `approve` is
  not an approval, and an approval-shaped near-miss gets a question.
  (`packages/jira/src/commands.ts`; `evals/jira.test.ts`)

### 3. Prompting: untrusted text is fenced
- Every agent's system prompt says that tool output is data and must never be obeyed.
  Skills can't remove this. (`packages/runtime/src/agent.ts`; `evals/agent-config.test.ts`)
- Scribe's PRD, draft and feedback go in `<prd>`, `<draft>` and `<feedback>` fences that
  can't be closed from inside. (`packages/scribe/src/prompts.ts`; `evals/injection.test.ts`)

### 4. Policy: one check on every tool call
- Every tool is `allow`, `approve` or `deny`, per agent. Unlisted tools are denied and not
  even offered to the model. (`packages/policy`; `evals/policy.test.ts`)
- An approval belongs to a named, listed human. An empty approver list means *nobody*, and
  `["*"]` has to be chosen explicitly. It is never the agent itself, and under separation of
  duties never the requester. It is single-use, expires, and covers only the exact
  arguments that were shown, by hash, in the conversation that asked for them.
- Deciding and spending an approval are atomic. Two clicks decide once, two runs spend it
  once, and an action that fails gives its approval back.
- The card shows each argument on its own capped line, escaped and fenced, so model-written
  text can't render as a link or ping `@channel`. The argument hash is on the card.
- An approval request nobody can see is not requested: if the card can't be posted, the
  tool does not run.
- The same rules hold on every surface: Jira `approve` (`JIRA_APPROVERS`), a board move (an
  unattributable mover fails closed), the Slack buttons (`SCRIBE_SLACK_APPROVERS`, and a
  draft fingerprint on the card), and lesson decisions (only on the ticket that proposed
  them, and a rejection stands). (`evals/jira-board.test.ts`, `evals/slack-approval.test.ts`,
  `evals/lessons.test.ts`)
- An approval older than the current draft was given to an earlier draft, and it is held.

### 5. Blast radius: connectors see only what they are allowed to see
- Jira projects, Confluence spaces and Slack channels are allow-listed, reads included, and
  an empty list means none. A refused Confluence page leaks not even its title.
  (`packages/connectors`; `evals/*-connector.test.ts`)
- The model supplies words, never JQL or CQL. Its input is escaped into a string literal.
- There is no Slack search tool: an agent reads only the thread it was asked in, and the
  tool is bound to that thread. A memory can be scoped only to everyone, the current
  channel, or the asker. (`bindToTurn`; `evals/teammate-bot.test.ts`)
- `_memory/` is invisible to every retrieval tool, the overview and MCP. A memory reaches
  only its own scope's prompt. (`evals/memory.test.ts`)
- The vault path guard means nothing an agent writes lands outside the vault.
  (`evals/publish-record.test.ts`)
- The MCP server is read-only: it files no gaps and writes no notes.
  (`evals/mcp-server.test.ts`)
- Credentials live in connectors and never enter a prompt or a tool result.

### 6. Output: no citation, no claim
- Any factual answer must cite a record a tool actually *fetched* in this conversation.
  Evidence is what tools declare they fetched (`ToolSpec.records`, taken from validated
  input or JSON the tool built), never text inside their output. A page that merely
  mentions `jira:DOC-99` is not evidence for it, and a refusal that echoes an id isn't
  either. (`enforceGrounding`; `evals/grounding.test.ts`, `evals/teammate.test.ts`)
- Attempting a write never switches that check off. An uncited reply around a write is
  replaced by exactly what the write tools reported.
- The model loop fails closed: a capped, truncated, refused or empty turn raises an error;
  it is never half an answer. (`evals/session.test.ts`)
- Every reply says it is AI-generated and names its run.

### 7. Learning: nothing is learned without a human
- Scribe's house rules and the Teammate's memories are both proposals until a listed human
  approves them. Memories are scoped (global, channel or person) and never reach published
  docs. Curator's behaviour never changes with either.
  (`evals/lesson-gate.test.ts`, `evals/memory.test.ts`, `evals/curator-isolation.test.ts`)

- Approvals are signed with a deployment-only key, over the id, status, body, approver, scope
  and check, and they are verified wherever they're *used*. However an "approved" note got
  into the vault (a restore, a docs-repo webhook, a hand edit), it doesn't apply without a
  valid signature. (`packages/core/src/signing.ts`; `evals/approval-signing.test.ts`)

- A Jira comment restricted to a role or group, or marked internal in Jira Service
  Management, is answered at the same visibility. A restriction it can't read is not
  answered at all. An approval outcome is said on the ticket only at a visibility the
  process saw the request asked at. (`apps/agents/src/ingress.ts` `commentRestriction`;
  `evals/teammate-e2e.test.ts`, mutant in `scripts/mutate.ts`)

- A plan (`propose_plan`) is one approval for several writes, bound by the args hash to the
  ordered steps. It can only hold steps whose own rule is the plan's rule (same approvers,
  same separation of duties), so approving it is what approving each step would have been.
  A plan that breaks this is refused before a card exists. The card lists every step and
  every one of its arguments, and a plan too long for one card is refused, never cut. A
  plan that stops part-way says how many steps landed. Each step op-keys on the
  approval id plus its position, so a retry never repeats one. (`packages/policy/src/plan.ts`;
  `evals/plan.test.ts`, mutant in `scripts/mutate.ts`)

- A reminder is a post the agent makes later on its own, so it is approve-tier: approved
  once for its exact text, channel and time. It is posted once, escaped (no pings, no hidden
  links), and only in the channel that asked; one more than a day overdue is dropped.
  (`apps/agents/src/teammate-bot/reminders.ts`; `evals/teammate-e2e.test.ts`, mutant)

- Admins can pause the Teammate, make it read-only, or switch single tools off at runtime.
  The controls only narrow what the deployment allows. They are signed, and a control file
  that fails to read or verify means paused. Paused, or with a tool switched off, an
  approval given earlier is not carried out. (`apps/agents/src/teammate-bot/control.ts`;
  `evals/control.test.ts`, `evals/teammate-e2e.test.ts`, mutants)

### 8. Record: every action is attributable
- The audit log is append-only JSONL, and every line inside a run carries the run's id.
  Every publish is a git commit naming its approver. Effects are exactly-once through
  op-keys, so a retry never doubles a write. (`evals/publish-record.test.ts`,
  `evals/run-trace.test.ts`, `evals/effects.test.ts`)

## Known gaps

- Low severity, found by review and not yet fixed:
  - A Confluence create's retry check can adopt a same-titled page a human made between the
    lost response and the retry (seconds). A title already taken before the first attempt is
    refused, not adopted.
  - `parentId` isn't validated.
  - The vault path guard doesn't resolve symlinks.
  - A card truncates long arguments; the approval is still bound to the full text by hash.
  - Separation of duties across surfaces holds only for accounts linked in `TEAMMATE_PEOPLE`.
    An unlinked approver who asked on Jira or GitHub can approve their own request in Slack.
  - Scribe's own replies on its doc tickets don't yet copy a comment's restriction (the
    Teammate's do). Keep Scribe's project out of Jira Service Management.

- **Set `SCRIPTORIUM_SIGNING_KEY`.** Without it, approvals are unsigned and the docs repo's
  internal branch is trusted. Rules approved before the key was set are unsigned and stop
  applying once it is set, so re-approve them.
- Scribe's Atlassian writes still use one person's API token. The Teammate writes only
  under its own service account (`TEAMMATE_ATLASSIAN_EMAIL`/`_TOKEN`). Without one, its Jira
  and Confluence tools are read-only: it never borrows another agent's identity to write.
- The Teammate answers on Jira tickets only under its own Atlassian account, and only when
  that account is mentioned. It replies once per triggering comment (op-keyed).
- Prompt-injection resistance is structural and cannot be proved deterministically. It
  needs a live red-team suite behind `RUN_LLM_EVALS`.
