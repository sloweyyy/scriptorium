# Single always-on container: Jira poller (Scribe) + Slack socket mode (Curator) + vault watcher.
# No ingress required — both surfaces dial out — but a health port is exposed for Cloud Run.
FROM node:22-slim

# openssh-client is not optional: the docs repo is reached over SSH with a deploy key,
# and without it git fails at clone with a bare "ssh: not found".
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile

COPY . .

# The vault is the system of record; git history is the audit trail, so identity must exist.
RUN git config --global user.email "agent@scriptorium.local" \
    && git config --global user.name "scriptorium agent" \
    && git config --global --add safe.directory /app

ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["pnpm", "dev"]
