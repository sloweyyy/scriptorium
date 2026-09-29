import fs from "node:fs/promises";
import path from "node:path";
import { isSafeSlug, parseMarkdown, type ImageInput } from "@scriptorium/core";
import {
  confluencePageIdFromUrl,
  confluencePageIdsIn,
  confluenceStorageToMarkdown,
  jiraToMarkdown,
  type JiraAttachment,
  type JiraIssue,
} from "@scriptorium/jira";
import { errorMessage, type Ctx } from "./context";

const VISION_TYPES: Record<string, ImageInput["mediaType"]> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/webp": "image/webp",
  "image/gif": "image/gif",
};

const PRD_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);

/**
 * What an image really is, from its first bytes. Jira's `mimeType` comes from the filename
 * the uploader chose, so a PDF renamed `.png` was sent to the model as a PNG and failed
 * every draft on the ticket. Undefined: not an image the model reads.
 */
export function sniffImage(bytes: Buffer): ImageInput["mediaType"] | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return undefined;
}

/**
 * A PRD is prose: a few thousand words. One far past that is an export or a log pasted in
 * by mistake, and was downloaded whole and sent to the model every draft.
 */
export const MAX_PRD_BYTES = 200_000;

const DRAFT_ATTACHMENT = /^draft-(.+)\.md$/i;

/**
 * The draft the agent last attached, newest first — the only durable record of a draft
 * that lives outside the gitignored state directory, and therefore what a restart with a
 * lost ledger reconstructs from.
 */
/**
 * Newest first. A PM who fixes a PRD usually re-uploads it next to the old one; reading
 * the array in Jira's order picked whichever came back first — often the stale copy.
 */
export function newestFirst(attachments: readonly JiraAttachment[]): JiraAttachment[] {
  return [...attachments].sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""));
}

export function lastDraftAttachment(issue: JiraIssue): { attachment: JiraAttachment; slug: string } | undefined {
  return (issue.fields.attachment ?? [])
    .flatMap((attachment) => {
      const slug = attachment.filename.match(DRAFT_ATTACHMENT)?.[1];
      // Only a name we could have written: "draft-../_lessons/L-001.md" is not our draft,
      // and its "slug" would have become the path the doc is published to.
      return slug && isSafeSlug(slug) ? [{ attachment, slug }] : [];
    })
    .sort((a, b) => (b.attachment.created ?? "").localeCompare(a.attachment.created ?? ""))[0];
}

/**
 * What the ticket offered as input last time. Re-drafting is driven off this, so the
 * agent retries by itself when the PM finally attaches the PRD — and stays quiet when
 * the only thing that changed is its own comment.
 */
export function sourceFingerprint(issue: JiraIssue, remoteLinks?: string): string {
  const attachments = (issue.fields.attachment ?? []).map((attachment) => attachment.id).sort();
  return `${attachments.join(",")}|${issue.fields.description?.trim().length ?? 0}|${remoteLinks ?? ""}`;
}

/**
 * Which pages this ticket points at, order-independent.
 *
 * `undefined` means "I could not look" and never "there are none" — returning an empty
 * string on a transient API failure would read as "every link was removed", and the next
 * successful call would then read as "links appeared", re-drafting on nothing at all.
 */
export async function remoteLinkFingerprint(ctx: Ctx, key: string): Promise<string | undefined> {
  try {
    const links = await ctx.client.remoteLinks(key);
    return links
      .map((link) => link.object?.url ?? "")
      .filter(Boolean)
      .sort()
      .join(",");
  } catch (error) {
    console.warn(`[scribe] ${key}: remote links unreadable: ${errorMessage(error)}`);
    return undefined;
  }
}

/**
 * Ticks between remote-link re-checks on one blocked ticket — ~2 minutes at a 15s poll.
 *
 * Jira does not bump `fields.updated` when a remote link is added, so the only way to see
 * a Confluence page linked after the fact is to ask. Asking for every issue on every tick
 * would be one extra API call per ticket per 15 seconds, forever, for a signal that
 * changes once in a ticket's life — so it is asked rarely, and only where the answer
 * could change anything.
 */
