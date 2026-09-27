# Deploying scriptorium

One container runs every surface in one process: the Jira poller, the Slack bots, the
webhooks and the run viewer. Slack needs no inbound traffic, because Socket Mode dials out.
The process serves only the health port, the Jira and GitHub webhooks, and the run viewer.

```bash
docker build -t scriptorium .
docker run --env-file .env -p 8080:8080 scriptorium
```

For the settings that decide safety, and what to check after a deploy, see the
[runbook](runbook.md).

## Cloud Run

Three settings matter and are easy to get wrong:

- **`--max-instances=1`.** The ledgers, the per-conversation queue and effect
  de-duplication are per-instance. Two instances mean two ledgers, duplicate drafts and
  duplicate writes.
- **`--no-cpu-throttling`.** Cloud Run throttles CPU between requests, so a warm instance is
  not a running one. The poller and timers would fire only when a request happened to wake the
  instance. This setting bills continuously; that is the cost of running a reconciler.
- **Workload identity, not a key file.** The service runs as a service account holding
  `roles/aiplatform.user`, so a model on Vertex authenticates with no credentials file in the
  image. `GOOGLE_APPLICATION_CREDENTIALS` is only for local development.

```bash
PROJECT=your-project
SA=scriptorium-agent@$PROJECT.iam.gserviceaccount.com

gcloud run deploy scriptorium \
  --source . --project "$PROJECT" --region us-central1 \
  --service-account "$SA" \
  --min-instances=1 --max-instances=1 --no-cpu-throttling \
  --set-env-vars "VERTEX_PROJECT_ID=$PROJECT,VERTEX_REGION=global,MODEL=claude-opus-5,JIRA_BASE_URL=https://your-site.atlassian.net,JIRA_EMAIL=you@example.com,JIRA_PROJECT_KEY=DOC,STATE_DIR=/state,AUDIT_FILE=/state/audit/log.jsonl" \
  --set-secrets "JIRA_API_TOKEN=jira-api-token:latest,SCRIPTORIUM_SIGNING_KEY=signing-key:latest,TEAMMATE_SLACK_BOT_TOKEN=teammate-slack-bot-token:latest,TEAMMATE_SLACK_APP_TOKEN=teammate-slack-app-token:latest" \
  --add-volume=name=state,type=cloud-storage,bucket=$PROJECT-state \
  --add-volume-mount=volume=state,mount-path=/state
```

**The GCS volume keeps state across restarts.** It holds the ledgers, approvals,
reminders, controls and the audit log. Without it, every ticket looks new again, and the
agent re-greets and re-drafts work it already did.

**Don't put the docs-repo work tree on that volume.** `DOCS_REPO_WORKDIR` must point at local
disk (`/tmp/docs-repo`). A GCS FUSE mount has no hardlinks and weak rename and lock semantics,
so `git clone` into it fails. The failure shows up as a publish that wrote the vault copy but
never reached the repo. The clone is scratch: it is re-created from the remote on every boot.

**The deploy key is mounted read-only (0444).** ssh refuses a private key that is group- or
world-readable, and you can't `chmod` a Secret Manager mount. So the agent copies the key once
per process to a 0600 path under `TMPDIR` and points `GIT_SSH_COMMAND` at the copy. There's
nothing to configure. It's worth knowing because the failure shows up as
`Permission denied (publickey)`, which looks like a wrong key.

## Model providers

The pipeline runs on the Anthropic API, Claude on Vertex AI, or Gemini on Vertex AI. Pick one
with `LLM_PROVIDER` and `MODEL`. Every guarantee (the input contract, the lint, the approval
gate, the allow-listed publish, cite-or-refuse retrieval) belongs to the pipeline, not the
model, so all of them hold whichever model runs underneath.

Claude on Vertex needs the Anthropic models enabled in Model Garden and online-prediction
quota for the base model
(`aiplatform.googleapis.com/global_online_prediction_requests_per_base_model`, dimension
`base_model=anthropic-claude-opus`). A fresh project starts at zero, and increases are
requested per base model with `gcloud alpha quotas preferences create`.

## Where the docs land

Scribe publishes into a separate content repository with two branches. Each branch owns
exactly one content tree and one site build:

| Branch | Content | Site | Who writes it |
|---|---|---|---|
| `main` | `docs/`: approved and public | Astro Starlight, public | a human merging a pull request |
| `vault-live` | `internal/`: PRDs, gap notes, house rules, index | Quartz, behind Basic auth | the agent, on approval |

The agent never pushes `main`. Approved docs land on a per-ticket branch and reach `main` only
when a human merges. That gate is a property of what the agent *does*, which is stronger than
relying only on what its token is forbidden to do.

**So a doc exists twice in that repo:** transformed for the public site, and untransformed
for the graph. Both are renderings of one vault note, not two sources. If a human edits
either copy, the divergence gate detects it and reports it on the ticket the doc came from,
instead of silently absorbing the edit.

**Each branch also carries a stub of the other branch's site**, with deployments turned off.
Vercel clones *both* projects on every push, and a project whose root directory is missing
fails before any ignore rule can run.

**Known cost: cross-target publishes are not atomic.** One target can land while the other
refuses, and neither divergence gate can see the mismatch. The ticket comment says so
explicitly when it happens.
