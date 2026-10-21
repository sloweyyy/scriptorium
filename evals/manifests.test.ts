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

  it("Teammate: the channel-privacy lookup has the read scopes it needs, or every gap stops quoting its question", async () => {
    // conversations.info needs channels:read (public), groups:read (private) and mpim:read
    // (group DM). Without them every lookup fails, every channel reads as private, and the gap
    // loop to the docs writer loses every question.
    const source = await fs.readFile("apps/agents/src/teammate-bot.ts", "utf8");
    expect(source).toMatch(/conversations\.info\(/);
    const scopes = await manifestBotScopes("slack-manifests/teammate.yaml");
    expect(scopes).toEqual(expect.arrayContaining(["channels:read", "groups:read", "mpim:read", "im:read"]));
  });
});