const REMOTE_LINK_EVERY_N_TICKS = 8;
export const remoteLinkTicks = new Map<string, number>();

export function dueForRemoteLinkCheck(key: string): boolean {
  const seen = remoteLinkTicks.get(key) ?? 0;
  remoteLinkTicks.set(key, seen + 1);
  return seen % REMOTE_LINK_EVERY_N_TICKS === 0;
}

export interface PrdSource {
  markdown?: string;
  origin?: string;
  images: ImageInput[];
  imageNames: string[];
  skipped: string[];
  /** A Confluence page was pointed at but could not be read. */
  confluenceError?: boolean;
}

/**
 * Every design image currently on the ticket.
 *
 * Split out from `loadSource` because a revision needs the designs and nothing else:
 * re-reading the PRD there would re-download an attachment and possibly re-fetch a
 * Confluence page for a question nobody asked. Always the CURRENT set, never a cached
 * one — the whole point is that a mockup attached after the first draft is seen.
 */
/**
 * The model's per-image ceiling is 5 MB of base64; base64 is 4/3 of the raw bytes. One
 * image over it failed EVERY draft on the ticket with a transport error the reviewer could
 * do nothing about. Oversized designs are now left out and named, and the draft goes ahead.
 */
export const MAX_DESIGN_BYTES = 3_750_000;
/** Enough for a flow's screens; past this each extra image costs more than it tells. */
export const MAX_DESIGNS = 8;

export async function loadDesignImages(ctx: Ctx, issue: JiraIssue): Promise<{ images: ImageInput[]; names: string[]; skipped: string[] }> {
  const images: ImageInput[] = [];
  const names: string[] = [];
  const skipped: string[] = [];
  for (const attachment of newestFirst(issue.fields.attachment ?? [])) {
    const mediaType = VISION_TYPES[attachment.mimeType?.toLowerCase() ?? ""];
    if (!mediaType) continue;
    if (images.length >= MAX_DESIGNS) {
      skipped.push(`${attachment.filename} (more than ${MAX_DESIGNS} designs; the newest ${MAX_DESIGNS} were read)`);
      continue;
    }
    // Checked before downloading when Jira says the size, and after in case it didn't.
    if ((attachment.size ?? 0) > MAX_DESIGN_BYTES) {
      skipped.push(`${attachment.filename} (over ${Math.round(MAX_DESIGN_BYTES / 1e6 * 10) / 10} MB — export it smaller)`);
      continue;
    }
    const bytes = await ctx.client.downloadAttachment(attachment);
    if (bytes.length > MAX_DESIGN_BYTES) {
      skipped.push(`${attachment.filename} (over ${Math.round(MAX_DESIGN_BYTES / 1e6 * 10) / 10} MB — export it smaller)`);
      continue;
    }
    // Sent as what it IS, never as what its name claims; not an image at all is left out, named.
    const actual = sniffImage(bytes);
    if (!actual) {
      skipped.push(`${attachment.filename} (named as an image, but it isn't one)`);
      continue;
    }
    images.push({ mediaType: actual, base64: bytes.toString("base64") });
    names.push(attachment.filename);
  }
  return { images, names, skipped };
}

