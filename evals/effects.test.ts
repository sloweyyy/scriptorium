import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileEffectLedger, MemoryEffectLedger, once, opKey, type EffectLedger } from "@scriptorium/runtime";
import { COMMENT_OP_PROPERTY, JiraClient } from "@scriptorium/jira";

/**
 * Exactly-once side effects (ADR-001 slice 2b), under a crash matrix.
 *
 * "Crash before" = the process dies before the write reaches the outside world.
 * "Crash after"  = the write LANDED, and then the process died before recording it —
 * the case that separates exactly-once from at-least-once.
 */

/** A stand-in for Jira: the comments that actually exist, each tagged with its op. */
let world: Array<{ op: string; body: string }>;
let tmpRoot: string;

beforeEach(async () => {
  world = [];
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-effects-"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5 });
});

function post(op: string, body: string, crash?: "before" | "after") {
  return async () => {
    if (crash === "before") throw new Error("crashed before the write");
    world.push({ op, body });
    if (crash === "after") throw new Error("crashed after the write");
    return { id: String(world.length) };
  };
}

const probe = (op: string) => async () => {
  const index = world.findIndex((comment) => comment.op === op);
  return index >= 0 ? { id: String(index + 1) } : undefined;
};

describe("once", () => {
  const op = opKey("jira:issue:DOC-1", "comment-17", "draft", 1);

  it("derives the same op from the same cause, a different one from anything else", () => {
    expect(opKey("a", 1)).toBe(opKey("a", 1));
    expect(opKey("a", 1)).not.toBe(opKey("a", 2));
    // Parts are delimited: ("ab","c") is not ("a","bc").
    expect(opKey("ab", "c")).not.toBe(opKey("a", "bc"));
  });

  it("does it once and replays the result after that", async () => {
    const ledger = new MemoryEffectLedger();
    const first = await once(ledger, op, post(op, "draft v1"), { probe: probe(op) });
    const again = await once(ledger, op, post(op, "draft v1"), { probe: probe(op) });
    expect(first.replayed).toBe(false);
    expect(again).toEqual({ result: first.result, replayed: true });
    expect(world).toHaveLength(1);
  });

  for (const crash of ["before", "after"] as const) {
    it(`crash ${crash} the write → exactly one write after the retry, across a restart`, async () => {
      const file = path.join(tmpRoot, "effects.json");
      await expect(once(new FileEffectLedger(file), op, post(op, "draft v1", crash), { probe: probe(op) })).rejects.toThrow(/crashed/);

      // The restart: a fresh ledger from disk sees the interrupted op...
      const restarted: EffectLedger = new FileEffectLedger(file);
      expect((await restarted.inProgress()).map((record) => record.op)).toEqual([op]);
      // ...and the retry neither loses the write nor makes a second one.
      await once(restarted, op, post(op, "draft v1"), { probe: probe(op) });
      expect(world).toHaveLength(1);
      expect(await restarted.inProgress()).toEqual([]);
    });
  }

  it("without a probe, an interrupted write is retried — at-least-once, by the caller's choice", async () => {
    const ledger = new MemoryEffectLedger();
    await expect(once(ledger, op, post(op, "x", "after"))).rejects.toThrow();
    await once(ledger, op, post(op, "x"));
    expect(world).toHaveLength(2);
  });
});

describe("jira op-keyed comments", () => {
  it("sends the op as a comment property and finds the comment by it", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        sent.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ id: "10", body: "hi", created: "now" }), { status: 201 });
      }
      expect(url).toContain("expand=properties");
      return new Response(
        JSON.stringify({ comments: [{ id: "10", body: "hi", created: "now", properties: [{ key: COMMENT_OP_PROPERTY, value: { op: "abc" } }] }] }),
        { status: 200 },
      );
    });
    const client = new JiraClient({ baseUrl: "https://example.atlassian.net", email: "a@example.com", apiToken: "t" } as never);
    await client.addComment("DOC-1", "hi", { op: "abc" });
    expect(sent[0]).toEqual({ body: "hi", properties: [{ key: COMMENT_OP_PROPERTY, value: { op: "abc" } }] });
    expect((await client.findCommentByOp("DOC-1", "abc"))?.id).toBe("10");
    expect(await client.findCommentByOp("DOC-1", "other")).toBeUndefined();
  });

  it("finds the comment on a busy ticket, past the first page", async () => {
    // 450 comments, oldest first by id; the op's comment is the newest.
    const all = Array.from({ length: 450 }, (_, i) => ({ id: String(i + 1), body: "x", created: "now", ...(i === 449 ? { properties: [{ key: COMMENT_OP_PROPERTY, value: { op: "late" } }] } : {}) }));
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      const url = new URL(String(input));
      asked.push(url.search);
      const newestFirst = url.searchParams.get("orderBy") === "-created";
      const ordered = newestFirst ? [...all].reverse() : all;
      const startAt = Number(url.searchParams.get("startAt") ?? 0);
      const max = Number(url.searchParams.get("maxResults") ?? 50);
      return new Response(JSON.stringify({ comments: ordered.slice(startAt, startAt + max), total: all.length }), { status: 200 });
    });
    const client = new JiraClient({ baseUrl: "https://example.atlassian.net", email: "a@example.com", apiToken: "t" } as never);
    expect((await client.findCommentByOp("DOC-1", "late"))?.id).toBe("450");
    expect(await client.findCommentByOp("DOC-1", "never")).toBeUndefined();
    expect(asked.length).toBeLessThanOrEqual(6);
  });
});

describe("once, concurrently", () => {
  it("two simultaneous calls for the same op act once; the second replays the first", async () => {
    const ledger = new MemoryEffectLedger();
    let acts = 0;
    const [a, b] = await Promise.all([once(ledger, "op-x", async () => ++acts), once(ledger, "op-x", async () => ++acts)]);
    expect(acts).toBe(1);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(a.result).toBe(b.result);
  });
});

describe("ledgers sharing a file", () => {
  it("three ledger instances on one file, writing at once, lose no record", async () => {
    const file = path.join(tmpRoot, "shared.json");
    const ledgers = [new FileEffectLedger(file), new FileEffectLedger(file), new FileEffectLedger(file)];
    await Promise.all(
      Array.from({ length: 21 }, (_, n) => ledgers[n % 3]!.put({ op: `op-${n}`, status: "done", startedAt: "t" })),
    );
    const reopened = new FileEffectLedger(file);
    for (let n = 0; n < 21; n += 1) expect((await reopened.get(`op-${n}`))?.status).toBe("done");
  });
});
