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

# .dockerignore keeps secrets (.env), state, audit and local notes out of the image.
COPY . .

# Not root: the process holds API tokens and deploy keys, and a compromise shouldn't come
# with the container's root. The `node` user (uid 1000) owns the app directory it writes
# (vault, default state). On Cloud Run, mount the GCS state volume with uid=1000;gid=1000.
RUN chown -R node:node /app
USER node

# The vault is the system of record; git history is the audit trail, so identity must exist.
RUN git config --global user.email "agent@scriptorium.local" \
    && git config --global user.name "scriptorium agent" \
    && git config --global --add safe.directory /app

ENV NODE_ENV=production PORT=8080
EXPOSE 8080
# For plain `docker run` (Cloud Run uses its own probes): healthy while /health answers.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# node is PID 1 on purpose: under `pnpm dev` the signal reaches pnpm, the child is torn
# down before the shutdown handler can close the poller and the socket, and the platform
# logs a bare `ELIFECYCLE` with no trace of a clean stop. Cloud Run replaces revisions by
# sending SIGTERM, so that path runs on every deploy.
CMD ["node", "--import", "tsx", "apps/agents/src/main.ts"]
