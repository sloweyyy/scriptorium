import { audit, docSlug } from "@scriptorium/core";
import { commentRestriction, issueStatus, parseCommand, splitAtLastOwnComment, type IssueState, type JiraComment, type JiraIssue } from "@scriptorium/jira";
import {
  approvesCurrentDraft,
  authorName,
  autoDrafts,
  engaged,
  errorMessage,
  handBack,
  mayApproveOnJira,
  moveTo,
  say,
  type Ctx,
} from "./context";
import { hashDraft, repostDraft, runDraft, runRevise } from "./drafting";
import { runLessonDecision } from "./lessons";
import { runPublish } from "./publishing";
import { dueForRemoteLinkCheck, lastDraftAttachment, remoteLinkFingerprint, sourceFingerprint } from "./source";

const HELP = [
  "**Scribe** — I draft user documentation from the PRD on this ticket. A human approves everything I publish.",
  "",
  "The PRD can live in any of these places (checked in this order):",
  "- a `.md` file attached to this ticket,",
  "- a **Confluence page** linked to the ticket (or its URL pasted in the description) — if the page changes later, comment `draft` to re-read it,",
  "- the issue description itself.",
  "",
  "How to work with me, all from this comment box:",
  "- **feedback** — just write it in plain English; I revise the draft and post it again",
  "- `approve` — publish the current draft to the knowledge vault (or move this issue to the approved status)",
  "- `approve lesson L-001` — turn feedback into a house rule that shapes every future draft",
  "- `reject lesson L-001` — discard the proposed rule",
  "- `revoke lesson L-001` — withdraw a rule that is in force, from any ticket",
  "- `draft` — start over from the PRD",
  "- **@ me** — mention me on any ticket in this project and I'll answer, drafted or not",
  "- `help` — this message",
].join("\n");

/** A comment whose command failed this many times is set aside, with a note, not retried forever. */
export const MAX_COMMAND_ATTEMPTS = 3;

/**
 * Someone said the agent's name. This path must never end in silence — that is the whole
 * reason the poller looks at unlabelled tickets at all.
 *
 * With no draft yet, the answer is an attempt: `runDraft` either posts a draft or names
 * exactly what it is missing (no PRD, or the contract fields it refuses to guess). With a
 * draft already on the ticket, the answer is where things stand and what to type next.
 */
async function runWake(ctx: Ctx, issue: JiraIssue): Promise<void> {
  const key = issue.key;
  const known = ctx.state.get(key);
  // The mention is the invitation: from here on this ticket is a conversation the agent
  // is in, so plain feedback that follows applies even without the auto-draft label.
  await ctx.state.patch(key, { engaged: true });

  if (known?.publishedPath) {
    await say(
      ctx,
      key,
      `I'm here. This ticket is already published to \`${known.publishedPath}\` — send feedback and comment \`draft\` if you want another revision, or \`help\` for the whole vocabulary.`,
    );
    return;
  }

  if (known?.hasDraft) {
    await say(
      ctx,
      key,
      [
        `I'm here. There's a draft on this ticket already (attached as \`draft-${known.docSlug ?? docSlug(issue.fields.summary)}.md\`).`,
        "",
        "Send feedback in plain English and I'll revise it, or comment `approve` to publish it to the vault. `help` lists everything.",
      ].join("\n"),
    );
    return;
  }

  // A human asked, so re-answer even if the same contract gap was reported before:
  // `askedForFields` exists to stop the poller repeating itself, not to stop the agent
  // replying to a person.
  await ctx.state.patch(key, { askedForFields: [] });
  await runDraft(ctx, issue, { force: true });
}

/** Everyone on the ticket can see a comment with this restriction: none, and readable. */
function unrestricted(restriction: ReturnType<typeof commentRestriction>): boolean {
  return restriction !== "unreadable" && !restriction.visibility && !restriction.internal;
}

