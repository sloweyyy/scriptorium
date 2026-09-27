import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubTools } from "@scriptorium/connectors";
import { MemoryEffectLedger } from "@scriptorium/runtime";
import { enforceGrounding, parseQaAnswer } from "@scriptorium/curator";
import { Vault } from "@scriptorium/core";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

/**
 * GitHub PRs as tools (v1 job #5): repos allow-listed, reads return what a reviewer needs,
 * the advisory comment is exactly-once, and a PR is citable as github:owner/repo/pull/N.
 */

let comments: Array<{ id: number; body: string }>;
let tokensAskedFor: string[];
let loseNext: boolean;

beforeEach(() => {
  comments = [];
  tokensAskedFor = [];
  loseNext = false;
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = String(input);
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (url.endsWith("/repos/org/app/pulls/12")) {
      return json({ number: 12, title: "DOC-7: digest timezone setting", body: "Implements the per-workspace setting.", state: "open", user: { login: "dev" }, head: { ref: "feat/DOC-7-timezone" }, html_url: "https://github.com/org/app/pull/12" });
    }
    if (url.includes("/pulls/12/files")) return json([{ filename: "src/settings.ts", status: "modified", additions: 40, deletions: 3 }]);
    if (url.includes("/issues/12/comments") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)).body as string;
      const stored = { id: 900 + comments.length, body };
      comments.push(stored);
      if (loseNext) {
        loseNext = false;
        throw new TypeError("socket hang up");
      }
      return json({ id: stored.id }, 201);
    }
    if (url.includes("/issues/12/comments")) return json(comments);
    return json({ message: "Not Found" }, 404);
  });
});

afterEach(() => vi.unstubAllGlobals());

const tools = (ledger = new MemoryEffectLedger()) =>
  Object.fromEntries(githubTools({ token: async (repo) => (tokensAskedFor.push(repo), "tok"), allowedRepos: ["org/app"], ledger }).map((tool) => [tool.name, tool]));

describe("github connector", () => {
  it("reads a PR — title, files, Jira keys — and records it as citable", async () => {
    const get = tools().github_get_pull!;
    const out = await get.run({ repo: "Org/App", number: 12 });
    expect(out).toMatch(/^github:org\/app\/pull\/12 — DOC-7: digest timezone setting/);
    expect(out).toContain("Jira keys mentioned: DOC-7");
    expect(out).toContain("modified src/settings.ts (+40/-3)");
    expect(get.records!({ repo: "Org/App", number: 12 }, out)).toEqual(["github:org/app/pull/12"]);
    expect(tokensAskedFor).toEqual(["org/app", "org/app"]);
  });

  it("refuses a repo off the allow-list before asking for a token", async () => {
    expect(await tools().github_get_pull!.run({ repo: "org/secret", number: 1 })).toMatch(/^NOT_ALLOWED/);
    expect(await tools().github_get_pull!.run({ repo: "../../x", number: 1 })).toMatch(/^NOT_ALLOWED/);
    expect(tokensAskedFor).toEqual([]);
  });

  it("comments once, marks it AI-generated, and finds its own comment after a lost response", async () => {
    const ledger = new MemoryEffectLedger();
    loseNext = true;
    const comment = () => tools(ledger).github_pr_comment!.run({ repo: "org/app", number: 12, body: "Criteria 1/2 covered." }, { approval: { id: "ap-1" } });
    await expect(comment()).rejects.toThrow(/socket hang up/);
    expect(await comment()).toMatch(/^Already commented/);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("AI-generated review note");
    expect(comments[0]?.body).toMatch(/<!-- scriptorium-op:[0-9a-f]{24} -->/);
  });

  it("a PR is a valid citation only when it was fetched", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-gh-"));
    const vault = new Vault(root);
    const cited = await enforceGrounding(vault, parseQaAnswer("It adds the setting [[github:org/app/pull/12]].", "q"), { usedOverview: false, retrieved: [], records: new Set(["github:org/app/pull/12"]) });
    expect(cited.ungrounded).toBeUndefined();
    const invented = await enforceGrounding(vault, parseQaAnswer("It adds the setting [[github:org/app/pull/13]].", "q"), { usedOverview: false, retrieved: [], records: new Set(["github:org/app/pull/12"]) });
    expect(invented.ungrounded).toBe(true);
    await fs.rm(root, { recursive: true, force: true });
  });
});
