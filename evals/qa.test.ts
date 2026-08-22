import { runGeminiToolLoop } from "@scriptorium/core";
import { z } from "zod";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Vault, llmProvider } from "@scriptorium/core";
import { answerQuestion } from "@scriptorium/curator";

/**
 * The single definition of Curator's Q&A contract, run against whichever provider is
 * configured — Claude by default, Gemini under LLM_PROVIDER=gemini. The assertions are
 * deliberately provider-blind: cite-or-refuse is a property of the pipeline, so a
 * transport that cannot satisfy these is not a supported transport.
 *
 *   RUN_LLM_EVALS=1 npx vitest run evals/qa.test.ts
 *   RUN_LLM_EVALS=1 LLM_PROVIDER=gemini GEMINI_MODEL=gemini-3.5-flash npx vitest run evals/qa.test.ts
 *
 * Gated on any configured provider rather than on ANTHROPIC_API_KEY: keying the gate to one
 * provider's credential makes the other provider's run silently skip and still report green.
 */
const provider = llmProvider();
const runLive = Boolean(process.env.RUN_LLM_EVALS) && provider !== "none";

let vault: Vault;
let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-qa-"));
  vault = new Vault(tmpRoot);
  await vault.ensure();
  await vault.writeNote(
    "docs/scheduled-maintenance-announcements.md",
    [
      "# Scheduled maintenance announcements",
      "",
      "## Overview",
      "Workspace admins can announce planned maintenance ahead of time.",
      "",
      "## Steps",
      "1. Open Announcements and choose New maintenance.",
      "2. Keep the Notify subscribers toggle on to email subscribers on publish and 1 hour before start.",
    ].join("\n"),
    { kind: "doc", feature: "Scheduled maintenance announcements", status: "published" },
  );
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/** A citation is only worth anything if the note behind it exists. */
async function assertCitationsResolve(citations: string[]): Promise<void> {
  for (const citation of citations) {
    const relPath = citation.endsWith(".md") ? citation : `${citation}.md`;
    await expect(fs.access(vault.abs(relPath)), `cited note does not exist: ${citation}`).resolves.toBeUndefined();
  }
}

describe(`curator grounded Q&A (live LLM, provider: ${provider})`, () => {
  it.skipIf(!runLive)("answers from the vault with at least one citation", async () => {
    const answer = await answerQuestion(vault, "How do subscribers get notified about maintenance?");
    expect(answer.gap).toBeNull();
    expect(answer.citations.length).toBeGreaterThan(0);
    expect(answer.citations.join(" ")).toContain("scheduled-maintenance-announcements");
    await assertCitationsResolve(answer.citations);
  });

  it.skipIf(!runLive)("refuses to invent an answer and reports a gap", async () => {
    const answer = await answerQuestion(vault, "How do I configure SSO with Okta?");
    expect(answer.gap).not.toBeNull();
    // The gap line is what the Slack Curator turns into a gap note and a Jira ticket, so
    // it has to be the whole answer — a hedged paragraph around it is not a refusal.
    expect(answer.text.startsWith("NOT_IN_KB:")).toBe(true);
    expect(answer.citations).toHaveLength(0);
  });
});

describe("gemini tool loop transport", () => {
  // The transport reads its project before it reaches the stubbed fetch, so without this
  // the whole block passes only on a machine whose `.env` happens to carry one — and a
  // clean clone runs `pnpm eval`, documented as needing no credentials, straight into two
  // red tests. Stubbed rather than required: these exercise the dialect, not the project.
  const savedProject = process.env.VERTEX_PROJECT_ID;
  beforeEach(() => {
    process.env.VERTEX_PROJECT_ID = "eval-project";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedProject === undefined) delete process.env.VERTEX_PROJECT_ID;
    else process.env.VERTEX_PROJECT_ID = savedProject;
  });

  it("answers every function call in one turn, in order", async () => {
    // The live traces only ever contained one call per round, so the multi-call branch was
    // written to spec and never exercised. Vertex rejects a turn whose functionResponse
    // parts do not match its functionCall parts 1:1 and in order, and that failure would
    // surface as an opaque 400 mid-retrieval.
    const ran: string[] = [];
    const sent: unknown[] = [];
    let round = 0;

    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { contents: Array<{ role: string; parts: unknown[] }> };
      sent.push(body.contents.at(-1));
      round += 1;
      const parts =
        round === 1
          ? [
              { functionCall: { name: "alpha", args: { q: "1" } } },
              { functionCall: { name: "beta", args: { q: "2" } } },
            ]
          : [{ text: "done" }];
      return new Response(JSON.stringify({ candidates: [{ content: { parts }, finishReason: "STOP" }] }), { status: 200 });
    });

    const tool = (name: string) => ({
      name,
      description: name,
      inputSchema: z.object({ q: z.string() }),
      run: async (input: unknown) => {
        ran.push(name);
        return `${name}:${(input as { q: string }).q}`;
      },
    });

    const answer = await runGeminiToolLoop({ system: "s", prompt: "p", tools: [tool("alpha"), tool("beta")] });

    expect(answer).toBe("done");
    expect(ran).toEqual(["alpha", "beta"]);
    const replies = (sent.at(-1) as { parts: Array<{ functionResponse?: { name: string; response: { result: string } } }> }).parts;
    expect(replies.map((p) => p.functionResponse?.name)).toEqual(["alpha", "beta"]);
    expect(replies.map((p) => p.functionResponse?.response.result)).toEqual(["alpha:1", "beta:2"]);
  });

  it("throws rather than returning a half-finished answer when the cap binds", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "alpha", args: {} } }] }, finishReason: "STOP" }] }),
        { status: 200 },
      ),
    );
    const alpha = { name: "alpha", description: "a", inputSchema: z.object({}), run: async () => "nothing" };
    await expect(runGeminiToolLoop({ system: "s", prompt: "p", tools: [alpha], maxRounds: 3 })).rejects.toThrow(/3-round cap/);
  });
});
