import { opKey, once, type EffectLedger } from "@scriptorium/runtime";
import type { AppConfig, Vault } from "@scriptorium/core";
import {
  issueStatus,
  markdownToJira,
  type IssueState,
  type JiraClient,
  type JiraComment,
  type JiraIssue,
  type JiraState,
} from "@scriptorium/jira";

export interface Ctx {
  config: AppConfig;
  vault: Vault;
  client: JiraClient;
  state: JiraState;
  botAccountId: string;
  /**
   * Other agents' Jira accounts (the Teammate): never feedback, never a command. A lookup,
   * because it can fail — and until it has succeeded, no comment is read (see knownAccounts).
   */
  otherAgentIds: () => Promise<string[]>;
  /** Per-issue serialisation — see withIssueLock. */
  locks: Map<string, Promise<unknown>>;
  /** Exactly-once record of the agent's own comments (op-keyed; see `say`). */
  effects: EffectLedger;
  /** The human comment currently being acted on, per issue, and how many replies it has had. */
  triggers: Map<string, { id: string; seq: number }>;
}

/**
 * Account ids that may need a network lookup. A failed lookup throws — the caller reads no
 * comments this time, and they stay unprocessed for the next — and is retried on the next
 * call; a successful one is remembered. Answering "no other agents" on a failure would fail
 * OPEN: Scribe would read the Teammate's answers as feedback and revise in a loop.
 */
export function knownAccounts(source: readonly string[] | (() => Promise<string[]>)): () => Promise<string[]> {
  if (typeof source !== "function") {
    const fixed = [...source];
    return async () => fixed;
  }
  let known: string[] | undefined;
  return async () => (known ??= await source());
}

/**
 * One issue is worked by one caller at a time.
 *
 * The ledger makes at-least-once *delivery* safe, but drafting is check-then-act: read
 * `hasDraft`, make a slow model call, write `hasDraft`. Two entrants both pass the check
 * and both draft. That is not theoretical — a webhook nudge and a poll tick hit the same
 * ticket seconds apart and posted two drafts and two attachments, because the poll loop's
 * in-flight flag never covered the webhook path. Serialise per issue key so the second
 * caller runs after the first and sees the state it wrote.
 */
export async function withIssueLock<T>(ctx: Ctx, key: string, work: () => Promise<T>): Promise<T> {
  const previous = ctx.locks.get(key) ?? Promise.resolve();
  const run = previous.then(work, work);
  // Keep a non-rejecting tail in the map so one failure cannot poison the queue.
  ctx.locks.set(
    key,
    run.catch(() => undefined),
  );
  try {
    return await run;
  } finally {
    if (ctx.locks.get(key) === run || (await ctx.locks.get(key)) === undefined) ctx.locks.delete(key);
  }
}

/** The label is the auto-draft trigger: with it, the agent drafts unasked; without it, only on request. */
export function autoDrafts(ctx: Ctx, issue: JiraIssue): boolean {
  const label = ctx.config.jira.label.toLowerCase();
  return (issue.fields.labels ?? []).some((candidate) => candidate.toLowerCase() === label);
}

/** Is the agent part of this ticket yet? Until it is, plain feedback here is not addressed to it. */
export function engaged(known: IssueState | undefined): boolean {
  return Boolean(known?.engaged || known?.hasDraft || known?.publishedPath);
}

/**
 * May this Jira account approve a publish? The same answer for a comment and a board move.
 * Unknown is never yes: an approval nobody can attribute is not an approval.
 */
export function mayApproveOnJira(
  settings: { approvers?: readonly string[] },
  botAccountId: string | undefined,
  accountId: string | undefined,
  otherAgentIds: readonly string[] = [],
): { ok: true } | { ok: false; reason: string } {
  if (!accountId) return { ok: false, reason: "I couldn't tell who approved, so I haven't published." };
  if (botAccountId && accountId === botAccountId) return { ok: false, reason: "My own move is bookkeeping, not an approval." };
  // Another agent's move or comment is never a human approval — even one a human told it to
  // make: that human approved the Teammate's action, not this publish.
  if (otherAgentIds.includes(accountId)) return { ok: false, reason: "Another agent can't approve this. A person needs to comment `approve`." };
  if (settings.approvers?.length && !settings.approvers.includes(accountId)) {
    return { ok: false, reason: "Only the configured approvers can publish from this ticket, so I haven't. Ask one of them to comment `approve`." };
  }
  return { ok: true };
}

