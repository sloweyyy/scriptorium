import path from "node:path";
import { audit, currentRunId, jiraReady, withRun, type AppConfig, type ToolSpec, type Vault } from "@scriptorium/core";
import {
  APPROVE_ACTION,
  ConfluenceConnector,
  REJECT_ACTION,
  SlackApprovalChannel,
  type SlackClient,
  githubTools,
  handleApprovalClick,
  jiraTools,
  slackTools,
} from "@scriptorium/connectors";
import { jiraClient, jiraToMarkdown, markdownToJira, mentionsAccount, plainText, type JiraClient } from "@scriptorium/jira";
import { installationToken } from "@scriptorium/publish";
import { FileApprovalStore, executeApproved, type GuardDeps } from "@scriptorium/policy";
import { FileEffectLedger, Gate, KeyedQueue, envelopeOf, keys, loadSkills, memoryTools, once, opKey, type AgentEvent, type EffectLedger } from "@scriptorium/runtime";
import { App } from "@slack/bolt";
import { teammateConfig } from "./agents/teammate";
import { gapTicketOpener } from "./gap-ticket";
import { citationLinks, resolveCitations } from "./citations";
import { answerBlocks, contextBlocks, toSlackMrkdwn } from "./slack-format";
import { digestDue, postDigestOnce } from "./digest";
import { runTeammateTurn, type TeammateReply } from "./teammate";
import { stripMentions } from "./util";

/**
 * The Teammate in Slack: the whole engine behind one surface.
 *
 * mention → AgentEvent → Gate (with reasons) → one lane per thread → runTeammateTurn →
 * reply in thread. Writes the agent asks for become approval cards in the same thread; a
 * listed approver's click carries the stored action out, exactly once.
 */

export interface SlackMention {
  type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  channel: string;
  event_ts?: string;
  client_msg_id?: string;
}

/** A Slack `app_mention` as the platform's event. Pure, so the mapping is pinned by evals. */
export function mentionToEvent(mention: SlackMention): AgentEvent<{ channel: string; threadTs: string; text: string; ts: string }> {
  const threadTs = mention.thread_ts ?? mention.ts;
  return {
    id: mention.client_msg_id ?? `${mention.channel}:${mention.event_ts ?? mention.ts}`,
    source: "slack",
    key: keys.slackThread(mention.channel, threadTs),
    kind: "slack.mention",
    actor: { id: `slack:${mention.user ?? mention.bot_id ?? "unknown"}`, isBot: Boolean(mention.bot_id) },
    payload: { channel: mention.channel, threadTs, text: stripMentions(mention.text), ts: mention.ts },
    receivedAt: new Date().toISOString(),
  };
}

/** Everything the Teammate can reach on this host, each limited to its allow-list. */
/** Tools that write to Jira or Confluence — offered only under the Teammate's own identity. */
const ATLASSIAN_WRITES = new Set(["jira_comment", "jira_create_issue", "confluence_create_page", "confluence_update_page"]);

export function teammateConnectorTools(config: AppConfig, slack: SlackClient, ledger: EffectLedger): ToolSpec[] {
  const settings = config.teammate;
  const tools: ToolSpec[] = [...slackTools({ client: slack, allowedChannels: settings.channels, ledger })];
  if (jiraReady(config.jira)) {
    const projects = settings.jiraProjects.length ? settings.jiraProjects : [config.jira.projectKey as string];
    // Its own service account, or read-only. Borrowing Scribe's token to WRITE would make
    // two agents one identity: a Teammate comment would read as Scribe's on every ticket.
    const ownIdentity = Boolean(settings.atlassianEmail && settings.atlassianToken);
    const email = ownIdentity ? (settings.atlassianEmail as string) : (config.jira.email as string);
    const apiToken = ownIdentity ? (settings.atlassianToken as string) : (config.jira.apiToken as string);
    const atlassian = [
      ...jiraTools({ client: jiraClient({ ...config.jira, email, apiToken }), allowedProjects: projects, createProject: projects[0], issueType: config.jira.issueType, ledger }),
      ...new ConfluenceConnector({ baseUrl: config.jira.baseUrl as string, email, apiToken, allowedSpaceKeys: settings.confluenceSpaces, ledger }).tools(),
    ];
    if (!ownIdentity) console.warn("[teammate] no TEAMMATE_ATLASSIAN_EMAIL/TOKEN — Jira and Confluence are read-only for the Teammate");
    tools.push(...(ownIdentity ? atlassian : atlassian.filter((tool) => !ATLASSIAN_WRITES.has(tool.name))));
  }
  // GitHub only under the Teammate's own App — never the docs repo's — and only for listed repos.
  if (settings.githubAppId && settings.githubAppKey && settings.githubRepos?.length) {
    const appId = settings.githubAppId;
    const privateKey = settings.githubAppKey;
    tools.push(...githubTools({ token: (repo) => installationToken({ appId, privateKey, repo }), allowedRepos: settings.githubRepos, ledger }));
  }
  return tools;
}

