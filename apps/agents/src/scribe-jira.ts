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
import { publishApprovedDoc } from "./docs-repo";
import { announceDraftForApproval, announcePublished } from "./slack-notify";
import {
  issueStatus,
  jiraClient,
  JiraState,
  jiraToMarkdown,
  markdownToJira,
  parseCommand,
  splitAtLastOwnComment,
  type JiraAttachment,
  type JiraClient,
  type JiraComment,
  type JiraIssue,
  type IssueState,
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
 *
 * Two modes, decided by the auto-draft label (`JIRA_LABEL`), not by the query:
 * - **labelled** — the ticket is a doc request: greet it and draft from the PRD unasked;
 * - **unlabelled** — mention-only: adopt it silently and never spend an LLM call until a
 *   human says the agent's name or types a command. The poller watches the whole project
 *   so that a mention is never met with silence, which is the one unforgivable failure.
 */

interface Ctx {
  config: AppConfig;
  vault: Vault;
  client: JiraClient;
  state: JiraState;
  botAccountId: string;
  /** Per-issue serialisation — see withIssueLock. */
  locks: Map<string, Promise<unknown>>;
}

/**
 * One issue is worked by one caller at a time.
 *
 * The ledger makes at-least-once *delivery* safe, but drafting is check-then-act: read
 * `hasDraft`, make a slow model call, write `hasDraft`. Two entrants both pass the check
 * and both draft. That is not theoretical — a webhook nudge and a poll tick hit the same
 * ticket seconds apart and posted two drafts and two attachments, because the poll loop's
 * in-flight flag never covered the webhook path. Serialise per issue key so the second
 * caller runs after the first and sees the state it wrote.
 */
async function withIssueLock<T>(ctx: Ctx, key: string, work: () => Promise<T>): Promise<T> {
  const previous = ctx.locks.get(key) ?? Promise.resolve();
  const run = previous.then(work, work);
  // Keep a non-rejecting tail in the map so one failure cannot poison the queue.
  ctx.locks.set(
    key,
    run.catch(() => undefined),
  );
  try {
    return await run;
  } finally {
    if (ctx.locks.get(key) === run || (await ctx.locks.get(key)) === undefined) ctx.locks.delete(key);
  }
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
  "- **@ me** — mention me on any ticket in this project and I'll answer, drafted or not",
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

/** The label is the auto-draft trigger: with it, the agent drafts unasked; without it, only on request. */
function autoDrafts(ctx: Ctx, issue: JiraIssue): boolean {
  const label = ctx.config.jira.label.toLowerCase();
  return (issue.fields.labels ?? []).some((candidate) => candidate.toLowerCase() === label);
}

/** Is the agent part of this ticket yet? Until it is, plain feedback here is not addressed to it. */
function engaged(known: IssueState | undefined): boolean {
  return Boolean(known?.engaged || known?.hasDraft || known?.publishedPath);
}

const DRAFT_ATTACHMENT = /^draft-(.+)\.md$/i;

/**
 * The draft the agent last attached, newest first — the only durable record of a draft
 * that lives outside the gitignored state directory, and therefore what a restart with a
 * lost ledger reconstructs from.
 */
function lastDraftAttachment(issue: JiraIssue): { attachment: JiraAttachment; slug: string } | undefined {
  return (issue.fields.attachment ?? [])
    .flatMap((attachment) => {
      const slug = attachment.filename.match(DRAFT_ATTACHMENT)?.[1];
      return slug ? [{ attachment, slug }] : [];
    })
    .sort((a, b) => (b.attachment.created ?? "").localeCompare(a.attachment.created ?? ""))[0];
}

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

/**
 * Move the ticket along the board, best-effort.
 *
 * The columns carry the state a reader cares about — working, waiting on me, done — so the
 * agent drives them rather than leaving everything in To Do and narrating only in comments.
 * Silent when the workflow has no such status: a board the agent cannot drive is a smaller
 * failure than a publish that refuses because a column is missing. `lastStatus` is patched
 * so the poller does not read the agent's own move as a human decision.
 */
async function moveTo(ctx: Ctx, key: string, statusName: string, currentStatus?: string): Promise<void> {
  if (!statusName || currentStatus?.toLowerCase() === statusName.toLowerCase()) return;
  try {
    const moved = await ctx.client.transitionTo(key, statusName);
    if (moved) await ctx.state.patch(key, { lastStatus: statusName });
    // A workflow that does not offer the column is a legitimate configuration, but silence
    // here is indistinguishable from success — and a board that never moves looks like the
    // agent is inert rather than like the project is missing a status.
    else console.warn(`[scribe] ${key}: workflow offers no transition to "${statusName}" from "${currentStatus ?? "its current status"}"`);
  } catch (error) {
    console.warn(`[scribe] ${key}: could not move to "${statusName}": ${errorMessage(error)}`);
  }
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

  // Working: say so on the board before the slow part, not after.
  await moveTo(ctx, key, ctx.config.jira.inProgressStatus, issueStatus(issue));

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
  // A draft exists and the next move is a human's.
  await moveTo(ctx, key, ctx.config.jira.inReviewStatus);

  await announceDraftForApproval(ctx.config, {
    issueKey: key,
    issueUrl: ctx.client.issueUrl(key),
    feature,
    lintSummary: formatLintFindings(result.lint).split("\n").join(" · "),
    appliedLessons: result.appliedLessons,
  });

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
    // Feedback before there is anything to revise — read it as "get started". Forced,
    // because the state may legitimately claim `hasDraft` (reconstructed from the
    // ticket's own attachment after a restart) while the local copy is gone: an
    // unforced runDraft would then return early and answer nothing at all.
    await runDraft(ctx, issue, { force: true });
    return;
  }
  if (!ctx.config.hasModelAccess) {
    await say(ctx, key, "⚠️ No model provider is configured on the agent host, so I can't revise yet.");
    return;
  }

  await moveTo(ctx, key, ctx.config.jira.inProgressStatus, issueStatus(issue));

  const result = await reviseDoc(ctx.vault, draft, feedback);
  await ctx.state.saveDraft(key, result.markdown);
  await moveTo(ctx, key, ctx.config.jira.inReviewStatus);
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

/**
 * Someone said the agent's name. This path must never end in silence — that is the whole
 * reason the poller looks at unlabelled tickets at all.
 *
 * With no draft yet, the answer is an attempt: `runDraft` either posts a draft or names
 * exactly what it is missing (no PRD, or the contract fields it refuses to guess). With a
 * draft already on the ticket, the answer is where things stand and what to type next.
 */
async function runWake(ctx: Ctx, issue: JiraIssue): Promise<void> {
  const key = issue.key;
  const known = ctx.state.get(key);
  // The mention is the invitation: from here on this ticket is a conversation the agent
  // is in, so plain feedback that follows applies even without the auto-draft label.
  await ctx.state.patch(key, { engaged: true });

  if (known?.publishedPath) {
    await say(
      ctx,
      key,
      `I'm here. This ticket is already published to \`${known.publishedPath}\` — send feedback and comment \`draft\` if you want another revision, or \`help\` for the whole vocabulary.`,
    );
    return;
  }

  if (known?.hasDraft) {
    await say(
      ctx,
      key,
      [
        `I'm here. There's a draft on this ticket already (attached as \`draft-${known.docSlug ?? slugify(issue.fields.summary)}.md\`).`,
        "",
        "Send feedback in plain English and I'll revise it, or comment `approve` to publish it to the vault. `help` lists everything.",
      ].join("\n"),
    );
    return;
  }

  // A human asked, so re-answer even if the same contract gap was reported before:
  // `askedForFields` exists to stop the poller repeating itself, not to stop the agent
  // replying to a person.
  await ctx.state.patch(key, { askedForFields: [] });
  await runDraft(ctx, issue, { force: true });
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
  // But "published to the vault" and "pushed to the docs repo" are different facts, and
  // when the second failed, approving again has to retry it rather than report success.
  const alreadyPublished = Boolean(known?.publishedPath);
  if (alreadyPublished && known?.docsPushed) {
    if (!options.quietWhenPublished) {
      await say(ctx, key, `Already published to \`${known.publishedPath}\`. Comment \`draft\` to start a new revision.`);
    }
    return;
  }

  // Approving with nothing to publish is never silent: a reviewer whose first move is
  // dragging the ticket to Approved must be told why nothing happened.
  let relPath = known?.publishedPath;

  if (alreadyPublished && relPath) {
    await say(ctx, key, `The vault copy of \`${relPath}\` is already published — retrying the docs-repo push only.`);
  } else {
    const draft = await ctx.state.readDraft(key);
    if (!draft) {
      await say(
        ctx,
        key,
        "I have no draft on this ticket yet, so there is nothing to publish. Attach the PRD as a `.md` file and comment `draft`.",
      );
      return;
    }
    relPath = await publishDoc({
    vault: ctx.vault,
    auditFile: ctx.config.auditFile,
    repoRoot: ctx.config.repoRoot,
    markdown: draft,
    approvedBy,
    sourcePrd: known?.sourcePrd,
    appliedLessons: known?.appliedLessons,
    slug: known?.docSlug,
    // The join key for the GitHub -> Jira round trip. Without it a human edit to a
    // published doc has no ticket to be reported on.
    jiraIssue: key,
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
  }

  // Egress: push the allowlisted trees to the docs repo and open the PR whose merge
  // publishes. Never fatal — a doc approved in Jira and written to the vault stays
  // approved and written even if GitHub is unreachable.
  try {
    const outcome = await publishApprovedDoc(ctx.config, ctx.vault, {
      issueKey: key,
      issueUrl: ctx.client.issueUrl(key),
      slug: known?.docSlug ?? relPath.replace(/^docs\//, "").replace(/\.md$/, ""),
      relPath,
      approvedBy,
      appliedLessons: known?.appliedLessons,
    });
    await say(ctx, key, outcome.comment);
    // Only a real push clears the retry flag; a refusal or a conflict must stay retryable.
    if (outcome.published) await ctx.state.patch(key, { docsPushed: true });
    await audit(ctx.config.auditFile, {
      type: outcome.published ? "docs.pushed" : "docs.push.refused",
      actor: approvedBy,
      issue: key,
      relPath,
      pullRequest: outcome.pullRequestUrl,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The ticket gets the first line; the logs get all of it. Reporting a production
    // failure only into a Jira comment left nothing to diagnose from.
    console.warn(`[scribe] ${key}: docs-repo push failed:\n${message}`);
    await say(
      ctx,
      key,
      `⚠️ Published to the vault, but pushing to the docs repo failed:\n\n\`${message.split("\n")[0]}\`\n\nComment \`approve\` again to retry the push — the vault copy stays published.`,
    );
  }

  // Above the early return, and deliberately: the column has to be true on *every* path
  // that ends with the doc published and pushed. A push-only retry is the case where the
  // board is most likely to be stale — the ticket went back through In Progress and In
  // Review for the revision that preceded it — so skipping the move here left a published,
  // pushed doc sitting in In Review with nothing left to review.
  await moveTo(ctx, key, ctx.config.jira.approvedStatus, issueStatus(issue));

  // The announcement and the lesson proposal are a different matter: those already
  // happened on the first approval, and doing them twice is noise, not honesty.
  if (alreadyPublished) return;

  await announcePublished(ctx.config, {
    relPath,
    feature: known?.docSlug ?? relPath,
    issueKey: key,
    issueUrl: ctx.client.issueUrl(key),
    approvedBy,
    appliedLessons: known?.appliedLessons,
  });

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

/** Rebuild what the ledger lost from the evidence that outlives it: the ticket itself and the vault. */
async function recoverState(ctx: Ctx, issue: JiraIssue): Promise<IssueState> {
  const key = issue.key;
  const attached = lastDraftAttachment(issue);
  // The inputs it has already judged. Without this the tail retry re-posts NO_PRD or the
  // same contract questions on a ticket it greeted but could not draft — a duplicate, not
  // a retry. A wake still answers (it forces the draft), and if the PRD actually changed
  // during the downtime the fingerprint differs and the retry happens by itself.
  const patch: Partial<IssueState> = { engaged: true, sourceFingerprint: sourceFingerprint(issue) };

  if (attached) {
    patch.hasDraft = true;
    patch.docSlug = attached.slug;
    patch.sourcePrd = `prd/${attached.slug}`;
    const published = `docs/${attached.slug}.md`;
    if (await ctx.vault.exists(published)) patch.publishedPath = published;
    try {
      // Pull the markdown back down so the next feedback revises the draft the reviewer
      // can actually see, rather than quietly starting a different one.
      const bytes = await ctx.client.downloadAttachment(attached.attachment);
      await ctx.state.saveDraft(key, bytes.toString("utf8"));
    } catch {
      // The attachment is still proof that a draft exists; runRevise force-drafts when the
      // local copy is missing, so a failed download degrades to a redraft, not to silence.
    }
  }
  return ctx.state.patch(key, patch);
}

/**
 * First sight of a ticket — three cases, and the difference between them is this step.
 *
 * `handled` means the ticket is finished for this poll; otherwise the caller runs the
 * normal comment loop over whatever was left unprocessed.
 */
async function firstSight(ctx: Ctx, issue: JiraIssue, status: string): Promise<{ known: IssueState; handled: boolean }> {
  const key = issue.key;
  const history = await ctx.client.listComments(key);
  const seeded = await ctx.state.seed(key, status);
  const { history: settled, unprocessed } = splitAtLastOwnComment(history, ctx.botAccountId);

  // (1) The agent has comments here: this is a restart on a ticket it already worked, not
  // a new ticket. Reconstruct instead of re-greeting and re-drafting, and apply the
  // downtime rule — everything up to its own last word is history, everything after it
  // still needs answering.
  if (settled.length) {
    await ctx.state.markProcessed(key, settled.map((comment) => comment.id));
    const known = await recoverState(ctx, issue);
    console.log(`[scribe] ${key}: adopted after a restart, ${unprocessed.length} comment(s) to catch up on`);
    return { known, handled: false };
  }

  // (2) Labelled: a doc request. Greet it and draft from the PRD. The whole thread counts
  // as history because the greeting plus a draft already answers anything it asked.
  if (autoDrafts(ctx, issue)) {
    await ctx.state.markProcessed(key, history.map((comment) => comment.id));
    await say(ctx, key, `${HELP}\n\nReading this ticket now…`);
    await runDraft(ctx, issue);
    const known = await ctx.state.patch(key, { lastStatus: status, lastUpdated: issue.fields.updated, lastError: undefined });
    return { known, handled: true };
  }

  // (3) Unlabelled: mention-only. Adopt in silence — no comment, no draft, no LLM call on
  // a ticket nobody pointed at the agent. The existing comments stay unprocessed on
  // purpose: with no comment of its own there is no cutoff, so a `@Scribe` typed before
  // the agent ever polled still gets an answer. Plain feedback among them is dropped by
  // the not-engaged gate in the loop.
  console.log(`[scribe] ${key}: adopted quietly — no "${ctx.config.jira.label}" label, so mention-only`);
  return { known: seeded, handled: false };
}

async function handleIssue(ctx: Ctx, issue: JiraIssue): Promise<void> {
  const key = issue.key;
  const status = issueStatus(issue);
  const seen = ctx.state.get(key);

  let known: IssueState;
  if (seen) {
    known = seen;
  } else {
    const adopted = await firstSight(ctx, issue, status);
    if (adopted.handled) return;
    known = adopted.known;
  }

  const untouched = known.lastUpdated && known.lastUpdated === issue.fields.updated && known.lastStatus === status;
  if (untouched) return;

  const autoDraft = autoDrafts(ctx, issue);
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
    // `hasDraft` is read fresh: a draft posted earlier in this same batch changes what a
    // mention means, and the parser needs the current answer, not the one from the top.
    const command = parseCommand(comment, ctx.botAccountId, { hasDraft: Boolean(ctx.state.get(key)?.hasDraft) });
    await ctx.state.markProcessed(key, [comment.id]);

    // Someone else's conversation: on a mention-only ticket the agent has never taken part
    // in, plain prose is people talking to each other and must not trigger a revise.
    // Commands and mentions still act — being answerable is the reason for watching at all.
    if (command.kind === "feedback" && !autoDraft && !engaged(ctx.state.get(key))) continue;

    // Anything explicit — a mention or a typed command — makes this a thread the agent is
    // in, so the plain-English feedback that follows applies even without the label. It has
    // to be recorded even when the command produced no draft (a PRD-less `draft`, say),
    // or the follow-up that supplies the PRD would be dropped as someone else's talk.
    if (command.kind !== "feedback" && command.kind !== "ignore") await ctx.state.patch(key, { engaged: true });

    switch (command.kind) {
      case "ignore":
        break;
      case "wake":
        await flushFeedback();
        await runWake(ctx, issue);
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

  // Inputs may have arrived after the first look — retry only when they actually changed,
  // and only where a draft was asked for: either the label requests one standing, or a
  // human already engaged the agent here. Never on a quietly adopted ticket.
  const wanted = autoDraft || engaged(ctx.state.get(key));
  if (wanted && !ctx.state.get(key)?.hasDraft) await runDraft(ctx, issue);

  const approvedStatus = ctx.config.jira.approvedStatus.toLowerCase();
  const movedToApproved = status.toLowerCase() === approvedStatus && (known.lastStatus ?? "").toLowerCase() !== approvedStatus;
  // A transition is only an approval of work the agent is part of; on a ticket it was
  // never asked to touch, someone else's workflow move is not a publish instruction.
  if (movedToApproved && wanted) {
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

/**
 * What the poller hands back. `nudge` is the seam the webhook uses: same handler, same
 * ledger, same state — the webhook is a latency optimisation, not a second code path.
 */
export interface ScribeJiraHandle {
  stop(): void;
  /** Work one issue now, by key. Re-fetches from the API; never trusts a webhook body. */
  nudge(issueKey: string): Promise<void>;
  /** Post a comment on a ticket from outside the poller (e.g. a GitHub event). */
  comment(issueKey: string, markdown: string): Promise<void>;
  /** Approve and publish from another surface (e.g. a Slack button). Same gate, second doorway. */
  approve(issueKey: string, approvedBy: string): Promise<void>;
}

export async function startScribeJira(config: AppConfig, vault: Vault): Promise<ScribeJiraHandle> {
  const client = jiraClient(config.jira);
  const me = await client.myself();
  const state = await JiraState.open(config.jira.stateDir);
  const ctx: Ctx = { config, vault, client, state, botAccountId: me.accountId, locks: new Map() };
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
          await withIssueLock(ctx, issue.key, () => handleIssue(ctx, issue));
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

  return {
    stop: () => clearInterval(timer),
    async nudge(issueKey: string): Promise<void> {
      // Re-fetch rather than believe the event: the payload is untrusted input, and by the
      // time we look the ticket may have moved on anyway.
      const issue = await client.getIssue(issueKey);
      try {
        // Same lock as the poller: a webhook is a faster trigger, not a second worker.
        await withIssueLock(ctx, issueKey, () => handleIssue(ctx, issue));
      } catch (error) {
        console.warn(`[scribe] ${issueKey} (webhook): ${errorMessage(error)}`);
        await reportFailure(ctx, issue, error);
      }
    },
    async comment(issueKey: string, markdown: string): Promise<void> {
      await say(ctx, issueKey, markdown);
    },
    async approve(issueKey: string, approvedBy: string): Promise<void> {
      // Re-fetch, then take the exact path an `approve` comment takes — including the
      // fail-closed checks. A button must not be a shortcut around any of them.
      const issue = await client.getIssue(issueKey);
      await runPublish(ctx, issue, approvedBy);
    },
  };
}