/** The answer to a restricted comment, said at its restriction. */
const RESTRICTED =
  "I only work from comments everyone on this ticket can see: my drafts, my replies and the published doc are public, so working from this one would repeat it in public. If it can be shared, say it in a comment without a restriction.";

/** How the agent's note of a failure starts. */
const ERROR_NOTE = "⚠️ I hit an error working this ticket:";

/** Rebuild what the ledger lost from the evidence that outlives it: the ticket itself and the vault. */
async function recoverState(ctx: Ctx, issue: JiraIssue, settled: JiraComment[], otherAgents: string[], interrupted: boolean): Promise<IssueState> {
  const key = issue.key;
  const attached = lastDraftAttachment(issue, ctx.botAccountId);
  // Engaged only where a draft was asked for: the label, a draft of its own on the ticket,
  // or a person who mentioned it or typed `draft`. Every ticket it had ever commented on
  // was engaged, so one where it had only answered `help` was drafted on the next comment,
  // taken from its assignee and moved across the board.
  const asked = settled.some((comment) => {
    if (!unrestricted(commentRestriction(comment))) return false;
    const kind = parseCommand(comment, ctx.botAccountId, { hasDraft: Boolean(attached), otherAgents }).kind;
    return kind === "wake" || kind === "draft";
  });
  // The inputs it has already judged. Without this the tail retry re-posts NO_PRD or the
  // same contract questions on a ticket it greeted but could not draft — a duplicate, not
  // a retry. A wake still answers (it forces the draft), and if the PRD actually changed
  // during the downtime the fingerprint differs and the retry happens by itself.
  // Rebuilt only for a lost ledger. On an interrupted first sight the ledger still knows what
  // was judged: rebuilt, a greeting whose response was lost stopped the draft for good.
  const patch: Partial<IssueState> = {
    adopting: undefined,
    engaged: Boolean(attached) || autoDrafts(ctx, issue) || asked,
    ...(interrupted ? {} : { sourceFingerprint: sourceFingerprint(issue, ctx.state.get(key)?.remoteLinkFingerprint) }),
  };

  // Still assigned to the agent: it holds the ticket, and gives it back when nothing is left to do.
  if (issue.fields.assignee?.accountId === ctx.botAccountId) patch.held = true;
  if (attached) {
    patch.hasDraft = true;
    patch.docSlug = attached.slug;
    patch.sourcePrd = `prd/${attached.slug}`;
    const published = `docs/${attached.slug}.md`;
    if (await ctx.vault.exists(published)) patch.publishedPath = published;
    try {
      // Pull the markdown back down so the next feedback revises the draft the reviewer
      // can actually see, rather than quietly starting a different one.
      const bytes = await ctx.client.downloadAttachment(attached.attachment);
      await ctx.state.saveDraft(key, bytes.toString("utf8"));
      // Shown already, by this very first sight before it failed: not posted again.
      const shown = ctx.state.get(key)?.postedDraftHash === hashDraft(bytes.toString("utf8"));
      // Not approvable as it stands: an attachment can exist without the comment that showed
      // it (its post failed), and nothing here proves which draft a reviewer read. It is
      // posted again, and an approval must come after that. Not on a ticket it already
      // published, where "nothing was published" would be false; an approval there is
      // still held and the draft shown first, by the publish step's own check.
      if (!patch.publishedPath && !shown) patch.draftUnposted = true;
    } catch {
      // The attachment is still proof that a draft exists; runRevise force-drafts when the
      // local copy is missing, so a failed download degrades to a redraft, not to silence.
    }
  }
  return ctx.state.patch(key, patch);
}

/**
 * First sight of a ticket — three cases, and the difference between them is this step.
 *
 * `handled` means the ticket is finished for this poll; otherwise the caller runs the
 * normal comment loop over whatever was left unprocessed.
 */
