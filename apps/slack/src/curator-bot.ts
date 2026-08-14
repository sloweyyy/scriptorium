import type { AppConfig, Vault } from "@scriptorium/core";
import { answerQuestion, fileGapNote } from "@scriptorium/curator";
import { App } from "@slack/bolt";
import { stripMentions } from "./util";

export async function startCuratorBot(config: AppConfig, vault: Vault): Promise<void> {
  const app = new App({
    token: config.curator.botToken,
    appToken: config.curator.appToken,
    socketMode: true,
  });

  app.event("app_mention", async ({ event, say }) => {
    const threadTs = event.thread_ts ?? event.ts;
    const question = stripMentions(event.text);

    if (!question) {
      await say({
        thread_ts: threadTs,
        text: "*Curator* — ask me anything about the product and I'll answer from the knowledge vault, with sources.",
      });
      return;
    }

    if (!config.hasAnthropicKey) {
      await say({ thread_ts: threadTs, text: "⚠️ `ANTHROPIC_API_KEY` is not configured, so I can't answer yet." });
      return;
    }

    try {
      const answer = await answerQuestion(vault, question);

      if (answer.gap) {
        const gapPath = await fileGapNote(vault, {
          question,
          missing: answer.gap,
          askedBy: event.user ?? "unknown",
          auditFile: config.auditFile,
        });
        await say({
          thread_ts: threadTs,
          text: `I can't answer that from the vault — it isn't documented yet.\n📥 Filed a gap note for Scribe: \`${gapPath}\``,
        });
        return;
      }

      const sources = answer.citations.map((citation) => `\`${citation}\``).join(", ");
      await say({
        thread_ts: threadTs,
        text: `${answer.text}\n\n_Sources: ${sources || "none cited"}_`,
      });
    } catch (error) {
      await say({
        thread_ts: threadTs,
        text: `⚠️ ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

  await app.start();
  console.log("[curator] ⚡ connected (socket mode)");
}
