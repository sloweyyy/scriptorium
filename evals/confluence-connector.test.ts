import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfluenceConnector, cqlString } from "@scriptorium/connectors";
import { MemoryEffectLedger } from "@scriptorium/runtime";

/**
 * The Confluence connector's two safety rules: spaces are allow-listed for reads too, and
 * the model supplies words, never CQL. Against a stubbed Confluence, no network.
 */

let requests: string[];
let downloads: Array<{ url: string; auth: boolean }> = [];
/** Pages the stub serves, by id → space id. */
const PAGES: Record<string, { spaceId: string; title: string }> = {
  "101": { spaceId: "1", title: "Maintenance windows" },
  "104": { spaceId: "1", title: "Specs" },
  "202": { spaceId: "2", title: "Salaries 2026" },
};

beforeEach(() => {
  requests = [];
  downloads = [];
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = decodeURIComponent(String(input));
    requests.push(url);
    downloads.push({ url, auth: Boolean((init?.headers as Record<string, string> | undefined)?.Authorization) });
    if (url.endsWith("/api/v2/pages/101/attachments?limit=50")) {
      return new Response(JSON.stringify({ results: [
        { id: "att1", title: "limits.csv", mediaType: "text/csv", fileSize: 40, downloadLink: "/download/attachments/101/limits.csv", pageId: "101" },
        { id: "att2", title: "deck.pdf", mediaType: "application/pdf", fileSize: 900000, downloadLink: "/download/attachments/101/deck.pdf", pageId: "101" },
      ] }), { status: 200 });
    }
    if (url.includes("/download/attachments/101/limits.csv")) return new Response(null, { status: 302, headers: { location: "https://media.example/blob/limits.csv" } });
    if (url.startsWith("https://media.example/")) return new Response("plan,max_seats\nfree,5\nteam,50", { status: 200 });
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (url.includes("/api/v2/spaces?keys=")) return json({ results: [{ id: 1, key: "BEACON" }] });
    if (url.includes("/rest/api/search")) {
      return json({ results: [{ excerpt: "@@@hl@@@Maintenance@@@endhl@@@ windows", content: { id: "101", title: "Maintenance windows", space: { key: "BEACON" } } }] });
    }
    const parent = url.match(/\/api\/v2\/pages\/(\d+)\/children/)?.[1];
    if (parent === "101") return json({ results: [{ id: "103", title: "Maintenance runbook", spaceId: "1" }, { id: "202", title: "Salaries 2026", spaceId: "2" }] });
    if (parent === "104") return json({ results: [{ id: "105", title: "Child", spaceId: "1" }], _links: { next: "/wiki/api/v2/pages/104/children?cursor=x" } });
    const page = url.match(/\/api\/v2\/pages\/(\d+)/)?.[1];
    if (page && PAGES[page]) {
      return json({ id: page, title: PAGES[page].title, spaceId: PAGES[page].spaceId, body: { storage: { value: "<h1>Hello</h1><p>World</p>" } }, _links: { webui: `/spaces/X/pages/${page}` } });
    }
    return new Response("nope", { status: 404 });
  });
});

afterEach(() => vi.unstubAllGlobals());

const connector = (allowedSpaceKeys: string[] = ["BEACON"]) =>
  new ConfluenceConnector({ baseUrl: "https://example.atlassian.net", email: "a@example.com", apiToken: "t", allowedSpaceKeys });

describe("confluence connector", () => {
  it("constrains every search to the allowed spaces", async () => {
    const results = await connector().search("maintenance");
    expect(results).toEqual([{ id: "101", title: "Maintenance windows", space: "BEACON", excerpt: "Maintenance windows", url: undefined }]);
    const cql = requests.find((url) => url.includes("/rest/api/search"));
    expect(cql).toContain('space in ("BEACON")');
  });

  it("the model's words cannot close the string and widen the query", async () => {
    await connector().search('x" OR space = "SECRET');
    const cql = requests.find((url) => url.includes("/rest/api/search")) ?? "";
    expect(cql).toContain('text ~ "x\\" OR space = \\"SECRET"');
    expect(cqlString('a\\"b')).toBe('"a\\\\\\"b"');
  });

  it("reads a page in an allowed space, and refuses one outside it without leaking its title", async () => {
    const page = await connector().readPage("101");
    expect(page).toMatchObject({ title: "Maintenance windows", space: "BEACON" });
    expect(page.markdown).toContain("Hello");

    const [search, read] = connector().tools();
    const refused = await read!.run({ id: "202" });
    expect(refused).toMatch(/^NOT_ALLOWED:/);
    expect(refused).not.toContain("Salaries");
    expect(search).toBeDefined();
  });

  it("no allow-list means no Confluence at all", async () => {
    const [search, read] = connector([]).tools();
    expect(await search!.run({ query: "maintenance" })).toMatch(/^NOT_ALLOWED:/);
    expect(await read!.run({ id: "101" })).toMatch(/^NOT_ALLOWED:/);
    expect(requests.some((url) => url.includes("/rest/api/search"))).toBe(false);
  });

  it("rejects a page id that is not a number before any request", async () => {
    const [, read] = connector().tools();
    expect(await read!.run({ id: "../../admin" })).toMatch(/^NOT_ALLOWED:/);
    expect(requests).toHaveLength(0);
  });

  it("fails loudly, naming the field, when Confluence changes shape", async () => {
    vi.stubGlobal("fetch", async (input: string) => {
      if (String(input).includes("spaces?keys")) return new Response(JSON.stringify({ results: [{ id: 1, key: "BEACON" }] }));
      return new Response(JSON.stringify({ id: "101", title: "T", spaceId: "1", body: {} }));
    });
    await expect(connector().readPage("101")).rejects.toThrow(/unexpected shape: body\.storage/);
  });
});

