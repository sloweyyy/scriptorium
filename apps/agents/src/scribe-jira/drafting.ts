import { createHash } from "node:crypto";
import { audit, docSlug } from "@scriptorium/core";
import { issueStatus, type JiraIssue } from "@scriptorium/jira";
import {
  checkContract,
  draftDoc,
  formatContractQuestions,
  formatLintFindings,
  lintOk,
  reviseDoc,
  withdrawnLessons,
} from "@scriptorium/scribe";
import { announceDraftForApproval } from "../slack-notify";
import { assignTo, handBack, moveTo, say, type Ctx } from "./context";
import { loadDesignImages, loadSource, seedVault, sourceFingerprint, type PrdSource } from "./source";

/**
 * How long to let an upload settle before drafting from it.
 *
 * Attachments land one at a time: a PM dragging a PRD and two wireframes onto a ticket
 * produces three separate events several seconds apart, and a poll tick that lands in the
 * middle drafts from half an upload — the PRD without its designs, with nothing to say it
 * happened. Measured on the live board: it hit three uploads out of three. Waiting one
 * tick costs 15 seconds; drafting early costs a wrong draft and a human's confusion.
 */
const ATTACHMENT_SETTLE_MS = 25_000;

const NO_PRD = [
  "**I can't find a PRD on this ticket.**",
  "",
  "Give me one of these, then comment `draft`:",
  "- attach the PRD as a `.md` file,",
  "- link the Confluence page that holds it (or paste its URL in the description), or",
  "- write the PRD into the issue description.",
  "",
  "Wherever it lives, it must state `feature`, `audience` and `user_goal` — as YAML frontmatter,",
  "as labeled lines (`audience: workspace admins`), or as headings. I refuse to guess those.",
  "Wireframes help: attach them as PNG, JPEG, WEBP or GIF and I will read them.",
].join("\n");

/**
 * Feedback that is pointing at a picture.
 *
 * The gate for sending designs into a revision, and deliberately conservative: the
 * default stays the old text-only behaviour, and images are added only when a human
 * invoked them. Sending every image on every revision was measurably unsafe — a
 * wireframe of a different feature rewrote a document's entire subject, twice, even
 * with the prompt telling it not to. Over-matching here is harmless (an extra image
 * the model is told to ignore); under-matching costs one `draft` to recover.
 */
const REFERS_TO_DESIGN =
  /\b(image|images|wireframe|wireframes|mock-?up|mock-?ups|design|designs|screenshot|screenshots|screen|figma|attached|attachment)\b/i;

/** Name the designs, and stay one line about it however many there are. */
function describeImages(names: string[]): string {
  const shown = names.slice(0, 3).join(", ");
  const rest = names.length - 3;
  return rest > 0 ? `${shown} +${rest} more` : shown;
}

/** "L-001 ✓, L-002 ✗, L-003 (unchecked)" — applied is not the same as obeyed, so say which. */
export function houseRules(applied: readonly string[], verdicts: ReadonlyArray<{ id: string; verdict: string }> = []): string {
  const mark = (id: string) => {
    const verdict = verdicts.find((candidate) => candidate.id === id)?.verdict;
    return verdict === "honored" ? `${id} ✓` : verdict === "violated" ? `${id} ✗` : `${id} (unchecked)`;
  };
  return applied.map(mark).join(", ");
}

/** What `postedDraftHash` records: the draft's text, as saved (trimmed, like `saveDraft`). */
export function hashDraft(markdown: string): string {
  return createHash("sha256").update(markdown.trim()).digest("hex");
}

/**
 * Jira refuses a comment over 32,767 characters, and it refused the same long draft on
 * every retry. Past this, the comment shows the start and points at the attachment, which
 * always carries the whole draft.
 */
export const DRAFT_COMMENT_CHARS = 24_000;

function draftBody(markdown: string, attachment: string | undefined): string {
  const text = markdown.trim();
  if (text.length <= DRAFT_COMMENT_CHARS) return text;
  return `${text.slice(0, DRAFT_COMMENT_CHARS)}\n\n_… the draft continues: the whole of it is attached as \`${attachment ?? "the draft attachment"}\`. Read it there before approving._`;
}

