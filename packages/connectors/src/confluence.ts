import { fetchWithBackoff, type ToolRunContext, type ToolSpec } from "@scriptorium/core";
import { confluenceStorageToMarkdown, markdownToJira } from "@scriptorium/jira";
import { once, opKey, type EffectLedger } from "@scriptorium/runtime";
import { z } from "zod";

/**
 * Confluence as tools an agent can hold (ADR-001 slice 4a — reads only).
 *
 * Two rules make it safe to hand to a model:
 *
 * 1. **Spaces are allow-listed, reads included.** The agent's credentials can see more
 *    than any one conversation should — the confused-deputy hole the security review
 *    found was exactly "any link that looks like a page is read with the bot's rights".
 *    Every search is constrained to the allowed spaces and every page read checks the
 *    page's space first. No allow-list configured means no Confluence at all.
 * 2. **Responses are validated at the boundary.** Upstream drift fails loudly here, with
 *    the field that moved, rather than as `undefined` three layers into a prompt.
 *
 * Search takes words, not CQL: the model never writes a query language, so it cannot
 * widen its own scope (`… OR space = SECRET`).
 */

export interface ConfluenceSettings {
  /** `https://<site>.atlassian.net` — the `/wiki` prefix is added here. */
  baseUrl: string;
  email: string;
  apiToken: string;
  /** Space KEYS the agent may see. Empty: none. */
  allowedSpaceKeys: readonly string[];
  /** Needed for writes (exactly-once). Without it the connector is read-only. */
  ledger?: EffectLedger;
}

const SpaceList = z.object({ results: z.array(z.object({ id: z.union([z.string(), z.number()]).transform(String), key: z.string() })) });
const SearchResult = z.object({
  results: z.array(
    z.object({
      title: z.string().optional(),
      excerpt: z.string().optional(),
      url: z.string().optional(),
      content: z.object({ id: z.string(), title: z.string().optional(), space: z.object({ key: z.string() }).optional() }).optional(),
    }),
  ),
});
const Page = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  title: z.string(),
  spaceId: z.union([z.string(), z.number()]).transform(String),
  body: z.object({ storage: z.object({ value: z.string() }) }),
  _links: z.object({ webui: z.string().optional(), base: z.string().optional() }).optional(),
});
const PageSpace = z.object({ id: z.union([z.string(), z.number()]).transform(String), spaceId: z.union([z.string(), z.number()]).transform(String) });
const ChildList = z.object({
  _links: z.object({ next: z.string().optional() }).optional(),
  results: z.array(z.object({ id: z.union([z.string(), z.number()]).transform(String), title: z.string(), spaceId: z.union([z.string(), z.number()]).transform(String).optional() })),
});
const AttachmentList = z.object({
  results: z.array(
    z.object({
      id: z.union([z.string(), z.number()]).transform(String),
      title: z.string(),
      mediaType: z.string().default("application/octet-stream"),
      fileSize: z.number().optional(),
      downloadLink: z.string().optional(),
      pageId: z.union([z.string(), z.number()]).transform(String).optional(),
    }),
  ),
  _links: z.object({ next: z.string().optional() }).optional(),
});
/** Attachments whose bytes are text a model can read as-is. */
const TEXT_TYPES = /^(text\/|application\/(json|xml|x-yaml|yaml|csv))/;
const PageMeta = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  title: z.string(),
  spaceId: z.union([z.string(), z.number()]).transform(String),
  version: z.object({ number: z.number(), message: z.string().optional() }),
});
const PageList = z.object({ results: z.array(z.object({ id: z.union([z.string(), z.number()]).transform(String), title: z.string() })) });

export class ConfluenceAccessError extends Error {}

export class ConfluenceConnector {
  private readonly auth: string;
  private spaceIds: Promise<Map<string, string>> | undefined;

  constructor(private readonly settings: ConfluenceSettings) {
    this.auth = `Basic ${Buffer.from(`${settings.email}:${settings.apiToken}`).toString("base64")}`;
  }