/**
 * The reply as posted. Every agent-written message says so and names its run: the footer is
 * the thread a reader pulls to find the trigger, tool calls and approvals behind it.
 */
/**
 * The thread so far, for context: "make a ticket for this" is meaningless without it. Only
 * the thread the agent was mentioned in (Slack's terms: no bulk reads), capped, oldest
 * first, the triggering message left out. It is handed to the model as data.
 */
export async function threadContext(slack: SlackClient, channel: string, threadTs: string, triggerTs: string, limit = 20): Promise<string | undefined> {
  if (threadTs === triggerTs) return undefined;
  const replies = await slack.conversations.replies({ channel, ts: threadTs, limit: 50 });
  const lines = (replies.messages ?? [])
    .filter((message) => message.ts !== triggerTs && message.text)
    .slice(-limit)
    .map((message) => `${message.user ? `<@${message.user}>` : "bot"}: ${(message.text ?? "").slice(0, 1_000)}`);
  return lines.length ? lines.join("\n") : undefined;
}

export function formatReply(reply: TeammateReply, runId?: string, viewer?: { baseUrl?: string; token?: string }): string {
  const body = toSlackMrkdwn(reply.text);
  const ticket = reply.kind === "gap" && reply.ticket ? `\n🎫 <${reply.ticket.url}|${reply.ticket.key}>` : "";
  const run = runId?.slice(0, 8);
  // With a viewer configured, the run id is a link to everything the run did.
  const runLabel = run
    ? viewer?.baseUrl && viewer.token
      ? ` · <${viewer.baseUrl.replace(/\/$/, "")}/runs/${run}?token=${encodeURIComponent(viewer.token)}|view run ${run}>`
      : ` · run \`${run}\``
    : "";
  return `${body}${ticket}\n_AI-generated — verify before acting${runLabel}_`;
}

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
  onJiraComment(input: { issueKey: string; commentId: string; body: string; authorId?: string }): Promise<void>;
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

/**
 * Everything the Teammate does in Slack, with no Bolt in it: the whole path from a mention
 * to a reply, and from a click to a carried-out action, driven by any Slack client. Bolt
 * only binds events to it — which is what lets the wiring itself be tested end to end.
 */
/** The Teammate's own Jira identity, when it has one — needed to answer on tickets. */
export interface TeammateJira {
  client: JiraClient;
  accountId: string;
}

