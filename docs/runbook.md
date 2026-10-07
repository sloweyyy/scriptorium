# Runbook

Operating scriptorium. The deployment is one always-on Cloud Run service, pinned to a single
instance (`--min-instances=1 --max-instances=1 --no-cpu-throttling`). It runs the Jira
poller, the Slack bots over Socket Mode, the webhooks and the run viewer. Setup is covered in
[deploy.md](deploy.md). This page covers what to set, how to check it works, and
what to do when it doesn't.

## Settings that decide safety

Every one of these fails closed: unset means *less* is allowed, never more.

| Setting | Unset means | Set it to |
|---|---|---|
| `SCRIPTORIUM_SIGNING_KEY` | approvals are unsigned, and the vault repo is trusted | `openssl rand -hex 32`, as a Secret Manager secret. After setting it, re-approve existing house rules. To rotate it, see *Rotating the signing key* below |
| `JIRA_APPROVERS` | any human on the ticket may approve a publish (never the agent) | the Jira account ids of your reviewers |
| `SCRIBE_SLACK_APPROVERS` | the Slack "Approve & publish" button is off | Slack user ids |
| `TEAMMATE_APPROVERS` | no Teammate write can be approved | Slack user ids |
| `TEAMMATE_SLACK_CHANNELS` | the Teammate answers nowhere | channel ids, and `/invite @Teammate` in each |
| `TEAMMATE_ATLASSIAN_EMAIL` / `_TOKEN` | the Teammate reads Jira and Confluence but can't write | a service account with access to only the allowed projects and spaces. Its project role needs Add Comments, Create, Edit, Transition, Assign and Link Issues; `jira_assign` also needs the global *Browse users and groups* permission |
| `TEAMMATE_JIRA_PROJECTS` / `TEAMMATE_CONFLUENCE_SPACES` | Jira defaults to `JIRA_PROJECT_KEY`; no Confluence | the keys it may read (and, with approval, write) |
| `TEAMMATE_GITHUB_APP_ID` / `_KEY` / `_REPOS` | no GitHub | the Teammate's own GitHub App, and the `owner/name` repos it may read |
| `TEAMMATE_PR_CHANNEL` | PRs are never checked automatically | a channel for PR-check summaries; each check's approval card threads under its summary |
| `TEAMMATE_ALLOW_DMS` | a DM gets a one-time pointer to a channel, never an answer | `true`, to answer DMs (their cards still go to the notify channel) |
| `TEAMMATE_MEMORY_DAYS` | memories lapse after 180 days | days; the expiry is signed with the approval |
| `TEAMMATE_PEOPLE` | a request made on Jira or GitHub can be approved in Slack by the same person | each approver's Slack, Jira and GitHub accounts, linked (`slack:U1=jira:abc=github:dev; …`) |
| `TEAMMATE_DAILY_TOKENS` | no spend cap | tokens per UTC day for each channel, Jira project and PR repo; over it the Teammate answers with a notice and no model call |
| `TEAMMATE_TRIAGE_PROJECTS` | no triage of new tickets | project keys (not Scribe's doc project); the Jira webhook must send *Issue created*. `TEAMMATE_TRIAGE_PER_HOUR` (20) caps each project |
| `TEAMMATE_DAILY_TOKENS_TOTAL` | no overall cap: each DM is its own scope, so N people each get the full per-scope cap | tokens per UTC day across everything |
| `DOCS_REPO_URL` / `VAULT_REPO_URL` | no publishing; without the vault repo, internal notes (PRDs, gaps, house rules) go nowhere and aren't restored on boot. They never fall back to the docs repo | the public docs repo and the **private** vault repo, each with its own deploy key (`DOCS_REPO_SSH_KEY`, `VAULT_REPO_SSH_KEY`) |
| `SLACK_WORKSPACE_URL` | Slack messages an answer cites are shown as ids, not links | `https://<your-team>.slack.com` |
| `TRACE_TOKEN` + `PUBLIC_BASE_URL` | no run viewer, so replies show a bare run id | a long random token and the service URL. Replies carry a link signed for their own run only; the token itself opens any run, so keep it to operators |
| `METRICS_TOKEN` | no `/metrics` | a long random token, different from `TRACE_TOKEN`, for your scraper (`Authorization: Bearer …`) |

Secrets go in Secret Manager (`--set-secrets`), never in `--set-env-vars`.

## After a deploy: prove it works

1. `pnpm doctor` (with the deployment's settings) checks what its safety depends on: the model,
   signing, where the audit log lives, approvers and admins, spend caps, the Slack app's
   scopes and channel membership, Confluence spaces, GitHub repos, and that the vault repo is
   separate from the docs repo. Each problem is printed with its fix. It is read-only.
2. `curl $URL/health` should report the configured surfaces (`jira`, `docsRepo`, webhooks) and which agents started. A 503 with `"status": "degraded"` names the one that failed under `surfaces`; its start error is in the logs.
3. `pnpm jira:doctor`, run locally against the same Jira, checks auth, JQL, comments,
   attachments and transitions (read-only unless `--write`).
4. In an allowed channel, `@Teammate what does <a documented feature> do?` should get a
   cited answer, with "AI-generated · view run …" at the end.
   `/teammate help` should answer privately with the help card, and the app's Home tab should
   list nothing waiting (or what is).
5. Ask it to "file a ticket for this". An approval card should appear. Click Approve as a
   listed approver, and "Done: Created jira:…" should follow in the thread.
6. Open the run link. The run page shows the trigger, the tool calls, the approval and the
   reply.

## When something goes wrong

| Symptom | Look at | Usual cause |
|---|---|---|
| The Teammate doesn't reply | audit `teammate.ignored` lines, which carry the reason | channel not in `TEAMMATE_SLACK_CHANNELS`, the bot not invited, or a message from another bot |
| "I couldn't finish that" | the run page or `pnpm trace <run>` → `teammate.error` | provider quota or outage, or a connector 5xx. Set `MODEL_FALLBACK` so an overloaded model is retried once on another (audited as `llm.fallback`) |
| A request sat unanswered | the card's thread | after `TEAMMATE_APPROVAL_NUDGE_HOURS` (24) the approvers are nudged once; after 7 days the card becomes "expired, nothing was done" |
| An approval card never appears | audit `policy.approval.unavailable` | the bot can't post in that channel. The write did **not** run |
| Approved, but "couldn't carry it out" | the run page → `policy.run.failed` | the connector failed. The approval was given back: an approver clicks **Retry** in the thread |
| A house rule stopped applying | lesson frontmatter `restored_unverified: true`, or a missing `approval_sig` | the signing key was set after the rule was approved, or the rule was edited in the repo. Re-approve it |
| A draft shows `L-00N ✗` | the draft comment's house-rules line | the draft broke a checked rule. The auto-revise already ran once; give feedback or fix the rule's check |
| "This doc may be out of date" on a ticket | `doc.stale.notified` | the PRD changed after approval. Comment `draft` to revise |
| A reminder never arrived | audit `teammate.reminder.failed` / `teammate.reminder.stale` | the bot isn't in the channel (`/invite @Teammate`), or the service was down for over a day — overdue reminders are dropped, not posted late |
| `/teammate` says "I don't work in this conversation" | `TEAMMATE_SLACK_CHANNELS` | the channel isn't listed, or it's a DM and `TEAMMATE_ALLOW_DMS` is off |
| The Home tab is empty or missing | the app's manifest | the app was installed before the Home tab was added: reinstall it from `slack-manifests/teammate.yaml` |
| Slow replies at busy times | nothing, usually | Jira, Confluence or GitHub rate-limited us (429). Calls wait what the service asks, up to 30s over 3 tries, then fail closed as before |
| The same Jira comment twice | shouldn't happen: writes are op-keyed | check whether two instances are running (see below) |

## The audit log

Every line is hash-chained to the one before it, so an edited, removed or reordered line is
detectable:

- `pnpm auditlog verify [file]` checks the chain and names the first line that breaks it.
- `pnpm auditlog export --from 2026-09-01 --to 2026-09-30 [file]` writes that range as JSONL.
  It refuses a log that doesn't verify. On stderr it prints the **anchor** (the hash the
  extract's first line chains onto) and a digest over the anchor and the extract.
- The reviewer checks the extract on its own with `pnpm auditlog verify --anchor <anchor> extract.jsonl`.
- When `SCRIPTORIUM_SIGNING_KEY` is set, the digest is an HMAC under a key derived from it.
  Give the reviewer `pnpm auditlog export-key`, never the signing key: the derived key
  checks exports and can't sign an approval.

Set `AUDIT_FILE` to a path on the persistent state volume (for example
`/state/audit/log.jsonl`). The default, `audit/log.jsonl` in the working directory, does not
survive a Cloud Run revision.

## Rotating the signing key

Changing `SCRIPTORIUM_SIGNING_KEY` on its own makes every approved house rule and memory stop
applying, because none of them verifies under the new key. To rotate without that:

1. Set the new key as `SCRIPTORIUM_SIGNING_KEY`, and put the old one in
   `SCRIPTORIUM_PREVIOUS_SIGNING_KEYS` (comma-separated). Previous keys verify; they never sign.
2. Run `pnpm resign` (`--dry-run` first). It re-signs, with the new key, every approval that
   already verifies under a previous key. A note that verifies under no key is reported and
   left alone: re-approve it if it should apply.
3. Change any admin control once (`/teammate admin status` doesn't count; `resume` does), so
   the control file is signed with the new key too.
4. Remove the old key from `SCRIPTORIUM_PREVIOUS_SIGNING_KEYS`.

## Stop it now

A tool misbehaving, answers going wrong, a cost spike: an admin (`TEAMMATE_ADMINS`) runs,
from anywhere in Slack:

- `/teammate admin pause <reason>`: it answers nothing and carries nothing out, including
  approvals already given. They stay pending until `/teammate admin resume`.
- `/teammate admin deny <tool>`: that one tool is off, even for approvals already given.
  `allow <tool>` turns it back on.
- `/teammate admin readonly on`: it answers, but proposes no changes.
- `/teammate admin delegate @away @standin YYYY-MM-DD`: while an approver is away, the stand-in
  may approve what they could, until that date (at most 60 days). The stand-in still can't
  approve their own requests. `undelegate @away` ends it early.
- `/teammate admin status`: what is switched off, who is standing in, by whom, and when.

The controls are a signed file in the state dir, `control.json`. A control file that can't
be read or doesn't verify counts as **paused**. Delete it (with the service running) to
clear every control.

## Hard rules

- **One instance.** Keep `--max-instances=1`. The ledgers, the per-conversation queue and
  the effect de-duplication are per-process. Two overlapping instances during a deploy is
  the one remaining way to double a write (see `docs/security-model.md`, known gaps).
- **Drain on stop.** SIGTERM drains the queues for up to 8 seconds before exiting.
  Unfinished work resumes on the next start from its durable state. A Slack question
  still being answered is not resumed: on the next start its "Looking into it…" becomes
  a notice asking the person to ask again.
- **One instance runs the scheduled work.** That covers the digest, reminders, approval nudges, and closing answers a restart cut off. During a deploy, the old and new revisions overlap, and only the one holding `state/scheduler.lease` runs this work. The holder renews the lease every minute and releases it on shutdown; the other takes over once it expires, after at most 3 minutes. Answers are unaffected, since each Slack event reaches one instance. To force a handover, delete the lease file.
- **Never share an Atlassian token between agents.** Two agents on one token are one
  identity, and the permission boundary between them is gone.

## Erasing a person

When someone asks to be removed, stop the service (the audit log is rewritten in place), then:

```bash
pnpm privacy:erase U0123ABC --by <you> --dry-run   # the plan; changes nothing
pnpm privacy:erase U0123ABC --by <you>
```

- **Linked accounts.** Everything linked to the person in `TEAMMATE_PEOPLE` goes too: their
  Jira and GitHub ids.
- **Audit lines.** Each line about them becomes a tombstone. It keeps the type, the time, the
  run, the structural fields that don't name them, and the hash of the original line, so
  `pnpm auditlog verify` still holds. Everyone else's lines stay byte-for-byte the same.
- **The record.** A `privacy.erased` record says who ran it, how much it erased, and the
  digest of each tombstone, so a tombstone edited later is found. It doesn't name the
  person, and it lands in the same write as the tombstones.
- **What else goes:**
  - Memories about them are deleted.
  - Their requests not yet carried out (pending or approved) are cancelled, and their
    requester id on past requests becomes a pseudonym.
  - Any request whose arguments or card name them has its text emptied; who approved it stays.
  - Reminders they asked for, or that name them, are cancelled or emptied.
  - Doc-ticket feedback waiting to be distilled into a lesson is dropped if they wrote it or
    it names them. Feedback is held with its author's Jira account; feedback recorded
    before that was the case is matched by name only.
  - Delegations to or from them end.
- **What stays, on purpose: who approved a write.** Erasing an approver would erase the
  record that separation of duties depends on. Vault notes that mention them (docs, house
  rules) are listed for review, not edited.
- **What it can't reach.** Slack, Jira and Confluence keep their own copies. Git history,
  including the vault repo's, still holds old text. Audit extracts exported earlier still hold
  the erased lines.

A tombstone keeps the original line's hash. Someone who guesses the line's exact contents
could confirm the guess against it. Lines carry a random run id and a timestamp, so guessing a
line exactly is impractical.

## Metrics

`GET /metrics` serves Prometheus text to a scraper holding `METRICS_TOKEN`. It is derived from
the audit log, so it survives restarts and agrees with the record:
`scriptorium_audit_events_total{type=…}` (answers, gaps, refusals, errors, `llm.fallback`,
approvals, feedback…) and `scriptorium_llm_tokens_total{kind=…}`. It holds only type names
and numbers. Worth alerting on: a rising `teammate.error` or `llm.fallback` rate, and
`teammate.gap` growing faster than docs are published.

## Cost

Each Teammate turn audits `llm.usage` with the true input, meaning uncached + cache read +
cache write, plus output. `pnpm trace <run>` shows what a single answer cost. Prompt caching
is on for the first-party Anthropic API.

## Answer quality

People mark a wrong answer with 👎 on the reply. The Teammate records a pointer: the
channel, the message, who flagged it, and the run that produced the answer. It never records
the Slack text. `pnpm feedback` lists flagged answers newest first, each with its
`pnpm trace <run>`. For each one worth keeping, add a case to `evals/golden/answers.json`:
the question, the notes it must cite, and the facts it must state. An answer that should have
been "I don't know" becomes an `unanswerable` case.

`RUN_LLM_EVALS=1 npx vitest run evals/answer-golden.test.ts` grades every case against the
configured model. Each `provider:model` has its own baseline in `evals/baselines/answers.json`:
record it with `UPDATE_BASELINE=1` before switching `MODEL`, and compare. Refusing what the
docs don't say has no baseline. Every model must get all of those right.

Recording 👎 needs the `reactions:read` scope and the `reaction_added` event, which are in the
manifest. `pnpm doctor` names a missing scope until the app is reinstalled.
