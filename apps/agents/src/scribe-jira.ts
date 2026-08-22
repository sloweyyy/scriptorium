import fs from "node:fs/promises";
import path from "node:path";
import {
  audit,
  commitVault,
  defaultJql,
  parseMarkdown,
  slugify,
  type AppConfig,
  type ImageInput,
  type Vault,
} from "@scriptorium/core";
import { organizePublishedDoc } from "@scriptorium/curator";
import {
  issueStatus,
  jiraClient,
  JiraState,
  jiraToMarkdown,
  markdownToJira,
  parseCommand,
  type JiraClient,
  type JiraComment,
  type JiraIssue,
} from "@scriptorium/jira";
import {
  approveLesson,
  checkContract,
  distillLesson,
  draftDoc,
  formatContractQuestions,
  formatLintFindings,
  lintOk,
  listLessons,
  publishDoc,
  reviseDoc,
  saveLesson,
} from "@scriptorium/scribe";

/**
 * Scribe on Jira — Agent A's primary surface.
 *
 * The ticket is the thread: description + attachments are the input, comments are the
 * conversation, and the workflow transition (or an `approve` comment) is the human gate.
 * Transport is polling, so the agent runs anywhere without a public endpoint; nothing
 * else about the pipeline changes — contract → draft → lint → revise → publish is the
 * same code the CLI and Slack call.
 */

interface Ctx {
  config: AppConfig;
  vault: Vault;
  client: JiraClient;
  state: JiraState;
  botAccountId: string;
}

const VISION_TYPES: Record<string, ImageInput["mediaType"]> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/webp": "image/webp",
  "image/gif": "image/gif",
};

const PRD_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);

const HELP = [
  "**Scribe** — I draft user documentation from the PRD on this ticket. A human approves everything I publish.",
  "",
  "How to work with me, all from this comment box:",
  "- **feedback** — just write it in plain English; I revise the draft and post it again",
  "- `approve` — publish the current draft to the knowledge vault (or move this issue to the approved status)",
  "- `approve lesson L-001` — turn feedback into a house rule that shapes every future draft",
  "- `reject lesson L-001` — discard the proposed rule",
  "- `draft` — start over from the PRD",
  "- `help` — this message",
].join("\n");

const NO_PRD = [
  "**I can't find a PRD on this ticket.**",
  "",
  "Give me one of these, then comment `draft`:",
  "- attach the PRD as a `.md` file (best fidelity), or",
  "- paste the PRD into the issue description.",
  "",
  "It must carry YAML frontmatter with `feature`, `audience` and `user_goal` — I refuse to guess those.",
  "Wireframes help: attach them as PNG, JPEG, WEBP or GIF and I will read them.",
].join("\n");

/**
 * What the ticket offered as input last time. Re-drafting is driven off this, so the
 * agent retries by itself when the PM finally attaches the PRD — and stays quiet when
 * the only thing that changed is its own comment.
 */
function sourceFingerprint(issue: JiraIssue): string {
  const attachments = (issue.fields.attachment ?? []).map((attachment) => attachment.id).sort();
  return `${attachments.join(",")}|${issue.fields.description?.trim().length ?? 0}`;
}

