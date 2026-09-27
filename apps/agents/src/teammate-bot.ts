import path from "node:path";
import { audit, jiraReady, type AppConfig, type ToolSpec, type Vault } from "@scriptorium/core";
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
import { FileEffectLedger, Gate, KeyedQueue, envelopeOf, keys, loadSkills, type AgentEvent, type EffectLedger } from "@scriptorium/runtime";
import { App } from "@slack/bolt";
import { teammateConfig } from "./agents/teammate";
import { gapTicketOpener } from "./gap-ticket";
import { toSlackMrkdwn } from "./slack-format";
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
export function mentionToEvent(mention: SlackMention): AgentEvent<{ channel: string; threadTs: string; text: string }> {
  const threadTs = mention.thread_ts ?? mention.ts;
  return {
    id: mention.client_msg_id ?? `${mention.channel}:${mention.event_ts ?? mention.ts}`,
    source: "slack",
    key: keys.slackThread(mention.channel, threadTs),
    kind: "slack.mention",
    actor: { id: `slack:${mention.user ?? mention.bot_id ?? "unknown"}`, isBot: Boolean(mention.bot_id) },
    payload: { channel: mention.channel, threadTs, text: stripMentions(mention.text) },
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
      }).tools(),
    );
  }
  return tools;
}

export function formatReply(reply: TeammateReply): string {
  const body = toSlackMrkdwn(reply.text);
  if (reply.kind === "gap" && reply.ticket) return `${body}\n🎫 <${reply.ticket.url}|${reply.ticket.key}>`;
  return body;
}

export async function startTeammateBot(config: AppConfig, vault: Vault): Promise<() => Promise<void>> {
  const settings = config.teammate;
  const app = new App({ token: settings.botToken, appToken: settings.appToken, socketMode: true });
  const identity = await app.client.auth.test();
  const self = `slack:${identity.user_id}`;

  const stateDir = config.jira.stateDir;
  const store = new FileApprovalStore(path.join(stateDir, "approvals.json"));
  const ledger = new FileEffectLedger(path.join(stateDir, "effects.json"));
  const connectorTools = teammateConnectorTools(config, app.client, ledger);
  const skills = await loadSkills(path.join(config.repoRoot, "skills"));
  const agentConfig = teammateConfig({ selfAccountIds: [self], approvers: (settings.approvers ?? []).map((id) => `slack:${id}`) });
  // Restrict to the connectors actually configured here: a tool the host can't provide is not offered.
  const available = new Set([...connectorTools.map((tool) => tool.name), "vault_overview", "search_vault", "read_note"]);
  const hostConfig = { ...agentConfig, tools: Object.fromEntries(Object.entries(agentConfig.tools).filter(([name]) => available.has(name))) };
  const envelope = envelopeOf(hostConfig);
  const approvalChannel = new SlackApprovalChannel(app.client, config.slack.notifyChannel);
  const guardDepsFor = (key: string): GuardDeps => ({ store, channel: approvalChannel, auditFile: config.auditFile, key });

  const gate = new Gate({
    selfIds: [self],
    // No channels configured → an empty scope list → it answers nowhere (fail closed).
    scopes: { slack: settings.channels.map((channel) => `slack:thread:${channel}/`) },
  });

  const queue = new KeyedQueue(
    async (key, events) => {
      for (const event of events) {
        const { channel, threadTs, text } = event.payload as { channel: string; threadTs: string; text: string };
        const reply = text
          ? await runTeammateTurn(
              { question: text, askedBy: event.actor.id },
              { vault, config: hostConfig, skills, connectorTools, guardDeps: guardDepsFor(key), auditFile: config.auditFile, openTicket: gapTicketOpener(config) },
            )
          : ({ kind: "action", text: "Hi — ask me about the product, a page or a ticket, or ask me to file one." } as const);
        await app.client.chat.postMessage({ channel, thread_ts: threadTs, text: formatReply(reply) });
        await audit(config.auditFile, { type: `teammate.${reply.kind}`, actor: "teammate", key, askedBy: event.actor.id });
      }
    },
    {
      concurrency: 2,
      onError: (key, error) => {
        console.warn(`[teammate] ${key}: ${error instanceof Error ? error.message : error}`);
        void audit(config.auditFile, { type: "teammate.error", actor: "teammate", key, error: String(error) });
      },
    },
  );

  app.event("app_mention", async ({ event }) => {
    const agentEvent = mentionToEvent(event as SlackMention);
    const verdict = gate.check(agentEvent);
    if (!verdict.accepted) {
      await audit(config.auditFile, { type: "teammate.ignored", actor: "teammate", key: agentEvent.key, reason: verdict.reason });
      return;
    }
    if (!config.hasModelAccess) {
      const { channel, threadTs } = agentEvent.payload;
      await app.client.chat.postMessage({ channel, thread_ts: threadTs, text: "⚠️ No model provider is configured, so I can't answer yet." });
      return;
    }
    queue.push(agentEvent);
  });

  for (const action of [APPROVE_ACTION, REJECT_ACTION]) {
    app.action(action, async ({ ack, body, respond }) => {
      await ack();
      const payload = body as { actions?: Array<{ value?: string }>; user?: { id?: string; username?: string }; channel?: { id?: string }; message?: { ts?: string; thread_ts?: string } };
      const requestId = payload.actions?.[0]?.value ?? "";
      const decided = await handleApprovalClick(app.client, store, (agent) => (agent === envelope.agent ? envelope : undefined), {
        action,
        requestId,
        userId: payload.user?.id,
        userName: payload.user?.username,
        channel: payload.channel?.id,
        messageTs: payload.message?.ts,
      });
      if (!decided.ok || action !== APPROVE_ACTION) {
        await respond({ text: decided.message, response_type: "ephemeral", replace_original: false });
        return;
      }
      const request = (await store.all()).find((candidate) => candidate.id === requestId);
      const outcome = await executeApproved(envelope, connectorTools, requestId, guardDepsFor(request?.key ?? ""));
      const text = outcome.kind === "ran" ? `Done: ${outcome.result}` : `Approved, but not carried out: ${"reason" in outcome ? outcome.reason : outcome.kind}`;
      if (payload.channel?.id) await app.client.chat.postMessage({ channel: payload.channel.id, thread_ts: payload.message?.thread_ts ?? payload.message?.ts, text });
    });
  }

  await app.start();
  console.log(`[teammate] ⚡ connected (socket mode) — ${settings.channels.length} channel(s), ${connectorTools.length} connector tool(s)`);
  return async () => {
    await queue.drain(8_000);
    await app.stop();
  };
}
