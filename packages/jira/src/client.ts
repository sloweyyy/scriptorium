import { Buffer } from "node:buffer";
import type { JiraSettings } from "@scriptorium/core";
import type { JiraAttachment, JiraComment, JiraIssue, JiraRemoteLink, JiraTransition, JiraUser } from "./types";

/** Entity-property key an op-keyed comment carries. */
export const COMMENT_OP_PROPERTY = "scriptorium.op";

export interface JiraClientConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  projectKey: string;
}

export class JiraError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
    detail: string,
  ) {
    super(`Jira ${status} on ${endpoint}: ${detail}`);
    this.name = "JiraError";
  }
}

/** Fields the poller needs; asking for them explicitly keeps enhanced search (`/search/jql`) happy. */
const ISSUE_FIELDS = ["summary", "description", "status", "issuetype", "labels", "attachment", "updated", "reporter"];

/**
 * Jira Cloud REST v2 client.
 *
 * v2 (not v3) on purpose: v2 takes and returns comment/description bodies as plain
 * wiki-markup strings, so the agent can read a PRD out of a description and post a
 * draft back without marshalling Atlassian Document Format.
 */
export class JiraClient {
  private readonly base: string;
  private readonly authHeader: string;
  /** Remembered after the first successful search so each poll costs one request. */
  private searchPath?: string;

  constructor(private readonly config: JiraClientConfig) {
    this.base = config.baseUrl.replace(/\/+$/, "");
    this.authHeader = `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString("base64")}`;
  }

  /** Which search endpoint answered — reported by `pnpm jira:doctor`. */
  get searchEndpoint(): string | undefined {
    return this.searchPath;
  }

  get projectKey(): string {
    return this.config.projectKey;
  }

  issueUrl(key: string): string {
    return `${this.base}/browse/${key}`;
  }

