import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Vault, geminiModel, llmProvider, modelId } from "@scriptorium/core";
import { answerQuestion, answerRegressions, gradeAnswer, scoreAnswers, type AnswerCase, type AnswerScores } from "@scriptorium/curator";

/**
 * Answer quality, measured per model. The retrieval golden set asks "was the right note
 * found?"; this one asks "was the answer right?": every required note cited, every required
 * fact stated, and a clean refusal for what the vault doesn't say.
 *
 * Live only. Each provider:model has its own committed baseline in evals/baselines/answers.json,
 * because models differ and a switch should show what it costs. A model with no baseline
 * prints its scores and passes, except that refusing what the vault doesn't say must be 100%
 * for every model. Record or raise a baseline with:
 *
 *   RUN_LLM_EVALS=1 UPDATE_BASELINE=1 npx vitest run evals/answer-golden.test.ts
 *
 * The grader itself is checked below without a model.
 */
const cases = JSON.parse(await fs.readFile(path.resolve("evals/golden/answers.json"), "utf8")) as AnswerCase[];
const baselineFile = path.resolve("evals/baselines/answers.json");
const baselines = JSON.parse(await fs.readFile(baselineFile, "utf8").catch(() => "{}")) as Record<string, AnswerScores>;

const provider = llmProvider();
const runLive = Boolean(process.env.RUN_LLM_EVALS) && provider !== "none";
const modelKey = `${provider}:${provider === "gemini" ? geminiModel() : modelId()}`;

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "scriptorium-answers-"));
  await fs.cp(path.resolve("evals/fixtures/golden-vault"), root, { recursive: true });
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
});

describe("answer golden set: the grader", () => {
  const retries: AnswerCase = cases.find((item) => item.q.startsWith("When are failed webhook")) as AnswerCase;
  const unknown: AnswerCase = { q: "custom domain?", tag: "unanswerable" };
  const right = { text: "Retries happen after 1 minute, 5 minutes, 30 minutes and 2 hours.", citations: ["docs/webhook-retry-policy.md"], gap: null };

  it("passes an answer that cites the note and states every fact", () => {
    expect(gradeAnswer(retries, right)).toEqual({ pass: true, reasons: [] });
  });

  it("fails an answer that leaves out a fact, cites the wrong note, or reports a gap", () => {
    expect(gradeAnswer(retries, { ...right, text: "Retries happen after 1 minute and 5 minutes." }).reasons.join()).toContain("30 minutes");
    expect(gradeAnswer(retries, { ...right, citations: ["docs/api-keys"] }).reasons.join()).toContain("didn't cite docs/webhook-retry-policy");
    expect(gradeAnswer(retries, { ...right, gap: "retries" }).pass).toBe(false);
  });

  it("passes only a clean refusal for what the vault doesn't say", () => {
    expect(gradeAnswer(unknown, { text: "NOT_IN_KB: custom domains", citations: [], gap: "custom domains" }).pass).toBe(true);
    expect(gradeAnswer(unknown, { text: "Open Settings → Domains.", citations: [], gap: null }).pass).toBe(false);
    expect(gradeAnswer(unknown, { text: "NOT_IN_KB: custom domains", citations: ["docs/sso-setup"], gap: "custom domains" }).pass).toBe(false);
  });

  it("holds every model to 100% on refusals, and each to its own baseline elsewhere", () => {
    const now = scoreAnswers([
      { tag: "answerable", pass: true },
      { tag: "answerable", pass: false },
      { tag: "unanswerable", pass: true },
    ]);
    expect(now).toEqual({ answerable: { pass: 0.5, n: 2 }, unanswerable: { pass: 1, n: 1 } });
    expect(answerRegressions(now, undefined)).toEqual([]);
    expect(answerRegressions(now, { answerable: { pass: 0.9, n: 2 } })).toEqual(["answerable: 0.5 < 0.9"]);
    expect(answerRegressions({ ...now, unanswerable: { pass: 0.8, n: 5 } }, undefined)).toEqual(["unanswerable: 0.8 < 1"]);
  });

  it("every case is well formed and its notes exist in the fixture vault", async () => {
    for (const item of cases) {
      if (item.tag === "unanswerable") expect(item.cite ?? [], item.q).toHaveLength(0);
      else expect(item.cite?.length && item.facts?.length, item.q).toBeTruthy();
      for (const want of item.cite ?? []) await fs.access(path.join(root, `${want}.md`));
      for (const fact of item.facts ?? []) expect(() => new RegExp(fact, "i")).not.toThrow();
    }
  });
});

describe(`answer golden set (live LLM, ${modelKey})`, () => {
  it.skipIf(!runLive)(
    "does not fall below this model's baseline, and refuses everything the vault doesn't say",
    async () => {
      const vault = new Vault(root);
      const graded: Array<{ tag: AnswerCase["tag"]; pass: boolean }> = [];
      for (const item of cases) {
        const grade = gradeAnswer(item, await answerQuestion(vault, item.q));
        if (!grade.pass) console.log(`[answers] ✗ ${item.q}: ${grade.reasons.join("; ")}`);
        graded.push({ tag: item.tag, pass: grade.pass });
      }
      const now = scoreAnswers(graded);
      console.log(`[answers] ${modelKey} ${JSON.stringify(now)}`);
      if (process.env.UPDATE_BASELINE) {
        await fs.writeFile(baselineFile, `${JSON.stringify({ ...baselines, [modelKey]: now }, null, 2)}\n`);
      } else if (!baselines[modelKey]) {
        console.log(`[answers] no baseline for ${modelKey}; record one with UPDATE_BASELINE=1`);
      }
      expect(answerRegressions(now, process.env.UPDATE_BASELINE ? undefined : baselines[modelKey])).toEqual([]);
    },
    600_000,
  );
});