describe("confluence page trees", () => {
  it("lists a page's children in allowed spaces only, and refuses a parent outside them", async () => {
    const children = connector().tools().find((tool) => tool.name === "confluence_page_children")!;
    const out = await children.run({ id: "101" });
    expect(JSON.parse(out)).toEqual([{ cite: "confluence:103", id: "103", title: "Maintenance runbook" }]);
    expect(out).not.toContain("Salaries");
    expect(children.records!({ id: "101" }, out)).toEqual(["confluence:103"]);
    const refused = await children.run({ id: "202" });
    expect(refused).toMatch(/^NOT_ALLOWED/);
    expect(refused).not.toContain("Salaries");
  });

  it("says when a page has more children than it lists", async () => {
    const children = connector().tools().find((tool) => tool.name === "confluence_page_children")!;
    const out = JSON.parse(await children.run({ id: "104" })) as Array<{ note?: string; cite?: string }>;
    expect(out.map((hit) => hit.cite ?? hit.note)).toEqual(["confluence:105", "Showing the first 100 child pages; there are more."]);
  });
});

describe("confluence attachments", () => {
  it("reads a text attachment of an allowed page, never sending credentials to media storage", async () => {
    const tools = connector().tools();
    const list = tools.find((tool) => tool.name === "confluence_page_attachments")!;
    const read = tools.find((tool) => tool.name === "confluence_read_attachment")!;
    expect(JSON.parse(await list.run({ id: "101" })).map((attachment: { title: string }) => attachment.title)).toEqual(["limits.csv", "deck.pdf"]);
    const out = await read.run({ pageId: "101", attachmentId: "att1" });
    expect(out).toBe("confluence:101 — attachment limits.csv\n\nplan,max_seats\nfree,5\nteam,50");
    expect(read.records!({ pageId: "101", attachmentId: "att1" }, out)).toEqual(["confluence:101"]);
    expect(downloads.find((request) => request.url.startsWith("https://media.example/"))?.auth).toBe(false);
    expect(await read.run({ pageId: "101", attachmentId: "att2" })).toMatch(/^NOT_ALLOWED: deck.pdf is application\/pdf/);
    expect(await list.run({ id: "202" })).toMatch(/^NOT_ALLOWED/);
    expect(await read.run({ pageId: "202", attachmentId: "att1" })).toMatch(/^NOT_ALLOWED/);
  });
});