/**
 * Attach the draft, once. A retry after a failure further on (the comment, say) used to add
 * another `draft-<slug>.md` every attempt. Probed on the ticket itself: when its newest
 * attachment of that name already holds exactly this text, the upload is done.
 */
export async function attachDraft(ctx: Ctx, key: string, filename: string, markdown: string): Promise<void> {
  const newest = await ctx.client
    .getIssue(key)
    .then((fresh) =>
      (fresh.fields.attachment ?? [])
        .filter((attachment) => attachment.filename === filename)
        .sort((a, b) => Date.parse(b.created ?? "") - Date.parse(a.created ?? ""))[0],
    )
    .catch(() => undefined);
  if (newest) {
    // Compared as text, trimmed like every saved draft (see hashDraft).
    const already = await ctx.client.downloadAttachment(newest).catch(() => undefined);
    if (already && already.toString("utf8").trim() === markdown.trim()) return;
  }
  await ctx.client.uploadAttachment(key, filename, markdown, "text/markdown");
}

/**
 * The saved draft never made it onto the ticket (its comment failed to post), so nobody has
 * seen what an approval would publish. Post it now, as it is, and say so.
 */
export async function repostDraft(ctx: Ctx, key: string, markdown: string): Promise<void> {
  const slug = ctx.state.get(key)?.docSlug ?? "doc";
  const attachment = `draft-${slug}.md`;
  await attachDraft(ctx, key, attachment, markdown);
  const posted = await say(
    ctx,
    key,
    [
      "**Draft (posted again)** The latest version didn't reach this ticket earlier, so nothing was published. This is exactly what an approval would publish.",
      "",
      "---",
      "",
      draftBody(markdown, attachment),
      "",
      "---",
      "",
      "Reply with feedback in plain English and I'll revise, or comment `approve` to publish it.",
    ].join("\n"),
  );
  await ctx.state.patch(key, { draftPostedAt: posted.created, postedDraftHash: hashDraft(markdown), draftUnposted: false });
  await audit(ctx.config.auditFile, { type: "jira.draft.reposted", actor: "scribe", issue: key });
}

