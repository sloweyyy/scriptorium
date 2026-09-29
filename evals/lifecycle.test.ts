import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "@scriptorium/core";
import { shutdownHandler, startIngress, Surfaces } from "@scriptorium/agents";

/**
 * Starting and stopping. One surface failing to start neither stops the others nor leaves
 * /health green; shutdown runs once, has a deadline, and exits non-zero when it failed.
 */
describe("surfaces", () => {
  it("a surface that fails to start is recorded, and the next one still starts", async () => {
    const surfaces = new Surfaces();
    expect(await surfaces.start("curator", async () => { throw new Error("invalid_auth\nstack"); })).toBeUndefined();
    expect(await surfaces.start("teammate", async () => "core")).toBe("core");
    expect(surfaces.snapshot()).toEqual({ curator: { state: "failed", detail: "invalid_auth" }, teammate: { state: "up" } });
    expect(surfaces.failed()).toEqual(["curator"]);
  });

  it("/health is degraded (503) while a configured surface is down", async () => {
    const surfaces = new Surfaces();
    await surfaces.start("scribe-jira", async () => { throw new Error("401"); });
    const config = { provider: "none", port: 0, jira: {}, docsRepo: {}, webhook: {} } as unknown as AppConfig;
    const server = startIngress({ config, hooks: {}, surfaces: () => surfaces.snapshot() });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/health`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ status: "degraded", surfaces: { "scribe-jira": "failed" } });
    } finally {
      server.close();
    }
  });
});

describe("shutdown", () => {
  it("runs once however many signals arrive, and exits 0 when every stop succeeded", async () => {
    const exits: number[] = [];
    let stopped = 0;
    const shutdown = shutdownHandler([async () => void stopped++], { exit: (code) => void exits.push(code) });
    await Promise.all([shutdown("SIGTERM"), shutdown("SIGTERM"), shutdown("SIGINT")]);
    expect(stopped).toBe(1);
    expect(exits).toEqual([0]);
  });

  it("a stop that failed exits non-zero, and the other stops still ran", async () => {
    const exits: number[] = [];
    let closed = false;
    await shutdownHandler([async () => { throw new Error("socket"); }, () => void (closed = true)], { exit: (code) => void exits.push(code) })("SIGTERM");
    expect(closed).toBe(true);
    expect(exits).toEqual([1]);
  });

  it("a stop that hangs does not hold the process past the deadline", async () => {
    const exits: number[] = [];
    await shutdownHandler([() => new Promise(() => undefined)], { deadlineMs: 30, exit: (code) => void exits.push(code) })("SIGTERM");
    expect(exits).toEqual([1]);
  });
});
