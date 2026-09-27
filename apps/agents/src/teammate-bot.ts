import path from "node:path";
import { audit, currentRunId, jiraReady, withRun, type AppConfig, type ToolSpec, type Vault } from "@scriptorium/core";
import {
  APPROVE_ACTION,
  ConfluenceConnector,
  REJECT_ACTION,
  SlackApprovalChannel,
  type SlackClient,
  handleApprovalClick,
  jiraTools,
  slackTools,
} from "@scriptorium/connectors";
import { jiraClient } from "@scriptorium/jira";
import { FileApprovalStore, executeApproved, type GuardDeps } from "@scriptorium/policy";
import { FileEffectLedger, Gate, KeyedQueue, envelopeOf, keys, loadSkills, memoryTools, type AgentEvent, type EffectLedger } from "@scriptorium/runtime";
import { App } from "@slack/bolt";
import { teammateConfig } from "./agents/teammate";
import { gapTicketOpener } from "./gap-ticket";
import { toSlackMrkdwn } from "./slack-format";
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
export function teammateConnectorTools(config: AppConfig, slack: SlackClient, ledger: EffectLedger): ToolSpec[] {
  const settings = config.teammate;
  const tools: ToolSpec[] = [...slackTools({ client: slack, allowedChannels: settings.channels, ledger })];
  if (jiraReady(config.jira)) {
    const projects = settings.jiraProjects.length ? settings.jiraProjects : [config.jira.projectKey as string];
    tools.push(...jiraTools({ client: jiraClient(config.jira), allowedProjects: projects, createProject: projects[0], issueType: config.jira.issueType, ledger }));
    tools.push(
      ...new ConfluenceConnector({
        baseUrl: config.jira.baseUrl as string,
        email: config.jira.email as string,
        apiToken: config.jira.apiToken as string,
        allowedSpaceKeys: settings.confluenceSpaces,
        ledger,
      }).tools(),
    );
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

export function formatReply(reply: TeammateReply, runId?: string): string {
  const body = toSlackMrkdwn(reply.text);
  const ticket = reply.kind === "gap" && reply.ticket ? `\n🎫 <${reply.ticket.url}|${reply.ticket.key}>` : "";
  const footer = `\n_AI-generated — verify before acting${runId ? ` · run \`${runId.slice(0, 8)}\`` : ""}_`;
  return `${body}${ticket}${footer}`;
}

export interface TeammateCore {
  /** A Slack `app_mention`, from Bolt or a test. */
  onMention(mention: SlackMention): Promise<void>;
  /** An Approve/Reject click. Returns a message for the clicker, if any (ephemeral). */
  onApprovalClick(action: string, payload: ApprovalClickPayload): Promise<string | undefined>;
  /** The weekly digest, if due and not yet posted this week. */
  checkDigest(now?: Date): Promise<void>;
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
export async function createTeammate(config: AppConfig, vault: Vault, slack: SlackClient, selfUserId: string): Promise<TeammateCore> {
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
  const approvalChannel = new SlackApprovalChannel(slack, config.slack.notifyChannel);
  const guardDepsFor = (key: string): GuardDeps => ({ store, channel: approvalChannel, auditFile: config.auditFile, key });
  const turnDeps = (key: string) => ({ vault, config: hostConfig, skills, connectorTools, guardDeps: guardDepsFor(key), auditFile: config.auditFile, openTicket: gapTicketOpener(config) });

  const gate = new Gate({
    selfIds: [self],
    // No channels configured → an empty scope list → it answers nowhere (fail closed).
    scopes: { slack: settings.channels.map((channel) => `slack:thread:${channel}/`) },
  });

  const queue = new KeyedQueue(
    async (key, events) => {
      for (const event of events) await withRun(async () => {
        const { channel, threadTs, text, ts } = event.payload as { channel: string; threadTs: string; text: string; ts: string };
        const context = text ? await threadContext(slack, channel, threadTs, ts).catch(() => undefined) : undefined;
        const reply = text
          ? await runTeammateTurn({ question: text, askedBy: event.actor.id, channel, context }, turnDeps(key))
          : ({ kind: "action", text: "Hi — ask me about the product, a page or a ticket, or ask me to file one." } as const);
        await slack.chat.postMessage({ channel, thread_ts: threadTs, text: formatReply(reply, currentRunId()) });
        await audit(config.auditFile, { type: `teammate.${reply.kind}`, actor: "teammate", key, askedBy: event.actor.id, event: event.id });
      });
    },
    {
      concurrency: 2,
      onError: (key, error) => {
        console.warn(`[teammate] ${key}: ${error instanceof Error ? error.message : error}`);
        void audit(config.auditFile, { type: "teammate.error", actor: "teammate", key, error: String(error) });
      },
    },
  );

  const digestChannel = settings.digestChannel && settings.channels.includes(settings.digestChannel) ? settings.digestChannel : undefined;
  if (settings.digestChannel && !digestChannel) console.warn(`[teammate] TEAMMATE_DIGEST_CHANNEL ${settings.digestChannel} is not in TEAMMATE_SLACK_CHANNELS — no digest`);

  return {
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
      const outcome = await executeApproved(envelope, [...connectorTools, ...memoryTools(vault)], requestId, guardDepsFor(request?.key ?? ""));
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

    drain: (deadlineMs) => queue.drain(deadlineMs),
  };
}

export async function startTeammateBot(config: AppConfig, vault: Vault): Promise<() => Promise<void>> {
  const settings = config.teammate;
  const app = new App({ token: settings.botToken, appToken: settings.appToken, socketMode: true });
  const identity = await app.client.auth.test();
  const core = await createTeammate(config, vault, app.client, String(identity.user_id));

  app.event("app_mention", async ({ event }) => core.onMention(event as SlackMention));
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
  return async () => {
    clearInterval(digestTimer);
    await core.drain(8_000);
    await app.stop();
  };
}
