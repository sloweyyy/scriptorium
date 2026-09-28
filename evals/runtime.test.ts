import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileSeenIds, Gate, KeyedQueue, keys, sourceOfKey, type AgentEvent } from "@scriptorium/runtime";

/**
 * The runtime's intake (ADR-001 slice 2a): a gate that says why it ignored something,
 * and a queue with one lane per conversation.
 */

let counter = 0;
function event(key: string, overrides: Partial<AgentEvent> = {}): AgentEvent {
  counter += 1;
  return {
    id: `e${counter}`,
    source: sourceOfKey(key) ?? "slack",
    key,
    kind: "test",
    actor: { id: "human-1" },
    payload: counter,
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("gate", () => {
  const A = keys.jiraIssue("doc-1");

  it("a redelivery after a restart is still a redelivery, and the window stays bounded", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriptorium-seen-"));
    const file = path.join(dir, "seen.json");
    const first = event(A);
    expect(new Gate({ selfIds: [] }, 5_000, new FileSeenIds(file)).check(first)).toEqual({ accepted: true });
    // A new process: a new Gate, the same file.
    expect(new Gate({ selfIds: [] }, 5_000, new FileSeenIds(file)).check(first)).toEqual({ accepted: false, reason: "duplicate delivery" });
    const small = new FileSeenIds(path.join(dir, "small.json"), 3);
    for (const id of ["a", "b", "c", "d"]) small.add(id);
    const reloaded = new FileSeenIds(path.join(dir, "small.json"), 3);
    expect(["a", "b", "c", "d"].map((id) => reloaded.has(id))).toEqual([false, true, true, true]);
    // An unreadable file starts empty, never throws.
    fs.writeFileSync(path.join(dir, "bad.json"), "{not json");
    expect(new FileSeenIds(path.join(dir, "bad.json")).has("a")).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("drops a redelivery, its own events and other bots — each with a reason", () => {
    const gate = new Gate({ selfIds: ["bot-1"] });
    const first = event(A);
    expect(gate.check(first)).toEqual({ accepted: true });
    expect(gate.check({ ...first })).toEqual({ accepted: false, reason: "duplicate delivery" });
    expect(gate.check(event(A, { actor: { id: "bot-1" } }))).toEqual({ accepted: false, reason: "own event" });
    expect(gate.check(event(A, { actor: { id: "other-bot", isBot: true } }))).toEqual({ accepted: false, reason: "sent by another bot" });
  });

  it("hears a source only inside its configured scope", () => {
    const gate = new Gate({ selfIds: [], scopes: { slack: ["slack:thread:C1/"], jira: [] } });
    expect(gate.check(event(keys.slackThread("C1", "1.0"))).accepted).toBe(true);
    expect(gate.check(event(keys.slackThread("C2", "1.0")))).toMatchObject({ accepted: false, reason: expect.stringContaining("outside") });
    // An empty scope list means nowhere; an absent one means everywhere.
    expect(gate.check(event(A)).accepted).toBe(false);
    expect(gate.check(event(keys.confluencePage("42"))).accepted).toBe(true);
  });

  it("does not remember a refused delivery as seen", () => {
    const gate = new Gate({ selfIds: [], scopes: { jira: [] } });
    const refused = event(A);
    expect(gate.check(refused).accepted).toBe(false);
    const reconfigured = new Gate({ selfIds: [] });
    expect(reconfigured.check(refused).accepted).toBe(true);
  });

  it("builds keys a human would call one conversation", () => {
    expect(keys.jiraIssue("doc-7")).toBe("jira:issue:DOC-7");
    expect(keys.githubPull("Org/Repo", 12)).toBe("github:pull:org/repo#12");
    expect(sourceOfKey(keys.confluencePage("9"))).toBe("confluence");
  });
});

describe("keyed queue", () => {
  it("never runs two batches of one conversation at once, and keeps arrival order", async () => {
    const log: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const queue = new KeyedQueue(async (_key, events) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await tick();
      log.push(...events.map((e) => String(e.payload)));
      running -= 1;
    }, { concurrency: 4 });

    const A = keys.jiraIssue("DOC-1");
    const sent = [event(A), event(A), event(A)];
    for (const e of sent) queue.push(e);
    await queue.drain(1_000);
    expect(maxRunning).toBe(1);
    expect(log).toEqual(sent.map((e) => String(e.payload)));
  });

  it("coalesces what arrives during a run into one follow-up run", async () => {
    const gate = deferred();
    const batches: number[] = [];
    const queue = new KeyedQueue(async (_key, events) => {
      batches.push(events.length);
      if (batches.length === 1) await gate.promise;
    });
    const A = keys.jiraIssue("DOC-1");
    queue.push(event(A));
    await tick();
    for (let i = 0; i < 5; i += 1) queue.push(event(A));
    gate.resolve();
    await queue.drain(1_000);
    expect(batches).toEqual([1, 5]);
  });

  it("does not let one slow conversation stall the others", async () => {
    const slow = deferred();
    const done: string[] = [];
    const queue = new KeyedQueue(async (key) => {
      if (key.endsWith("SLOW")) await slow.promise;
      done.push(key);
    }, { concurrency: 2 });
    queue.push(event(keys.jiraIssue("SLOW")));
    queue.push(event(keys.jiraIssue("FAST")));
    await tick();
    await tick();
    expect(done).toEqual(["jira:issue:FAST"]);
    slow.resolve();
    await queue.drain(1_000);
    expect(done).toContain("jira:issue:SLOW");
  });

  it("keeps a lane alive after its handler throws, and reports the error", async () => {
    const errors: string[] = [];
    let calls = 0;
    const queue = new KeyedQueue(async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
    }, { onError: (key, error) => errors.push(`${key}: ${(error as Error).message}`) });
    const A = keys.jiraIssue("DOC-1");
    queue.push(event(A));
    await queue.drain(1_000);
    const second = new KeyedQueue(async () => {
      calls += 1;
    });
    second.push(event(A));
    await second.drain(1_000);
    expect(errors).toEqual(["jira:issue:DOC-1: boom"]);
    expect(calls).toBe(2);
  });

  it("drain closes intake, finishes accepted work, and gives up at the deadline", async () => {
    const hang = deferred();
    const queue = new KeyedQueue(async () => {
      await hang.promise;
    });
    queue.push(event(keys.jiraIssue("DOC-1")));
    const drained = queue.drain(20);
    expect(queue.push(event(keys.jiraIssue("DOC-2")))).toBe(false);
    expect(await drained).toBe(false);
    hang.resolve();
  });
});
