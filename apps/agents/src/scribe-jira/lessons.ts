import { audit, commitVault } from "@scriptorium/core";
import {
  approveLesson,
  distillLesson,
  findLessonByText,
  lessonDecisionCheck,
  listLessons,
  rejectLesson,
  revokeLesson,
  saveLesson,
} from "@scriptorium/scribe";
import { pushInternalPlane } from "../docs-repo";
import { mayApproveOnJira, say, type Ctx } from "./context";

export async function proposeLesson(ctx: Ctx, key: string, approvedBy: string): Promise<void> {
  const known = ctx.state.get(key);
  const feedback = known?.feedback ?? [];
  if (!feedback.length || !ctx.config.hasModelAccess) return;

  // Consumed either way: this feedback has been judged once, and the next publish on
  // this ticket must not re-distill it into a duplicate proposal.
  await ctx.state.patch(key, { feedback: [] });

  const rule = await distillLesson(feedback.join("\n"));
  if (!rule) {
    await say(ctx, key, "_Nothing here generalizes — the feedback was specific to this document, so I'm not proposing a rule._");
    return;
  }

  // A rule a human already ruled on is not a new proposal. Only checkable now that a
  // rejected lesson leaves its note behind — while rejection deleted the note, the
  // distiller could re-propose the refused rule and nothing could tell.
  const ruled = await findLessonByText(ctx.vault, rule);
  if (ruled) {
    await ctx.state.patch(key, { pendingLessonId: ruled.status === "proposed" ? ruled.id : undefined });
    await audit(ctx.config.auditFile, { type: "lesson.duplicate", actor: "scribe", issue: key, id: ruled.id, text: rule });
    const standing =
      ruled.status === "rejected"
        ? `a human already refused it (**${ruled.id}**). I'm not asking anyone to judge it twice.`
        : ruled.status === "approved"
          ? `it is already in force as **${ruled.id}** — nothing to approve.`
          : `it is already proposed as **${ruled.id}**, still waiting on a decision.`;
    await say(ctx, key, [`Your feedback distils to a rule I already hold, so ${standing}`, "", `> ${rule}`].join("\n"));
    return;
  }

  const lesson = await saveLesson(ctx.vault, {
    text: rule,
    author: approvedBy,
    sourceThread: ctx.client.issueUrl(key),
    status: "proposed",
  });
  await ctx.state.patch(key, { pendingLessonId: lesson.id });
  await audit(ctx.config.auditFile, { type: "lesson.proposed", actor: "scribe", issue: key, id: lesson.id, text: rule });
  // Durable the moment it exists: a proposal that lives only in this container is one
  // redeploy away from vanishing — and its id being reissued to a different rule.
  await pushInternalPlane(ctx.config, ctx.vault, `lessons: propose ${lesson.id} (${key})`);

  await say(
    ctx,
    key,
    [
      `**Proposed house rule ${lesson.id}** — from your feedback on this ticket:`,
      "",
      `> ${rule}`,
      "",
      `Comment \`approve lesson ${lesson.id}\` and it applies to every future draft; \`reject lesson ${lesson.id}\` and I forget it.`,
      "It stays a proposal until you say so — the system doesn't get to decide what it learns.",
    ].join("\n"),
  );
}

export async function runLessonDecision(
  ctx: Ctx,
  key: string,
  decision: "approve" | "reject" | "revoke",
  explicitId: string | undefined,
  actor: string,
  actorAccountId?: string,
): Promise<void> {
  const known = ctx.state.get(key);
  const id = explicitId ?? known?.pendingLessonId;
  if (!id) {
    await say(ctx, key, "I don't have a lesson pending on this ticket. Lessons are proposed right after a doc is published.");
    return;
  }

  // A house rule shapes every future draft, so deciding one takes at least what publishing
  // one doc takes: a permitted human, on the ticket the rule came from, on a live proposal.
  const allowed = mayApproveOnJira(ctx.config.jira, ctx.botAccountId, actorAccountId, await ctx.otherAgentIds());
  if (!allowed.ok) {
    await say(ctx, key, allowed.reason.replace("publish from this ticket", "decide house rules"));
    return;
  }
  const current = (await listLessons(ctx.vault)).find((candidate) => candidate.id === id);
  if (current) {
    const check = lessonDecisionCheck(current, decision, ctx.client.issueUrl(key));
    if (!check.ok) {
      await say(ctx, key, check.reason);
      return;
    }
  }

  if (decision === "approve") {
    const lesson = await approveLesson(ctx.vault, id, actor, ctx.config.signingKey);
    if (!lesson) {
      await say(ctx, key, `I can't find lesson \`${id}\` in the vault.`);
      return;
    }
    await audit(ctx.config.auditFile, { type: "lesson.approved", actor, issue: key, id, relPath: lesson.relPath });
    await commitVault(ctx.config.repoRoot, `lessons: approve ${id} (approved by ${actor})`);
    await pushInternalPlane(ctx.config, ctx.vault, `lessons: approve ${id} (approved by ${actor})`);
    await ctx.state.patch(key, { pendingLessonId: undefined });
    await say(
      ctx,
      key,
      [
        `**Lesson ${id} approved** by ${actor} — it now applies to every future draft.`,
        "",
        `It is a file (\`${lesson.relPath}\`) with provenance, not a weight: readable, versioned in git, and revocable — comment \`revoke lesson ${id}\` on any ticket to withdraw it.`,
      ].join("\n"),
    );
    return;
  }

  if (decision === "revoke") {
    const revoked = await revokeLesson(ctx.vault, id, actor);
    if (!revoked) {
      await say(ctx, key, `I can't find lesson \`${id}\` in the vault.`);
      return;
    }
    await audit(ctx.config.auditFile, { type: "lesson.revoked", actor, issue: key, id, relPath: revoked.relPath });
    await commitVault(ctx.config.repoRoot, `lessons: revoke ${id} (revoked by ${actor})`);
    await pushInternalPlane(ctx.config, ctx.vault, `lessons: revoke ${id} (revoked by ${actor})`);
    await say(ctx, key, `**Lesson ${id} revoked** by ${actor} — no future draft will follow it. The note stays, marked \`revoked\`, as the record of what drafts once followed.`);
    return;
  }

  const lesson = await rejectLesson(ctx.vault, id, actor);
  if (!lesson) {
    await say(ctx, key, `I can't find lesson \`${id}\` in the vault.`);
    return;
  }
  await audit(ctx.config.auditFile, { type: "lesson.rejected", actor, issue: key, id, relPath: lesson.relPath });
  await commitVault(ctx.config.repoRoot, `lessons: reject ${id} (rejected by ${actor})`);
  await pushInternalPlane(ctx.config, ctx.vault, `lessons: reject ${id} (rejected by ${actor})`);
  await ctx.state.patch(key, { pendingLessonId: undefined });
  await say(
    ctx,
    key,
    [
      `**Lesson ${id} rejected** by ${actor} — it will never shape a draft.`,
      "",
      `The note (\`${lesson.relPath}\`) stays, marked \`rejected\` with your name on it. Your decision is` +
        ` the record: the number stays spoken for, and if this same rule is distilled again I will point at` +
        ` your refusal instead of asking you again.`,
    ].join("\n"),
  );
}
