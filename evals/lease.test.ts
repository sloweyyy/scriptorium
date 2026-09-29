import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Lease } from "@scriptorium/runtime";

/** One instance runs the scheduled work: the holder renews, others wait until it expires. */
let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-lease-"));
  file = path.join(dir, "scheduler.lease");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe("the scheduler lease", () => {
  it("the first instance takes it and renews it; a second waits while it's live", async () => {
    const old = new Lease(file, 180_000, "old", 0);
    const fresh = new Lease(file, 180_000, "new", 0);
    const t = Date.parse("2026-09-29T10:00:00Z");
    expect(await old.acquire(t)).toBe(true);
    expect(await fresh.acquire(t + 1_000)).toBe(false);
    // The holder renews every tick, so the other never gets in while it lives.
    expect(await old.acquire(t + 60_000)).toBe(true);
    expect(await fresh.acquire(t + 200_000)).toBe(false);
    expect((await old.holder(t + 200_000))?.owner).toBe("old");
  });

  it("takes over a lease its holder stopped renewing, once it has expired", async () => {
    const old = new Lease(file, 180_000, "old", 0);
    const fresh = new Lease(file, 180_000, "new", 0);
    const t = Date.parse("2026-09-29T10:00:00Z");
    await old.acquire(t);
    expect(await fresh.acquire(t + 179_000)).toBe(false);
    expect(await fresh.acquire(t + 181_000)).toBe(true);
    // And the old one, if it comes back, finds it taken.
    expect(await old.acquire(t + 182_000)).toBe(false);
  });

  it("released at shutdown, the next instance doesn't wait out the TTL", async () => {
    const old = new Lease(file, 180_000, "old", 0);
    const fresh = new Lease(file, 180_000, "new", 0);
    const t = Date.parse("2026-09-29T10:00:00Z");
    await old.acquire(t);
    await old.release();
    expect(await fresh.acquire(t + 1_000)).toBe(true);
    // Releasing someone else's lease does nothing.
    await old.release();
    expect((await fresh.holder(t + 2_000))?.owner).toBe("new");
  });

  it("a concurrent writer that won the race is caught by the read-back", async () => {
    const a = new Lease(file, 180_000, "a", 40);
    const b = new Lease(file, 180_000, "b", 0);
    const t = Date.parse("2026-09-29T10:00:00Z");
    // a writes, then waits to read back; b writes in that window and wins.
    const aResult = a.acquire(t);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await fs.writeFile(file, JSON.stringify({ owner: "b", until: new Date(t + 180_000).toISOString() }));
    expect(await aResult).toBe(false);
    expect(b.owner).toBe("b");
  });

  it("an unreadable lease file counts as no lease", async () => {
    await fs.writeFile(file, "{not json");
    expect(await new Lease(file, 180_000, "x", 0).acquire()).toBe(true);
  });
});
