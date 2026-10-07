import { cardNamesItsDraft, mayApproveInSlack, parseApprovalButtonValue } from "./slack-approval";
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
    const target = parseApprovalButtonValue((body as { actions?: Array<{ value?: string }> }).actions?.[0]?.value);
    const user = (body as { user?: { id?: string; username?: string } }).user;

    if (!target || !jira) {
      await respond({ text: "I can't publish from here — the Jira surface isn't running on this host.", replace_original: false });
      return;
    }
    const bound = cardNamesItsDraft(target);
    if (!bound.ok) {
      await respond({ text: bound.reason, response_type: "ephemeral", replace_original: false });
      return;
    }

    // Who pressed it is the whole question. A refusal leaves the card in place: someone
    // who IS an approver may still use it.
    const allowed = mayApproveInSlack(config.scribe.approvers ?? [], user?.id);
    if (!allowed.ok) {
      await respond({ text: allowed.reason, response_type: "ephemeral", replace_original: false });
      return;
    }

    // A human name for the git commit, with the Slack id beside it: names change, ids don't.
    let name = user?.username ?? "a Slack user";
    try {
      if (user?.id) {
        const profile = await client.users.info({ user: user.id });
        name = profile.user?.real_name ?? profile.user?.name ?? name;
      }
    } catch {
      // Name lookup is a nicety; never block a publish on it.
    }
    const approver = `${name} (slack:${user?.id})`;

    try {
      await jira.approve(target.issueKey, approver, target.draft);
      // Decided: replace the card so its button cannot be pressed a second time.
      await respond({ text: `Published ${target.issueKey} — approved by ${approver}. Details are on the ticket.`, replace_original: true });
    } catch (error) {
      await respond({
        text: `Couldn't publish ${target.issueKey}: ${error instanceof Error ? error.message : String(error)}`,
        replace_original: /draft has changed/.test(String(error)),
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
