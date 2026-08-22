import type { AppConfig, Vault } from "@scriptorium/core";
import { checkContract, formatContractQuestions } from "@scriptorium/scribe";
import { App } from "@slack/bolt";
import type { ScribeJiraHandle } from "./scribe-jira";
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

export async function startScribeBot(config: AppConfig, _vault: Vault, jira?: ScribeJiraHandle): Promise<void> {
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

  // The approve button from a draft announcement. It routes into exactly the same
  // runPublish the ticket's `approve` comment reaches — one gate, a second doorway — and
  // it lives in Scribe's identity because Curator may never approve product claims.
  app.action("approve_doc", async ({ ack, body, respond, client }) => {
    await ack();
    // The button carries the issue key in `value`, so the handler needs no state of its own.
    const key = (body as { actions?: Array<{ value?: string }> }).actions?.[0]?.value;
    const userId = (body as { user?: { id?: string; username?: string } }).user;

    if (!key || !jira) {
      await respond({ text: "I can't publish from here — the Jira surface isn't running on this host.", replace_original: false });
      return;
    }

    // Record a human name, not a Slack id: the approver ends up in a git commit message.
    let approver = userId?.username ?? userId?.id ?? "a Slack user";
    try {
      if (userId?.id) {
        const profile = await client.users.info({ user: userId.id });
        approver = profile.user?.real_name ?? profile.user?.name ?? approver;
      }
    } catch {
      // Name lookup is a nicety; never block a publish on it.
    }

    try {
      await jira.approve(key, approver);
      await respond({ text: `Published ${key} — approved by ${approver}. Details are on the ticket.`, replace_original: false });
    } catch (error) {
      await respond({
        text: `Couldn't publish ${key}: ${error instanceof Error ? error.message : String(error)}`,
        replace_original: false,
      });
    }
  });

  // The "Open the ticket" button is a link; Slack still sends the interaction.
  app.action("open_ticket", async ({ ack }) => {
    await ack();
  });

  await app.start();
  console.log("[scribe] ⚡ connected (socket mode)");
}
