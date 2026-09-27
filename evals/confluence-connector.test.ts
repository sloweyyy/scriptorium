import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfluenceConnector, cqlString } from "@scriptorium/connectors";

/**
 * The Confluence connector's two safety rules: spaces are allow-listed for reads too, and
 * the model supplies words, never CQL. Against a stubbed Confluence, no network.
 */

let requests: string[];
/** Pages the stub serves, by id → space id. */
const PAGES: Record<string, { spaceId: string; title: string }> = {
  "101": { spaceId: "1", title: "Maintenance windows" },
  "202": { spaceId: "2", title: "Salaries 2026" },
};

beforeEach(() => {
  requests = [];
  vi.stubGlobal("fetch", async (input: string) => {
    const url = decodeURIComponent(String(input));
    requests.push(url);
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (url.includes("/api/v2/spaces?keys=")) return json({ results: [{ id: 1, key: "BEACON" }] });
    if (url.includes("/rest/api/search")) {
      return json({ results: [{ excerpt: "@@@hl@@@Maintenance@@@endhl@@@ windows", content: { id: "101", title: "Maintenance windows", space: { key: "BEACON" } } }] });
    }
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
