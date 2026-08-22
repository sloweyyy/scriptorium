/**
 * Publish is an allowlist, not a mirror.
 *
 * `vault/reference/` holds retrieved third-party material. It is gitignored but it is
 * PRESENT ON DISK, so a recursive copy of the vault would silently ship it. There is
 * therefore no code path in this package that walks the vault and copies what it finds:
 * every file that leaves the vault has to be named by one of the patterns below.
 */

export type PublishTarget = "external" | "internal";

/** The public docs site (Astro Starlight). Agent-authored, human-approved docs only. */
export const EXTERNAL_INCLUDE = ["docs/**"] as const;

/**
 * The private knowledge plane (Quartz over `vault-live`). Adds the internal halves of
 * the loop: the PRDs docs are drafted from, Curator's gap notes, and the human-gated
 * lessons — `_lessons/**` is the learning and must stop living only on container disk.
 */
export const INTERNAL_INCLUDE = ["docs/**", "prd/**", "_gaps/**", "_lessons/**", "index.md"] as const;

/** Never publishable anywhere, under any target, by any pattern. Asserted, not assumed. */
export const NEVER_PUBLISH = ["reference/", "_inbox/"] as const;

/** Frontmatter keys that are internal provenance and are stripped from external output. */
export const EXTERNAL_STRIP_KEYS = ["source", "applied_lessons", "approved_by"] as const;

/**
 * The marker every retrieved `reference/**` note carries. The second staging gate keys on
 * this rather than on a path, so a reference note that somehow lands under `docs/` is
 * still rejected.
 */
export const RETRIEVED_MARKER_KEY = "source_url";

export function includePatterns(target: PublishTarget): readonly string[] {
  return target === "external" ? EXTERNAL_INCLUDE : INTERNAL_INCLUDE;
}

/** `docs/**` matches anything below `docs/`; anything else is an exact path. */
function matchesPattern(relPath: string, pattern: string): boolean {
  if (pattern.endsWith("/**")) return relPath.startsWith(pattern.slice(0, -2));
  return relPath === pattern;
}

export function isIncluded(relPath: string, target: PublishTarget): boolean {
  const normalized = relPath.replace(/^\.\//, "");
  // Belt and braces: even if a pattern were ever widened by mistake, these two prefixes
  // can never publish.
  if (NEVER_PUBLISH.some((prefix) => normalized.startsWith(prefix))) return false;
  return includePatterns(target).some((pattern) => matchesPattern(normalized, pattern));
}
