import path from "node:path";
import { defaultJql, type AppConfig, type Vault } from "@scriptorium/core";
import { FileEffectLedger } from "@scriptorium/runtime";
import { jiraClient, JiraState, markdownToJira } from "@scriptorium/jira";
import { draftFingerprint } from "./slack-approval";
import { errorMessage, knownAccounts, say, withIssueLock, type Ctx } from "./scribe-jira/context";
import { handleIssue, reportFailure } from "./scribe-jira/issue";
import { runPublish } from "./scribe-jira/publishing";
import { remoteLinkTicks } from "./scribe-jira/source";

export { approvesCurrentDraft, knownAccounts, mayApproveOnJira, moveTo, withIssueLock } from "./scribe-jira/context";
export { MAX_DESIGN_BYTES, MAX_DESIGNS, MAX_PRD_BYTES, lastDraftAttachment, sniffImage, newestFirst, prdFrontmatter, safeDesignName, sameSource, sourceFingerprint } from "./scribe-jira/source";
export { houseRules } from "./scribe-jira/drafting";
export { MAX_COMMAND_ATTEMPTS } from "./scribe-jira/issue";

/**
 * Scribe on Jira — Agent A's primary surface.
 *
 * The ticket is the thread: description + attachments are the input, comments are the
 * conversation, and the workflow transition (or an `approve` comment) is the human gate.
 * Transport is polling, so the agent runs anywhere without a public endpoint; nothing
 * else about the pipeline changes — contract → draft → lint → revise → publish is the
 * same code the CLI and Slack call.
 *
 * Two modes, decided by the auto-draft label (`JIRA_LABEL`), not by the query:
 * - **labelled** — the ticket is a doc request: greet it and draft from the PRD unasked;
 * - **unlabelled** — mention-only: adopt it silently and never spend an LLM call until a
 *   human says the agent's name or types a command. The poller watches the whole project
 *   so that a mention is never met with silence, which is the one unforgivable failure.
 */

/**
 * What the poller hands back. `nudge` is the seam the webhook uses: same handler, same
 * ledger, same state — the webhook is a latency optimisation, not a second code path.
 */
export interface ScribeJiraHandle {
  stop(): void;
  /** Work one issue now, by key. Re-fetches from the API; never trusts a webhook body. */
  nudge(issueKey: string): Promise<void>;
  /** Post a comment on a ticket from outside the poller (e.g. a GitHub event). */
  /**
   * With `op`, posted exactly once: the comment carries the op, and `commentPosted` finds it
   * after a lost response or a crash, so a retry doesn't post it again.
   */
  comment(issueKey: string, markdown: string, op?: string): Promise<void>;
  commentPosted(issueKey: string, op: string): Promise<boolean>;
  /** Approve and publish from another surface (e.g. a Slack button). Same gate, second doorway. */
  /** `draft` is the fingerprint the Slack card was posted for; a changed draft refuses. */
  approve(issueKey: string, approvedBy: string, draft?: string): Promise<void>;
}

export async function startScribeJira(config: AppConfig, vault: Vault, options: { otherAgentIds?: string[] | (() => Promise<string[]>) } = {}): Promise<ScribeJiraHandle> {
  const client = jiraClient(config.jira);
  const me = await client.myself();
  const state = await JiraState.open(config.jira.stateDir);
  const ctx: Ctx = {
    config,
    vault,
    client,
    state,
    botAccountId: me.accountId,
    otherAgentIds: knownAccounts(options.otherAgentIds ?? []),
    locks: new Map(),
    effects: new FileEffectLedger(path.join(config.jira.stateDir, "effects.json")),
    triggers: new Map(),
  };
  const jql = defaultJql(config.jira);

  // A fresh poller re-checks every blocked ticket's links once. Cheap — bounded by the
  // number of tickets still waiting on a PRD — and it means a restart is never the reason
  // a page linked during the downtime stayed invisible.
  remoteLinkTicks.clear();

  console.log(`[scribe] 🎫 jira: ${config.jira.baseUrl} as ${me.displayName}, polling every ${Math.round(config.jira.pollMs / 1000)}s`);
  console.log(`[scribe]    jql: ${jql}`);

  let inFlight = false;
  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      for (const issue of await client.searchAllIssues(jql)) {
        try {
          await withIssueLock(ctx, issue.key, () => handleIssue(ctx, issue));
        } catch (error) {
          console.warn(`[scribe] ${issue.key}: ${errorMessage(error)}`);
          await reportFailure(ctx, issue, error);
        }
      }
    } catch (error) {
      console.warn(`[scribe] poll failed: ${errorMessage(error)}`);
    } finally {
      inFlight = false;
    }
  };

  /** Is this issue one the poller's own query returns? Asked of Jira, with the same JQL. */
  const inScope = async (issueKey: string): Promise<boolean> => {
    if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(issueKey)) return false;
    const scope = defaultJql(config.jira).replace(/\s+ORDER\s+BY\s+[\s\S]*$/i, "");
    return (await client.searchIssues(`key = "${issueKey}" AND (${scope})`, 1)).some((found) => found.key === issueKey);
  };

  await tick();
  const timer = setInterval(() => void tick(), config.jira.pollMs);

  return {
    stop: () => clearInterval(timer),
    async nudge(issueKey: string): Promise<void> {
      // Only a ticket the poller would work: the one Jira webhook also carries other
      // projects' events (the Teammate triages them), and every hook but this one filtered
      // by project, so a `draft` or `approve` comment anywhere drove Scribe.
      if (!(await inScope(issueKey))) return;
      // Re-fetch rather than believe the event: the payload is untrusted input, and by the
      // time we look the ticket may have moved on anyway.
      const issue = await client.getIssue(issueKey);
      try {
        // Same lock as the poller: a webhook is a faster trigger, not a second worker.
        await withIssueLock(ctx, issueKey, () => handleIssue(ctx, issue));
      } catch (error) {
        console.warn(`[scribe] ${issueKey} (webhook): ${errorMessage(error)}`);
        await reportFailure(ctx, issue, error);
      }
    },
    async comment(issueKey: string, markdown: string, op?: string): Promise<void> {
      if (!op) return void (await say(ctx, issueKey, markdown));
      const posted = await ctx.client.addComment(issueKey, markdownToJira(markdown), { op });
      await ctx.state.markProcessed(issueKey, [posted.id]);
    },
    async commentPosted(issueKey: string, op: string): Promise<boolean> {
      return Boolean(await ctx.client.findCommentByOp(issueKey, op));
    },
    async approve(issueKey: string, approvedBy: string, draft?: string): Promise<void> {
      // Re-fetch, then take the exact path an `approve` comment takes — including the
      // fail-closed checks. A button must not be a shortcut around any of them, and it
      // takes the same per-issue lock, so it cannot race a tick that is revising.
      await withIssueLock(ctx, issueKey, async () => {
        const current = await ctx.state.readDraft(issueKey);
        if (draft && (!current || draftFingerprint(current) !== draft)) {
          throw new Error("the draft has changed since this card was posted. Review the latest draft on the ticket and approve it there");
        }
        const issue = await client.getIssue(issueKey);
        await runPublish(ctx, issue, approvedBy);
      });
    },
  };
}
