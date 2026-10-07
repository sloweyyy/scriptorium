import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { manifestBotScopes } from "@scriptorium/agents";

/**
 * Each Slack app asks for exactly what its code uses. A scope nobody calls is only a larger
 * blast radius for a leaked token (Scribe's could read every channel's history).
 */
describe("Slack app manifests, least privilege", () => {
  it("Scribe: mentions, its cards and the approver's name, nothing else", async () => {
    expect((await manifestBotScopes("slack-manifests/scribe.yaml")).sort()).toEqual(["app_mentions:read", "chat:write", "users:read"]);
    const manifest = await fs.readFile("slack-manifests/scribe.yaml", "utf8");
    expect(manifest).not.toMatch(/message\.channels|reaction_added/);
  });

  it("Curator: mentions, replies and reactions; no history, no buttons", async () => {
    expect((await manifestBotScopes("slack-manifests/curator.yaml")).sort()).toEqual(["app_mentions:read", "chat:write", "reactions:write"]);
    expect(await fs.readFile("slack-manifests/curator.yaml", "utf8")).toMatch(/interactivity:\s*\n\s*is_enabled: false/);
  });
});
