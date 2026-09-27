import fs from "node:fs/promises";
import path from "node:path";
import { audit, currentRunId, jiraReady, parseAudit, withRun, type AppConfig, type Vault } from "@scriptorium/core";
import {
  APPROVE_ACTION,
  REJECT_ACTION,
  RETRY_ACTION,
  SlackApprovalChannel,
  type SlackClient,
  handleApprovalClick,
} from "@scriptorium/connectors";
import { jiraClient, jiraToMarkdown, markdownToJira, mentionsAccount, plainText, type CommentRestriction, type JiraClient } from "@scriptorium/jira";
import { FileApprovalStore, executeApproved, mayApprove, type ApprovalRequest, type GuardDeps } from "@scriptorium/policy";
import { DailyBudget, FileEffectLedger, Gate, KeyedQueue, envelopeOf, keys, loadSkills, memoryTools, once, opKey, type AgentEvent } from "@scriptorium/runtime";
import { App } from "@slack/bolt";
import { teammateConfig } from "./agents/teammate";
import { gapTicketOpener } from "./gap-ticket";
import { citationLinks, resolveCitations } from "./citations";
import { answerBlocks, contextBlocks } from "./slack-format";
import { digestDue, postDigestOnce } from "./digest";
import { runTeammateTurn } from "./teammate";
import { ASKING_SUBTYPES, capQuestion, formatReply, helpText, isHelpRequest, mentionToEvent, progressText, threadContext, type SlackMention } from "./teammate-bot/messages";
import { sharesScribeAccount, teammateConnectorTools } from "./teammate-bot/tools";
import { outcomeMessages } from "./teammate-bot/outcome";

export * from "./teammate-bot/messages";
export * from "./teammate-bot/tools";
export * from "./teammate-bot/outcome";

/**
 * The Teammate in Slack: the whole engine behind one surface.
 *
 * mention → AgentEvent → Gate (with reasons) → one lane per thread → runTeammateTurn →
 * reply in thread. Writes the agent asks for become approval cards in the same thread; a
 * listed approver's click carries the stored action out, exactly once.
 */

export interface TeammateCore {
  /** A Slack `app_mention`, from Bolt or a test. */
  onMention(mention: SlackMention): Promise<void>;
  /** A direct message to the Teammate (only when `TEAMMATE_ALLOW_DMS=true`). */
  onDirectMessage(message: SlackMention & { channel_type?: string; subtype?: string }): Promise<void>;
  /** An Approve/Reject click. Returns a message for the clicker, if any (ephemeral). */
  onApprovalClick(action: string, payload: ApprovalClickPayload): Promise<string | undefined>;
  /** The weekly digest, if due and not yet posted this week. */
  checkDigest(now?: Date): Promise<void>;
  /** A Jira comment; answered on the ticket, as the Teammate, if it mentions the Teammate. */
  /** `restriction`: who may see the comment; the reply carries the same. Omitted: public. */
  onJiraComment(input: { issueKey: string; commentId: string; body: string; authorId?: string; restriction?: CommentRestriction }): Promise<void>;
  /** A Jira issue assigned to the Teammate: it checks readiness and replies on the ticket. */
  onJiraAssigned(input: { issueKey: string; assigneeId: string; changeId: string }): Promise<void>;
  /** A pull request to check against its ticket (from the GitHub webhook). */
  onPullRequest(input: { repo: string; number: number; author?: string; deliveryId?: string }): Promise<void>;
  drain(deadlineMs: number): Promise<boolean>;
}

export interface ApprovalClickPayload {
  actions?: Array<{ value?: string }>;
  user?: { id?: string; username?: string };
  channel?: { id?: string };
  message?: { ts?: string; thread_ts?: string };
}

/** The Teammate's own Jira identity, when it has one — needed to answer on tickets. */
export interface TeammateJira {
  client: JiraClient;
  accountId: string;
}

/**
 * Everything the Teammate does in Slack, with no Bolt in it: the whole path from a mention
 * to a reply, and from a click to a carried-out action, driven by any Slack client. Bolt
 * only binds events to it — which is what lets the wiring itself be tested end to end.
 */
