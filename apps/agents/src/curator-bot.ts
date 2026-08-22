import type { AppConfig, Vault } from "@scriptorium/core";
import { answerQuestion, fileGapNote } from "@scriptorium/curator";
import { App } from "@slack/bolt";
import { gapTicketOpener } from "./gap-ticket";
import { answerBlocks, contextBlocks, progressLine, toSlackMrkdwn } from "./slack-format";
import { stripMentions } from "./util";

/**
 * Curator in Slack.
 *
 * A grounded answer takes several seconds — two or three searches, a note read, then the
 * model composing. Silence for that long reads as a bot that did not hear you, and the
 * honest fix is not to answer faster but to say what is happening: a reaction the instant
 * the mention lands, then a single muted line that updates in place while the retrieval
 * runs, then the answer with the progress line removed. The thread ends holding the answer
 * and nothing else.
 *
 * Everything here is best-effort around the answer. A reaction that fails, a progress
 * message that cannot be posted, an update that races — none of them may cost a question
 * its reply, so each is caught and dropped. The answer is the product; this is scaffolding.
 */

/** Wait this long before saying anything: a fast answer should never get a progress bubble. */
const PROGRESS_AFTER_MS = 2_500;
/** Floor between edits. Slack rate-limits chat.update, and a counter racing is not useful. */
const PROGRESS_UPDATE_MS = 3_000;

interface Reactor {
  add(name: string): Promise<void>;
  remove(name: string): Promise<void>;
}

/**
 * Reactions need `reactions:write`, which an app installed from the older manifest does not
 * have. Rather than crash or nag on every message, the first refusal disables them for the
 * process and says so once — the progress message still carries the same information.
 */
function reactor(app: App, channel: string, timestamp: string, state: { enabled: boolean }): Reactor {
  const call = async (verb: "add" | "remove", name: string): Promise<void> => {
    if (!state.enabled) return;
    try {
      await app.client.reactions[verb]({ channel, timestamp, name });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("missing_scope")) {
        state.enabled = false;
        console.warn("[curator] reactions disabled — the Slack app lacks reactions:write (reinstall to enable)");
        return;
      }
      // already_reacted / no_reaction are the normal outcome of a retry, not a problem.
      if (!/already_reacted|no_reaction/.test(message)) {
        console.warn(`[curator] reaction ${verb} ${name} failed: ${message}`);
      }
    }
  };
  return { add: (name) => call("add", name), remove: (name) => call("remove", name) };
}

/**
 * A single Slack message that reports retrieval as it happens.
 *
 * Posted lazily and deleted on completion, so it exists only for the window where a human
 * is waiting and wondering. Counting searches and reads separately is what makes it worth
 * showing at all: "3 searches, 0 notes read" after ten seconds is the shape of a question
 * the vault does not cover, which is a different thing to be waiting on than a long read.
 */
class Progress {
  private searches = 0;
  private reads = 0;
  private messageTs: string | undefined;
  private lastUpdate = 0;
  private readonly startedAt = Date.now();
  private timer: NodeJS.Timeout | undefined;
  private done = false;

  constructor(
    private readonly app: App,
    private readonly channel: string,
    private readonly threadTs: string,
  ) {
    // A question that needs no tool at all still deserves a sign of life if it runs long.
    this.timer = setTimeout(() => void this.render(), PROGRESS_AFTER_MS);
  }

  observe(toolName: string): void {
    if (toolName === "read_note") this.reads += 1;
    else this.searches += 1;
    // Only ever renders after the initial delay, so a two-second answer stays silent.
    if (Date.now() - this.startedAt >= PROGRESS_AFTER_MS) void this.render();
  }

