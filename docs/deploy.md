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
  --set-env-vars "VERTEX_PROJECT_ID=$PROJECT,VERTEX_REGION=global,MODEL=claude-opus-5,JIRA_BASE_URL=https://your-site.atlassian.net,JIRA_EMAIL=you@example.com,JIRA_PROJECT_KEY=DOC,STATE_DIR=/state,AUDIT_FILE=/state/audit/log.jsonl,DOCS_REPO_URL=git@github.com:you/your-docs.git,VAULT_REPO_URL=git@github.com:you/your-vault.git,DOCS_REPO_WORKDIR=/tmp/docs-repo,VAULT_REPO_WORKDIR=/tmp/vault-repo" \
  --set-secrets "JIRA_API_TOKEN=jira-api-token:latest,SCRIPTORIUM_SIGNING_KEY=signing-key:latest,/keys/docs=docs-deploy-key:latest,/keys/vault=vault-deploy-key:latest,TEAMMATE_SLACK_BOT_TOKEN=teammate-slack-bot-token:latest,TEAMMATE_SLACK_APP_TOKEN=teammate-slack-app-token:latest" \
  --add-volume=name=state,type=cloud-storage,bucket=$PROJECT-state,mount-options="uid=1000;gid=1000" \
  --add-volume-mount=volume=state,mount-path=/state
```

**The container runs as the `node` user (uid 1000), not root.** A process holding API tokens
and deploy keys shouldn't come with the container's root. That's why the state volume above
is mounted with `uid=1000;gid=1000`; without it, the mount is root-owned and every state
write fails. Upgrading from an image that ran as root? Add the mount options on the same
deploy.

**Build images from a clean context.** `.dockerignore` keeps `.env`, local state, the audit
log, `vault/_memory` and your notes out of `docker build .`, and `.gcloudignore` does the same
for `gcloud run deploy --source`. Secrets belong in the runtime environment
(`--set-secrets`, `--env-file`), never in the image.

**The GCS volume keeps state across restarts.** It holds the ledgers, approvals,
reminders, controls and the audit log. Without it, every ticket looks new again, and the
agent re-greets and re-drafts work it already did.

**Don't put either repo's work tree on that volume.** `DOCS_REPO_WORKDIR` and
`VAULT_REPO_WORKDIR` must point at local disk (`/tmp/docs-repo`, `/tmp/vault-repo`). A GCS FUSE mount has no hardlinks and weak rename and lock semantics,
so `git clone` into it fails. The failure shows up as a publish that wrote the vault copy but
never reached the repo. The clone is scratch: it is re-created from the remote on every boot.

**The deploy keys are mounted read-only (0444).** Point `DOCS_REPO_SSH_KEY` and
`VAULT_REPO_SSH_KEY` at the mounts (`/keys/docs`, `/keys/vault` above). ssh refuses a private
key that is group- or world-readable, and you can't `chmod` a Secret Manager mount. So the
agent copies each key once per process to a 0600 path under `TMPDIR` and points that clone's
`core.sshCommand` at the copy. There's
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

Scribe publishes into two content repositories. Each owns exactly one content tree and one
site build:

| Repository | Content | Site | Who writes it |
|---|---|---|---|
| **Docs repo** (`DOCS_REPO_URL`, may be public) | `docs/`: approved product docs | Astro Starlight, public | a human merging a pull request |
| **Vault repo** (`VAULT_REPO_URL`, keep private) | `internal/`: PRDs, gap notes, house rules, an untransformed copy of every doc | Quartz, behind Basic auth | the agent, on approval |

They are **two repositories, not two branches**, because every branch of a public repo is
public. The internal tree has no route into the docs repo: no fallback and no default. If
`VAULT_REPO_URL` is unset, internal notes are pushed nowhere, the vault isn't restored on
boot, and the ticket comment says so.

**Each repo has its own deploy key** (`DOCS_REPO_SSH_KEY`, `VAULT_REPO_SSH_KEY`), because
GitHub binds a deploy key to one repository. The key travels in each clone's own
`core.sshCommand`, not process-wide, so the docs key never reaches the vault remote.

**The agent never pushes the docs repo's base branch.** Approved docs land on a per-ticket
branch and reach it only when a human merges. The internal tree goes straight to the vault
repo's branch (`VAULT_REPO_BRANCH`, default `vault-live`), because losing it is the failure
this exists to prevent and there's no second audience to review it for.

**Only the docs repo feeds the round trip.** The GitHub webhook accepts pushes from the docs
repo alone. If it synced the agent's own vault pushes back, it would mark every note as
human-edited and push it again, forever.

**A doc exists in both repos:** transformed for the public site, and untransformed for the
internal graph. Both are renderings of one vault note, not two sources. If a human edits
either copy, the divergence gate detects it and reports it on the ticket the doc came from,
instead of silently absorbing the edit.

**Known cost: the two publishes are not atomic.** One can land while the other fails or
refuses. If the vault repo can't be reached, the pull request still opens and the publish
stays retryable. Either way, the ticket comment says exactly what happened.