describe("confluence writes", () => {
  let pages: Record<string, { title: string; spaceId: string; version: number; message?: string; body?: string }>;
  let loseNext: boolean;

  beforeEach(() => {
    pages = { "101": { title: "Maintenance windows", spaceId: "1", version: 3 }, "202": { title: "Salaries 2026", spaceId: "2", version: 1 } };
    loseNext = false;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      const url = decodeURIComponent(String(input));
      const method = init?.method ?? "GET";
      const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
      if (url.includes("/api/v2/spaces?keys=")) return json({ results: [{ id: 1, key: "BEACON" }] });
      if (url.includes("/api/v2/pages?space-id=")) {
        const title = new URL(String(input)).searchParams.get("title");
        return json({ results: Object.entries(pages).filter(([, page]) => page.title === title).map(([id, page]) => ({ id, title: page.title })) });
      }
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (method === "POST" && url.endsWith("/api/v2/pages")) {
        const id = String(300 + Object.keys(pages).length);
        pages[id] = { title: body.title, spaceId: String(body.spaceId), version: 1, body: body.body.value };
        if (loseNext) { loseNext = false; throw new TypeError("socket hang up"); }
        return json({ id, title: body.title, spaceId: body.spaceId, version: { number: 1 } });
      }
      const id = url.match(/\/api\/v2\/pages\/(\d+)/)?.[1];
      if (id && pages[id] && method === "PUT") {
        pages[id] = { ...pages[id]!, version: body.version.number, message: body.version.message, body: body.body.value };
        if (loseNext) { loseNext = false; throw new TypeError("socket hang up"); }
        return json({ id, title: body.title, spaceId: pages[id]!.spaceId, version: { number: body.version.number } });
      }
      if (id && pages[id]) return json({ id, title: pages[id]!.title, spaceId: pages[id]!.spaceId, version: { number: pages[id]!.version, message: pages[id]!.message } });
      return new Response("nope", { status: 404 });
    });
  });

  const writer = (ledger = new MemoryEffectLedger()) =>
    new ConfluenceConnector({ baseUrl: "https://example.atlassian.net", email: "a", apiToken: "t", allowedSpaceKeys: ["BEACON"], ledger });

  it("creates a page once, even when the response is lost after Confluence created it", async () => {
    const ledger = new MemoryEffectLedger();
    loseNext = true;
    await expect(writer(ledger).createPage({ space: "BEACON", title: "Digest emails", markdown: "# Digest\n\nOne a day." })).rejects.toThrow();
    const retry = await writer(ledger).createPage({ space: "BEACON", title: "Digest emails", markdown: "# Digest\n\nOne a day." });
    expect(retry.created).toBe(false);
    expect(Object.values(pages).filter((page) => page.title === "Digest emails")).toHaveLength(1);
    // Sent as Confluence wiki markup.
    expect(pages[retry.id]?.body).toContain("h1. Digest");
  });

  it("won't claim a page someone else already made with that title", async () => {
    pages["777"] = { title: "Release notes", spaceId: "1", version: 3, body: "a human's page" };
    const create = writer().tools().find((tool) => tool.name === "confluence_create_page")!;
    const out = await create.run({ space: "BEACON", title: "Release notes", markdown: "# x" }, { approval: { id: "ap-1" } });
    expect(out).toMatch(/^NOT_ALLOWED: A page titled "Release notes" already exists in BEACON \(confluence:777\)/);
    expect(pages["777"]?.body).toBe("a human's page");
  });

  it("refuses to write outside the allowed spaces", async () => {
    await expect(writer().createPage({ space: "HR", title: "x", markdown: "x" })).rejects.toThrow(/outside/);
    await expect(writer().updatePage({ id: "202", markdown: "x" })).rejects.toThrow(/outside/);
    expect(pages["202"]!.version).toBe(1);
  });

  it("updates to version + 1 exactly once, with the op in the version message", async () => {
    const ledger = new MemoryEffectLedger();
    loseNext = true;
    await expect(writer(ledger).updatePage({ id: "101", markdown: "Windows are 4 hours." })).rejects.toThrow();
    expect(await writer(ledger).updatePage({ id: "101", markdown: "Windows are 4 hours." })).toEqual({ version: 4, updated: false });
    expect(pages["101"]!.version).toBe(4);
    expect(pages["101"]!.message).toMatch(/^scriptorium op /);
  });

  it("offers no write tools without a ledger", () => {
    const readOnly = new ConfluenceConnector({ baseUrl: "https://example.atlassian.net", email: "a", apiToken: "t", allowedSpaceKeys: ["BEACON"] });
    expect(readOnly.tools().map((tool) => tool.name)).toEqual(["confluence_search", "confluence_read_page", "confluence_page_children", "confluence_page_attachments", "confluence_read_attachment"]);
    expect(writer().tools().map((tool) => tool.name)).toContain("confluence_update_page");
  });
});

describe("a failed space lookup", () => {
  it("is retried on the next call, not cached as a failure until restart", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async (input: string) => {
      const url = decodeURIComponent(String(input));
      if (url.includes("/api/v2/spaces?keys=")) {
        calls += 1;
        return calls === 1 ? new Response("down", { status: 503 }) : new Response(JSON.stringify({ results: [{ id: 1, key: "BEACON" }] }));
      }
      return new Response(JSON.stringify({ results: [] }));
    });
    const c = new ConfluenceConnector({ baseUrl: "https://example.atlassian.net", email: "a", apiToken: "t", allowedSpaceKeys: ["BEACON"] });
    await expect(c.search("x")).rejects.toThrow(/503/);
    expect(await c.search("x")).toEqual([]);
  });
});

describe("separately approved identical writes", () => {
  it("a page reverted A→B→A under three approvals is updated three times", async () => {
    const pages: Record<string, { version: number; message?: string }> = { "101": { version: 1 } };
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      const url = decodeURIComponent(String(input));
      if (url.includes("/api/v2/spaces?keys=")) return new Response(JSON.stringify({ results: [{ id: 1, key: "BEACON" }] }));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (init?.method === "PUT") {
        pages["101"] = { version: body.version.number, message: body.version.message };
        return new Response(JSON.stringify({ id: "101", title: "T", spaceId: "1", version: { number: body.version.number } }));
      }
      return new Response(JSON.stringify({ id: "101", title: "T", spaceId: "1", version: { number: pages["101"]!.version, message: pages["101"]!.message } }));
    });
    const ledger = new MemoryEffectLedger();
    const c = new ConfluenceConnector({ baseUrl: "https://example.atlassian.net", email: "a", apiToken: "t", allowedSpaceKeys: ["BEACON"], ledger });
    await c.updatePage({ id: "101", markdown: "A", approvalId: "ap-1" });
    await c.updatePage({ id: "101", markdown: "B", approvalId: "ap-2" });
    expect((await c.updatePage({ id: "101", markdown: "A", approvalId: "ap-3" })).updated).toBe(true);
    expect(pages["101"]!.version).toBe(4);
  });
});