  private async render(): Promise<void> {
    if (this.done) return;
    const now = Date.now();
    if (this.messageTs && now - this.lastUpdate < PROGRESS_UPDATE_MS) return;
    this.lastUpdate = now;

    const text = progressLine({ searches: this.searches, reads: this.reads, elapsedMs: now - this.startedAt });
    try {
      if (this.messageTs) {
        await this.app.client.chat.update({ channel: this.channel, ts: this.messageTs, text, blocks: contextBlocks(text) as never });
      } else {
        const posted = await this.app.client.chat.postMessage({
          channel: this.channel,
          thread_ts: this.threadTs,
          text,
          blocks: contextBlocks(text) as never,
        });
        this.messageTs = posted.ts;
      }
    } catch (error) {
      console.warn(`[curator] progress update failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  /** Stop reporting and remove the bubble. Called on every exit path, including errors. */
  async finish(): Promise<void> {
    this.done = true;
    if (this.timer) clearTimeout(this.timer);
    if (!this.messageTs) return;
    try {
      await this.app.client.chat.delete({ channel: this.channel, ts: this.messageTs });
    } catch {
      // A bubble that cannot be deleted is stale text under a correct answer. Leave it.
    }
    this.messageTs = undefined;
  }
}

export async function startCuratorBot(config: AppConfig, vault: Vault): Promise<void> {
  const app = new App({
    token: config.curator.botToken,
    appToken: config.curator.appToken,
    socketMode: true,
  });

  // Curator cannot author documentation — but it can say what is missing and hand that
  // to Agent A. This is the seam where Slack's dead end becomes Jira's ticket.
  const openTicket = gapTicketOpener(config);
  const reactions = { enabled: true };

  app.event("app_mention", async ({ event, say }) => {
    const threadTs = event.thread_ts ?? event.ts;
    const question = stripMentions(event.text);
    const react = reactor(app, event.channel, event.ts, reactions);

    if (!question) {
      await say({
        thread_ts: threadTs,
        text: "*Curator* — ask me anything about the product and I'll answer from the knowledge vault, with sources.",
      });
      return;
    }

    if (!config.hasModelAccess) {
      await react.add("warning");
      await say({ thread_ts: threadTs, text: "⚠️ No model provider is configured, so I can't answer yet." });
      return;
    }

    // Heard you. This is the whole reason the reaction exists: it lands before any work.
    await react.add("eyes");
    const progress = new Progress(app, event.channel, threadTs);

    try {
      const answer = await answerQuestion(vault, question, { onTool: (name) => progress.observe(name) });
      await progress.finish();

      if (answer.gap) {
        const gap = await fileGapNote(vault, {
          question,
          missing: answer.gap,
          askedBy: event.user ?? "unknown",
          auditFile: config.auditFile,
          openTicket,
        });
        const lines = [
          "*Not in the knowledge base yet* — so I won't guess at it.",
          `📥 Filed a gap note for Scribe: \`${gap.relPath}\``,
          gap.ticket ? `🎫 Opened a doc request on Jira: <${gap.ticket.url}|${gap.ticket.key}>` : undefined,
        ].filter((line): line is string => Boolean(line));

        await say({
          thread_ts: threadTs,
          text: lines.join("\n"),
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
            ...contextBlocks("A missing answer here becomes Agent A's next ticket — that loop is the point."),
          ] as never,
        });
        // Not an error: refusing to invent an answer is the system working.
        await react.remove("eyes");
        await react.add("inbox_tray");
        return;
      }

      await say({
        thread_ts: threadTs,
        // `text` is the notification and the accessible fallback, so it carries the answer
        // too — a blocks-only message shows as an empty push on a phone.
        text: toSlackMrkdwn(answer.text),
        blocks: answerBlocks({ markdown: answer.text, citations: answer.citations }) as never,
      });
      await react.remove("eyes");
      await react.add("white_check_mark");
    } catch (error) {
      await progress.finish();
      await react.remove("eyes");
      await react.add("warning");
      await say({
        thread_ts: threadTs,
        text: `⚠️ ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

  await app.start();
  console.log("[curator] ⚡ connected (socket mode)");
}
