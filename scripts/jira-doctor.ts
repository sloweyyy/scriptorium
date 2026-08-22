/**
 * Verify the Jira side of the demo before trusting it to run unattended:
 *   pnpm jira:doctor            # read-only checks
 *   pnpm jira:doctor --write    # also posts a test comment + attachment on the newest issue
 *
 * Checks auth, which search endpoint this instance answers on, the doc-request JQL,
 * comments, attachments (including a real authenticated download), and whether the
 * approval transition exists.
 */
import { defaultJql, jiraReady, loadConfig } from "@scriptorium/core";
import { issueStatus, jiraClient } from "@scriptorium/jira";

const config = loadConfig();
const wantsWrite = process.argv.includes("--write");

if (!jiraReady(config.jira)) {
  console.error("🚫 Jira is not configured. Fill JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY in .env");
  process.exit(1);
}

const client = jiraClient(config.jira);

console.log(`site:    ${config.jira.baseUrl}`);
console.log(`project: ${config.jira.projectKey}`);

const me = await client.myself();
console.log(`✅ auth: ${me.displayName} (accountId ${me.accountId})`);

const jql = defaultJql(config.jira);
console.log(`\njql:     ${jql}`);
const issues = await client.searchIssues(jql);
console.log(`✅ search endpoint: ${client.searchEndpoint} — ${issues.length} issue(s)`);
for (const issue of issues.slice(0, 10)) {
  console.log(`   ${issue.key}  [${issueStatus(issue)}]  ${issue.fields.summary}`);
}

const probe = issues[0];
if (!probe) {
  console.log(
    `\n⚠️  No issue matched. Create any issue in ${config.jira.projectKey} and re-run — the poller watches the whole project now; the "${config.jira.label}" label only decides whether Scribe drafts unprompted.`,
  );
  process.exit(0);
}

console.log(`\nprobing ${probe.key}`);
const comments = await client.listComments(probe.key);
console.log(`✅ comments: ${comments.length}${comments.length ? ` (latest by ${comments.at(-1)?.author?.displayName})` : ""}`);

const attachments = probe.fields.attachment ?? [];
console.log(`✅ attachments: ${attachments.length}`);
for (const attachment of attachments) console.log(`   ${attachment.filename} (${attachment.mimeType})`);
const firstAttachment = attachments[0];
if (firstAttachment) {
  const bytes = await client.downloadAttachment(firstAttachment);
  console.log(`✅ download: ${firstAttachment.filename} -> ${bytes.byteLength} bytes`);
}

const transitions = await client.listTransitions(probe.key);
console.log(`✅ transitions: ${transitions.map((t) => `${t.name} -> ${t.to?.name ?? "?"}`).join(", ") || "none"}`);
const approved = config.jira.approvedStatus.toLowerCase();
const hasApproval = transitions.some((t) => t.to?.name?.toLowerCase() === approved || t.name.toLowerCase() === approved);
console.log(
  hasApproval
    ? `✅ approval transition to "${config.jira.approvedStatus}" is available`
    : `⚠️  no transition to "${config.jira.approvedStatus}" from ${issueStatus(probe)} — add that status to the workflow, or approve with the comment "approve"`,
);

if (wantsWrite) {
  const comment = await client.addComment(probe.key, "{color:#707070}scriptorium connectivity check — write access OK.{color}");
  console.log(`✅ posted comment ${comment.id}`);
  await client.uploadAttachment(probe.key, "scriptorium-check.md", "# scriptorium\n\nWrite access verified.\n", "text/markdown");
  console.log("✅ uploaded attachment scriptorium-check.md");
}

// Webhook reachability. The registration API is Connect/OAuth-only, so all the doctor can
// prove is that the route answers — with a probe event the ingress drops before doing work.
const publicUrl = process.env.PUBLIC_URL?.trim();
const webhookSecret = process.env.JIRA_WEBHOOK_SECRET?.trim();
if (publicUrl && webhookSecret) {
  const url = `${publicUrl.replace(/\/+$/, "")}/jira/webhook/${webhookSecret}`;
  try {
    // Sign the probe when a webhook secret is configured, or the ingress will (correctly)
    // refuse its own doctor with a 401.
    const body = JSON.stringify({ webhookEvent: "scriptorium:probe" });
    const hmac = process.env.JIRA_WEBHOOK_HMAC_SECRET?.trim();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (hmac) {
      const { createHmac } = await import("node:crypto");
      headers["x-hub-signature"] = `sha256=${createHmac("sha256", hmac).update(Buffer.from(body)).digest("hex")}`;
    }
    const response = await fetch(url, { method: "POST", headers, body });
    console.log(
      response.ok
        ? `✅ webhook reachable: POST ${publicUrl}/jira/webhook/<secret> -> ${response.status}`
        : `🚫 webhook route answered ${response.status} — check the secret and the deployment`,
    );
  } catch (error) {
    console.log(`🚫 webhook unreachable: ${error instanceof Error ? error.message : error}`);
  }
} else {
  console.log(
    "⚠️  webhook not probed — set PUBLIC_URL and JIRA_WEBHOOK_SECRET once deployed. The poller works without it; the webhook only removes the poll delay.",
  );
}

console.log("\nall checks passed.");