function draftComment(input: {
  markdown: string;
  lintReport: string;
  appliedLessons: string[];
  lessonVerdicts?: Array<{ id: string; verdict: "honored" | "violated" | "unchecked" }>;
  source: PrdSource;
  revision: boolean;
  attachment?: string;
}): string {
  const provenance = [
    `Drafted from ${input.source.origin ?? "the ticket"}`,
    // Named, not counted. A ticket accumulates mockups, and "2 design image(s)" cannot tell
    // a reviewer that the superseded one is still attached and still being read.
    input.source.images.length ? `designs read: ${describeImages(input.source.imageNames)}` : undefined,
  ]
    .filter(Boolean)
    .join(", ");

  return [
    input.revision ? "**Revised draft**" : "**Draft ready**",
    "",
    `${provenance}.`,
    `Lint: ${input.lintReport.split("\n").join(" · ")}`,
    `House rules applied: ${houseRules(input.appliedLessons, input.lessonVerdicts) || "none yet"}`,
    input.source.skipped.length
      ? `Skipped attachments: ${input.source.skipped.join(", ")}`
      : "",
    "",
    "---",
    "",
    draftBody(input.markdown, input.attachment),
    "",
    "---",
    "",
    "Reply with feedback in plain English and I'll revise, or comment `approve` to publish it to the vault.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export async function runDraft(ctx: Ctx, issue: JiraIssue, options: { force?: boolean } = {}): Promise<void> {
  const key = issue.key;
  const known = ctx.state.get(key);
  const fingerprint = sourceFingerprint(issue, known?.remoteLinkFingerprint);
  if (!options.force && (known?.hasDraft || known?.sourceFingerprint === fingerprint)) return;

  // An upload still in progress is not a PRD yet. The fingerprint is deliberately NOT
  // recorded here, so the next tick — by which time the rest has landed — sees a source it
  // has never drafted from and picks it up by itself. A human typing `draft` overrides:
  // they can see what they attached, and asked for it anyway.
  if (!options.force) {
    const landed = (issue.fields.attachment ?? [])
      .map((attachment) => Date.parse(attachment.created ?? ""))
      .filter((at) => Number.isFinite(at));
    const newest = landed.length ? Math.max(...landed) : 0;
    if (newest && Date.now() - newest < ATTACHMENT_SETTLE_MS) {
      // Flagged, not just skipped: the deferral has to survive the tick that made it.
      await ctx.state.patch(key, { awaitingUpload: true });
      console.log(`[scribe] ${key}: attachments still arriving — waiting for the upload to settle`);
      return;
    }
  }

  // Recorded before the work, so a ticket with no usable PRD is told once, not every poll.
  await ctx.state.patch(key, { sourceFingerprint: fingerprint, awaitingUpload: false });

  if (!ctx.config.hasModelAccess) {
    await say(ctx, key, "⚠️ No model provider is configured on the agent host, so I can't draft yet.");
    return;
  }

  const source = await loadSource(ctx, issue);
  if (!source.markdown?.trim()) {
    await handBack(ctx, key, issue);
    await say(
      ctx,
      key,
      source.confluenceError
        ? "**This ticket points at a Confluence page I can't read** — it may be restricted, or deleted. Grant my account view access to it (or attach the PRD as a `.md` file), then comment `draft`."
        : // Why each file wasn't the PRD: "I can't find a PRD" beside a PRD the PM attached
          // (too long, say) left them nothing to fix.
          [NO_PRD, ...(source.skipped.length ? ["", `Not read: ${source.skipped.join(", ")}`] : [])].join("\n"),
    );
    return;
  }

  const contract = checkContract(source.markdown);
  if (!contract.ok) {
    const missing = contract.missing.map((field) => field.key);
    // Ask once per distinct gap — re-asking the same three questions every poll is noise.
    // But the gap is "these fields, in this document": when the source changes the answer
    // has to be repeated against the new one, or a PM who just linked a page is met with
    // silence they cannot tell apart from being ignored.
    const askedBefore =
      (known?.askedForFields ?? []).join(",") === missing.join(",") &&
      (known?.askedFromOrigin ?? "") === (source.origin ?? "");
    // A human typing `draft` always gets an answer, even the same questions again: every
    // agent message tells them to comment `draft`, and silence reads as being ignored.
    if (!askedBefore || options.force) {
      await say(
        ctx,
        key,
        [
          "**I can't draft from this PRD yet.** It's missing the fields I refuse to guess:",
          "",
          formatContractQuestions(contract),
          "",
          `State them in ${source.origin ?? "the PRD"} — YAML frontmatter, a labeled line (\`audience: workspace admins\`), or a heading with the answer under it — and comment \`draft\`.`,
          ...(source.confluenceError
            ? ["", "_This ticket also links a Confluence page I can't read — if the PRD lives there, grant my account view access and comment `draft`._"]
            : []),
        ].join("\n"),
      );
      await ctx.state.patch(key, { askedForFields: missing, askedFromOrigin: source.origin ?? "" });
      // It cannot proceed without them: the ticket belongs to whoever can answer.
      await handBack(ctx, key, issue);
      await audit(ctx.config.auditFile, { type: "jira.contract.rejected", actor: "scribe", issue: key, missing });
    }
    return;
  }

  const feature = String(contract.frontmatter.feature ?? issue.fields.summary);
  const slug = docSlug(feature);
  await seedVault(ctx, slug, feature, source, key);

  // Working: say so on the board before the slow part, not after — and take the ticket,
  // so the assignee column agrees with the column it sits in.
  await moveTo(ctx, key, ctx.config.jira.inProgressStatus, issueStatus(issue));
  await assignTo(ctx, key, ctx.botAccountId);

  const withdrawn = await withdrawnLessons(ctx.config.jira.stateDir);
  let result = await draftDoc(ctx.vault, source.markdown, source.images, { withdrawn });
  if (!lintOk(result.lint)) {
    // Deterministic checks get one machine round-trip before a human is asked to read anything.
    result = await reviseDoc(
      ctx.vault,
      result.markdown,
      result.lint.map((finding) => `[${finding.code}] ${finding.message}`),
      [],
      { withdrawn },
    );
  }

  await ctx.state.saveDraft(key, result.markdown);
  await ctx.state.patch(key, {
    hasDraft: true,
    draftUnposted: true,
    draftPublished: false,
    docSlug: slug,
    sourcePrd: `prd/${slug}`,
    appliedLessons: result.appliedLessons,
    askedForFields: [],
  });

  await attachDraft(ctx, key, `draft-${slug}.md`, result.markdown);
  const posted = await say(
    ctx,
    key,
    draftComment({
      markdown: result.markdown,
      lintReport: formatLintFindings(result.lint),
      appliedLessons: result.appliedLessons,
      lessonVerdicts: result.lessonVerdicts,
      source,
      revision: false,
      attachment: `draft-${slug}.md`,
    }),
  );
  await ctx.state.patch(key, { draftPostedAt: posted.created, postedDraftHash: hashDraft(result.markdown), draftUnposted: false });
  // A draft exists and the next move is a human's — so it goes back to them, by name.
  await moveTo(ctx, key, ctx.config.jira.inReviewStatus);
  await handBack(ctx, key, issue);

  await announceDraftForApproval(ctx.config, {
    issueKey: key,
    issueUrl: ctx.client.issueUrl(key),
    feature,
    lintSummary: formatLintFindings(result.lint).split("\n").join(" · "),
    appliedLessons: result.appliedLessons,
    draftMarkdown: result.markdown,
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

export async function runRevise(ctx: Ctx, issue: JiraIssue, feedback: string[], authors: Array<string | undefined> = []): Promise<void> {
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

  // This feedback was already turned into the saved draft, whose comment never landed (a
  // failure after the save, retried): post that revision, don't revise it again.
  const fromThis = createHash("sha256").update(feedback.join("\u0000")).digest("hex");
  const known0 = ctx.state.get(key);
  if (known0?.revisedFrom === fromThis && known0.postedDraftHash !== hashDraft(draft)) {
    const recorded = known0.feedback ?? [];
    for (const [index, item] of feedback.entries()) if (!recorded.includes(item)) await ctx.state.appendFeedback(key, item, authors[index]);
    await repostDraft(ctx, key, draft);
    await ctx.state.patch(key, { revisedFrom: undefined });
    await moveTo(ctx, key, ctx.config.jira.inReviewStatus);
    await handBack(ctx, key, issue);
    return;
  }

  await moveTo(ctx, key, ctx.config.jira.inProgressStatus, issueStatus(issue));
  await assignTo(ctx, key, ctx.botAccountId);

  // Re-read fresh, never carried over from the first draft — "match the new mockup" is
  // feedback the text alone cannot express. But only when the feedback actually points at
  // a design: see REFERS_TO_DESIGN for why the default is text-only.
  const pointsAtDesign = feedback.some((item) => REFERS_TO_DESIGN.test(item));
  const designs = pointsAtDesign ? await loadDesignImages(ctx, issue) : { images: [], names: [] };
  const result = await reviseDoc(ctx.vault, draft, feedback, designs.images, { withdrawn: await withdrawnLessons(ctx.config.jira.stateDir) });
  await ctx.state.saveDraft(key, result.markdown);
  // The vault copy is now stale relative to this draft: the next approve republishes.
  await ctx.state.patch(key, { draftPublished: false, revisedFrom: fromThis });
  await moveTo(ctx, key, ctx.config.jira.inReviewStatus);
  await handBack(ctx, key, issue);
  for (const [index, item] of feedback.entries()) await ctx.state.appendFeedback(key, item, authors[index]);

  const known = ctx.state.get(key);
  const slug = known?.docSlug ?? docSlug(issue.fields.summary);
  await attachDraft(ctx, key, `draft-${slug}.md`, result.markdown);
  const posted = await say(
    ctx,
    key,
    draftComment({
      markdown: result.markdown,
      lintReport: formatLintFindings(result.lint),
      appliedLessons: result.appliedLessons,
      lessonVerdicts: result.lessonVerdicts,
      source: {
        images: designs.images,
        imageNames: designs.names,
        skipped: [],
        origin: `${feedback.length} comment(s) of feedback`,
      },
      revision: true,
      attachment: `draft-${slug}.md`,
    }),
  );
  await ctx.state.patch(key, { draftPostedAt: posted.created, postedDraftHash: hashDraft(result.markdown), revisedFrom: undefined });
  await audit(ctx.config.auditFile, { type: "jira.draft.revised", actor: "scribe", issue: key, feedback });
}
