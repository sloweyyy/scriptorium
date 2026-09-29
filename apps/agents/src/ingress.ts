import { createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { auditMetrics, docsRepoReady, jiraReady, linesForRun, parseAudit, repoSlugFromUrl, runLinkSignature, runPage, type AppConfig } from "@scriptorium/core";
import type { CommentRestriction } from "@scriptorium/jira";
import { z } from "zod";

/**
 * The one HTTP surface: health, plus the two webhooks.
 *
 * Everything here treats its body as untrusted, and both routes verify an HMAC when one is
 * configured — GitHub on `x-hub-signature-256`, Jira on `x-hub-signature`, each over the raw
 * bytes and compared in constant time.
 *
 * Jira's registration API is still Connect/OAuth-only (`POST /rest/api/3/webhook` answers
 * `403 "Only Connect and OAuth 2.0 apps can use this operation"` for an API token, verified
 * against the live instance), so the webhook is created in the UI — but that form DOES offer
 * a secret, so signing is available and used when set. The high-entropy path segment stays as
 * the first gate and as the only gate when no secret is configured.
 *
 * Either way the payload is evidence of nothing: only the issue key is read from it, and the
 * issue is then re-fetched from the API.
 */

/** Probe event the doctor can post to prove reachability without doing any work. */
export const PROBE_EVENT = "scriptorium:probe";

const JiraEvent = z.object({
  webhookEvent: z.string().optional(),
  issue: z.object({ key: z.string() }).partial().optional(),
  comment: z.object({ id: z.string().optional() }).partial().optional(),
});

const GitHubPush = z.object({
  ref: z.string().optional(),
  after: z.string().optional(),
  repository: z.object({ full_name: z.string().optional() }).partial().optional(),
  commits: z
    .array(
      z.object({
        id: z.string().optional(),
        url: z.string().optional(),
        added: z.array(z.string()).optional(),
        modified: z.array(z.string()).optional(),
        removed: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});

export interface IngressHooks {
  /** Work one Jira issue now — the poller's own handler, by key. */
  nudge?: (issueKey: string) => Promise<void>;
  /** A push landed on the public docs repo's base branch; these repo-relative paths changed. */
  docsChanged?: (input: { paths: string[]; commit?: string; commitUrl?: string }) => Promise<void>;
  /** A pull request opened (or became ready for review) on a source repo. */
  pullRequest?: (input: { repo: string; number: number; author?: string; deliveryId?: string }) => Promise<void>;
  /** A Jira comment was created — the Teammate answers it if it is mentioned. */
  jiraComment?: (input: JiraCommentEvent) => Promise<void>;
  /** A Jira issue was assigned to someone — the Teammate acts if it is the assignee. */
  jiraAssigned?: (input: { issueKey: string; assigneeId: string; changeId: string }) => Promise<void>;
  /** A new issue — triaged by the Teammate in the projects that opted in. */
  jiraCreated?: (input: { issueKey: string; reporterId?: string }) => Promise<void>;
}

/** `jira:issue_updated` whose changelog moved the assignee: who to, and the change's id. */
export function jiraAssignmentFrom(payload: unknown): { issueKey: string; assigneeId: string; changeId: string } | undefined {
  const body = payload as { webhookEvent?: string; issue?: { key?: string }; changelog?: { id?: string | number; items?: Array<{ field?: string; fieldId?: string; to?: string | null }> } };
  if (body.webhookEvent !== "jira:issue_updated" || typeof body.issue?.key !== "string") return undefined;
  const change = body.changelog?.items?.find((item) => item.fieldId === "assignee" || item.field === "assignee");
  if (!change?.to) return undefined;
  return { issueKey: body.issue.key, assigneeId: change.to, changeId: String(body.changelog?.id ?? `${body.issue.key}:${change.to}`) };
}

/** A new issue (`jira:issue_created`): what triage needs. */
export function jiraCreatedFrom(payload: unknown): { issueKey: string; reporterId?: string } | undefined {
  const body = payload as { webhookEvent?: string; issue?: { key?: string; fields?: { reporter?: { accountId?: string } | null } } };
  if (body.webhookEvent !== "jira:issue_created" || typeof body.issue?.key !== "string") return undefined;
  return { issueKey: body.issue.key, reporterId: body.issue.fields?.reporter?.accountId };
}

export interface JiraCommentEvent {
  issueKey: string;
  commentId: string;
  body: string;
  authorId?: string;
  /** Who may see the comment: a reply must be restricted the same way. */
  restriction: CommentRestriction;
}

/**
 * A comment's restriction from its webhook JSON: a role/group `visibility`, or JSM's
 * internal flag (`jsdPublic: false`, or the `sd.public.comment` property). A visibility we
 * cannot read is "unreadable": the comment is not answered, since a reply can't match it.
 */
export function commentRestriction(comment: unknown): CommentRestriction | "unreadable" {
  const c = (comment ?? {}) as { visibility?: unknown; jsdPublic?: unknown; properties?: unknown };
  const restriction: CommentRestriction = {};
  if (c.visibility !== undefined && c.visibility !== null) {
    const v = c.visibility as { type?: unknown; value?: unknown; identifier?: unknown };
    if ((v.type !== "role" && v.type !== "group") || typeof v.value !== "string") return "unreadable";
    restriction.visibility = { type: v.type, value: v.value, ...(typeof v.identifier === "string" ? { identifier: v.identifier } : {}) };
  }
  const internalProperty = Array.isArray(c.properties)
    ? (c.properties as Array<{ key?: unknown; value?: { internal?: unknown } }>).some((property) => property.key === "sd.public.comment" && property.value?.internal === true)
    : false;
  if (c.jsdPublic === false || internalProperty) restriction.internal = true;
  return restriction;
}

/**
 * Atlassian Document Format → the wiki-ish text the rest of the pipeline reads. Webhooks
 * registered through the REST API (and some automation payloads) send comment bodies as
 * ADF, not a string; a mention node becomes `[~accountid:<id>]`, exactly as v2 text has it.
 */
export function adfToText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as { type?: string; text?: string; attrs?: { id?: string; url?: string }; content?: unknown[] };
  if (n.type === "text") return n.text ?? "";
  if (n.type === "mention") return n.attrs?.id ? `[~accountid:${n.attrs.id}]` : "";
  // A pasted issue or page link becomes a smart card: keep its URL, or "is DOC-42 ready?" reads "is  ready?".
  if (n.type === "inlineCard" || n.type === "blockCard") return n.attrs?.url ?? "";
  if (n.type === "hardBreak") return "\n";
  const inner = (n.content ?? []).map(adfToText).join("");
  return n.type === "paragraph" || n.type === "heading" || n.type === "listItem" ? `${inner}\n` : inner;
}

/** A `comment_created` or `comment_updated` webhook as the fields the Teammate needs; anything else is not one. */
export function jiraCommentFrom(payload: unknown): JiraCommentEvent | undefined {
  const body = payload as { webhookEvent?: string; issue?: { key?: string }; comment?: { id?: string | number; body?: unknown; author?: { accountId?: string } } };
  // An edit counts too: adding the forgotten @mention is how people fix a question. The
  // reply is op-keyed per comment, so an edit to a comment already answered stays answered once.
  if (body.webhookEvent !== "comment_created" && body.webhookEvent !== "comment_updated") return undefined;
  const issueKey = body.issue?.key;
  const commentId = body.comment?.id;
  const raw = body.comment?.body;
  const text = typeof raw === "string" ? raw : raw && typeof raw === "object" ? adfToText(raw).trim() : undefined;
  if (typeof issueKey !== "string" || commentId === undefined || !text) return undefined;
  // A restriction we can't read: not answered at all, rather than answered in public.
  const restriction = commentRestriction(body.comment);
  if (restriction === "unreadable") return undefined;
  return { issueKey, commentId: String(commentId), body: text, authorId: body.comment?.author?.accountId, restriction };
}

/** The pull-request events worth a review: opened, reopened, or taken out of draft. */
export function pullRequestFrom(event: string | undefined, payload: unknown): { repo: string; number: number; author?: string } | undefined {
  if (event !== "pull_request") return undefined;
  const body = payload as { action?: string; pull_request?: { number?: number; draft?: boolean; user?: { login?: string } }; repository?: { full_name?: string } };
  if (!["opened", "reopened", "ready_for_review"].includes(body.action ?? "")) return undefined;
  if (body.pull_request?.draft) return undefined;
  const repo = body.repository?.full_name?.toLowerCase();
  const number = body.pull_request?.number;
  if (!repo || !Number.isInteger(number)) return undefined;
  return { repo, number: number as number, author: body.pull_request?.user?.login };
}

function readBody(request: IncomingMessage, limitBytes = 1_000_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      // A webhook body has no business being large; refuse rather than buffer it.
      if (size > limitBytes) {
        reject(new Error("payload too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  response.end(payload);
}

/** Constant-time compare that never leaks length through an early return. */
export function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still do a comparison so timing does not distinguish "wrong length" from "wrong value".
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function verifyGitHubSignature(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  return secretMatches(header, expected);
}

/**
 * Jira signs with the same scheme as GitHub when a secret is configured on the webhook,
 * but on the unsuffixed `X-Hub-Signature` header. When a secret is set this is the real
 * gate and the path segment becomes defence in depth.
 */
export function verifyJiraSignature(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const digest = createHmac("sha256", secret).update(rawBody).digest("hex");
  return secretMatches(header, `sha256=${digest}`) || secretMatches(header, digest);
}

export function jiraIssueKeyFrom(payload: unknown): { key?: string; event?: string; probe: boolean } {
  const parsed = JiraEvent.safeParse(payload);
  if (!parsed.success) return { probe: false };
  const event = parsed.data.webhookEvent;
  return { key: parsed.data.issue?.key, event, probe: event === PROBE_EVENT };
}

export function docsPathsFrom(payload: unknown): { paths: string[]; ref?: string; commit?: string; commitUrl?: string; repo?: string } {
  const parsed = GitHubPush.safeParse(payload);
  if (!parsed.success) return { paths: [] };
  const paths = new Set<string>();
  for (const commit of parsed.data.commits ?? []) {
    for (const list of [commit.added, commit.modified, commit.removed]) {
      for (const item of list ?? []) paths.add(item);
    }
  }
  const last = parsed.data.commits?.at(-1);
  return { paths: [...paths], ref: parsed.data.ref, commit: parsed.data.after ?? last?.id, commitUrl: last?.url, repo: parsed.data.repository?.full_name };
}

export interface IngressOptions {
  config: AppConfig;
  hooks: IngressHooks;
  /** Which surfaces started. One that failed makes /health degraded (503), not green. */
  surfaces?: () => Record<string, { state: "up" | "failed"; detail?: string }>;
}

/**
 * Delivery ids already handled. Jira and GitHub both redeliver (timeouts, retries, a
 * webhook replayed from their UI); neither signature carries a timestamp, so without this a
 * captured, validly signed delivery could be replayed at will. Checked AFTER the signature:
 * only authenticated deliveries are remembered.
 */
function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export class RecentDeliveries {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];
  constructor(private readonly capacity = 5_000) {}

  /** True the first time an id is seen; false for a repeat. A missing id is never deduped. */
  firstTime(id: string | undefined): boolean {
    if (!id) return true;
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    this.order.push(id);
    if (this.order.length > this.capacity) this.seen.delete(this.order.shift() as string);
    return true;
  }
}

export function startIngress({ config, hooks, surfaces }: IngressOptions): Server {
  const deliveries = new RecentDeliveries();
  const jiraSecret = config.webhook.jiraSecret;
  const githubSecret = config.webhook.githubSecret;

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const route = url.pathname.replace(/\/+$/, "") || "/";

      if (request.method === "GET" && (route === "/health" || route === "/")) {
        const started = surfaces?.() ?? {};
        const degraded = Object.values(started).some((surface) => surface.state === "failed");
        send(response, degraded ? 503 : 200, {
          status: degraded ? "degraded" : "ok",
          surfaces: Object.fromEntries(Object.entries(started).map(([name, surface]) => [name, surface.state])),
          provider: config.provider,
          jira: jiraReady(config.jira),
          docsRepo: docsRepoReady(config.docsRepo),
          webhooks: {
            jira: Boolean(jiraSecret),
            jiraSigned: Boolean(config.webhook.jiraHmacSecret),
            github: Boolean(githubSecret),
          },
        });
        return;
      }

      if (request.method === "GET" && route === "/metrics") {
        const token = config.webhook.metricsToken;
        const provided = (headerValue(request.headers.authorization) ?? "").replace(/^Bearer\s+/i, "");
        // 404 whether metrics are off or the token is wrong, like the run viewer.
        if (!token || !secretMatches(provided, token)) {
          send(response, 404, { error: "not found" });
          return;
        }
        const text = auditMetrics(parseAudit(await fs.readFile(config.auditFile, "utf8").catch(() => "")));
        response.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Content-Length": Buffer.byteLength(text), "Cache-Control": "no-store" });
        response.end(text);
        return;
      }

      if (request.method === "GET" && route.startsWith("/runs/")) {
        const token = config.webhook.traceToken;
        const prefix = decodeURIComponent(route.slice("/runs/".length)).replace(/[^0-9a-f-]/gi, "");
        // Two keys: a reply's signed link opens exactly its own run; the operator's token
        // (never posted anywhere) opens any run by prefix. 404 for anything else, whether
        // the viewer is off or the key is wrong: nothing to learn by probing.
        const sig = url.searchParams.get("sig") ?? "";
        const bySignature = Boolean(token && sig && secretMatches(sig, runLinkSignature(token, prefix)));
        const byToken = Boolean(token && secretMatches(url.searchParams.get("token") ?? "", token));
        if (!bySignature && !byToken) {
          send(response, 404, { error: "not found" });
          return;
        }
        const all = parseAudit(await fs.readFile(config.auditFile, "utf8").catch(() => ""));
        const lines = bySignature ? all.filter((line) => line.run === prefix) : linesForRun(all, prefix);
        const html = runPage(prefix, lines);
        response.writeHead(lines.length ? 200 : 404, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": Buffer.byteLength(html),
          // A run page holds user questions: never cached, never framed, never scripted.
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
          "X-Frame-Options": "DENY",
          "Referrer-Policy": "no-referrer",
        });
        response.end(html);
        return;
      }

      if (request.method === "POST" && route.startsWith("/jira/webhook/")) {
        const provided = route.slice("/jira/webhook/".length);
        if (!jiraSecret || !secretMatches(provided, jiraSecret)) {
          // 404, not 401: an unauthenticated caller learns nothing about what lives here.
          send(response, 404, { error: "not found" });
          return;
        }
        const rawJira = await readBody(request).catch(() => Buffer.alloc(0));
        const hmacSecret = config.webhook.jiraHmacSecret;
        if (hmacSecret) {
          // A configured secret means Jira signs; an unsigned or mis-signed body is refused
          // even though the caller got the path right.
          const header = (request.headers["x-hub-signature"] ?? request.headers["x-hub-signature-256"]) as string | undefined;
          if (!verifyJiraSignature(rawJira, header, hmacSecret)) {
            send(response, 401, { error: "bad signature" });
            return;
          }
        }
        let payload: unknown;
        try {
          payload = JSON.parse(rawJira.toString("utf8") || "{}");
        } catch {
          send(response, 400, { error: "invalid json" });
          return;
        }
        if (!deliveries.firstTime(headerValue(request.headers["x-atlassian-webhook-identifier"]))) {
          send(response, 202, { accepted: false, reason: "duplicate delivery" });
          return;
        }
        const { key, event, probe } = jiraIssueKeyFrom(payload);
        if (probe) {
          // Reachability probe: prove the route is live without touching any ticket.
          send(response, 200, { accepted: false, probe: true });
          return;
        }
        if (!key) {
          send(response, 202, { accepted: false, reason: "no issue key in payload" });
          return;
        }
        // Answer before working: Jira gives up in seconds, and the ledger makes a retry safe.
        send(response, 202, { accepted: true, issue: key, event });
        const assignment = jiraAssignmentFrom(payload);
        if (assignment && hooks.jiraAssigned) {
          await hooks.jiraAssigned(assignment).catch((error: unknown) => console.warn(`[ingress] teammate assignment ${assignment.issueKey}: ${error instanceof Error ? error.message : error}`));
        }
        const created = jiraCreatedFrom(payload);
        if (created && hooks.jiraCreated) {
          await hooks.jiraCreated(created).catch((error: unknown) => console.warn(`[ingress] teammate triage ${created.issueKey}: ${error instanceof Error ? error.message : error}`));
        }
        const jiraComment = jiraCommentFrom(payload);
        if (jiraComment && hooks.jiraComment) {
          await hooks.jiraComment(jiraComment).catch((error: unknown) => console.warn(`[ingress] teammate jira comment ${jiraComment.issueKey}: ${error instanceof Error ? error.message : error}`));
        }
        if (hooks.nudge) {
          try {
            await hooks.nudge(key);
          } catch (error) {
            console.warn(`[ingress] nudge ${key} failed: ${error instanceof Error ? error.message : error}`);
          }
        }
        return;
      }

      if (request.method === "POST" && route === "/github/webhook") {
        const raw = await readBody(request).catch(() => Buffer.alloc(0));
        if (!githubSecret || !verifyGitHubSignature(raw, request.headers["x-hub-signature-256"] as string | undefined, githubSecret)) {
          send(response, 401, { error: "bad signature" });
          return;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(raw.toString("utf8") || "{}");
        } catch {
          send(response, 400, { error: "invalid json" });
          return;
        }
        if (!deliveries.firstTime(headerValue(request.headers["x-github-delivery"]))) {
          send(response, 202, { accepted: false, reason: "duplicate delivery" });
          return;
        }
        const pull = pullRequestFrom(headerValue(request.headers["x-github-event"]), payload);
        if (pull) {
          send(response, 202, { accepted: Boolean(hooks.pullRequest), pullRequest: `${pull.repo}#${pull.number}` });
          if (hooks.pullRequest) {
            try {
              await hooks.pullRequest({ ...pull, deliveryId: headerValue(request.headers["x-github-delivery"]) });
            } catch (error) {
              console.warn(`[ingress] pull request ${pull.repo}#${pull.number} failed: ${error instanceof Error ? error.message : error}`);
            }
          }
          return;
        }
        const { paths, ref, commit, commitUrl, repo } = docsPathsFrom(payload);
        // Only the public docs repo feeds the round trip. The vault repo's pushes are the
        // agent's own: syncing them back would stamp every note as human-edited and push it
        // again, forever.
        const docsSlug = config.docsRepo.slug ?? repoSlugFromUrl(config.docsRepo.url);
        const fromDocsRepo = !repo || !docsSlug || repo.toLowerCase() === docsSlug.toLowerCase();
        const onBase = fromDocsRepo && (!ref || ref === `refs/heads/${config.docsRepo.base}`);
        send(response, 202, { accepted: onBase && paths.length > 0, paths: paths.length, ref });
        if (onBase && paths.length && hooks.docsChanged) {
          try {
            await hooks.docsChanged({ paths, commit, commitUrl });
          } catch (error) {
            console.warn(`[ingress] docs sync failed: ${error instanceof Error ? error.message : error}`);
          }
        }
        return;
      }

      send(response, 404, { error: "not found" });
    })();
  });

  server.listen(config.port, () => {
    console.log(`[ingress] :${config.port} — /health, /jira/webhook/<secret>${githubSecret ? ", /github/webhook" : ""}`);
    if (!jiraSecret) console.log("[ingress] JIRA_WEBHOOK_SECRET not set — the Jira webhook route is closed; the poller still runs");
  });
  return server;
}
