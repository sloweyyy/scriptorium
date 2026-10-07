import { audit, docsRepoReady } from "@scriptorium/core";
import { organizePublishedDoc } from "@scriptorium/curator";
import { issueStatus, type JiraIssue } from "@scriptorium/jira";
import { publishDoc } from "@scriptorium/scribe";
import { publishApprovedDoc } from "../docs-repo";
import { announcePublished } from "../slack-notify";
import { moveTo, say, type Ctx } from "./context";
import { hashDraft, repostDraft } from "./drafting";
import { proposeLesson } from "./lessons";

export async function runPublish(
  ctx: Ctx,
  issue: JiraIssue,
  approvedBy: string,
  options: { quietWhenPublished?: boolean } = {},
): Promise<void> {
  const key = issue.key;
  const known = ctx.state.get(key);

  // Approving twice (comment then transition, or the reverse) is normal — say nothing.
  // But three facts are separate here, and conflating any two produced a real failure:
  // "a doc was published", "the docs repo has it", and "the CURRENT draft is the one
  // that was published". A revision after a publish makes the third false while the
  // first two stay true — and keying the guards on the first alone locked every revised
  // draft out of publishing forever, with advice (`draft`) that would have discarded
  // the very feedback that caused the revision.
  const alreadyPublished = Boolean(known?.publishedPath) && known?.draftPublished !== false;

  // The column is corrected before either early return below, because how much of the work
  // was already done is not something the board should reflect: an approval on a ticket
  // whose doc is published belongs in the approved column, whether this call publishes it,
  // retries a failed push, or finds nothing left to do. Both guards used to sit above the
  // move, so a ticket that went back through In Progress and In Review for a revision and
  // was then re-approved stayed in In Review with nothing left to review.
  if (alreadyPublished) await moveTo(ctx, key, ctx.config.jira.approvedStatus, issueStatus(issue));

  if (alreadyPublished && known?.docsPushed) {
    if (!options.quietWhenPublished) {
      await say(ctx, key, `Already published to \`${known.publishedPath}\`. Reply with feedback and I'll revise — approving the revision publishes the new version.`);
    }
    return;
  }

  // Approving with nothing to publish is never silent: a reviewer whose first move is
  // dragging the ticket to Approved must be told why nothing happened.
  let relPath = known?.publishedPath;

  // A push-only retry needs the approved body's hash to check against. A ticket without one
  // (published before the hash was recorded, or state rebuilt by recoverState after a lost
  // ledger) goes back through the draft gate below instead: republished from the draft the
  // approver saw, never from whatever the vault copy says now.
  if (alreadyPublished && relPath && known?.publishedBodyHash) {
    // A retry republishes the vault note as it is NOW, under the original approval. The
    // vault takes edits from the vault repo between the failed push and this retry (the
    // webhook sync, the boot restore), and none of them was approved: sending one to a
    // public PR titled "approved by <them>" would put words in the approver's mouth.
    const current = await ctx.vault.readNote(relPath).catch(() => undefined);
    if (!current || hashDraft(current.body) !== known.publishedBodyHash) {
      await audit(ctx.config.auditFile, { type: "docs.push.held", actor: "scribe", issue: key, relPath, reason: "vault-note-changed-since-approval" });
      await say(
        ctx,
        key,
        `The vault copy of \`${relPath}\` changed after it was approved, so I won't push it under that approval. Reply with feedback and I'll revise; approving the revision publishes it.`,
      );
      return;
    }
    await say(ctx, key, `The vault copy of \`${relPath}\` is already published — retrying the docs-repo push only.`);
  } else {
    const draft = await ctx.state.readDraft(key);
    if (!draft) {
      await say(
        ctx,
        key,
        "I have no draft on this ticket yet, so there is nothing to publish. Attach the PRD as a `.md` file and comment `draft`.",
      );
      return;
    }
    // No approval of text nobody saw. Every path to a publish (comment, board move, Slack
    // button) comes through here, so this is where it is held.
    if (known?.postedDraftHash !== hashDraft(draft)) {
      await audit(ctx.config.auditFile, { type: "jira.approve.held", actor: "scribe", issue: key, reason: "draft-not-on-ticket" });
      await repostDraft(ctx, key, draft);
      await moveTo(ctx, key, ctx.config.jira.inReviewStatus, issueStatus(issue));
      return;
    }
    relPath = await publishDoc({
    vault: ctx.vault,
    auditFile: ctx.config.auditFile,
    repoRoot: ctx.config.repoRoot,
    markdown: draft,
    approvedBy,
    sourcePrd: known?.sourcePrd,
    appliedLessons: known?.appliedLessons,
    slug: known?.docSlug,
    // The join key for the GitHub -> Jira round trip. Without it a human edit to a
    // published doc has no ticket to be reported on.
    jiraIssue: key,
  });
  await organizePublishedDoc(ctx.vault, relPath);
  // Organizing touches only frontmatter (related links), so the body hashed here is the
  // approved text, and stays so until something outside the approval edits it.
  const publishedBodyHash = hashDraft((await ctx.vault.readNote(relPath)).body);
  // docsPushed resets here: a republished revision has NOT reached the repo yet, and a
  // stale true would let the next approve report success for a push that never happened.
  await ctx.state.patch(key, { publishedPath: relPath, publishedBodyHash, draftPublished: true, docsPushed: false, announcePending: true, lessonPending: true });
  // Approved and written, so the column says so before the egress — which may fail.
  await moveTo(ctx, key, ctx.config.jira.approvedStatus, issueStatus(issue));

  await say(
    ctx,
    key,
    [
      `**Published** — approved by ${approvedBy}.`,
      "",
      `- Vault note: \`${relPath}\``,
      "- Curator has cross-linked it to the PRD and refreshed `index.md`",
      "- Committed to git with the approver recorded — that commit is the audit trail",
      "",
        "Ask Curator about it in Slack; it will answer from this note and cite it.",
      ].join("\n"),
    );
  }

  // Egress: push the allowlisted trees to the docs repo and open the PR whose merge
  // publishes. Never fatal — a doc approved in Jira and written to the vault stays
  // approved and written even if GitHub is unreachable.
  try {
    const outcome = await publishApprovedDoc(ctx.config, ctx.vault, {
      issueKey: key,
      issueUrl: ctx.client.issueUrl(key),
      slug: known?.docSlug ?? relPath.replace(/^docs\//, "").replace(/\.md$/, ""),
      relPath,
      approvedBy,
      appliedLessons: known?.appliedLessons,
    });
    await say(ctx, key, outcome.comment);
    // Only a real push clears the retry flag; a refusal or a conflict must stay retryable.
    // Except when no docs repo is configured at all: then no push will ever exist, the
    // egress is vacuously complete, and leaving the flag unset would make every later
    // approve republish the same draft instead of saying "already published".
    if (outcome.published || !docsRepoReady(ctx.config.docsRepo)) await ctx.state.patch(key, { docsPushed: true });
    await audit(ctx.config.auditFile, {
      type: outcome.published ? "docs.pushed" : "docs.push.refused",
      actor: approvedBy,
      issue: key,
      relPath,
      pullRequest: outcome.pullRequestUrl,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The ticket gets the first line; the logs get all of it. Reporting a production
    // failure only into a Jira comment left nothing to diagnose from.
    console.warn(`[scribe] ${key}: docs-repo push failed:\n${message}`);
    await say(
      ctx,
      key,
      `⚠️ Published to the vault, but pushing to the docs repo failed:\n\n\`${message.split("\n")[0]}\`\n\nComment \`approve\` again to retry the push — the vault copy stays published.`,
    );
  }

  // The announcement and the lesson proposal happen once per publish: repeating them is
  // noise, and skipping them because the publish itself is done lost them whenever
  // something failed in between. Each is owed until it has happened.
  if (ctx.state.get(key)?.announcePending) {
    await announcePublished(ctx.config, {
      relPath,
      feature: known?.docSlug ?? relPath,
      issueKey: key,
      issueUrl: ctx.client.issueUrl(key),
      approvedBy,
      appliedLessons: known?.appliedLessons,
    });
    await ctx.state.patch(key, { announcePending: false });
  }

  if (ctx.state.get(key)?.lessonPending) {
    await proposeLesson(ctx, key, approvedBy);
    await ctx.state.patch(key, { lessonPending: false });
  }
}