export async function createTeammate(config: AppConfig, vault: Vault, slack: SlackClient, selfUserId: string, jira?: TeammateJira): Promise<TeammateCore> {
  const settings = config.teammate;
  const self = `slack:${selfUserId}`;

  const stateDir = config.jira.stateDir;
  const store = new FileApprovalStore(path.join(stateDir, "approvals.json"));
  const ledger = new FileEffectLedger(path.join(stateDir, "effects.json"));
  const connectorTools = teammateConnectorTools(config, slack, ledger);

  // A turn is in memory only: a restart mid-answer (a deploy, a crash) loses it, and its
  // "Looking into it…" would stay forever. Each open placeholder is on the ledger; on boot,
  // any left open is closed with an honest notice instead.
  const turnOp = (channel: string, ts: string) => opKey("teammate.turn", channel, ts);
  for (const record of await ledger.inProgress().catch(() => [])) {
    const meta = record.meta as { kind?: string; channel?: string; ts?: string } | undefined;
    if (meta?.kind !== "teammate.turn" || !meta.channel || !meta.ts) continue;
    const closed = await slack.chat
      .update({ channel: meta.channel, ts: meta.ts, text: "⚠️ I restarted before I finished this, so it wasn't answered and nothing was changed. Please ask again." })
      .catch(() => undefined);
    if (closed?.ok) await ledger.put({ ...record, status: "done", completedAt: new Date().toISOString() });
  }
  const skills = await loadSkills(path.join(config.repoRoot, "skills"));
  const agentConfig = teammateConfig({ selfAccountIds: [self], approvers: (settings.approvers ?? []).map((id) => `slack:${id}`), people: settings.people });
  // Restrict to the connectors actually configured here: a tool the host can't provide is not offered.
  const available = new Set([...connectorTools.map((tool) => tool.name), "vault_overview", "search_vault", "read_note", "memory_save"]);
  const hostConfig = { ...agentConfig, tools: Object.fromEntries(Object.entries(agentConfig.tools).filter(([name]) => available.has(name))) };
  const envelope = envelopeOf(hostConfig);
  // Cards follow the request: its channel thread; a PR → the PR channel; a DM or Jira → notify.
  /** The visibility each Jira conversation was last asked at (public is `{}`), for replies. */
  const jiraRestrictions = new Map<string, CommentRestriction>();
  /** A running PR check's summary message, keyed by conversation: its card threads under it. */
  const prThreads = new Map<string, string>();
  const approvalChannel = new SlackApprovalChannel(slack, { fallbackChannel: config.slack.notifyChannel, prChannel: settings.prChannel, threadFor: (key) => prThreads.get(key) });
  const guardDepsFor = (key: string): GuardDeps => ({ store, channel: approvalChannel, auditFile: config.auditFile, key });
  // Spend caps per channel per day, seeded from today's audit so a restart is not a reset.
  const budget = new DailyBudget(settings.dailyTokens);
  // Per scope, each DM is its own channel: N people each get the full cap. The total caps them all.
  const total = new DailyBudget(settings.dailyTokensTotal);
  const ALL = "*";
  const usage = parseAudit(await fs.readFile(config.auditFile, "utf8").catch(() => ""));
  budget.seed(usage);
  total.seed(usage.map((line) => ({ ...line, scope: ALL })));
  const LIMIT_NOTICE = "I've reached today's usage limit here, so I'm not answering until tomorrow (UTC). An admin can raise `TEAMMATE_DAILY_TOKENS`.";
  /** Every surface a person can trigger spends against a cap: a channel, a Jira project, a repo. */
  const overBudget = async (key: string, scope: string): Promise<boolean> => {
    const exhausted = budget.exhausted(scope) ? scope : total.exhausted(ALL) ? ALL : undefined;
    if (!exhausted) return false;
    await audit(config.auditFile, { type: "teammate.budget.exhausted", actor: "teammate", key, scope: exhausted }).catch(() => undefined);
    return true;
  };
  const spendAgainst = (scope: string) => ({
    onUsage: (usage: { input: number; output: number }) => {
      budget.add(scope, usage.input + usage.output);
      total.add(ALL, usage.input + usage.output);
    },
  });
  const turnDeps = (key: string) => ({ vault, config: hostConfig, skills, connectorTools, guardDeps: guardDepsFor(key), auditFile: config.auditFile, openTicket: gapTicketOpener(config), signingKey: config.signingKey });

  const gate = new Gate({
    selfIds: [self],
    // No channels configured → an empty scope list → it answers nowhere (fail closed).
    // DMs (channel ids starting "D") only when explicitly allowed.
    scopes: { slack: [...settings.channels.map((channel) => `slack:thread:${channel}/`), ...(settings.allowDms ? ["slack:thread:D"] : [])] },
  });

  const queue = new KeyedQueue(
    async (key, events) => {
      for (const event of events) await withRun(async () => {
        if (event.kind === "github.pull_request") return checkPullRequest(key, event);
        if (event.kind === "jira.mention") return answerOnJira(key, event);
        const { channel, threadTs, text, ts } = event.payload as { channel: string; threadTs: string; text: string; ts: string };
        // One failing turn is answered and logged; it never drops the rest of the batch —
        // those deliveries are already marked seen, so Slack's redelivery would not bring them back.
        // Acknowledge at once, then turn that same message into the answer: the asker sees the
        // agent is on it, and the thread gets one reply rather than a placeholder plus an answer.
        const placeholder = !isHelpRequest(text)
          ? await slack.chat.postMessage({ channel, thread_ts: threadTs, text: "🔎 Looking into it…" }).catch(() => undefined)
          : undefined;
        const open = placeholder?.ts
          ? { op: turnOp(channel, placeholder.ts), status: "in-progress" as const, startedAt: new Date().toISOString(), meta: { kind: "teammate.turn", channel, ts: placeholder.ts } }
          : undefined;
        if (open) await ledger.put(open).catch(() => undefined);
        // Progress updates are fire-and-forget, so one can land AFTER the answer (a slow call,
        // or a 429 retried after its wait) and leave "Searching…" as the final word. Delivery
        // closes the gate and waits for any update already in flight.
        let finished = false;
        let inFlight: Promise<unknown> = Promise.resolve();
        const deliver = async (message: string, blocks?: unknown[]): Promise<void> => {
          finished = true;
          await inFlight;
          const close = async () => {
            if (open) await ledger.put({ ...open, status: "done", completedAt: new Date().toISOString() }).catch(() => undefined);
          };
          if (placeholder?.ts) {
            const updated = await slack.chat.update({ channel, ts: placeholder.ts, text: message, ...(blocks ? { blocks: blocks as never } : {}) }).catch(() => undefined);
            if (updated?.ok) return close();
          }
          await slack.chat.postMessage({ channel, thread_ts: threadTs, text: message, ...(blocks ? { blocks: blocks as never } : {}) });
          await close();
        };
        try {
          if (isHelpRequest(text)) {
            await deliver(helpText(settings));
            return;
          }
          if (await overBudget(key, channel)) {
            await deliver(LIMIT_NOTICE);
            return;
          }
          const context = text ? await threadContext(slack, channel, threadTs, ts).catch(() => undefined) : undefined;
          // Show what it is doing, at most every 2s (chat.update is rate-limited).
          let lastProgress = 0;
          const onTool = (tool: string): void => {
            const now = Date.now();
            if (finished || !placeholder?.ts || now - lastProgress < 2_000) return;
            lastProgress = now;
            inFlight = slack.chat.update({ channel, ts: placeholder.ts, text: progressText(tool) }).catch(() => undefined);
          };
          const reply = await runTeammateTurn(
            { question: text, askedBy: event.actor.id, channel, threadTs, context },
            { ...turnDeps(key), ...spendAgainst(channel), onTool },
          );
          const textOut = formatReply(reply, currentRunId(), { baseUrl: config.webhook?.publicBaseUrl, token: config.webhook?.traceToken });
          // An answer's sources are the point of the product: render them as links, the way
          // Curator does — vault notes to their site, Jira/Confluence/GitHub to their pages.
          const blocks =
            reply.kind === "answer"
              ? [
                  ...answerBlocks({ markdown: reply.text, citations: reply.citations, links: citationLinks(await resolveCitations(vault, config, reply.citations)) }),
                  ...contextBlocks(textOut.slice(textOut.lastIndexOf("\n_AI-generated") + 1)),
                ]
              : undefined;
          await deliver(textOut, blocks);
          await audit(config.auditFile, { type: `teammate.${reply.kind}`, actor: "teammate", key, askedBy: event.actor.id, event: event.id });
        } catch (error) {
          await audit(config.auditFile, { type: "teammate.error", actor: "teammate", key, event: event.id, error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
          await deliver(`⚠️ I couldn't finish that, so I haven't answered or changed anything. _run \`${(currentRunId() ?? "").slice(0, 8)}\`_`).catch(() => undefined);
        }
      });
    },
    {
      concurrency: 2,
      onError: (key, error) => {
        console.warn(`[teammate] ${key}: ${error instanceof Error ? error.message : error}`);
        void audit(config.auditFile, { type: "teammate.error", actor: "teammate", key, error: String(error) }).catch(() => undefined);
      },
    },
  );

  /**
   * A question asked on a Jira ticket, answered there — as the Teammate's own account, once
   * per triggering comment (op-keyed; a webhook redelivery or a retry finds the reply).
   */
  async function answerOnJira(key: string, event: AgentEvent): Promise<void> {
    if (!jira) return;
    const { issueKey, commentId, question, restriction = {} } = event.payload as { issueKey: string; commentId: string; question: string; restriction?: CommentRestriction };
    // Whatever the Teammate says next on this ticket's thread is said at this visibility.
    jiraRestrictions.set(keys.jiraIssue(issueKey), restriction);
    const scope = `jira:${issueKey.split("-")[0]}`;
    const reply = await (await overBudget(key, scope)
      ? Promise.resolve({ kind: "refused" as const, text: LIMIT_NOTICE })
      : runTeammateTurn({ question: `${question}\n\n(Asked on jira:${issueKey}.)`, askedBy: event.actor.id, budgetScope: scope }, { ...turnDeps(key), ...spendAgainst(scope) })
    ).catch(
      // The exception belongs in the audit log, not on a ticket other people read.
      async (error: unknown) => {
        await audit(config.auditFile, { type: "teammate.error", actor: "teammate", key, error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
        return { kind: "refused" as const, text: "I couldn't finish that, so I haven't answered or changed anything. Try again in a moment." };
      },
    );
    // Citations as Jira links, not raw `[[wikilinks]]` — the same resolver Slack answers use.
    const citations = reply.kind === "answer" ? reply.citations : [];
    const links = citationLinks(await resolveCitations(vault, config, citations));
    // `[[docs/x.md]]` resolves as `docs/x`, and `[[docs/x|Digest emails]]` keeps its label.
    const linked = reply.text.replace(/\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_whole, raw: string, _heading: string | undefined, alias: string | undefined) => {
      const target = raw.trim();
      const label = alias?.trim() || target;
      const url = links.get(target) ?? links.get(target.replace(/\.md$/, ""));
      return url ? `[${label}](${url})` : label;
    });
    const body = markdownToJira(`${linked}\n\n_AI-generated — verify before acting · run ${(currentRunId() ?? "").slice(0, 8)}_`);
    const op = opKey("teammate.jira.reply", issueKey, commentId);
    await once(ledger, op, async () => (await jira.client.addComment(issueKey, body, { op, restriction })).id, {
      probe: async () => (await jira.client.findCommentByOp(issueKey, op))?.id,
    });
    await audit(config.auditFile, { type: `teammate.jira.${reply.kind}`, actor: "teammate", key, issue: issueKey }).catch(() => undefined);
  }

  /** The pr-check skill, run for a PR the webhook handed over; the card goes to the PR channel. */
  async function checkPullRequest(key: string, event: AgentEvent): Promise<void> {
    const { repo, number } = event.payload as { repo: string; number: number };
    const channel = settings.prChannel as string;
    const heading = `*PR check* — <https://github.com/${repo}/pull/${number}|${repo}#${number}>`;
    // The summary is posted first, so a card the check raises can thread under it.
    const header = await slack.chat.postMessage({ channel, text: `${heading}\n⏳ Checking…` }).catch(() => undefined);
    if (header?.ts) prThreads.set(key, header.ts);
    const scope = `github:${repo.toLowerCase()}`;
    const reply = await (await overBudget(key, scope)
      ? Promise.resolve({ kind: "refused" as const, text: LIMIT_NOTICE })
      : runTeammateTurn(
          { question: `Check pull request github:${repo}/pull/${number} against the Jira ticket it implements, and propose one advisory comment.`, askedBy: event.actor.id, budgetScope: scope },
          { ...turnDeps(key), ...spendAgainst(scope) },
        )
    ).catch(async (error: unknown) => {
      await audit(config.auditFile, { type: "teammate.error", actor: "teammate", key, error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
      return { kind: "refused" as const, text: "I couldn't check this pull request, so nothing was posted to it." };
    });
    prThreads.delete(key);
    const text = `${heading}\n${formatReply(reply, currentRunId(), { baseUrl: config.webhook?.publicBaseUrl, token: config.webhook?.traceToken })}`;
    const updated = header?.ts ? await slack.chat.update({ channel, ts: header.ts, text }).catch(() => undefined) : undefined;
    if (!updated?.ok) await slack.chat.postMessage({ channel, text });
    await audit(config.auditFile, { type: `teammate.pr.${reply.kind}`, actor: "teammate", key, repo, number }).catch(() => undefined);
  }

  /**
   * The card goes where an approver will see it, which is not where a DM or a ticket asked.
   * Say the outcome at the origin too, once per request, or the requester never hears it.
   */
  async function tellOrigin(request: ApprovalRequest | undefined, text: string): Promise<void> {
    if (!request) return;
    const op = opKey("teammate.approval.outcome", request.id);
    const dm = request.key.match(/^slack:thread:(D[^/]+)\/(.+)$/);
    if (dm) {
      await once(ledger, op, async () => (await slack.chat.postMessage({ channel: dm[1] as string, thread_ts: dm[2], text }), true));
      return;
    }
    const issue = request.key.match(/^jira:issue:(.+)$/);
    // Only at a visibility this process saw the request asked at. Unknown (a restart since):
    // say nothing on the ticket — the card's own thread already has the outcome.
    const restriction = jiraRestrictions.get(request.key);
    if (issue && jira && restriction) {
      const issueKey = issue[1] as string;
      await once(ledger, op, async () => (await jira.client.addComment(issueKey, markdownToJira(text), { op, restriction })).id, {
        probe: async () => (await jira.client.findCommentByOp(issueKey, op))?.id,
      });
    }
  }

  /**
   * Run an approved request and say what happened. A connector that throws gives the
   * approval back (guard.ts), so the card thread gets a Retry button — otherwise the
   * decided card has no buttons left and the approval sits unusable until it expires. A
   * tool's refusal (`NOT_ALLOWED: …`) is not "done".
   */
  async function carryOut(request: ApprovalRequest, userId: string | undefined, userName: string | undefined, where: { channel?: string; threadTs?: string }): Promise<void> {
    const approver = userName ?? userId ?? "an approver";
    const outcome = await executeApproved(envelope, [...connectorTools, ...memoryTools(vault, config.signingKey)], request.id, guardDepsFor(request.key)).catch(
      (error: unknown) => ({ kind: "failed" as const, reason: error instanceof Error ? error.message : String(error) }),
    );
    const asker = request.requestedBy?.startsWith("slack:") ? `<@${request.requestedBy.slice("slack:".length)}> ` : "";
    const { text, origin, notRun } = outcomeMessages(outcome, { asker, approver, approverMention: userId ? `<@${userId}>` : approver });
    if (notRun) {
      await audit(config.auditFile, { type: "teammate.approval.not_run", actor: "teammate", request: request.id, outcome: notRun, reason: "reason" in outcome ? outcome.reason : undefined }).catch(() => undefined);
    }
    const retryable = (await store.all()).find((candidate) => candidate.id === request.id)?.status === "approved";
    if (where.channel) {
      await slack.chat.postMessage({
        channel: where.channel,
        thread_ts: where.threadTs,
        text,
        ...(retryable
          ? {
              blocks: [
                { type: "section", text: { type: "mrkdwn", text } },
                { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Retry" }, action_id: RETRY_ACTION, value: request.id }] },
              ] as never,
            }
          : {}),
      });
    }
    await tellOrigin(request, origin).catch(() => undefined);
  }

  const digestChannel = settings.digestChannel && settings.channels.includes(settings.digestChannel) ? settings.digestChannel : undefined;
  if (settings.digestChannel && !digestChannel) console.warn(`[teammate] TEAMMATE_DIGEST_CHANNEL ${settings.digestChannel} is not in TEAMMATE_SLACK_CHANNELS — no digest`);

  const core: TeammateCore = {
    async onMention(mention) {
      const agentEvent = mentionToEvent(mention);
      const verdict = gate.check(agentEvent);
      if (!verdict.accepted) {
        await audit(config.auditFile, { type: "teammate.ignored", actor: "teammate", key: agentEvent.key, reason: verdict.reason });
        return;
      }
      if (!config.hasModelAccess) {
        const { channel, threadTs } = agentEvent.payload;
        await slack.chat.postMessage({ channel, thread_ts: threadTs, text: "⚠️ No model provider is configured, so I can't answer yet." });
        return;
      }
      queue.push(agentEvent);
    },

    async onDirectMessage(message) {
      // A DM is a conversation with the Teammate by definition: no mention needed. Other
      // bots, edits and joins arrive as subtypes and are never questions.
      // A message with a screenshot is `file_share`, and one also sent to the channel is
      // `thread_broadcast`: both are still a person asking.
      if (message.channel_type !== "im" || (message.subtype && !ASKING_SUBTYPES.has(message.subtype)) || message.bot_id) return;
      if (!settings.allowDms) {
        // Silence reads as broken. Say once per DM where to ask instead — never answer here.
        const where = settings.channels.length ? `<#${settings.channels[0]}>` : "a channel I've been added to";
        await once(ledger, opKey("teammate.dm.pointer", message.channel), async () => {
          await slack.chat.postMessage({ channel: message.channel, text: `I don't answer direct messages here — mention me in ${where} and I'll help there.` });
          return true;
        }).catch(() => undefined);
        return;
      }
      await core.onMention(message);
    },

    async onApprovalClick(action, payload) {
      const requestId = payload.actions?.[0]?.value ?? "";
      const where = { channel: payload.channel?.id, threadTs: payload.message?.thread_ts ?? payload.message?.ts };
      if (action === RETRY_ACTION) {
        // A retry decides nothing new: the request is already approved. It only asks a
        // listed approver's say-so to run it again.
        const request = (await store.all()).find((candidate) => candidate.id === requestId);
        if (!request || request.status !== "approved") return "Nothing to retry: it was already carried out, rejected or expired.";
        const allowed = mayApprove(envelope, envelope.tools[request.tool] ?? { tier: "deny" }, payload.user?.id ? { accountId: `slack:${payload.user.id}` } : undefined, request.requestedBy);
        if (!allowed.ok) return `Not retried: ${allowed.reason}.`;
        await carryOut(request, payload.user?.id, payload.user?.username, where);
        return undefined;
      }
      const decided = await handleApprovalClick(slack, store, (agent) => (agent === envelope.agent ? envelope : undefined), {
        action,
        requestId,
        userId: payload.user?.id,
        userName: payload.user?.username,
        channel: payload.channel?.id,
        messageTs: payload.message?.ts,
        threadTs: payload.message?.thread_ts,
      });
      if (!decided.ok) return decided.message;
      const request = (await store.all()).find((candidate) => candidate.id === requestId);
      if (action !== APPROVE_ACTION) {
        await tellOrigin(request, `❌ Rejected by ${payload.user?.username ?? payload.user?.id ?? "an approver"} — nothing was done.`).catch(() => undefined);
        return decided.message;
      }
      if (request) await carryOut(request, payload.user?.id, payload.user?.username, where);
      return undefined;
    },

    async checkDigest(now = new Date()) {
      if (!digestChannel || !config.hasModelAccess) return;
      if (!digestDue(now, { weekday: settings.digestWeekday, hour: settings.digestHour })) return;
      await withRun(() =>
        postDigestOnce(
          ledger,
          digestChannel,
          now,
          async () => {
            // The digest spends its channel's budget; over it, the next hour retries.
            if (await overBudget(keys.cron("digest"), digestChannel)) throw new Error("digest not produced (daily token limit)");
            const reply = await runTeammateTurn({ question: "Write this week's digest for the team.", askedBy: "cron:digest", channel: digestChannel }, { ...turnDeps(keys.cron("digest")), ...spendAgainst(digestChannel) });
            // A refusal is not a digest: throw, so the op stays open and the next hour retries.
            // Neither a refusal nor a gap note is a digest: throw, so the next hour retries.
            if (reply.kind === "refused" || reply.kind === "gap") throw new Error(`digest not produced (${reply.kind})`);
            return formatReply(reply, currentRunId());
          },
          async (text) => {
            await slack.chat.postMessage({ channel: digestChannel, text: `*Weekly digest*\n${text}` });
          },
        ),
      );
    },

    async onJiraComment({ issueKey, commentId, body, authorId, restriction = {} }) {
      if (!jira || !mentionsAccount(body, jira.accountId) || authorId === jira.accountId) return;
      const projects = (settings.jiraProjects.length ? settings.jiraProjects : [config.jira.projectKey ?? ""]).map((project) => project.toUpperCase());
      if (!projects.includes(issueKey.split("-")[0]?.toUpperCase() ?? "")) {
        await audit(config.auditFile, { type: "teammate.ignored", actor: "teammate", key: keys.jiraIssue(issueKey), reason: "project is outside the Teammate's Jira projects" }).catch(() => undefined);
        return;
      }
      const event: AgentEvent = {
        id: `jira-comment:${commentId}`,
        source: "jira",
        key: keys.jiraIssue(issueKey),
        kind: "jira.mention",
        actor: { id: `jira:${authorId ?? "unknown"}` },
        payload: { issueKey, commentId, question: capQuestion(jiraToMarkdown(plainText(body))), restriction },
        receivedAt: new Date().toISOString(),
      };
      const verdict = gate.check(event);
      if (!verdict.accepted) {
        await audit(config.auditFile, { type: "teammate.ignored", actor: "teammate", key: event.key, reason: verdict.reason }).catch(() => undefined);
        return;
      }
      queue.push(event);
    },

    async onJiraAssigned({ issueKey, assigneeId, changeId }) {
      if (!jira || assigneeId !== jira.accountId) return;
      const projects = (settings.jiraProjects.length ? settings.jiraProjects : [config.jira.projectKey ?? ""]).map((project) => project.toUpperCase());
      if (!projects.includes(issueKey.split("-")[0]?.toUpperCase() ?? "")) return;
      const event: AgentEvent = {
        id: `jira-assigned:${changeId}`,
        source: "jira",
        key: keys.jiraIssue(issueKey),
        kind: "jira.mention",
        actor: { id: "jira:assignment" },
        // Answered like a mention, keyed on the change so a redelivery is one reply.
        payload: { issueKey, commentId: `assigned-${changeId}`, question: `You were assigned jira:${issueKey}. Check whether it is ready to be worked on, and reply with the verdict and what is missing.` },
        receivedAt: new Date().toISOString(),
      };
      const verdict = gate.check(event);
      if (!verdict.accepted) return;
      queue.push(event);
    },

    async onPullRequest({ repo, number, author, deliveryId }) {
      // Only allowed repos, and only with somewhere to put the result and the card.
      if (!config.hasModelAccess || !settings.prChannel || !settings.githubRepos.map((allowed) => allowed.toLowerCase()).includes(repo.toLowerCase())) {
        await audit(config.auditFile, { type: "teammate.ignored", actor: "teammate", key: keys.githubPull(repo, number), reason: "PR checks are not configured for this repo" }).catch(() => undefined);
        return;
      }
      const event: AgentEvent = {
        id: deliveryId ?? `${repo}#${number}`,
        source: "github",
        key: keys.githubPull(repo, number),
        kind: "github.pull_request",
        actor: { id: `github:${author ?? "unknown"}` },
        payload: { repo, number },
        receivedAt: new Date().toISOString(),
      };
      const verdict = gate.check(event);
      if (!verdict.accepted) {
        await audit(config.auditFile, { type: "teammate.ignored", actor: "teammate", key: event.key, reason: verdict.reason }).catch(() => undefined);
        return;
      }
      queue.push(event);
    },

    drain: (deadlineMs) => queue.drain(deadlineMs),
  };
  return core;
}

export async function startTeammateBot(config: AppConfig, vault: Vault): Promise<{ stop: () => Promise<void>; core: TeammateCore }> {
  const settings = config.teammate;
  const app = new App({ token: settings.botToken, appToken: settings.appToken, socketMode: true });
  const identity = await app.client.auth.test();
  // On Jira only as itself: its own service account, or not at all.
  let jira: TeammateJira | undefined;
  if (sharesScribeAccount(config)) {
    console.warn("[teammate] TEAMMATE_ATLASSIAN_EMAIL is Scribe's Jira account, so Jira is off for the Teammate: two agents on one account are one identity.");
  } else if (jiraReady(config.jira) && settings.atlassianEmail && settings.atlassianToken) {
    const client = jiraClient({ ...config.jira, email: settings.atlassianEmail, apiToken: settings.atlassianToken });
    // A Jira problem at boot costs the Jira surface, never the whole Teammate: Slack keeps working.
    jira = await client
      .myself()
      .then((me) => ({ client, accountId: me.accountId }))
      .catch((error: unknown) => {
        console.warn(`[teammate] its Jira account could not be verified, so Jira mentions are off: ${error instanceof Error ? error.message : error}`);
        return undefined;
      });
  }
  const core = await createTeammate(config, vault, app.client, String(identity.user_id), jira);

  app.event("app_mention", async ({ event }) => core.onMention(event as SlackMention));
  app.message(async ({ message }) => core.onDirectMessage(message as SlackMention & { channel_type?: string; subtype?: string }));
  for (const action of [APPROVE_ACTION, REJECT_ACTION, RETRY_ACTION]) {
    app.action(action, async ({ ack, body, respond }) => {
      await ack();
      const message = await core.onApprovalClick(action, body as ApprovalClickPayload);
      if (message) await respond({ text: message, response_type: "ephemeral", replace_original: false });
    });
  }

  // The weekly digest: checked hourly, posted once per ISO week (the effects ledger makes a
  // restart or a second instance a no-op).
  const digestCheck = (): void => void core.checkDigest().catch((error) => console.warn(`[teammate] digest: ${error instanceof Error ? error.message : error}`));
  const digestTimer = setInterval(digestCheck, 60 * 60 * 1000);
  digestCheck();

  await app.start();
  console.log(`[teammate] ⚡ connected (socket mode) — ${settings.channels.length} channel(s)`);
  return {
    core,
    stop: async () => {
      clearInterval(digestTimer);
      await core.drain(8_000);
      await app.stop();
    },
  };
}
