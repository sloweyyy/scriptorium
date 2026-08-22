import path from "node:path";
import { slugify, type Frontmatter } from "@scriptorium/core";

/**
 * Link transform for the external site.
 *
 * Astro Starlight has no native wikilink support, and the external allowlist is narrower
 * than the vault: a published doc carries `source: [[prd/scheduled-maintenance]]` and
 * often body links to PRDs, gap notes and lessons. Copied verbatim those become dead
 * links that also leak internal note titles — so every `[[wikilink]]` is either rewritten
 * to a relative link (target is in the include-list) or removed (target is not).
 *
 * The internal site is Quartz over the vault's own shape and needs no transform.
 */

/** Emitted links keep the `.md` extension; Starlight resolves relative markdown links. */
const LINK_EXTENSION = ".md";

const WIKILINK = /(!?)\[\[([^\][\n]+)\]\]/g;

export interface WikilinkParts {
  embed: boolean;
  target: string;
  heading?: string;
  alias?: string;
}

export function parseWikilink(inner: string, embed: boolean): WikilinkParts {
  const [linkPart = "", ...aliasParts] = inner.split("|");
  const alias = aliasParts.length ? aliasParts.join("|").trim() : undefined;
  const [targetPart = "", ...headingParts] = linkPart.split("#");
  return {
    embed,
    target: targetPart.trim(),
    heading: headingParts.length ? headingParts.join("#").trim() : undefined,
    alias,
  };
}

/**
 * Obsidian resolves a bare note name anywhere in the vault, so `[[widget-exports]]` and
 * `[[docs/widget-exports]]` are the same link. Both forms have to be resolvable against
 * the include-list or an allowlisted target would be dropped as if it were excluded.
 */
export function resolveTarget(target: string, included: ReadonlySet<string>): string | undefined {
  const withExt = target.endsWith(".md") ? target : `${target}${LINK_EXTENSION}`;
  if (included.has(target)) return target;
  if (included.has(withExt)) return withExt;
  if (!target.includes("/")) {
    for (const candidate of included) {
      if (candidate.slice(candidate.lastIndexOf("/") + 1) === withExt) return candidate;
    }
  }
  return undefined;
}

export function relativeLink(fromRelPath: string, toRelPath: string): string {
  const fromDir = path.posix.dirname(fromRelPath);
  const rel = path.posix.relative(fromDir === "." ? "" : fromDir, toRelPath);
  return rel.startsWith(".") ? rel : `./${rel}`;
}

export interface TransformBodyResult {
  body: string;
  /** Wikilink targets that were dropped because they are outside the include-list. */
  dropped: string[];
}

/**
 * Rewrite the wikilinks in one note's body.
 *
 * A link whose target is excluded is *never* emitted as a link. When the author gave it a
 * label we keep the label as plain text (the sentence still reads); otherwise the whole
 * link goes. Embeds (`![[image.png]]`) of excluded targets are removed outright — a stub
 * image is worse than no image.
 */
/**
 * "relative" rewrites every surviving wikilink into a relative markdown link, for a
 * generator that cannot resolve wikilinks (Starlight). "prune" keeps the wikilink syntax
 * for a generator that resolves them natively (Quartz) and only removes the ones pointing
 * outside the include-list — which still matters, because an unpublished target leaks its
 * title onto a published page even when the file itself never ships.
 */
export type LinkMode = "relative" | "prune";

export function transformBodyLinks(
  relPath: string,
  body: string,
  included: ReadonlySet<string>,
  mode: LinkMode = "relative",
): TransformBodyResult {
  const dropped: string[] = [];
  const transformed = body.replace(WIKILINK, (match, bang: string, inner: string) => {
    const link = parseWikilink(inner, bang === "!");
    const resolved = resolveTarget(link.target, included);
    const label = link.alias ?? link.heading ?? link.target;
    if (!resolved) {
      dropped.push(link.target);
      // No link, and no label either in prune mode: the label IS the leak — a reference
      // note's title is exactly what must not appear on a published page.
      return link.embed || mode === "prune" ? "" : label;
    }
    if (mode === "prune") return match;
    const anchor = link.heading ? `#${slugify(link.heading)}` : "";
    const href = `${relativeLink(relPath, resolved)}${anchor}`;
    return `${link.embed ? "!" : ""}[${label}](${href})`;
  });
  return { body: transformed, dropped };
}

function wikilinkTargets(value: string): string[] {
  return [...value.matchAll(WIKILINK)].map((match) => parseWikilink(match[2] ?? "", false).target);
}

/** True when the value carries a wikilink and every target of it is publishable. */
function frontmatterValueSurvives(value: unknown, included: ReadonlySet<string>): boolean {
  if (typeof value !== "string") return true;
  const targets = wikilinkTargets(value);
  if (!targets.length) return true;
  return targets.every((target) => resolveTarget(target, included) !== undefined);
}

/**
 * Strip internal-only provenance and any remaining frontmatter that points outside the
 * include-list. Generic rather than per-key: special-casing `related` would just leave
 * the next wikilink-bearing key dead.
 */
export function transformFrontmatter(
  frontmatter: Frontmatter,
  stripKeys: readonly string[],
  included: ReadonlySet<string>,
): Frontmatter {
  const out: Frontmatter = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (stripKeys.includes(key)) continue;
    if (Array.isArray(value)) {
      const kept = value.filter((entry) => frontmatterValueSurvives(entry, included));
      if (kept.length) out[key] = kept;
      continue;
    }
    if (!frontmatterValueSurvives(value, included)) continue;
    out[key] = value;
  }
  return out;
}