/** Read the PRD and designs off the ticket: attachments first, description as the fallback. */
export async function loadSource(ctx: Ctx, issue: JiraIssue): Promise<PrdSource> {
  const designs = await loadDesignImages(ctx, issue);
  const source: PrdSource = { images: designs.images, imageNames: designs.names, skipped: [...designs.skipped] };

  for (const attachment of newestFirst(issue.fields.attachment ?? [])) {
    // Images were read above; this pass is only looking for the PRD.
    if (VISION_TYPES[attachment.mimeType?.toLowerCase() ?? ""]) continue;
    // Never its own output: the agent attaches every draft as `draft-<slug>.md`, and a
    // later re-draft that reads one back as "the PRD" refuses on missing frontmatter —
    // the agent asking the PM for fields its own draft never carries.
    if (DRAFT_ATTACHMENT.test(attachment.filename)) {
      continue;
    }
    if (!source.markdown && PRD_EXTENSIONS.has(path.extname(attachment.filename).toLowerCase())) {
      const tooBig = `${attachment.filename} (over ${MAX_PRD_BYTES / 1000} KB, too long to be a PRD — trim it, or link the Confluence page)`;
      if ((attachment.size ?? 0) > MAX_PRD_BYTES) {
        source.skipped.push(tooBig);
        continue;
      }
      const bytes = await ctx.client.downloadAttachment(attachment);
      if (bytes.length > MAX_PRD_BYTES) {
        source.skipped.push(tooBig);
        continue;
      }
      source.markdown = bytes.toString("utf8");
      source.origin = `the attachment \`${attachment.filename}\``;
      continue;
    }
    source.skipped.push(`${attachment.filename} (not a PRD or a readable image)`);
  }

  // Between the attachment and the description: a linked Confluence page. That is where
  // PRDs actually live, and the ticket already points at it — Jira creates a remote link
  // the moment a page is linked, and a pasted URL in the description works the same way.
  if (!source.markdown) {
    const confluence = await loadConfluencePrd(ctx, issue);
    if (confluence) {
      source.markdown = confluence.markdown;
      source.origin = confluence.origin;
    } else if (confluence === null) {
      // A page was pointed at but could not be read — say so instead of "no PRD found",
      // because "attach a .md file" is the wrong advice when the fix is page permissions.
      source.confluenceError = true;
    }
  }

  if (!source.markdown) {
    const description = issue.fields.description?.trim();
    // A description that is essentially just the link to the (unreadable) page is a
    // pointer, not a PRD — running the contract on it would answer "add feature,
    // audience, user_goal" when the actual problem is page permissions.
    const withoutUrls = (description ?? "").replace(/https?:\/\/[^\s|\]")>]+/g, "").replace(/\W+/g, " ").trim();
    const pointerOnly = source.confluenceError && withoutUrls.length < 80;
    if (description && !pointerOnly) {
      // Jira's editor rewrites pasted markdown as wiki markup — put it back before the contract check.
      source.markdown = jiraToMarkdown(description);
      source.origin = "the issue description";
    }
  }
  return source;
}

/**
 * The PRD from a Confluence page the ticket points at.
 *
 * Sources, in order: the issue's remote links (what "link a Confluence page" creates),
 * then any Confluence URL sitting in the description. Returns `undefined` when nothing
 * points at Confluence, and `null` when something does but the page could not be read —
 * the caller words its refusal differently for those two.
 *
 * A page read this way is snapshot at draft time: editing the page does not touch the
 * issue's `updated`, so the poller cannot see the change. `draft` re-reads it — HELP
 * says so.
 */
async function loadConfluencePrd(
  ctx: Ctx,
  issue: JiraIssue,
): Promise<{ markdown: string; origin: string } | null | undefined> {
  const candidates: string[] = [];
  // Only this site's pages, only in allowed spaces. The page id was taken from ANY URL, so a
  // link to anything.example?pageId=123 read page 123 here; and the service account may see
  // spaces the ticket's author can't, whose content would then be quoted onto the ticket.
  const site = siteHost(ctx.config.jira.baseUrl);
  const allowed = ctx.config.jira.prdSpaces ?? [];
  const onThisSite = (url: string) => Boolean(site) && siteHost(url) === site;

  try {
    for (const link of await ctx.client.remoteLinks(issue.key)) {
      const url = link.object?.url;
      if (!url || !onThisSite(url)) continue;
      const id = confluencePageIdFromUrl(url);
      if (id && !candidates.includes(id)) candidates.push(id);
    }
  } catch (error) {
    // Remote links are an enrichment; a 4xx here must not take down description intake.
    console.warn(`[scribe] ${issue.key}: remote links unreadable: ${errorMessage(error)}`);
  }

  for (const match of (issue.fields.description ?? "").matchAll(/https?:\/\/[^\s|\]")>]+/g)) {
    if (!onThisSite(match[0])) continue;
    for (const id of confluencePageIdsIn(match[0])) if (!candidates.includes(id)) candidates.push(id);
  }
  if (!candidates.length) return undefined;
  if (!allowed.length) {
    console.warn(`[scribe] ${issue.key}: a Confluence PRD is linked, but no spaces are allowed (SCRIBE_CONFLUENCE_SPACES); not reading it`);
    return null;
  }

  for (const id of candidates) {
    try {
      const page = await ctx.client.confluencePage(id);
      // Nothing about a refused page (not even its title) reaches the ticket.
      if (!page.spaceKey || !allowed.includes(page.spaceKey.toUpperCase())) {
        console.warn(`[scribe] ${issue.key}: Confluence page ${id} is outside the allowed spaces; not reading it`);
        continue;
      }
      const markdown = confluenceStorageToMarkdown(page.storage);
      if (markdown.trim()) {
        return { markdown, origin: `the linked Confluence page “${page.title}”` };
      }
    } catch (error) {
      console.warn(`[scribe] ${issue.key}: Confluence page ${id} unreadable: ${errorMessage(error)}`);
    }
  }
  return null;
}

/** An Atlassian site's host, for comparing a link against the configured site. */
function siteHost(url: string | undefined): string | undefined {
  try {
    return url ? new URL(url).host.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Hand the inputs to Agent B: PRD and designs land in `_inbox`, where Curator's watcher
 * files and links them. Agent A's ticket becomes Agent B's knowledge without a second copy.
 */
/**
 * The PRD's own frontmatter is the PM's input, not the vault's metadata. Copied wholesale,
 * a PRD carrying `source_url` became the citation link Curator shows for it and blocked the
 * internal publish; `kind`, `status` or `approved_by` could pose as vault state. Only the
 * fields a PRD legitimately carries are kept.
 */
const PRD_KEYS = new Set(["feature", "audience", "user_goal", "owner", "title", "summary", "tags"]);

export function prdFrontmatter(frontmatter: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(frontmatter).filter(([key]) => PRD_KEYS.has(key)));
}

const IMAGE_EXTENSIONS: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" };

/**
 * A design's filename, made safe to file. The name is whatever the uploader typed: an
 * image named `approve.md` was filed by the organizer as a DOCUMENT. The extension now
 * comes from the bytes' media type, and the rest is reduced to a plain slug.
 */
export function safeDesignName(uploaded: string | undefined, mediaType: string, fallback: string): string {
  const stem = path
    .basename(uploaded ?? "")
    .replace(/\.[^.]*$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${stem || fallback}${IMAGE_EXTENSIONS[mediaType] ?? ".png"}`;
}

export async function seedVault(ctx: Ctx, slug: string, feature: string, source: PrdSource, issueKey: string): Promise<void> {
  if (source.markdown) {
    // Written through the vault with `kind: prd` set explicitly: the organizer would
    // otherwise fall back to heuristics and could file a PRD into docs/, colliding with
    // the very note publishDoc writes on approval.
    const { frontmatter, body } = parseMarkdown(source.markdown);
    await ctx.vault.writeNote(`_inbox/${slug}.md`, body, {
      ...prdFrontmatter(frontmatter),
      kind: "prd",
      feature,
      // Pinned so the organizer files it under the same slug the doc is published as.
      slug,
      jira_issue: issueKey,
      source_ticket: ctx.client.issueUrl(issueKey),
    });
  }
  for (const [index, image] of source.images.entries()) {
    const name = safeDesignName(source.imageNames[index], image.mediaType, `${slug}-design-${index + 1}`);
    await fs.writeFile(ctx.vault.abs(`_inbox/${name}`), Buffer.from(image.base64, "base64"));
  }
}
