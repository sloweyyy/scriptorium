import { audit, commitVault } from "@scriptorium/core";
import {
  approveLesson,
  distillLesson,
  findLessonByText,
  LessonChangedError,
  lessonBodyHash,
  lessonDecisionCheck,
  listLessons,
  markLessonWithdrawn,
  rejectLesson,
  revokeLesson,
  saveLesson,
  withdrawnLessons,
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
  const bodyHash = lessonBodyHash((await ctx.vault.readNote(lesson.relPath)).body);
  await ctx.state.patch(key, { pendingLessonId: lesson.id, proposedLessons: { ...ctx.state.get(key)?.proposedLessons, [lesson.id]: { bodyHash } } });
  await audit(ctx.config.auditFile, { type: "lesson.proposed", actor: "scribe", issue: key, id: lesson.id, text: rule });
  // Durable the moment it exists: a proposal that lives only in this container is one
  // redeploy away from vanishing — and its id being reissued to a different rule.
  await pushInternalPlane(ctx.config, ctx.vault, `lessons: propose ${lesson.id} (${key})`);

  const posted = await say(
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
  // Only now has anyone been shown it: an approval needs this time, and must be newer.
  await ctx.state.patch(key, { proposedLessons: { ...ctx.state.get(key)?.proposedLessons, [lesson.id]: { bodyHash, postedAt: posted.created } } });
}

export async function runLessonDecision(
  ctx: Ctx,
  key: string,
  decision: "approve" | "reject" | "revoke",
  explicitId: string | undefined,
  actor: string,
  actorAccountId?: string,
  /** When the deciding comment was written: an approval older than the proposal approves nothing. */
  decidedAt?: string,
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
  const current = (await listLessons(ctx.vault, { withdrawn: await withdrawnLessons(ctx.config.jira.stateDir) })).find((candidate) => candidate.id === id);
  if (current) {
    const check = lessonDecisionCheck(current, decision, ctx.client.issueUrl(key));
    if (!check.ok) {
      await say(ctx, key, check.reason);
      return;
    }
  }

  if (decision === "approve") {
    // Approved is what was shown: the rule text the proposal comment quoted, approved by a
    // comment written after that proposal. `approve` and `approve lesson` landing in one poll
    // used to sign the rule the publish had just proposed, which nobody had read; and the
    // note was signed as it stood, so a proposal edited in the vault repo was signed too.
    const shown = known?.proposedLessons?.[id];
    if (!shown) {
      await say(ctx, key, `Lesson ${id} wasn't proposed on this ticket, so there is nothing here to approve. Give the feedback again and it will be proposed fresh.`);
      return;
    }
    if (!shown.postedAt || (decidedAt && Date.parse(decidedAt) < Date.parse(shown.postedAt))) {
      await say(ctx, key, `That approval was written before lesson ${id} was proposed, so it can't be for this rule. Read the proposal above, then comment \`approve lesson ${id}\` if it should apply.`);
      return;
    }
    let lesson: Awaited<ReturnType<typeof approveLesson>>;
    try {
      lesson = await approveLesson(ctx.vault, id, actor, ctx.config.signingKey, shown.bodyHash);
    } catch (error) {
      if (!(error instanceof LessonChangedError)) throw error;
      await audit(ctx.config.auditFile, { type: "lesson.approve.held", actor, issue: key, id, reason: "changed-since-proposed" });
      await say(ctx, key, `Lesson ${id}'s text changed after it was proposed here, so I won't sign it: what you'd approve isn't what was shown. Reject it, and give the feedback again for a fresh proposal.`);
      return;
    }
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
    // Recorded where the vault can't undo it, before the note changes: a failed push or a
    // rolled-back vault branch must not bring the rule back.
    await markLessonWithdrawn(ctx.config.jira.stateDir, id);
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

  await markLessonWithdrawn(ctx.config.jira.stateDir, id);
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