export function authorName(comment: JiraComment): string {
  return comment.author?.displayName ?? comment.author?.accountId ?? "a Jira user";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Move the ticket along the board, best-effort.
 *
 * The columns carry the state a reader cares about — working, waiting on me, done — so the
 * agent drives them rather than leaving everything in To Do and narrating only in comments.
 * Silent when the workflow has no such status: a board the agent cannot drive is a smaller
 * failure than a publish that refuses because a column is missing. `lastStatus` is patched
 * so the poller does not read the agent's own move as a human decision.
 */
export async function moveTo(ctx: Ctx, key: string, statusName: string, currentStatus?: string): Promise<void> {
  if (!statusName || currentStatus?.toLowerCase() === statusName.toLowerCase()) return;
  try {
    // `currentStatus` is what the caller last saw, which may be a model call ago. A human who
    // dragged the ticket to Approved in the meantime must not be silently undone by the
    // agent's bookkeeping move: leave it where they put it, and the tick's end leaves the
    // change for the next tick to judge as an approval (and to hold, if it predates the draft).
    const approved = ctx.config.jira.approvedStatus.toLowerCase();
    const live = await ctx.client
      .getIssue(key)
      .then((fresh) => issueStatus(fresh))
      .catch(() => undefined);
    if (live?.toLowerCase() === statusName.toLowerCase()) return;
    if (live?.toLowerCase() === approved && (currentStatus ?? "").toLowerCase() !== approved && statusName.toLowerCase() !== approved) {
      console.warn(`[scribe] ${key}: someone moved it to "${ctx.config.jira.approvedStatus}" while I worked, so I'm not moving it to "${statusName}"`);
      return;
    }
    const moved = await ctx.client.transitionTo(key, statusName);
    if (moved) await ctx.state.patch(key, { lastStatus: statusName });
    // A workflow that does not offer the column is a legitimate configuration, but silence
    // here is indistinguishable from success — and a board that never moves looks like the
    // agent is inert rather than like the project is missing a status.
    else console.warn(`[scribe] ${key}: workflow offers no transition to "${statusName}" from "${currentStatus ?? "its current status"}"`);
  } catch (error) {
    console.warn(`[scribe] ${key}: could not move to "${statusName}": ${errorMessage(error)}`);
  }
}

/**
 * Put the ticket in the hands of whoever owes the next action.
 *
 * The assignee column is the fastest thing to read on a board, and it should answer one
 * question: who is this waiting on? So the agent takes the ticket while it is drafting and
 * hands it back the moment a human's judgement is what is missing — a review, a decision,
 * or a PRD it refused to guess at.
 *
 * Best-effort, exactly like the status moves: a project where the agent may comment but
 * not assign still gets its draft, and the comment thread remains the authoritative
 * narration either way.
 */
export async function assignTo(ctx: Ctx, key: string, accountId: string | null | undefined): Promise<void> {
  // `undefined` means "leave it alone"; `null` means "explicitly nobody".
  if (accountId === undefined) return;
  try {
    await ctx.client.assign(key, accountId);
  } catch (error) {
    console.warn(`[scribe] ${key}: could not assign: ${errorMessage(error)}`);
  }
}

/** The human who filed it — the one who owes an answer when the agent cannot proceed. */
function reporterId(issue: JiraIssue): string | undefined {
  return issue.fields.reporter?.accountId;
}

/**
 * Give the ticket back to the human who owes the next move.
 *
 * Usually that is the reporter. But a gap ticket was filed by Curator, so the agent IS the
 * reporter — handing it "back" parks it on the agent while a human is the only one who can
 * move it, and the board then lies about who is blocked. Those go to nobody, which reads
 * correctly as "unassigned, free for someone to pick up".
 */
export async function handBack(ctx: Ctx, key: string, issue: JiraIssue): Promise<void> {
  const reporter = reporterId(issue);
  await assignTo(ctx, key, reporter && reporter !== ctx.botAccountId ? reporter : null);
}

/** Post a markdown comment as Jira wiki markup, and remember it so it never reads as feedback. */
/**
 * Post the agent's comment. While a human comment is being acted on, each reply is an
 * op-keyed effect — (issue, triggering comment, nth reply) — so a retry after a crash finds
 * the reply it already posted instead of posting it again.
 */
export async function say(ctx: Ctx, key: string, markdown: string): Promise<JiraComment> {
  const trigger = ctx.triggers.get(key);
  if (!trigger) {
    const comment = await ctx.client.addComment(key, markdownToJira(markdown));
    await ctx.state.markProcessed(key, [comment.id]);
    return comment;
  }
  const op = opKey("jira.say", key, trigger.id, trigger.seq++);
  const { result } = await once(
    ctx.effects,
    op,
    async () => {
      const posted = await ctx.client.addComment(key, markdownToJira(markdown), { op });
      return { id: posted.id, created: posted.created };
    },
    { probe: async () => {
      const found = await ctx.client.findCommentByOp(key, op);
      return found ? { id: found.id, created: found.created } : undefined;
    }, meta: { issue: key, trigger: trigger.id } },
  );
  await ctx.state.markProcessed(key, [result.id]);
  return { id: result.id, created: result.created, body: markdown };
}

/** Was this approval given to the draft currently on the ticket, or to an earlier one? */
export function approvesCurrentDraft(approvalCreated: string | undefined, draftPostedAt: string | undefined): boolean {
  if (!draftPostedAt || !approvalCreated) return true;
  const approved = Date.parse(approvalCreated);
  const drafted = Date.parse(draftPostedAt);
  return Number.isNaN(approved) || Number.isNaN(drafted) || approved >= drafted;
}
