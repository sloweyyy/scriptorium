import { afterEach, describe, expect, it, vi } from "vitest";
import { docBranchName, docPullRequestBody, GitHubError, openPullRequest } from "@scriptorium/publish";

/**
 * PR creation is the second gate, and it runs on a credential the push path deliberately
 * does not have. These pin the two behaviours that decide whether a publish looks broken:
 * it must be idempotent (webhook + poll can both approve the same ticket), and a PR
 * failure must never be mistaken for a failed publish.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("doc pull requests", () => {
  it("opens a pull request and returns its url", async () => {
    const seen: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), method: init?.method ?? "GET", body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ number: 7, html_url: "https://github.com/o/r/pull/7", state: "open" }), { status: 201 });
    });

    const pull = await openPullRequest({
      repo: "o/r",
      head: "docs/doc-1-scheduled-maintenance",
      base: "main",
      title: "docs: scheduled-maintenance (DOC-1)",
      body: "body",
      token: "t",
    });

    expect(pull).toEqual({ number: 7, url: "https://github.com/o/r/pull/7", state: "open" });
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.body).toMatchObject({ head: "docs/doc-1-scheduled-maintenance", base: "main" });
  });

  it("returns the existing pull request when GitHub says one already exists", async () => {
    // Approving twice — comment then transition, or webhook then poll — must not fail the
    // publish or open a duplicate.
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") {
        return new Response(JSON.stringify({ message: "A pull request already exists for o:docs/doc-1." }), { status: 422 });
      }
      expect(String(url)).toContain("state=open");
      return new Response(JSON.stringify([{ number: 3, html_url: "https://github.com/o/r/pull/3", state: "open" }]), { status: 200 });
    });

    const pull = await openPullRequest({ repo: "o/r", head: "docs/doc-1", base: "main", title: "t", body: "b", token: "t" });
    expect(pull.number).toBe(3);
  });

  it("surfaces a real failure instead of pretending a pull request exists", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }));
    await expect(openPullRequest({ repo: "o/r", head: "h", base: "main", title: "t", body: "b", token: "bad" })).rejects.toThrow(
      GitHubError,
    );
  });

  it("names the branch per ticket so a re-publish updates the same pull request", () => {
    expect(docBranchName("DOC-1", "scheduled-maintenance")).toBe("docs/doc-1-scheduled-maintenance");
    expect(docBranchName("DOC-12", "subscriber-management")).toBe("docs/doc-12-subscriber-management");
  });

  it("puts the ticket, approver and applied rules in the pull request body", () => {
    const body = docPullRequestBody({
      issueKey: "DOC-1",
      issueUrl: "https://example.atlassian.net/browse/DOC-1",
      approvedBy: "Alex",
      relPath: "docs/scheduled-maintenance.md",
      appliedLessons: ["L-001"],
    });
    expect(body).toContain("DOC-1");
    expect(body).toContain("approved by Alex");
    expect(body).toContain("L-001");
    // The PR body has to say what merging means, because merging is the publication gate.
    expect(body.toLowerCase()).toContain("second gate");
  });
});