async function firstSight(ctx: Ctx, issue: JiraIssue, status: string): Promise<{ known: IssueState; handled: boolean }> {
  const key = issue.key;
  const history = await ctx.client.listComments(key);
  const otherAgents = await ctx.otherAgentIds();
  // A first sight that began and failed, rather than a ledger that was lost: begun (the
  // entry says so) on a ticket where the agent had said nothing yet. The count is kept from
  // the first try: a reply posted since (the note of the failure) doesn't make it a recovery.
  const entry = ctx.state.get(key);
  // Its notes of a failure don't count: one written before first sight began (a lookup that
  // failed) made a new ticket read as one it had worked, and it was never greeted or drafted.
  const spoken = history.filter((comment) => comment.author?.accountId === ctx.botAccountId && !comment.body.includes(ERROR_NOTE)).length;
  const spokenBefore = entry?.adopting === true ? (entry.spokenBefore ?? spoken) : spoken;
  const interrupted = entry?.adopting === true && spokenBefore === 0;
  await ctx.state.seed(key, status, spokenBefore);

  // The baseline, recorded once per ticket: without it, a ticket created WITH a linked
  // page would look like a ticket that just gained one on the very next tick, and get a
  // duplicate refusal for its trouble.
  const linkedAtAdoption = await remoteLinkFingerprint(ctx, key);
  if (linkedAtAdoption !== undefined) await ctx.state.patch(key, { remoteLinkFingerprint: linkedAtAdoption });
  const { history: settled, unprocessed } = splitAtLastOwnComment(history, ctx.botAccountId);

  // (1) The agent has comments here: this is a restart on a ticket it already worked, not
  // a new ticket. Reconstruct instead of re-greeting and re-drafting, and apply the
  // downtime rule — everything up to its own last word is history, everything after it
  // still needs answering. Notes of a failure aren't working it: a ticket it has said
  // nothing else on is still new, and is greeted and drafted.
  if (settled.length && spoken > 0) {
    await ctx.state.markProcessed(key, settled.map((comment) => comment.id));
    const known = await recoverState(ctx, issue, settled, otherAgents, interrupted);
    console.log(`[scribe] ${key}: adopted after a restart, ${unprocessed.length} comment(s) to catch up on`);
    return { known, handled: false };
  }

  // (2) Labelled: a doc request. Greet it and draft from the PRD. The whole thread counts
  // as history because the greeting plus a draft already answers anything it asked.
  if (autoDrafts(ctx, issue)) {
    await ctx.state.markProcessed(key, history.map((comment) => comment.id));
    await say(ctx, key, `${HELP}\n\nReading this ticket now…`);
    await runDraft(ctx, issue);
    const known = await ctx.state.patch(key, { lastStatus: status, lastUpdated: issue.fields.updated, lastError: undefined, adopting: undefined });
    return { known, handled: true };
  }

  // (3) Unlabelled: mention-only. Adopt in silence — no comment, no draft, no LLM call on
  // a ticket nobody pointed at the agent. The existing comments stay unprocessed on
  // purpose: with no comment of its own there is no cutoff, so a `@Scribe` typed before
  // the agent ever polled still gets an answer. Plain feedback among them is dropped by
  // the not-engaged gate in the loop.
  console.log(`[scribe] ${key}: adopted quietly — no "${ctx.config.jira.label}" label, so mention-only`);
  return { known: await ctx.state.patch(key, { adopting: undefined }), handled: false };
}