  private async call(endpoint: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${this.base}${endpoint}`, {
      ...init,
      headers: { Authorization: this.authHeader, Accept: "application/json", ...(init.headers ?? {}) },
    });
  }

  private async readJson<T>(response: Response, endpoint: string): Promise<T> {
    const text = await response.text();
    if (!response.ok) {
      throw new JiraError(response.status, endpoint, text.slice(0, 400) || response.statusText);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  private async get<T>(endpoint: string): Promise<T> {
    return this.readJson<T>(await this.call(endpoint), endpoint);
  }

  private async post<T>(endpoint: string, body: unknown): Promise<T> {
    const response = await this.call(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return this.readJson<T>(response, endpoint);
  }

  /** The authenticated bot account — used to ignore the agent's own comments. */
  async myself(): Promise<JiraUser> {
    return this.get<JiraUser>("/rest/api/2/myself");
  }

  /**
   * The ticket's remote links — where a linked Confluence page shows up. Jira and
   * Confluence on the same site create one automatically the moment a page is linked
   * to the issue, so this is how a "PRD lives in Confluence" ticket points at its PRD.
   */
  async remoteLinks(key: string): Promise<JiraRemoteLink[]> {
    return this.get<JiraRemoteLink[]>(`/rest/api/2/issue/${encodeURIComponent(key)}/remotelink`);
  }

  /**
   * One Confluence page, as storage-format XHTML.
   *
   * Same site, same token: Confluence Cloud lives under `/wiki` on the Jira base URL and
   * accepts the same basic auth, so reading a PRD out of Confluence costs no new
   * credential and no new configuration.
   */
  async confluencePage(pageId: string): Promise<{ title: string; storage: string }> {
    // A page id is digits. Anything else is a URL fragment someone typed, not a page.
    if (!/^\d+$/.test(pageId)) throw new JiraError(400, "/wiki/api/v2/pages", `not a Confluence page id: ${pageId}`);
    // v2 first: the v1 content GET is gone from Atlassian's current spec. v1 stays as the
    // fallback for sites that still serve it, tried only when v2 is not there at all.
    const v2 = `/wiki/api/v2/pages/${pageId}?body-format=storage`;
    const response = await this.call(v2);
    if (response.status !== 404 && response.status !== 410) {
      const page = await this.readJson<{ title?: string; body?: { storage?: { value?: string } } }>(response, v2);
      return { title: page.title ?? `Confluence page ${pageId}`, storage: page.body?.storage?.value ?? "" };
    }
    const v1 = `/wiki/rest/api/content/${pageId}?expand=body.storage`;
    const page = await this.get<{ title?: string; body?: { storage?: { value?: string } } }>(v1);
    return { title: page.title ?? `Confluence page ${pageId}`, storage: page.body?.storage?.value ?? "" };
  }

  /**
   * JQL search. Cloud has moved to `/search/jql` (token paging, explicit fields);
   * older Cloud and Server/DC still answer on `/search`. Try new, fall back once, remember.
   */
  async searchIssues(jql: string, maxResults = 50): Promise<JiraIssue[]> {
    const query = new URLSearchParams({ jql, maxResults: String(maxResults), fields: ISSUE_FIELDS.join(",") });
    const candidates = this.searchPath ? [this.searchPath] : ["/rest/api/2/search/jql", "/rest/api/2/search"];

    let lastError: JiraError | undefined;
    for (const path of candidates) {
      const endpoint = `${path}?${query.toString()}`;
      const response = await this.call(endpoint);
      if (response.status === 404 || response.status === 410) {
        lastError = new JiraError(response.status, path, "endpoint not available on this instance");
        continue;
      }
      const data = await this.readJson<{ issues?: JiraIssue[] }>(response, path);
      this.searchPath = path;
      return data.issues ?? [];
    }
    throw lastError ?? new JiraError(404, "/rest/api/2/search", "no usable search endpoint");
  }

  async getIssue(key: string): Promise<JiraIssue> {
    return this.get<JiraIssue>(`/rest/api/2/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS.join(",")}`);
  }

  /** Who last moved the issue into `statusName` — the approver of record for the audit log. */
  /**
   * Who last moved the issue into `statusName` — name AND accountId, because the caller
   * must be able to tell a human's transition from the agent's own. The agent drives the
   * board itself, so "someone moved it to Done" is only an approval when that someone is
   * not the agent.
   */
  async lastStatusChangeAuthor(
    key: string,
    statusName: string,
  ): Promise<{ name: string; accountId?: string } | undefined> {
    const data = await this.get<{
      changelog?: { histories?: Array<{ author?: JiraUser; items?: Array<{ field?: string; toString?: string }> }> };
    }>(`/rest/api/2/issue/${encodeURIComponent(key)}?expand=changelog&fields=status`);

    const wanted = statusName.trim().toLowerCase();
    const histories = data.changelog?.histories ?? [];
    for (let index = histories.length - 1; index >= 0; index -= 1) {
      const entry = histories[index];
      const moved = entry?.items?.some((item) => item.field === "status" && item.toString?.toLowerCase() === wanted);
      if (moved) {
        const name = entry?.author?.displayName ?? entry?.author?.accountId;
        return name ? { name, accountId: entry?.author?.accountId } : undefined;
      }
    }
    return undefined;
  }

  async listComments(key: string, maxResults = 200, options: { expandProperties?: boolean } = {}): Promise<JiraComment[]> {
    const expand = options.expandProperties ? "&expand=properties" : "";
    const data = await this.get<{ comments?: JiraComment[] }>(
      `/rest/api/2/issue/${encodeURIComponent(key)}/comment?orderBy=created&maxResults=${maxResults}${expand}`,
    );
    return data.comments ?? [];
  }

  /**
   * `op` is stored as an entity property on the comment itself, in the same call — so
   * whether a write landed can be asked of Jira, not only of a local ledger that a crash
   * may have left behind (see `findCommentByOp`).
   */
  async addComment(key: string, body: string, options: { op?: string } = {}): Promise<JiraComment> {
    const properties = options.op ? [{ key: COMMENT_OP_PROPERTY, value: { op: options.op } }] : undefined;
    return this.post<JiraComment>(`/rest/api/2/issue/${encodeURIComponent(key)}/comment`, { body, ...(properties ? { properties } : {}) });
  }

  /** The comment an op already produced, if Jira has it. */
  async findCommentByOp(key: string, op: string): Promise<JiraComment | undefined> {
    const comments = await this.listComments(key, 200, { expandProperties: true });
    return comments.find((comment) =>
      comment.properties?.some((property) => property.key === COMMENT_OP_PROPERTY && (property.value as { op?: string } | undefined)?.op === op),
    );
  }

  async listTransitions(key: string): Promise<JiraTransition[]> {
    const data = await this.get<{ transitions?: JiraTransition[] }>(
      `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`,
    );
    return data.transitions ?? [];
  }

  /**
   * Set the assignee. `null` unassigns.
   *
   * PUT rather than an edit payload because assignment is its own endpoint in v2, and
   * because it needs the "Assign issues" permission specifically — a project where the
   * agent may comment but not assign fails here and nowhere else.
   */
  async assign(key: string, accountId: string | null): Promise<void> {
    const endpoint = `/rest/api/2/issue/${encodeURIComponent(key)}/assignee`;
    const response = await this.call(endpoint, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId }),
    });
    if (!response.ok) {
      throw new JiraError(response.status, endpoint, (await response.text()).slice(0, 200));
    }
  }

  /** Move the issue by target status name (case-insensitive). Returns false when no such transition exists. */
  async transitionTo(key: string, statusName: string): Promise<boolean> {
    const wanted = statusName.trim().toLowerCase();
    const transitions = await this.listTransitions(key);
    const match = transitions.find(
      (transition) => transition.to?.name?.toLowerCase() === wanted || transition.name.toLowerCase() === wanted,
    );
    if (!match) return false;
    await this.post(`/rest/api/2/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: match.id } });
    return true;
  }

  /**
   * Download an attachment. The first hop is authenticated; Atlassian answers with a
   * redirect to signed media storage on another host, where the Authorization header
   * must not travel (undici strips it cross-origin anyway).
   */
  async downloadAttachment(attachment: JiraAttachment): Promise<Buffer> {
    const first = await fetch(attachment.content, {
      headers: { Authorization: this.authHeader },
      redirect: "manual",
    });

    let response = first;
    if (first.status >= 300 && first.status < 400) {
      const location = first.headers.get("location");
      if (!location) throw new JiraError(first.status, attachment.content, "redirect without a location header");
      response = await fetch(location, { redirect: "follow" });
    }

    if (!response.ok) {
      throw new JiraError(response.status, attachment.content, response.statusText);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  /** Attach a file to an issue (multipart; the boundary must come from FormData, not from us). */
  async uploadAttachment(key: string, filename: string, content: string | Buffer, contentType: string): Promise<void> {
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: contentType }), filename);

    const endpoint = `/rest/api/2/issue/${encodeURIComponent(key)}/attachments`;
    const response = await this.call(endpoint, {
      method: "POST",
      headers: { "X-Atlassian-Token": "no-check" },
      body: form,
    });
    await this.readJson(response, endpoint);
  }

  async createIssue(input: {
    summary: string;
    description: string;
    issueType: string;
    labels?: string[];
  }): Promise<{ key: string; url: string }> {
    const created = await this.post<{ key: string }>("/rest/api/2/issue", {
      fields: {
        project: { key: this.projectKey },
        summary: input.summary,
        description: input.description,
        issuetype: { name: input.issueType },
        ...(input.labels?.length ? { labels: input.labels } : {}),
      },
    });
    return { key: created.key, url: this.issueUrl(created.key) };
  }
}

/** Build a client from env-backed settings, failing loudly when the demo is half-configured. */
export function jiraClient(settings: JiraSettings): JiraClient {
  const { baseUrl, email, apiToken, projectKey } = settings;
  if (!baseUrl || !email || !apiToken || !projectKey) {
    throw new Error("Jira is not configured — set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN and JIRA_PROJECT_KEY.");
  }
  return new JiraClient({ baseUrl, email, apiToken, projectKey });
}
