# North star

**A teammate that lives wherever a team already talks (Slack, Discord, Microsoft Teams,
Google Chat, and whatever comes next) and does work for the whole team:
engineering, product, support, ops, and people/admin. It stays policy-first throughout. Every write is
approved, every claim is cited, and every action is on the audit log.**

The loop (see [README.md](README.md)) moves the project toward this one PR at a time.
Scribe and Curator stay as they are. They are proof that the platform carries more than one agent.
The Teammate is the product that grows.

## What "done" looks like

A new team can do the following without editing code:

1. Install the Teammate into their chat tool, whichever one it is, and run `pnpm doctor` green.
2. Ask it anything in a thread. It answers from their knowledge with citations, or says it doesn't
   know and files the gap.
3. Ask it to *do* something (file a ticket, comment on a PR, schedule a report, update a page).
   It proposes the write, a named approver approves it in the same chat tool, and the result
   comes back into the same thread.
4. Leave it work that outlives one turn ("watch CI on this PR", "every Monday post the sprint
   report", "tell me when SUP-12 moves"). It survives a restart and reports back where it was asked.
5. Give each team its own skills, tools, approvers, budget and knowledge without one team's
   setup leaking into another's.
6. See what it did and what it cost, for each team and each run.

## Milestones

Each milestone is a set of backlog items ([BACKLOG.md](BACKLOG.md)). A milestone is done when
its exit check passes **as an eval**, not as a demo.

| | Milestone | Exit check |
|---|---|---|
| **M1** | **Channel-neutral core**: conversation anchors, a `ChatSurface` adapter interface, people identity across surfaces. Slack becomes adapter #1. | The Teammate's e2e suite runs unchanged against a fake surface that is not Slack. No package outside `adapters/slack` imports Bolt or builds `<@U…>` text. |
| **M2** | **More surfaces**: Discord, then Microsoft Teams. | One surface-contract eval (like the retriever contract, #113) passes for every adapter. A thread started in Discord can be approved from Discord. |
| **M3** | **Whole-team work**: connectors beyond Atlassian/GitHub-PR, a generic MCP-client connector with allow/approve/hide tiers, non-engineering skills, chat attachments as input. | The skill set covers support, ops and people/admin, each with a golden case. A new MCP upstream is added by config plus a tier map, with no new code. |
| **M4** | **Proactive and long-running**: recurring jobs and watchers bound to a conversation, durable tasks that resume after restart, approvals that re-enter the session. | Kill the process mid-task and restart it. The task finishes exactly once and reports to the thread it came from. |
| **M5** | **Per-team profiles**: skills, tools, approvers, budgets and credentials chosen from the conversation's bound identity only, never from the request. A conflict fails closed. | Two profiles in one process. A cross-profile read or approval is refused, and a mutant proves it. |
| **M6** | **Operability**: a runs/sessions viewer from the audit log, cost per team, a setup wizard, a doctor for each surface, and progress messages that keep audit signals. | A non-author sets up a fresh workspace from the docs alone. |

## What we take from Thor (and what we don't)

Thor (`sloweyyy/thor`, a mirror of `scoutqa-dot-ai/thor`) is a mature Slack teammate. It is the
behavioural reference. It is **not** channel-neutral: its Slack wiring is exactly the cost we
want to avoid. Ideas we take, by milestone:

- **M1:** Correlation **anchors + alias keys**. One opaque conversation id, and every external key
  (`slack:thread:…`, `discord:thread:…`, `git:branch:…`, `jira:issue:…`) is an alias of it. Aliases
  are added as side effects of real actions, never by the model.
- **M1:** A **transport interface** for progress, cards and posts (Thor's `ProgressTransport`, but
  generalized from day one).
- **M3:** **Recipes**: team-defined bundles of prompt, tools and schedule. Thor's own compare.md
  rates them its highest-leverage next step. Ours are human-approved vault notes, like lessons.
- **M4:** **Approval as an async event** that re-enters the session. No card posted means no pending
  action, and arguments too big for a card go up as a file, never truncated.
- **M4:** A **durable queue** with debounce, mention-interrupt and per-anchor locks.
- **M4:** **Wake on result** with provenance gates: CI finished on *our* commit, PR closed, Jira moved.
- **M5:** **Profiles** resolved only from the anchor's bound aliases, with all-or-nothing credential
  bundles.
- **M6:** Trigger viewer and sessions dashboard derived from the event log. Progress messages are kept
  only when the run produced audit signals.

What we don't take: Thor's model-side shell and CLI surface, and its "clean over compatible"
posture. scriptorium's tools stay words-not-query-language, schema-checked, and approve-tier
for writes.
