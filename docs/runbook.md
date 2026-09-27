# Runbook

Operating scriptorium. The deployment is one always-on Cloud Run service, pinned to a single
instance (`--min-instances=1 --max-instances=1 --no-cpu-throttling`). It runs the Jira
poller, the Slack bots over Socket Mode, the webhooks and the run viewer. Setup is covered in
the README's *Deploy it* section. This page covers what to set, how to check it works, and
what to do when it doesn't.

## Settings that decide safety

Every one of these fails closed: unset means *less* is allowed, never more.

| Setting | Unset means | Set it to |
|---|---|---|
| `SCRIPTORIUM_SIGNING_KEY` | approvals are unsigned, and the docs repo's internal branch is trusted | `openssl rand -hex 32`, as a Secret Manager secret. After setting it, re-approve existing house rules |
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
| `TRACE_TOKEN` + `PUBLIC_BASE_URL` | no run viewer, so replies show a bare run id | a long random token and the service URL |

Secrets go in Secret Manager (`--set-secrets`), never in `--set-env-vars`.

## After a deploy: prove it works

1. `curl $URL/health` should report the configured surfaces (`jira`, `docsRepo`, webhooks).
2. `pnpm jira:doctor`, run locally against the same Jira, checks auth, JQL, comments,
   attachments and transitions (read-only unless `--write`).
3. In an allowed channel, `@Teammate what does <a documented feature> do?` should get a
   cited answer, with "AI-generated · view run …" at the end.
4. Ask it to "file a ticket for this". An approval card should appear. Click Approve as a
   listed approver, and "Done: Created jira:…" should follow in the thread.
5. Open the run link. The run page shows the trigger, the tool calls, the approval and the
   reply.

## When something goes wrong

| Symptom | Look at | Usual cause |
|---|---|---|
| The Teammate doesn't reply | audit `teammate.ignored` lines, which carry the reason | channel not in `TEAMMATE_SLACK_CHANNELS`, the bot not invited, or a message from another bot |
| "I couldn't finish that" | the run page or `pnpm trace <run>` → `teammate.error` | provider quota or outage, or a connector 5xx |
| An approval card never appears | audit `policy.approval.unavailable` | the bot can't post in that channel. The write did **not** run |
| Approved, but "couldn't carry it out" | the run page → `policy.run.failed` | the connector failed. The approval was given back: an approver clicks **Retry** in the thread |
| A house rule stopped applying | lesson frontmatter `restored_unverified: true`, or a missing `approval_sig` | the signing key was set after the rule was approved, or the rule was edited in the repo. Re-approve it |
| A draft shows `L-00N ✗` | the draft comment's house-rules line | the draft broke a checked rule. The auto-revise already ran once; give feedback or fix the rule's check |
| "This doc may be out of date" on a ticket | `doc.stale.notified` | the PRD changed after approval. Comment `draft` to revise |
| The same Jira comment twice | shouldn't happen: writes are op-keyed | check whether two instances are running (see below) |

## Hard rules

- **One instance.** Keep `--max-instances=1`. The ledgers, the per-conversation queue and
  the effect de-duplication are per-process. Two overlapping instances during a deploy is
  the one remaining way to double a write (see `docs/security-model.md`, known gaps).
- **Drain on stop.** SIGTERM drains the queues for up to 8 seconds before exiting.
  Unfinished work resumes on the next start from its durable state. A Slack question
  still being answered is not resumed: on the next start its "Looking into it…" becomes
  a notice asking the person to ask again.
- **Never share an Atlassian token between agents.** Two agents on one token are one
  identity, and the permission boundary between them is gone.

## Cost

Each Teammate turn audits `llm.usage` with the true input, meaning uncached + cache read +
cache write, plus output. `pnpm trace <run>` shows what a single answer cost. Prompt caching
is on for the first-party Anthropic API.
