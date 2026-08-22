import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Vertex's dialect, with nothing real behind it.
 *
 * These exercise how a request, a function call and a tool result are spelled — not the
 * project, and not the credentials. The transport asks google-auth-library for a token
 * before it ever reaches the stubbed fetch, so without the mock below a clean clone runs
 * `pnpm eval` — documented as needing no credentials — straight into `invalid_grant`.
 * That is the first thing a reviewer sees, and it says the repo is broken when it is not.
 *
 * The live grounded-Q&A evals stay in qa.test.ts, unmocked: those DO need real auth, and
 * mocking it here rather than there is the whole reason the two are separate files.
 */

vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    async getAccessToken(): Promise<string> {
      return "eval-token";
    }
  },
}));

// Imported after the mock so the transport closes over the fake auth.
const { runGeminiToolLoop } = await import("@scriptorium/core");

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