export async function createTeammate(config: AppConfig, vault: Vault, slack: SlackClient, selfUserId: string, jira?: TeammateJira): Promise<TeammateCore> {
  const settings = config.teammate;
  const self = `slack:${selfUserId}`;

  const stateDir = config.jira.stateDir;
  const store = new FileApprovalStore(path.join(stateDir, "approvals.json"));
  const ledger = new FileEffectLedger(path.join(stateDir, "effects.json"));
  const connectorTools = teammateConnectorTools(config, slack, ledger);
  const skills = await loadSkills(path.join(config.repoRoot, "skills"));
  const agentConfig = teammateConfig({ selfAccountIds: [self], approvers: (settings.approvers ?? []).map((id) => `slack:${id}`) });
  // Restrict to the connectors actually configured here: a tool the host can't provide is not offered.
  const available = new Set([...connectorTools.map((tool) => tool.name), "vault_overview", "search_vault", "read_note", "memory_save"]);
  const hostConfig = { ...agentConfig, tools: Object.fromEntries(Object.entries(agentConfig.tools).filter(([name]) => available.has(name))) };
  const envelope = envelopeOf(hostConfig);
  // Requests that did not start in a Slack thread (a PR check) put their card in the PR channel.
  const approvalChannel = new SlackApprovalChannel(slack, settings.prChannel ?? config.slack.notifyChannel);
  const guardDepsFor = (key: string): GuardDeps => ({ store, channel: approvalChannel, auditFile: config.auditFile, key });
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
        const placeholder = text
          ? await slack.chat.postMessage({ channel, thread_ts: threadTs, text: "🔎 Looking into it…" }).catch(() => undefined)
          : undefined;
        const deliver = async (message: string, blocks?: unknown[]): Promise<void> => {
          if (placeholder?.ts) {
            const updated = await slack.chat.update({ channel, ts: placeholder.ts, text: message, ...(blocks ? { blocks: blocks as never } : {}) }).catch(() => undefined);
            if (updated?.ok) return;
          }
          await slack.chat.postMessage({ channel, thread_ts: threadTs, text: message, ...(blocks ? { blocks: blocks as never } : {}) });
        };
        try {
          const context = text ? await threadContext(slack, channel, threadTs, ts).catch(() => undefined) : undefined;
          const reply = text
            ? await runTeammateTurn({ question: text, askedBy: event.actor.id, channel, threadTs, context }, turnDeps(key))
            : ({ kind: "action", text: "Hi — ask me about the product, a page or a ticket, or ask me to file one." } as const);
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
    const { issueKey, commentId, question } = event.payload as { issueKey: string; commentId: string; question: string };
    const reply = await runTeammateTurn({ question: `${question}\n\n(Asked on jira:${issueKey}.)`, askedBy: event.actor.id }, turnDeps(key)).catch(
      (error: unknown) => ({ kind: "refused" as const, text: `I couldn't finish that: ${error instanceof Error ? error.message : String(error)}` }),
    );
    const body = markdownToJira(`${reply.text}\n\n_AI-generated — verify before acting · run ${(currentRunId() ?? "").slice(0, 8)}_`);
    const op = opKey("teammate.jira.reply", issueKey, commentId);
    await once(ledger, op, async () => (await jira.client.addComment(issueKey, body, { op })).id, {
      probe: async () => (await jira.client.findCommentByOp(issueKey, op))?.id,
    });
    await audit(config.auditFile, { type: `teammate.jira.${reply.kind}`, actor: "teammate", key, issue: issueKey }).catch(() => undefined);
  }

  /** The pr-check skill, run for a PR the webhook handed over; the card goes to the PR channel. */
  async function checkPullRequest(key: string, event: AgentEvent): Promise<void> {
    const { repo, number } = event.payload as { repo: string; number: number };
    const channel = settings.prChannel as string;
    const reply = await runTeammateTurn(
      { question: `Check pull request github:${repo}/pull/${number} against the Jira ticket it implements, and propose one advisory comment.`, askedBy: event.actor.id },
      turnDeps(key),
    ).catch((error: unknown) => ({ kind: "refused" as const, text: `I couldn't check it: ${error instanceof Error ? error.message : String(error)}` }));
    await slack.chat.postMessage({ channel, text: `*PR check* — github:${repo}/pull/${number}\n${formatReply(reply, currentRunId(), { baseUrl: config.webhook?.publicBaseUrl, token: config.webhook?.traceToken })}` });
    await audit(config.auditFile, { type: `teammate.pr.${reply.kind}`, actor: "teammate", key, repo, number }).catch(() => undefined);
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
      if (!settings.allowDms || message.channel_type !== "im" || message.subtype || message.bot_id) return;
      await core.onMention(message);
    },

    async onApprovalClick(action, payload) {
      const requestId = payload.actions?.[0]?.value ?? "";
      const decided = await handleApprovalClick(slack, store, (agent) => (agent === envelope.agent ? envelope : undefined), {
        action,
        requestId,
        userId: payload.user?.id,
        userName: payload.user?.username,
        channel: payload.channel?.id,
        messageTs: payload.message?.ts,
      });
      if (!decided.ok || action !== APPROVE_ACTION) return decided.message;
      const request = (await store.all()).find((candidate) => candidate.id === requestId);
      const outcome = await executeApproved(envelope, [...connectorTools, ...memoryTools(vault, config.signingKey)], requestId, guardDepsFor(request?.key ?? ""));
      const text = outcome.kind === "ran" ? `Done: ${outcome.result}` : `Approved, but not carried out: ${"reason" in outcome ? outcome.reason : outcome.kind}`;
      if (payload.channel?.id) await slack.chat.postMessage({ channel: payload.channel.id, thread_ts: payload.message?.thread_ts ?? payload.message?.ts, text });
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
            const reply = await runTeammateTurn({ question: "Write this week's digest for the team.", askedBy: "cron:digest", channel: digestChannel }, turnDeps(keys.cron("digest")));
            // A refusal is not a digest: throw, so the op stays open and the next hour retries.
            if (reply.kind === "refused") throw new Error(`digest refused: ${reply.text}`);
            return formatReply(reply, currentRunId());
          },
          async (text) => {
            await slack.chat.postMessage({ channel: digestChannel, text: `*Weekly digest*\n${text}` });
          },
        ),
      );
    },

    async onJiraComment({ issueKey, commentId, body, authorId }) {
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
        payload: { issueKey, commentId, question: jiraToMarkdown(plainText(body)) },
        receivedAt: new Date().toISOString(),
      };
      const verdict = gate.check(event);
      if (!verdict.accepted) {
        await audit(config.auditFile, { type: "teammate.ignored", actor: "teammate", key: event.key, reason: verdict.reason }).catch(() => undefined);
        return;
      }
      queue.push(event);
    },

    async onPullRequest({ repo, number, author, deliveryId }) {
      // Only allowed repos, and only with somewhere to put the result and the card.
      if (!settings.prChannel || !settings.githubRepos.map((allowed) => allowed.toLowerCase()).includes(repo.toLowerCase())) {
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
  if (jiraReady(config.jira) && settings.atlassianEmail && settings.atlassianToken) {
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
  for (const action of [APPROVE_ACTION, REJECT_ACTION]) {
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
