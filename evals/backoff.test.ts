import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithBackoff, retryAfterMs } from "@scriptorium/core";
import { JiraClient } from "@scriptorium/jira";

/** Rate limits: wait what the server asks, retry what wasn't processed, give up bounded. */

afterEach(() => vi.unstubAllGlobals());

function script(statuses: Array<{ status: number; retryAfter?: string }>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    const next = statuses.shift() ?? { status: 200 };
    return new Response(next.status === 200 ? JSON.stringify({ id: "10001", body: "hi", created: "now" }) : "slow down", {
      status: next.status,
      headers: next.retryAfter ? { "retry-after": next.retryAfter } : {},
    });
  });
  return calls;
}

describe("fetchWithBackoff", () => {
  it("waits what Retry-After says, then succeeds — a write lands once", async () => {
    const calls = script([{ status: 429, retryAfter: "2" }, { status: 200 }]);
    const waits: number[] = [];
    const response = await fetchWithBackoff("https://x.atlassian.net/rest/api/2/issue/DOC-1/comment", { method: "POST" }, { sleep: async (ms) => void waits.push(ms) });
    expect(response.status).toBe(200);
    expect(waits).toEqual([2000]);
    expect(calls).toHaveLength(2);
  });

  it("gives up after its tries and its wait budget, returning the refusal (fail closed)", async () => {
    script([{ status: 429, retryAfter: "20" }, { status: 429, retryAfter: "20" }, { status: 429, retryAfter: "20" }]);
    const waits: number[] = [];
    const response = await fetchWithBackoff("https://x/y", {}, { sleep: async (ms) => void waits.push(ms), maxWaitMs: 30_000 });
    expect(response.status).toBe(429);
    expect(waits).toEqual([20_000, 10_000]);
  });

  it("never retries an error that may have been processed", async () => {
    const calls = script([{ status: 500 }, { status: 200 }]);
    expect((await fetchWithBackoff("https://x/y", { method: "POST" }, { sleep: async () => undefined })).status).toBe(500);
    expect(calls).toHaveLength(1);
  });

  it("retries a read through a transient 500/502/504, and never a write", async () => {
    for (const status of [500, 502, 504]) {
      const reads = script([{ status }, { status: 200 }]);
      expect((await fetchWithBackoff("https://x/y", {}, { sleep: async () => undefined })).status, `GET ${status}`).toBe(200);
      expect(reads).toHaveLength(2);
      for (const method of ["POST", "PUT", "DELETE"]) {
        const writes = script([{ status }, { status: 200 }]);
        expect((await fetchWithBackoff("https://x/y", { method }, { sleep: async () => undefined })).status, `${method} ${status}`).toBe(status);
        expect(writes).toHaveLength(1);
      }
    }
    // Bounded like any other retry.
    const calls = script([{ status: 502 }, { status: 502 }, { status: 502 }, { status: 200 }]);
    expect((await fetchWithBackoff("https://x/y", {}, { sleep: async () => undefined })).status).toBe(502);
    expect(calls).toHaveLength(3);
  });

  it("reads Retry-After as seconds or a date", () => {
    expect(retryAfterMs("3")).toBe(3000);
    expect(retryAfterMs(new Date(Date.now() + 5000).toUTCString(), Date.now())).toBeGreaterThan(3000);
    expect(retryAfterMs(null)).toBeUndefined();
  });

  it("the Jira client rides out a 429", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      script([{ status: 429, retryAfter: "1" }, { status: 200 }]);
      const client = new JiraClient({ baseUrl: "https://x.atlassian.net", email: "a", apiToken: "t" } as never);
      const pending = client.addComment("DOC-1", "hi");
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await pending).id).toBe("10001");
    } finally {
      vi.useRealTimers();
    }
  });
});