  private async get<T>(endpoint: string, schema: z.ZodType<T>): Promise<T> {
    const response = await fetchWithBackoff(`${this.settings.baseUrl.replace(/\/$/, "")}/wiki${endpoint}`, {
      headers: { Authorization: this.auth, Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Confluence ${endpoint.split("?")[0]} → HTTP ${response.status}`);
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) throw new Error(`Confluence ${endpoint.split("?")[0]} returned an unexpected shape: ${parsed.error.issues[0]?.path.join(".")}`);
    return parsed.data;
  }

  /** space id → key, for the allowed spaces only. Resolved once. */
  private allowedSpaces(): Promise<Map<string, string>> {
    if (!this.settings.allowedSpaceKeys.length) return Promise.resolve(new Map());
    this.spaceIds ??= this.get(`/api/v2/spaces?keys=${this.settings.allowedSpaceKeys.map(encodeURIComponent).join(",")}`, SpaceList).then(
      (list) => new Map(list.results.map((space) => [space.id, space.key])),
      (error: unknown) => {
        // A failed lookup must not be cached: that kept Confluence dead until restart.
        this.spaceIds = undefined;
        throw error;
      },
    );
    return this.spaceIds;
  }

  async search(words: string, limit = 10): Promise<Array<{ id: string; title: string; space?: string; excerpt: string; url?: string }>> {
    const keys = [...(await this.allowedSpaces()).values()];
    if (!keys.length) throw new ConfluenceAccessError("No Confluence spaces are allowed for this agent.");
    const cql = `text ~ ${cqlString(words)} AND space in (${keys.map(cqlString).join(",")}) AND type = page`;
    const data = await this.get(`/rest/api/search?cql=${encodeURIComponent(cql)}&limit=${Math.min(limit, 25)}`, SearchResult);
    return data.results
      .filter((result) => result.content?.id)
      .map((result) => ({
        id: result.content!.id,
        title: result.content?.title ?? result.title ?? "",
        space: result.content?.space?.key,
        excerpt: stripHighlight(result.excerpt ?? ""),
        url: result.url,
      }));
  }

  async readPage(pageId: string): Promise<{ id: string; title: string; space: string; markdown: string; url?: string }> {
    if (!/^\d+$/.test(pageId)) throw new ConfluenceAccessError("A Confluence page id is digits only.");
    const allowed = await this.allowedSpaces();
    const page = await this.get(`/api/v2/pages/${pageId}?body-format=storage`, Page);
    const space = allowed.get(page.spaceId);
    // Checked after the fetch because only the page knows its space — and nothing about a
    // refused page (not even its title) leaves this function.
    if (!space) throw new ConfluenceAccessError(`Page ${pageId} is outside the Confluence spaces this agent may read.`);
    const base = page._links?.base ?? `${this.settings.baseUrl.replace(/\/$/, "")}/wiki`;
    return {
      id: page.id,
      title: page.title,
      space,
      markdown: confluenceStorageToMarkdown(page.body.storage.value),
      url: page._links?.webui ? `${base}${page._links.webui}` : undefined,
    };
  }

  /**
   * The pages directly under a page — how a spec space is organised. The parent must be in
   * an allowed space, and so must every child listed: a child moved into another space is
   * left out, title and all.
   */
  async listChildren(pageId: string): Promise<{ children: Array<{ id: string; title: string }>; more: boolean }> {
    if (!/^\d+$/.test(pageId)) throw new ConfluenceAccessError("A Confluence page id is digits only.");
    const allowed = await this.allowedSpaces();
    const parent = await this.get(`/api/v2/pages/${pageId}`, PageSpace);
    if (!allowed.has(parent.spaceId)) throw new ConfluenceAccessError(`Page ${pageId} is outside the Confluence spaces this agent may read.`);
    const children = await this.get(`/api/v2/pages/${pageId}/children?limit=100`, ChildList);
    const listed = children.results
      .filter((child) => allowed.has(child.spaceId ?? parent.spaceId))
      .map((child) => ({ id: child.id, title: child.title }));
    return { children: listed, more: Boolean(children._links?.next) };
  }

  /** A page's attachments, if the page is in an allowed space. */
  async listAttachments(pageId: string): Promise<{ attachments: Array<{ id: string; title: string; mediaType: string; fileSize?: number; downloadLink?: string }>; more: boolean }> {
    if (!/^\d+$/.test(pageId)) throw new ConfluenceAccessError("A Confluence page id is digits only.");
    const allowed = await this.allowedSpaces();
    const page = await this.get(`/api/v2/pages/${pageId}`, PageSpace);
    if (!allowed.has(page.spaceId)) throw new ConfluenceAccessError(`Page ${pageId} is outside the Confluence spaces this agent may read.`);
    // 250 is the API's largest page; past it, the listing says it is partial.
    const list = await this.get(`/api/v2/pages/${pageId}/attachments?limit=250`, AttachmentList);
    return { attachments: list.results.filter((attachment) => !attachment.pageId || attachment.pageId === pageId), more: Boolean(list._links?.next) };
  }

  /**
   * One attachment's text: text formats only (a spec as .md, a CSV of limits, JSON), at most
   * 200 KB. The first hop carries the credentials; the redirect to media storage does not.
   */
  async readAttachment(pageId: string, attachmentId: string): Promise<{ title: string; text: string; truncated: boolean }> {
    const { attachments, more } = await this.listAttachments(pageId);
    const attachment = attachments.find((candidate) => candidate.id === attachmentId);
    if (!attachment?.downloadLink) {
      throw new ConfluenceAccessError(more ? `Attachment ${attachmentId} is not among the first ${attachments.length} on page ${pageId}.` : `Page ${pageId} has no attachment ${attachmentId}.`);
    }
    if (!TEXT_TYPES.test(attachment.mediaType)) throw new ConfluenceAccessError(`${attachment.title} is ${attachment.mediaType}; only text attachments can be read.`);
    const base = `${this.settings.baseUrl.replace(/\/$/, "")}/wiki`;
    let response = await fetch(`${base}${attachment.downloadLink}`, { headers: { Authorization: this.auth }, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Confluence attachment redirect without a location");
      response = await fetch(new URL(location, base).toString(), { redirect: "follow" });
    }
    if (!response.ok) throw new Error(`Confluence attachment → HTTP ${response.status}`);
    const text = await response.text();
    const limit = 200_000;
    return { title: attachment.title, text: text.slice(0, limit), truncated: text.length > limit };
  }

  private async send<T>(method: "POST" | "PUT", endpoint: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    const response = await fetchWithBackoff(`${this.settings.baseUrl.replace(/\/$/, "")}/wiki${endpoint}`, {
      method,
      headers: { Authorization: this.auth, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Confluence ${method} ${endpoint.split("?")[0]} → HTTP ${response.status}`);
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) throw new Error(`Confluence ${endpoint.split("?")[0]} returned an unexpected shape: ${parsed.error.issues[0]?.path.join(".")}`);
    return parsed.data;
  }

  private async spaceIdFor(spaceKey: string): Promise<string> {
    for (const [id, key] of await this.allowedSpaces()) if (key === spaceKey) return id;
    throw new ConfluenceAccessError(`Space ${spaceKey} is outside the Confluence spaces this agent may write to.`);
  }

  /**
   * Create a page, exactly once. The probe is the page itself: a page with this title
   * already in this space means an earlier attempt landed (Confluence titles are unique
   * per space), so a retry returns it instead of failing or duplicating.
   */
  async createPage(input: { space: string; title: string; markdown: string; parentId?: string; approvalId?: string }): Promise<{ id: string; created: boolean }> {
    const ledger = this.settings.ledger;
    if (!ledger) throw new ConfluenceAccessError("This connector is read-only.");
    const spaceId = await this.spaceIdFor(input.space);
    const find = async () => {
      const found = await this.get(`/api/v2/pages?space-id=${spaceId}&title=${encodeURIComponent(input.title)}&limit=1`, PageList);
      return found.results[0]?.id;
    };
    const op = opKey("confluence.create", spaceId, input.title, input.approvalId);
    // First attempt only: a page that already has this title is someone else's, not an
    // earlier attempt of ours — reporting it as "Already created" would claim their page.
    if (!(await ledger.get(op))) {
      const taken = await find();
      if (taken) throw new ConfluenceAccessError(`A page titled "${input.title}" already exists in ${input.space} (confluence:${taken}). Update it with confluence_update_page, or choose another title.`);
    }
    const { result, replayed } = await once(
      ledger,
      op,
      async () =>
        (
          await this.send("POST", "/api/v2/pages", {
            spaceId,
            status: "current",
            title: input.title,
            ...(input.parentId ? { parentId: input.parentId } : {}),
            body: { representation: "wiki", value: markdownToJira(input.markdown) },
          }, PageMeta)
        ).id,
      { probe: find },
    );
    return { id: result, created: !replayed };
  }

  /**
   * Replace a page's body, exactly once. Confluence requires version = current + 1; the op
   * rides in the version message, so a retry that finds its own op on the current version
   * knows the update already landed.
   */
  async updatePage(input: { id: string; markdown: string; title?: string; approvalId?: string }): Promise<{ version: number; updated: boolean }> {
    const ledger = this.settings.ledger;
    if (!ledger) throw new ConfluenceAccessError("This connector is read-only.");
    if (!/^\d+$/.test(input.id)) throw new ConfluenceAccessError("A Confluence page id is digits only.");
    const current = await this.get(`/api/v2/pages/${input.id}`, PageMeta);
    if (!(await this.allowedSpaces()).has(current.spaceId)) throw new ConfluenceAccessError(`Page ${input.id} is outside the Confluence spaces this agent may write to.`);
    // The approval is part of the cause: reverting a page A→B→A is a third, separately
    // approved update, not a replay of the first. (Not the page version: a retry after a
    // lost response sees the version it already bumped, and would update twice.)
    const op = opKey("confluence.update", input.id, input.markdown, input.title, input.approvalId);
    const { result, replayed } = await once(
      ledger,
      op,
      async () =>
        (
          await this.send("PUT", `/api/v2/pages/${input.id}`, {
            id: input.id,
            status: "current",
            title: input.title ?? current.title,
            body: { representation: "wiki", value: markdownToJira(input.markdown) },
            version: { number: current.version.number + 1, message: `scriptorium op ${op}` },
          }, PageMeta)
        ).version.number,
      {
        probe: async () => {
          const now = await this.get(`/api/v2/pages/${input.id}`, PageMeta);
          return now.version.message?.includes(op) ? now.version.number : undefined;
        },
      },
    );
    return { version: result, updated: !replayed };
  }

  /** The connector as model tools. Plain-language refusals, never a thrown stack. */
  tools(): ToolSpec[] {
    return [
      {
        name: "confluence_search",
        description: "Search Confluence pages (only the spaces you are allowed to read) by keywords. Returns page ids, titles and excerpts.",
        inputSchema: z.object({ query: z.string().min(1).describe("Keywords, not a sentence and not CQL.") }),
        run: async (input) => {
          const { query } = z.object({ query: z.string().min(1) }).parse(input);
          return refusalOr(async () => JSON.stringify(await this.search(query)));
        },
        records: (_input: unknown, output: string) => ownIds(output, (hit) => (typeof hit.id === "string" ? `confluence:${hit.id}` : undefined)),
      },
      {
        name: "confluence_read_page",
        description: "Read one Confluence page by id, as markdown. Cite it as [[confluence:<id>]].",
        inputSchema: z.object({ id: z.string().describe("The numeric page id from confluence_search.") }),
        run: async (input) => {
          const { id } = z.object({ id: z.string() }).parse(input);
          return refusalOr(async () => {
            const page = await this.readPage(id);
            return `confluence:${page.id} — ${page.title} (space ${page.space})${page.url ? ` ${page.url}` : ""}\n\n${page.markdown}`;
          });
        },
        // The page read is evidence for ITSELF only — its id came from the validated input,
        // and the output starts with it only when the read succeeded.
        records: (input: unknown, output: string) => {
          const id = (input as { id?: unknown })?.id;
          return typeof id === "string" && output.startsWith(`confluence:${id} — `) ? [`confluence:${id}`] : [];
        },
      },
      {
        name: "confluence_page_children",
        description: "List the pages directly under a Confluence page (ids and titles), to find the right page in a spec tree. Read a page before citing it.",
        inputSchema: z.object({ id: z.string().describe("The parent page id.") }),
        run: async (input) => {
          const { id } = z.object({ id: z.string() }).parse(input);
          return refusalOr(async () => {
            const { children, more } = await this.listChildren(id);
            return JSON.stringify([
              ...children.map((child) => ({ cite: `confluence:${child.id}`, ...child })),
              ...(more ? [{ note: "Showing the first 100 child pages; there are more." }] : []),
            ]);
          });
        },
        records: (_input: unknown, output: string) => ownIds(output, (hit) => (typeof hit.id === "string" ? `confluence:${hit.id}` : undefined)),
      },
      {
        name: "confluence_page_attachments",
        description: "List a Confluence page's attachments (id, name, type, size). Only text attachments can be read.",
        inputSchema: z.object({ id: z.string().describe("The page id.") }),
        run: async (input) => {
          const { id } = z.object({ id: z.string() }).parse(input);
          return refusalOr(async () => {
            const { attachments, more } = await this.listAttachments(id);
            return JSON.stringify({
              attachments: attachments.map(({ id: attachmentId, title, mediaType, fileSize }) => ({ id: attachmentId, title, mediaType, fileSize })),
              ...(more ? { note: `Only the first ${attachments.length} attachments are listed; the page has more.` } : {}),
            });
          });
        },
      },
      {
        name: "confluence_read_attachment",
        description: "Read a text attachment of a Confluence page (Markdown, CSV, JSON…). Cite what you use from it as [[confluence:<page id>]].",
        inputSchema: z.object({ pageId: z.string(), attachmentId: z.string() }),
        run: async (input) => {
          const { pageId, attachmentId } = z.object({ pageId: z.string(), attachmentId: z.string() }).parse(input);
          return refusalOr(async () => {
            const read = await this.readAttachment(pageId, attachmentId);
            return `confluence:${pageId} — attachment ${read.title}${read.truncated ? " (first 200 KB only)" : ""}\n\n${read.text}`;
          });
        },
        // Evidence for the page it is attached to, and only when the read succeeded.
        records: (input: unknown, output: string) => {
          const pageId = (input as { pageId?: unknown })?.pageId;
          return typeof pageId === "string" && output.startsWith(`confluence:${pageId} — attachment `) ? [`confluence:${pageId}`] : [];
        },
      },
      ...(this.settings.ledger
        ? [
            {
              name: "confluence_create_page",
              description: "Create a Confluence page in an allowed space. Requires human approval; it is not done until approved.",
              inputSchema: z.object({ space: z.string(), title: z.string().min(1).max(255), markdown: z.string().min(1), parentId: z.string().optional() }),
              run: async (input: unknown, context?: ToolRunContext) => {
                const parsed = z.object({ space: z.string(), title: z.string().min(1).max(255), markdown: z.string().min(1), parentId: z.string().optional() }).parse(input);
                return refusalOr(async () => {
                  const page = await this.createPage({ ...parsed, approvalId: context?.approval?.id });
                  return `${page.created ? "Created" : "Already created"} confluence:${page.id} — ${parsed.title}`;
                });
              },
            },
            {
              name: "confluence_update_page",
              description: "Replace the body of a Confluence page in an allowed space. Requires human approval; it is not done until approved.",
              inputSchema: z.object({ id: z.string(), markdown: z.string().min(1), title: z.string().optional() }),
              run: async (input: unknown, context?: ToolRunContext) => {
                const parsed = z.object({ id: z.string(), markdown: z.string().min(1), title: z.string().optional() }).parse(input);
                return refusalOr(async () => {
                  const page = await this.updatePage({ ...parsed, approvalId: context?.approval?.id });
                  return `${page.updated ? "Updated" : "Already updated"} confluence:${parsed.id} (version ${page.version})`;
                });
              },
            },
          ]
        : []),
    ];
  }
}

/** Record ids out of JSON this connector built itself (never out of page content). */
function ownIds(output: string, id: (hit: Record<string, unknown>) => string | undefined): string[] {
  try {
    const parsed = JSON.parse(output) as unknown;
    return Array.isArray(parsed) ? parsed.flatMap((hit) => (hit && typeof hit === "object" ? [id(hit as Record<string, unknown>)].filter((value): value is string => Boolean(value)) : [])) : [];
  } catch {
    return [];
  }
}

async function refusalOr(work: () => Promise<string>): Promise<string> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ConfluenceAccessError) return `NOT_ALLOWED: ${error.message}`;
    throw error;
  }
}

/** A CQL string literal. Quotes and backslashes escaped, so input can never close it. */
export function cqlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function stripHighlight(excerpt: string): string {
  return excerpt.replace(/@@@(end)?hl@@@/g, "").replace(/\s+/g, " ").trim();
}