export async function handleIssue(ctx: Ctx, snapshot: JiraIssue): Promise<void> {
  // Each caller (the poller, a webhook) takes its view of the ticket before the lock. A view
  // older than what the ledger has already handled is read again: acted on as it was, a
  // drag to Approved the first caller answered was answered a second time.
  const recorded = ctx.state.get(snapshot.key)?.lastUpdated;
  const issue = recorded && Date.parse(snapshot.fields.updated ?? "") < Date.parse(recorded) ? await ctx.client.getIssue(snapshot.key) : snapshot;
  const key = issue.key;
  const status = issueStatus(issue);
  const seen = ctx.state.get(key);

  let known: IssueState;
  if (seen && ctx.state.adopted(key)) {
    known = seen;
  } else {
    const adopted = await firstSight(ctx, issue, status);
    if (adopted.handled) return;
    known = adopted.known;
  }

  // Captured as a PRIMITIVE before any work: `known` is a live reference into the state
  // store, and the agent's own board moves during comment handling (revise -> In Progress
  // -> In Review) patch lastStatus straight through it. The approval detector below must
  // compare the tick-start snapshot of the ISSUE against the tick-start snapshot of the
  // LEDGER — mixing a stale issue with a fresh ledger once turned the agent's own move
  // into a "human approval" and published without one.
  const lastStatusAtTickStart = known.lastStatus;

  const autoDraft = autoDrafts(ctx, issue);

  let untouched = Boolean(
    known.lastUpdated && known.lastUpdated === issue.fields.updated && known.lastStatus === status,
  );

  // Adding a remote link bumps nothing the gate above can see, so a Confluence page linked
  // AFTER the agent already said "I can't find a PRD" was invisible forever: the ticket sat
  // "processed" with the PRD it needed one click away. Asked only where the answer could
  // change something — a ticket being worked that still has no draft — and only every few
  // ticks, because this is an API call for a signal that changes once in a ticket's life.
  // A draft deferred mid-upload must be come back to. Attachments were the last thing to
  // change the ticket, so "nothing has changed since I looked" is true and wrong at once.
  if (untouched && known.awaitingUpload) untouched = false;

  if (untouched && !known.hasDraft && (autoDraft || engaged(known)) && dueForRemoteLinkCheck(key)) {
    const links = await remoteLinkFingerprint(ctx, key);
    if (links !== undefined && links !== (known.remoteLinkFingerprint ?? "")) {
      console.log(`[scribe] ${key}: linked pages changed — re-reading the ticket`);
      known = await ctx.state.patch(key, { remoteLinkFingerprint: links });
      untouched = false;
    }
  }

  if (untouched) return;
  const comments = await ctx.client.listComments(key);
  const pendingFeedback: string[] = [];
  const pendingAuthors: Array<string | undefined> = [];
  // Set once this tick rewrites the draft. An approval that arrives in the same poll was
  // given to the PREVIOUS version — the reviewer has not seen the one it would publish.
  let revisedThisTick = false;

  const flushFeedback = async (): Promise<void> => {
    if (!pendingFeedback.length) return;
    const batch = [...pendingFeedback];
    const authors = [...pendingAuthors];
    pendingFeedback.length = 0;
    pendingAuthors.length = 0;
    await runRevise(ctx, issue, batch, authors);
    revisedThisTick = true;
  };

  /** Approval of a draft nobody has seen is not approval: post it, and ask again. */
  const holdUnseenRevision = async (): Promise<void> => {
    await say(
      ctx,
      key,
      "I revised the draft from the feedback that came in with this approval, so the version above is one you haven't seen yet — nothing is published. Read it, then comment `approve` (or move the ticket to Approved) to publish it.",
    );
    await audit(ctx.config.auditFile, { type: "jira.approve.held", actor: "scribe", issue: key, reason: "unseen-revision" });
  };

  /**
   * One unit of work for one triggering comment: its replies are op-keyed to IT (so a retry
   * resumes instead of repeating), and a failure is counted against IT — three strikes and
   * it is set aside with a note. Feedback and commands are separate units: a revision's
   * replies used to consume the next command's reply numbers, so a command retried after the
   * revision landed found "its" reply already done — the revision comment — and never posted.
   */
  const attempt = async (triggerId: string, markDone: string[], work: () => Promise<void>, settled: Partial<IssueState> = {}): Promise<void> => {
    ctx.triggers.set(key, { id: triggerId, seq: 0 });
    try {
      await work();
      await ctx.state.markProcessed(key, markDone, settled);
      if (ctx.state.get(key)?.failing?.commentId === triggerId) await ctx.state.patch(key, { failing: undefined });
    } catch (error) {
      const failing = ctx.state.get(key)?.failing;
      const attempts = failing?.commentId === triggerId ? failing.attempts + 1 : 1;
      if (attempts < MAX_COMMAND_ATTEMPTS) {
        await ctx.state.patch(key, { failing: { commentId: triggerId, attempts } });
        throw error;
      }
      // Set aside, loudly: retrying something that fails the same way forever costs a model
      // call per poll and tells the reviewer nothing new.
      await ctx.state.patch(key, { failing: undefined });
      await ctx.state.markProcessed(key, markDone, settled);
      await say(ctx, key, `⚠️ I tried that ${MAX_COMMAND_ATTEMPTS} times and it kept failing:\n\n{{${errorMessage(error)}}}\n\nI've set that comment aside. Comment again once the cause is fixed.`);
      // Set aside, it is no longer the agent's to hold.
      if (ctx.state.get(key)?.held) await handBack(ctx, key, issue);
    } finally {
      ctx.triggers.delete(key);
    }
  };

  // Feedback is applied as its own unit, keyed to its last comment, and marked done only
  // once the revision that used it succeeded.
  const pendingFeedbackIds: string[] = [];
  const flushAndMark = async (): Promise<void> => {
    if (!pendingFeedback.length) return;
    const ids = [...pendingFeedbackIds];
    // The revision record goes in the same write that marks its feedback done.
    await attempt(`feedback:${ids.at(-1)}`, ids, flushFeedback, { revision: undefined });
    pendingFeedbackIds.length = 0;
  };

  // Before any comment is read: whose comments are another agent's. Throws until known.
  const otherAgents = comments.some((comment) => !ctx.state.isProcessed(key, comment.id)) ? await ctx.otherAgentIds() : [];
  for (const comment of comments) {
    if (ctx.state.isProcessed(key, comment.id)) continue;
    // `hasDraft` is read fresh: a draft posted earlier in this same batch changes what a
    // mention means, and the parser needs the current answer, not the one from the top.
    const command = parseCommand(comment, ctx.botAccountId, { hasDraft: Boolean(ctx.state.get(key)?.hasDraft), otherAgents: otherAgents, botName: ctx.botName });

    // Worked only from what everyone on the ticket can see: the draft, its attachment, the
    // published doc and a lesson are all public, so feedback or a command in a restricted
    // comment would be repeated in public. One addressed to the agent is answered once, at
    // its own restriction; one whose restriction can't be read isn't answered at all.
    const restriction = commentRestriction(comment);
    if (!unrestricted(restriction)) {
      if (restriction !== "unreadable" && command.kind !== "ignore" && command.kind !== "feedback" && command.kind !== "too-long") {
        await attempt(comment.id, [comment.id], async () => {
          await say(ctx, key, RESTRICTED, restriction);
        });
      } else {
        await ctx.state.markProcessed(key, [comment.id]);
      }
      continue;
    }

    // Someone else's conversation: on a mention-only ticket the agent has never taken part
    // in, plain prose is people talking to each other and must not trigger a revise.
    // Commands and mentions still act — being answerable is the reason for watching at all.
    if (command.kind === "ignore" || ((command.kind === "feedback" || command.kind === "too-long") && !autoDraft && !engaged(ctx.state.get(key)))) {
      await ctx.state.markProcessed(key, [comment.id]);
      continue;
    }
    if (command.kind === "feedback") {
      pendingFeedback.push(command.text);
      pendingAuthors.push(comment.author?.accountId);
      pendingFeedbackIds.push(comment.id);
      continue;
    }

    // Feedback that came before this command is applied first — as its own unit.
    await flushAndMark();

    // Mark-after-act: a comment is done only when its command finished. A crash or an
    // error mid-way leaves it (and everything after it) for the next tick, and the op-keyed
    // replies make that retry safe — it resumes, it does not repeat itself.
    await attempt(comment.id, [comment.id], async () => {
      // Anything explicit — a mention or a typed command — makes this a thread the agent is
      // in, so the plain-English feedback that follows applies even without the label.
      // A human command also resets the "already reported this error" memory: whoever typed
      // `draft` after an error was told to, and must hear the result — even the same error.
      // Only on the first attempt: an automatic retry of the same comment is not a new
      // human asking, and re-reporting the same error every poll is noise.
      const retrying = ctx.state.get(key)?.failing?.commentId === comment.id;
      // Only asking for the agent engages it: a mention or `draft`. `help`, a lesson command
      // or a near-miss approve on an unlabelled ticket used to set it too, and the agent then
      // drafted the ticket, took it from its assignee and moved it across the board.
      const engages = command.kind === "wake" || command.kind === "draft";
      await ctx.state.patch(key, { ...(engages ? { engaged: true } : {}), ...(retrying ? {} : { lastError: undefined }) });

      switch (command.kind) {
        case "wake":
          await runWake(ctx, issue);
          break;
        case "help":
          await say(ctx, key, HELP);
          break;
        case "too-long":
          await say(
            ctx,
            key,
            `That comment is ${command.length.toLocaleString("en-US")} characters, far longer than feedback on a draft, so I haven't revised anything. Tell me in a few sentences what to change, or attach the material as a file.`,
          );
          break;
        case "unclear":
          // Neither published nor rewritten: a near-miss on the one irreversible command
          // gets a question, and the reviewer's next comment decides.
          await say(
            ctx,
            key,
            `That reads like an approval, so I haven't published or changed anything yet. If you meant it, comment exactly \`${command.suggestion}\`. If it was feedback, rephrase it without starting on "approve" and I'll revise.`,
          );
          break;
        case "draft":
          await runDraft(ctx, issue, { force: true });
          break;
        case "approve-doc": {
          const allowed = mayApproveOnJira(ctx.config.jira, ctx.botAccountId, comment.author?.accountId, otherAgents);
          if (!allowed.ok) await say(ctx, key, allowed.reason);
          // Older than the draft on the ticket = given to an earlier draft. Holds across
          // crashes and retries, where "revised in this tick" alone would not.
          else if (revisedThisTick || !approvesCurrentDraft(comment.created, ctx.state.get(key)?.draftPostedAt)) await holdUnseenRevision();
          else await runPublish(ctx, issue, authorName(comment));
          break;
        }
        case "approve-lesson":
          await runLessonDecision(ctx, key, "approve", command.id, authorName(comment), comment.author?.accountId, comment.created);
          break;
        case "reject-lesson":
          await runLessonDecision(ctx, key, "reject", command.id, authorName(comment), comment.author?.accountId);
          break;
        case "revoke-lesson":
          await runLessonDecision(ctx, key, "revoke", command.id, authorName(comment), comment.author?.accountId);
          break;
      }
    });
  }
  await flushAndMark();

  // Inputs may have arrived after the first look — retry only when they actually changed,
  // and only where a draft was asked for: either the label requests one standing, or a
  // human already engaged the agent here. Never on a quietly adopted ticket.
  const wanted = autoDraft || engaged(ctx.state.get(key));
  if (wanted && !ctx.state.get(key)?.hasDraft) await runDraft(ctx, issue);
  // A first draft saved but never posted (its comment failed): `hasDraft` kept every later
  // tick from drafting again, so it sat unseen until someone commented. Post it as it is.
  const saved = ctx.state.get(key);
  if (wanted && saved?.hasDraft && saved.draftUnposted) {
    const draft = await ctx.state.readDraft(key);
    if (draft) {
      await repostDraft(ctx, key, draft);
      // Shown now: the next move is a reviewer's, as after any draft. Only out of the agent's
      // own In Progress: after a lost ledger, a column a person chose ("Blocked") was taken for
      // the agent's own, and moved.
      if (issueStatus(issue).toLowerCase() === ctx.config.jira.inProgressStatus.toLowerCase()) await moveTo(ctx, key, ctx.config.jira.inReviewStatus);
      if (ctx.state.get(key)?.held) await handBack(ctx, key, issue);
    }
  }

  const approvedStatus = ctx.config.jira.approvedStatus.toLowerCase();
  const movedToApproved = status.toLowerCase() === approvedStatus && (lastStatusAtTickStart ?? "").toLowerCase() !== approvedStatus;
  // A transition is only an approval of work the agent is part of; on a ticket it was
  // never asked to touch, someone else's workflow move is not a publish instruction.
  if (movedToApproved && wanted) {
    const mover = await ctx.client.lastStatusChangeAuthor(key, ctx.config.jira.approvedStatus);
    // Belt to the snapshot's braces: whoever moved it must be a HUMAN. The agent drives
    // the board itself, and its own transition is bookkeeping, never an approval — the
    // fail-closed rule is "no human approval, no publish", and this is where it is held.
    const allowed = mayApproveOnJira(ctx.config.jira, ctx.botAccountId, mover?.accountId, await ctx.otherAgentIds());
    if (mover?.accountId && mover.accountId === ctx.botAccountId) {
      console.warn(`[scribe] ${key}: ignoring my own transition to "${ctx.config.jira.approvedStatus}" — not a human approval`);
    } else if (!allowed.ok) {
      // A mover the changelog can't name, or one who isn't an approver: fail closed, say why,
      // and put the column back so the board doesn't claim an approval that didn't count.
      await say(ctx, key, allowed.reason);
      await moveTo(ctx, key, ctx.config.jira.inReviewStatus, ctx.config.jira.approvedStatus);
    } else if (revisedThisTick || !approvesCurrentDraft(mover?.created, ctx.state.get(key)?.draftPostedAt)) {
      // Dragged to Approved while feedback was still being applied, or before the draft now
      // on the ticket was posted: the column was set for an older draft. Put it back in
      // review with the new one. The same rule as a comment approval, by the move's time.
      await holdUnseenRevision();
      // Where the ticket is now: the agent's own move if it revised this tick, else where it
      // was dragged (the ledger's baseline deliberately doesn't hold a drag it didn't see).
      await moveTo(ctx, key, ctx.config.jira.inReviewStatus, revisedThisTick ? ctx.state.get(key)?.lastStatus : status);
    } else {
      await runPublish(ctx, issue, mover?.name ?? mover?.accountId ?? "a Jira approver", { quietWhenPublished: true });
    }
  }

  const refreshed = await ctx.client.getIssue(key).catch(() => issue);
  // The baseline is what this tick saw or did: the status it started from, or its own
  // latest move (moveTo records those). A change neither explains was made by someone
  // while the tick ran, and is left for the next tick to see AS a change. Recording it
  // as the baseline swallowed a drag to Approved made during a revise: the next tick saw
  // Approved on both sides, published nothing, and told nobody.
  const now = issueStatus(refreshed);
  const agentsOwn = ctx.state.get(key)?.lastStatus ?? status;
  const unseen = now.toLowerCase() !== status.toLowerCase() && now.toLowerCase() !== agentsOwn.toLowerCase();
  await ctx.state.patch(key, {
    lastStatus: unseen ? agentsOwn : now,
    lastUpdated: refreshed.fields.updated,
    lastError: undefined,
  });
}

/** One issue blowing up must never take the poller down — report it on the ticket, once. */
export async function reportFailure(ctx: Ctx, issue: JiraIssue, error: unknown): Promise<void> {
  const message = errorMessage(error);
  const known = ctx.state.get(issue.key);
  if (known?.lastError === message) return;
  await ctx.state.patch(issue.key, { lastError: message });
  try {
    await say(ctx, issue.key, `${ERROR_NOTE}\n\n{{${message}}}\n\nComment \`draft\` to make me retry.`);
  } catch {
    // Jira itself may be the thing that's down; the log line below is the fallback.
  }
}
