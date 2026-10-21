# Backlog

The loop picks from the top. **H** items are hardening (bugs, guardrail gaps) and **B** items are
building (toward a milestone in [NORTH_STAR.md](NORTH_STAR.md)). A confirmed High-severity H
item goes ahead of every B item.

Status: `todo` · `in-review (#PR)` · `done (#PR)` · `split → B-0xxa/b` · `dropped (reason)`.
Size: S fits easily in one PR. M fits one PR. L must be split before it is picked.

When the loop finds new work (a bug a sweep turned up, or a follow-up a build exposed), it adds a
row here in the same PR, with where it came from.

## Hardening

| ID | Item | Sev | Size | Status | Source |
|---|---|---|---|---|---|
| H-001 | `TEAMMATE_DIGEST_WEEKDAY` is validated as 0–6 (`packages/core/src/config.ts`) but `digestDue` uses ISO 1=Mon…7=Sun (`apps/agents/src/digest.ts:29`). `0` makes the digest due at the first hourly check of every week, ignoring the hour, and Sunday can't be configured. `evals/config.test.ts` sets `0`. | Medium | S | todo | surface map, 2026-10-21 |

## Build

| ID | M | Item | Size | Depends | Status |
|---|---|---|---|---|---|
| B-001 | M1 | **Conversation anchors.** An opaque id with surface-namespaced alias keys replaces the closed `EventSource` union and `keys.slackThread` (`packages/runtime/src/event.ts`). Aliases are bound by the runtime on real actions only. The ledger is file-backed in `.scriptorium-state/`. | M | | todo |
| B-002 | M1 | **`ChatSurface` interface, inbound half.** Event in, thread context, the asker's identity. Slack's `mentionToEvent`, `threadContext` and `stripMentions` move behind it (`teammate-bot/messages.ts`, `util.ts`). | M | B-001 | todo |
| B-003 | M1 | **`ChatSurface` outbound half.** Reply, update, progress, and a post-with-probe-tag for exactly-once (replaces Slack `metadata` probes in digest, nudges and reminders). `formatReply` renders from a neutral reply model (`slack-format.ts`, `teammate-bot.ts:247-317`). | M | B-002 | todo |
| B-004 | M1 | **Approval-card interface.** Card render, click payload, retry and origin notice behind the surface (`connectors/slack.ts:145-330`, `tellOrigin`, `carryOut` retry blocks). `SlackApprovalChannel` becomes the Slack adapter's implementation. | M | B-003 | todo |
| B-005 | M1 | **People identity.** One person id with accounts on each surface (generalize `TEAMMATE_PEOPLE`). Memory scopes `person:<id>` instead of `person:slack:U`, approvers/admins by person, and separation of duties across surfaces (`runtime/src/memory.ts`, `control.ts`, config). | M | B-001 | todo |
| B-006 | M1 | **Surface contract eval + fake surface.** One suite every adapter must pass. `teammate-e2e` runs on a non-Slack fake. Neutral citations (`curator/src/qa-contract.ts:252`, `citations.ts`). This closes M1. | M | B-002..B-005 | todo |
| B-007 | M2 | **Discord adapter.** Gateway WebSocket for messages, Ed25519-verified interactions for approval buttons, threads as anchors, a manifest/doc and a doctor check. | L | B-006 | todo |
| B-008 | M2 | **Microsoft Teams adapter.** Bot Framework JWT, Adaptive Card approvals. | L | B-006 | todo |
| B-009 | M3 | **Generic MCP-client connector.** Upstream tools mapped to allow/approve/hide by config, strict schemas, and drift fails loud. A new upstream needs no code. | L | | todo |
| B-010 | M3 | **GitHub issues + search.** Reads allow-tier, `github_create_issue` approve-tier, once-keyed. | M | | todo |
| B-011 | M3 | **Linear connector.** Reads plus approve-tier issue create/comment/transition. | M | | todo |
| B-012 | M3 | **Notion / Google Drive reads.** Allow-listed sources, cited as external records. | M | | todo |
| B-013 | M3 | **Whole-team skills.** Support triage, incident summary, meeting notes to action items, onboarding Q&A, each with a golden case. Broaden the agent description and help text beyond product/eng (`agents/teammate.ts:15`, `messages.ts:105`). | S each | | todo |
| B-014 | M3 | **Recipes.** Team-defined prompt + tools + schedule as vault notes, human-approved and signed like lessons. Withdrawn recipes stay withdrawn. | M | B-016 | todo |
| B-015 | M3 | **Chat attachments as input.** Files and images in a thread reach the turn, size-capped and type-allow-listed. | M | B-002 | todo |
| B-016 | M4 | **Recurring jobs bound to an anchor.** "Every Monday post X here" is approve-tier to create, runs exactly once per slot, and reports to its thread. Generalizes `cron.digest`. | M | B-001, B-003 | todo |
| B-017 | M4 | **Durable tasks.** Turn state checkpointed in the state dir, resumed after restart, finished exactly once ("I'll report back"). Replaces the loss in `sweepCutOffTurns`. | L | B-001 | todo |
| B-018 | M4 | **Approvals re-enter the session.** The decision arrives as an event on the same anchor, so the agent can continue the task, not only the one write. | M | B-001, B-017 | todo |
| B-019 | M4 | **Wake on result.** CI finished on the Teammate's own PR commit, PR closed, Jira transitioned. Provenance-gated, no self-loops. | M | B-001 | todo |
| B-020 | M4 | **Debounce + mention interrupt per anchor.** A burst of messages coalesces, and a fresh mention pre-empts the running turn. | M | B-001 | todo |
| B-021 | M5 | **Team profiles.** Per-profile skills, tool tiers, approvers, budgets and credentials, resolved from the anchor's bound aliases only. Conflict fails closed. | L | B-001, B-005 | todo |
| B-022 | M6 | **Runs/sessions viewer.** `/runs` on ingress grows to per-anchor event lists and stuck-session detection from the audit log, with cost per team. | M | B-001 | todo |
| B-023 | M6 | **Progress that keeps audit signals.** The working message is deleted on a clean run and kept as a summary when the run wrote memory or hit an error. | S | B-003 | todo |
| B-024 | M6 | **Setup wizard + doctor per surface.** `pnpm setup` writes `.env` interactively, and `pnpm doctor` checks every configured surface. | M | B-007 | todo |
