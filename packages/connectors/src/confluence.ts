import type { ToolSpec } from "@scriptorium/core";
import { confluenceStorageToMarkdown } from "@scriptorium/jira";
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

export class ConfluenceAccessError extends Error {}

export class ConfluenceConnector {
  private readonly auth: string;
  private spaceIds: Promise<Map<string, string>> | undefined;

  constructor(private readonly settings: ConfluenceSettings) {
    this.auth = `Basic ${Buffer.from(`${settings.email}:${settings.apiToken}`).toString("base64")}`;
  }

  private async get<T>(endpoint: string, schema: z.ZodType<T>): Promise<T> {
    const response = await fetch(`${this.settings.baseUrl.replace(/\/$/, "")}/wiki${endpoint}`, {
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
      },
    ];
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