function authorName(comment: JiraComment): string {
  return comment.author?.displayName ?? comment.author?.accountId ?? "a Jira user";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Post a markdown comment as Jira wiki markup, and remember it so it never reads as feedback. */
async function say(ctx: Ctx, key: string, markdown: string): Promise<void> {
  const comment = await ctx.client.addComment(key, markdownToJira(markdown));
  await ctx.state.markProcessed(key, [comment.id]);
}

interface PrdSource {
  markdown?: string;
  origin?: string;
  images: ImageInput[];
  imageNames: string[];
  skipped: string[];
}

/** Read the PRD and designs off the ticket: attachments first, description as the fallback. */
async function loadSource(ctx: Ctx, issue: JiraIssue): Promise<PrdSource> {
  const source: PrdSource = { images: [], imageNames: [], skipped: [] };

  for (const attachment of issue.fields.attachment ?? []) {
    const mediaType = VISION_TYPES[attachment.mimeType?.toLowerCase() ?? ""];
    if (mediaType) {
      const bytes = await ctx.client.downloadAttachment(attachment);
      source.images.push({ mediaType, base64: bytes.toString("base64") });
      source.imageNames.push(attachment.filename);
      continue;
    }
    if (!source.markdown && PRD_EXTENSIONS.has(path.extname(attachment.filename).toLowerCase())) {
      const bytes = await ctx.client.downloadAttachment(attachment);
      source.markdown = bytes.toString("utf8");
      source.origin = `the attachment \`${attachment.filename}\``;
      continue;
    }
    source.skipped.push(attachment.filename);
  }

  if (!source.markdown) {
    const description = issue.fields.description?.trim();
    if (description) {
      // Jira's editor rewrites pasted markdown as wiki markup — put it back before the contract check.
      source.markdown = jiraToMarkdown(description);
      source.origin = "the issue description";
    }
  }
  return source;
}

/**
 * Hand the inputs to Agent B: PRD and designs land in `_inbox`, where Curator's watcher
 * files and links them. Agent A's ticket becomes Agent B's knowledge without a second copy.
 */
async function seedVault(ctx: Ctx, slug: string, feature: string, source: PrdSource, issueKey: string): Promise<void> {
  if (source.markdown) {
    // Written through the vault with `kind: prd` set explicitly: the organizer would
    // otherwise fall back to heuristics and could file a PRD into docs/, colliding with
    // the very note publishDoc writes on approval.
    const { frontmatter, body } = parseMarkdown(source.markdown);
    await ctx.vault.writeNote(`_inbox/${slug}.md`, body, {
      ...frontmatter,
      kind: "prd",
      feature,
      jira_issue: issueKey,
      source_ticket: ctx.client.issueUrl(issueKey),
    });
  }
  for (const [index, image] of source.images.entries()) {
    const name = source.imageNames[index] ?? `${slug}-design-${index + 1}.png`;
    await fs.writeFile(ctx.vault.abs(`_inbox/${name}`), Buffer.from(image.base64, "base64"));
  }
}

function draftComment(input: {
  markdown: string;
  lintReport: string;
  appliedLessons: string[];
  source: PrdSource;
  revision: boolean;
}): string {
  const provenance = [
    `Drafted from ${input.source.origin ?? "the ticket"}`,
    input.source.images.length ? `${input.source.images.length} design image(s)` : undefined,
  ]
    .filter(Boolean)
    .join(", ");

  return [
    input.revision ? "**Revised draft**" : "**Draft ready**",
    "",
    `${provenance}.`,
    `Lint: ${input.lintReport.split("\n").join(" · ")}`,
    `House rules applied: ${input.appliedLessons.join(", ") || "none yet"}`,
    input.source.skipped.length
      ? `Skipped attachments (not a PRD or a readable image): ${input.source.skipped.join(", ")}`
      : "",
    "",
    "---",
    "",
    input.markdown.trim(),
    "",
    "---",
    "",
    "Reply with feedback in plain English and I'll revise, or comment `approve` to publish it to the vault.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

async function runDraft(ctx: Ctx, issue: JiraIssue, options: { force?: boolean } = {}): Promise<void> {
  const key = issue.key;
  const known = ctx.state.get(key);
  const fingerprint = sourceFingerprint(issue);
  if (!options.force && (known?.hasDraft || known?.sourceFingerprint === fingerprint)) return;
  // Recorded before the work, so a ticket with no usable PRD is told once, not every poll.
  await ctx.state.patch(key, { sourceFingerprint: fingerprint });

  if (!ctx.config.hasModelAccess) {
    await say(ctx, key, "⚠️ No model provider is configured on the agent host, so I can't draft yet.");
    return;
  }

  const source = await loadSource(ctx, issue);
  if (!source.markdown?.trim()) {
    await say(ctx, key, NO_PRD);
    return;
  }

  const contract = checkContract(source.markdown);
  if (!contract.ok) {
    const missing = contract.missing.map((field) => field.key);
    // Ask once per distinct gap — re-asking the same three questions every poll is noise.
    if ((known?.askedForFields ?? []).join(",") !== missing.join(",")) {
      await say(
        ctx,
        key,
        [
          "**I can't draft from this PRD yet.** It's missing the fields I refuse to guess:",
          "",
          formatContractQuestions(contract),
          "",
          `Add them to the YAML frontmatter in ${source.origin ?? "the PRD"} and comment \`draft\`.`,
        ].join("\n"),
      );
      await ctx.state.patch(key, { askedForFields: missing });
      await audit(ctx.config.auditFile, { type: "jira.contract.rejected", actor: "scribe", issue: key, missing });
    }
    return;
  }

  const feature = String(contract.frontmatter.feature ?? issue.fields.summary);
  const slug = slugify(feature);
  await seedVault(ctx, slug, feature, source, key);

  let result = await draftDoc(ctx.vault, source.markdown, source.images);
  if (!lintOk(result.lint)) {
    // Deterministic checks get one machine round-trip before a human is asked to read anything.
    result = await reviseDoc(
      ctx.vault,
      result.markdown,
      result.lint.map((finding) => `[${finding.code}] ${finding.message}`),
    );
  }

  await ctx.state.saveDraft(key, result.markdown);
  await ctx.state.patch(key, {
    hasDraft: true,
    docSlug: slug,
    sourcePrd: `prd/${slug}`,
    appliedLessons: result.appliedLessons,
    askedForFields: [],
  });

  await ctx.client.uploadAttachment(key, `draft-${slug}.md`, result.markdown, "text/markdown");
  await say(
    ctx,
    key,
    draftComment({
      markdown: result.markdown,
      lintReport: formatLintFindings(result.lint),
      appliedLessons: result.appliedLessons,
      source,
      revision: false,
    }),
  );
  await audit(ctx.config.auditFile, {
    type: "jira.draft.posted",
    actor: "scribe",
    issue: key,
    slug,
    appliedLessons: result.appliedLessons,
    lint: result.lint.map((finding) => finding.code),
  });
}

async function runRevise(ctx: Ctx, issue: JiraIssue, feedback: string[]): Promise<void> {
  const key = issue.key;
  const draft = await ctx.state.readDraft(key);
  if (!draft) {
    // Feedback before there is anything to revise — read it as "get started".
    await runDraft(ctx, issue);
    return;
  }
  if (!ctx.config.hasModelAccess) {
    await say(ctx, key, "⚠️ No model provider is configured on the agent host, so I can't revise yet.");
    return;
  }

  const result = await reviseDoc(ctx.vault, draft, feedback);
  await ctx.state.saveDraft(key, result.markdown);
  for (const item of feedback) await ctx.state.appendFeedback(key, item);

  const known = ctx.state.get(key);
  const slug = known?.docSlug ?? slugify(issue.fields.summary);
  await ctx.client.uploadAttachment(key, `draft-${slug}.md`, result.markdown, "text/markdown");
  await say(
    ctx,
    key,
    draftComment({
      markdown: result.markdown,
      lintReport: formatLintFindings(result.lint),
      appliedLessons: result.appliedLessons,
      source: { images: [], imageNames: [], skipped: [], origin: `${feedback.length} comment(s) of feedback` },
      revision: true,
    }),
  );
  await audit(ctx.config.auditFile, { type: "jira.draft.revised", actor: "scribe", issue: key, feedback });
}

async function proposeLesson(ctx: Ctx, key: string, approvedBy: string): Promise<void> {
  const known = ctx.state.get(key);
  const feedback = known?.feedback ?? [];
  if (!feedback.length || !ctx.config.hasModelAccess) return;

  const rule = await distillLesson(feedback.join("\n"));
  if (!rule) {
    await say(ctx, key, "_Nothing here generalizes — the feedback was specific to this document, so I'm not proposing a rule._");
    return;
  }

  const lesson = await saveLesson(ctx.vault, {
    text: rule,
    author: approvedBy,
    sourceThread: ctx.client.issueUrl(key),
    status: "proposed",
  });
  await ctx.state.patch(key, { pendingLessonId: lesson.id });
  await audit(ctx.config.auditFile, { type: "lesson.proposed", actor: "scribe", issue: key, id: lesson.id, text: rule });

  await say(
    ctx,
    key,
    [
      `**Proposed house rule ${lesson.id}** — from your feedback on this ticket:`,
      "",
      `> ${rule}`,
      "",
      `Comment \`approve lesson ${lesson.id}\` and it applies to every future draft; \`reject lesson ${lesson.id}\` and I forget it.`,
      "It stays a proposal until you say so — the system doesn't get to decide what it learns.",
    ].join("\n"),
  );
}

async function runPublish(
  ctx: Ctx,
  issue: JiraIssue,
  approvedBy: string,
  options: { quietWhenPublished?: boolean } = {},
): Promise<void> {
  const key = issue.key;
  const known = ctx.state.get(key);

  // Approving twice (comment then transition, or the reverse) is normal — say nothing.
  if (known?.publishedPath) {
    if (!options.quietWhenPublished) {
      await say(ctx, key, `Already published to \`${known.publishedPath}\`. Comment \`draft\` to start a new revision.`);
    }
    return;
  }

  // Approving with nothing to publish is never silent: a reviewer whose first move is
  // dragging the ticket to Approved must be told why nothing happened.
  const draft = await ctx.state.readDraft(key);
  if (!draft) {
    await say(
      ctx,
      key,
      "I have no draft on this ticket yet, so there is nothing to publish. Attach the PRD as a `.md` file and comment `draft`.",
    );
    return;
  }

  const relPath = await publishDoc({
    vault: ctx.vault,
    auditFile: ctx.config.auditFile,
    repoRoot: ctx.config.repoRoot,
    markdown: draft,
    approvedBy,
    sourcePrd: known?.sourcePrd,
    appliedLessons: known?.appliedLessons,
    slug: known?.docSlug,
  });
  await organizePublishedDoc(ctx.vault, relPath);
  await ctx.state.patch(key, { publishedPath: relPath });

  await say(
    ctx,
    key,
    [
      `**Published** — approved by ${approvedBy}.`,
      "",
      `- Vault note: \`${relPath}\``,
      "- Curator has cross-linked it to the PRD and refreshed `index.md`",
      "- Committed to git with the approver recorded — that commit is the audit trail",
      "",
      "Ask Curator about it in Slack; it will answer from this note and cite it.",
    ].join("\n"),
  );

  // Keep the board honest when the approval arrived as a comment.
  if (issueStatus(issue).toLowerCase() !== ctx.config.jira.approvedStatus.toLowerCase()) {
    const moved = await ctx.client.transitionTo(key, ctx.config.jira.approvedStatus).catch(() => false);
    if (moved) await ctx.state.patch(key, { lastStatus: ctx.config.jira.approvedStatus });
  }

  await proposeLesson(ctx, key, approvedBy);
}

async function runLessonDecision(
  ctx: Ctx,
  key: string,
  decision: "approve" | "reject",
  explicitId: string | undefined,
  actor: string,
): Promise<void> {
  const known = ctx.state.get(key);
  const id = explicitId ?? known?.pendingLessonId;
  if (!id) {
    await say(ctx, key, "I don't have a lesson pending on this ticket. Lessons are proposed right after a doc is published.");
    return;
  }

  if (decision === "approve") {
    const lesson = await approveLesson(ctx.vault, id, actor);
    if (!lesson) {
      await say(ctx, key, `I can't find lesson \`${id}\` in the vault.`);
      return;
    }
    await audit(ctx.config.auditFile, { type: "lesson.approved", actor, issue: key, id, relPath: lesson.relPath });
    await commitVault(ctx.config.repoRoot, `lessons: approve ${id} (approved by ${actor})`);
    await ctx.state.patch(key, { pendingLessonId: undefined });
    await say(
      ctx,
      key,
      [
        `**Lesson ${id} approved** by ${actor} — it now applies to every future draft.`,
        "",
        `It is a file (\`${lesson.relPath}\`) with provenance, not a weight: readable, revocable by deleting it, and versioned in git.`,
      ].join("\n"),
    );
    return;
  }

  const lesson = (await listLessons(ctx.vault)).find((candidate) => candidate.id === id);
  if (!lesson) {
    await say(ctx, key, `I can't find lesson \`${id}\` in the vault.`);
    return;
  }
  await ctx.vault.deleteFile(lesson.relPath);
  await audit(ctx.config.auditFile, { type: "lesson.rejected", actor, issue: key, id, relPath: lesson.relPath });
  await commitVault(ctx.config.repoRoot, `lessons: reject ${id} (rejected by ${actor})`);
  await ctx.state.patch(key, { pendingLessonId: undefined });
  await say(ctx, key, `**Lesson ${id} rejected** by ${actor} — deleted from the vault. Nothing was learned from it.`);
}

async function handleIssue(ctx: Ctx, issue: JiraIssue): Promise<void> {
  const key = issue.key;
  const status = issueStatus(issue);
  const known = ctx.state.get(key);

  if (!known) {
    // First sight: adopt the issue where it stands. Existing comments are history, not
    // instructions, and an issue already sitting in the approved column is not a new approval.
    const history = await ctx.client.listComments(key);
    await ctx.state.seed(key, status);
    await ctx.state.markProcessed(key, history.map((comment) => comment.id));
    await say(ctx, key, `${HELP}\n\nReading this ticket now…`);
    await runDraft(ctx, issue);
    await ctx.state.patch(key, { lastStatus: status, lastUpdated: issue.fields.updated, lastError: undefined });
    return;
  }

  const untouched = known.lastUpdated && known.lastUpdated === issue.fields.updated && known.lastStatus === status;
  if (untouched) return;

  const comments = await ctx.client.listComments(key);
  const pendingFeedback: string[] = [];

  const flushFeedback = async (): Promise<void> => {
    if (!pendingFeedback.length) return;
    const batch = [...pendingFeedback];
    pendingFeedback.length = 0;
    await runRevise(ctx, issue, batch);
  };

  for (const comment of comments) {
    if (ctx.state.isProcessed(key, comment.id)) continue;
    const command = parseCommand(comment, ctx.botAccountId);
    await ctx.state.markProcessed(key, [comment.id]);

    switch (command.kind) {
      case "ignore":
        break;
      case "feedback":
        pendingFeedback.push(command.text);
        break;
      case "help":
        await flushFeedback();
        await say(ctx, key, HELP);
        break;
      case "draft":
        await flushFeedback();
        await runDraft(ctx, issue, { force: true });
        break;
      case "approve-doc":
        await flushFeedback();
        await runPublish(ctx, issue, authorName(comment));
        break;
      case "approve-lesson":
        await flushFeedback();
        await runLessonDecision(ctx, key, "approve", command.id, authorName(comment));
        break;
      case "reject-lesson":
        await flushFeedback();
        await runLessonDecision(ctx, key, "reject", command.id, authorName(comment));
        break;
    }
  }
  await flushFeedback();

  // Inputs may have arrived after the first look — retry only when they actually changed.
  if (!ctx.state.get(key)?.hasDraft) await runDraft(ctx, issue);

  const approvedStatus = ctx.config.jira.approvedStatus.toLowerCase();
  const movedToApproved = status.toLowerCase() === approvedStatus && (known.lastStatus ?? "").toLowerCase() !== approvedStatus;
  if (movedToApproved) {
    const approver = (await ctx.client.lastStatusChangeAuthor(key, ctx.config.jira.approvedStatus)) ?? "a Jira approver";
    await runPublish(ctx, issue, approver, { quietWhenPublished: true });
  }

  const refreshed = await ctx.client.getIssue(key).catch(() => issue);
  await ctx.state.patch(key, {
    lastStatus: issueStatus(refreshed),
    lastUpdated: refreshed.fields.updated,
    lastError: undefined,
  });
}

/** One issue blowing up must never take the poller down — report it on the ticket, once. */
async function reportFailure(ctx: Ctx, issue: JiraIssue, error: unknown): Promise<void> {
  const message = errorMessage(error);
  const known = ctx.state.get(issue.key);
  if (known?.lastError === message) return;
  await ctx.state.patch(issue.key, { lastError: message });
  try {
    await say(ctx, issue.key, `⚠️ I hit an error working this ticket:\n\n{{${message}}}\n\nComment \`draft\` to make me retry.`);
  } catch {
    // Jira itself may be the thing that's down; the log line below is the fallback.
  }
}

export async function startScribeJira(config: AppConfig, vault: Vault): Promise<() => void> {
  const client = jiraClient(config.jira);
  const me = await client.myself();
  const state = await JiraState.open(config.jira.stateDir);
  const ctx: Ctx = { config, vault, client, state, botAccountId: me.accountId };
  const jql = defaultJql(config.jira);

  console.log(`[scribe] 🎫 jira: ${config.jira.baseUrl} as ${me.displayName}, polling every ${Math.round(config.jira.pollMs / 1000)}s`);
  console.log(`[scribe]    jql: ${jql}`);

  let inFlight = false;
  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      for (const issue of await client.searchIssues(jql)) {
        try {
          await handleIssue(ctx, issue);
        } catch (error) {
          console.warn(`[scribe] ${issue.key}: ${errorMessage(error)}`);
          await reportFailure(ctx, issue, error);
        }
      }
    } catch (error) {
      console.warn(`[scribe] poll failed: ${errorMessage(error)}`);
    } finally {
      inFlight = false;
    }
  };

  await tick();
  const timer = setInterval(() => void tick(), config.jira.pollMs);
  return () => clearInterval(timer);
}
