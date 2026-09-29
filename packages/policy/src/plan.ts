import type { ToolRunContext, ToolSpec } from "@scriptorium/core";
import { z } from "zod";
import { CARD_TEXT_CHARS, escapedLength, summarizeArgs } from "./card";
import type { Envelope, ToolRule } from "./policy";

/**
 * One approval for a multi-step plan: "these five tickets and that page" is one card, not
 * six. The approval is bound (by the args hash, like any other) to the ordered list of
 * steps, and carrying it out runs exactly those steps, in order.
 *
 * - **A plan can't widen what an approver agreed to.** Every step must be a tool whose own
 *   rule is the plan's rule — same approvers, same separation of duties — so approving the
 *   plan is what approving each step would have been. Anything else is refused before a card
 *   is posted (`checkPlan`), and again when it runs.
 * - **Each step is exactly-once on its own.** A step runs with the approval id plus its
 *   position, which every write op-keys on: a retry after a failure replays the steps that
 *   landed and carries on from the one that didn't.
 * - **A refusal stops the plan.** Later steps may depend on it, so nothing after it runs,
 *   and the result says what was and wasn't done.
 */
export const PLAN_TOOL = "propose_plan";

const Step = z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()) });
const Plan = z.object({ title: z.string().min(1).max(120), steps: z.array(Step).min(2).max(10) });
export type PlanInput = z.infer<typeof Plan>;

function sameRule(a: ToolRule | undefined, b: ToolRule | undefined): boolean {
  if (!a || !b || a.tier !== "approve" || b.tier !== "approve") return false;
  const approvers = (rule: ToolRule) => [...(rule.approvers ?? [])].sort().join(",");
  return approvers(a) === approvers(b) && Boolean(a.separateDuties) === Boolean(b.separateDuties);
}

/**
 * What the approver reads for a plan: every step, and every argument of it (each capped as
 * a single call's would be). A whole plan's arguments as one JSON field, cut at 400
 * characters, hid step 3's comment body behind step 1's — approved unseen.
 */
export function summarizePlan(input: unknown): string {
  const parsed = Plan.safeParse(input);
  if (!parsed.success) return summarizeArgs(input);
  return parsed.data.steps
    .map((step, index) => `Step ${index + 1} · ${step.tool}\n${summarizeArgs(step.args)}`)
    .join("\n");
}

/** Room the card has for the plan's text: the same card, the same limit, every step in full. */
export const PLAN_CARD_CHARS = CARD_TEXT_CHARS;

/**
 * A step failed after earlier ones landed. The approval is given back, and a retry resumes
 * at the failed step — but "nothing was changed" would be false, so the count travels.
 */
export class PlanPartialError extends Error {
  constructor(
    readonly done: number,
    readonly total: number,
    readonly failedStep: number,
    cause: unknown,
  ) {
    super(`PARTIAL: ${done} of ${total} steps done before step ${failedStep} failed.`, { cause });
  }
}

/** Why this plan can't be proposed, or undefined when it can. */
export function checkPlan(envelope: Envelope, tools: readonly ToolSpec[], input: unknown): string | undefined {
  const parsed = Plan.safeParse(input);
  if (!parsed.success) return "a plan needs a title and 2 to 10 steps, each a tool and its arguments.";
  const rule = envelope.tools[PLAN_TOOL];
  for (const [index, step] of parsed.data.steps.entries()) {
    const tool = tools.find((candidate) => candidate.name === step.tool);
    if (step.tool === PLAN_TOOL) return `step ${index + 1} is a plan; plans don't nest.`;
    if (!tool) return `step ${index + 1} uses ${step.tool}, which isn't available here.`;
    if (!sameRule(envelope.tools[step.tool], rule)) return `step ${index + 1} (${step.tool}) needs its own approval; it can't be part of a plan.`;
    if (!tool.inputSchema.safeParse(step.args).success) return `step ${index + 1} (${step.tool}) has arguments that tool doesn't accept.`;
  }
  // Every step must be readable on the card; a plan that doesn't fit is split, never cut.
  if (escapedLength(summarizePlan(input)) > PLAN_CARD_CHARS) return "the plan is too long to show on one approval card; split it into smaller plans.";
  return undefined;
}

export function planTool(envelope: Envelope, tools: readonly ToolSpec[]): ToolSpec {
  return {
    name: PLAN_TOOL,
    description:
      "Propose several writes as ONE plan with one approval — e.g. the tickets from a meeting and the page that lists them. Each step is a write tool and its exact arguments. Requires human approval; nothing in it is done until approved.",
    inputSchema: Plan,
    run: async (input: unknown, context?: ToolRunContext) => {
      const problem = checkPlan(envelope, tools, input);
      if (problem) return `NOT_ALLOWED: ${problem}`;
      const { title, steps } = Plan.parse(input);
      const lines: string[] = [];
      let done = 0;
      for (const [index, step] of steps.entries()) {
        const tool = tools.find((candidate) => candidate.name === step.tool) as ToolSpec;
        const approval = context?.approval ? { ...context.approval, id: `${context.approval.id}#${index + 1}` } : undefined;
        // A throw propagates: the guard gives the approval back and a retry resumes here.
        let result: string;
        try {
          result = await tool.run(step.args, approval ? { approval } : undefined);
        } catch (error) {
          if (done) throw new PlanPartialError(done, steps.length, index + 1, error);
          throw error;
        }
        const first = result.split("\n")[0] ?? "";
        if (/^NOT_ALLOWED\b/.test(result)) {
          const reason = first.replace(/^NOT_ALLOWED:\s*/, "");
          const head = done
            ? `PARTIAL: plan “${title}”: ${done} of ${steps.length} steps done; step ${index + 1} was refused (${reason}), so nothing after it was run.`
            : `NOT_ALLOWED: plan “${title}” stopped at step 1 (${reason}); nothing was done.`;
          return [head, ...lines].join("\n");
        }
        done += 1;
        lines.push(`${index + 1}. ${first}`);
      }
      return [`Plan “${title}”: all ${steps.length} steps done.`, ...lines].join("\n");
    },
  };
}
