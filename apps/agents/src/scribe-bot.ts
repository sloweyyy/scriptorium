import type { AppConfig, Vault } from "@scriptorium/core";
import { checkContract, formatContractQuestions } from "@scriptorium/scribe";
import { App } from "@slack/bolt";
import { extractPrdText, stripMentions } from "./util";

const HELP = [
  "*Scribe* — drafts user documentation from PRDs. Humans approve everything.",
  "",
  "*Jira is where I work.* File a `doc-request` issue with the PRD attached and I run the whole loop there:",
  "contract check → draft → your feedback → approval → publish → proposed house rule.",
  "",
  "Here in Slack I only do a quick contract check:",
  "• `@Scribe check` + a fenced ```PRD``` block — validate a PRD against the input contract",
  "",
  "_Local dry run of the full pipeline: `pnpm draft samples/prd-001-scheduled-maintenance.md`_",
].join("\n");

export async function startScribeBot(config: AppConfig, _vault: Vault): Promise<void> {
  const app = new App({
    token: config.scribe.botToken,
    appToken: config.scribe.appToken,
    socketMode: true,
  });

  app.event("app_mention", async ({ event, say }) => {
    const threadTs = event.thread_ts ?? event.ts;
    const text = stripMentions(event.text);

    const prd = extractPrdText(text);
    if (prd) {
      const result = checkContract(prd);
      await say({
        thread_ts: threadTs,
        text: result.ok
          ? "✅ *Contract OK* — `feature`, `audience`, and `user_goal` are all present. Ready to draft."
          : `🚫 *I can't draft from this yet.* The PRD is missing:\n${formatContractQuestions(result)}\n\nAdd these to the frontmatter and mention me again.`,
      });
      return;
    }

    await say({ thread_ts: threadTs, text: HELP });
  });

  await app.start();
  console.log("[scribe] ⚡ connected (socket mode)");
}
