import type { AppConfig, Vault } from "@scriptorium/core";

/**
 * Turning a cited note into somewhere a reader can actually go.
 *
 * Curator answers from 69 notes and the two published sites carry six of them. That is not
 * an accident — 63 are retrieved third-party pages, and republishing someone else's content
 * under our own documentation site would be passing it off as ours. But it left every
 * citation to that material a dead end: a path naming a note nobody outside the container
 * can open. Provenance a reader cannot check is a claim about provenance, not provenance.
 *
 * So each citation resolves to the one place its content legitimately lives:
 *
 * - a retrieved page → the `source_url` it was retrieved from, which is the honest citation
 *   for something we did not write;
 * - an approved doc → the public site, where a human merge put it;
 * - a PRD, gap note or house rule → the internal site, gated to the people it is for.
 *
 * Unresolvable stays unlinked rather than guessed. A citation that names its note is worth
 * less than one that opens it, and far more than one that opens the wrong thing.
 */

export interface ResolvedCitation {
  /** Vault-relative path, without `.md` — exactly as the model cited it. */
  path: string;
  url?: string;
}

/** `docs/foo` is served at `/foo`: the site's content root IS the vault's docs folder. */
function externalUrl(base: string, notePath: string): string | undefined {
  if (!notePath.startsWith("docs/")) return undefined;
  return `${base}/${notePath.slice("docs/".length)}`;
}

/** The internal site renders the whole internal tree, so vault paths map straight through. */
function internalUrl(base: string, notePath: string): string {
  return `${base}/${notePath}`;
}

/**
 * Never published, by allowlist: `_inbox` is unfiled, and `reference` is other people's
 * content. A reference note reaches a reader through its `source_url` or not at all.
 */
const NEVER_ON_A_SITE = ["reference/", "_inbox/"];

async function sourceUrlOf(vault: Vault, notePath: string): Promise<string | undefined> {
  try {
    const note = await vault.readNote(`${notePath}.md`);
    const url = note.frontmatter.source_url;
    // Only http(s): a frontmatter field is data, and a citation must not become a way to
    // put `javascript:` or `file:` in front of a reader.
    return typeof url === "string" && /^https?:\/\//.test(url) ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `jira:DOC-7`, `confluence:123`, `github:org/app/pull/12` → their URLs. Returns null for a
 * vault path (not an external record), undefined when the record has no known site.
 */
export function externalRecordUrl(config: AppConfig, citation: string): string | undefined | null {
  const base = config.jira?.baseUrl?.replace(/\/$/, "");
  const jira = citation.match(/^jira:([A-Z][A-Z0-9_]*-\d+)$/);
  if (jira) return base ? `${base}/browse/${jira[1]}` : undefined;
  const confluence = citation.match(/^confluence:(\d+)$/);
  if (confluence) return base ? `${base}/wiki/pages/viewpage.action?pageId=${confluence[1]}` : undefined;
  const github = citation.match(/^github:([a-z0-9_.-]+\/[a-z0-9_.-]+)\/pull\/(\d+)$/);
  if (github) return `https://github.com/${github[1]}/pull/${github[2]}`;
  return null;
}

export async function resolveCitations(
  vault: Vault,
  config: AppConfig,
  citations: readonly string[],
): Promise<ResolvedCitation[]> {
  const { external, internal } = config.sites;

  return Promise.all(
    citations.map(async (raw): Promise<ResolvedCitation> => {
      // Records outside the vault resolve to where they live, so a reader can open them.
      const record = externalRecordUrl(config, raw);
      if (record !== null) return { path: raw, url: record };
      const notePath = raw.replace(/\.md$/, "");

      // Source first, and for every note that has one: where the content came from beats
      // where we happen to be serving a copy of it.
      const source = await sourceUrlOf(vault, notePath);
      if (source) return { path: notePath, url: source };

      if (NEVER_ON_A_SITE.some((prefix) => notePath.startsWith(prefix))) return { path: notePath };

      const publicUrl = external ? externalUrl(external, notePath) : undefined;
      if (publicUrl) return { path: notePath, url: publicUrl };

      return { path: notePath, url: internal ? internalUrl(internal, notePath) : undefined };
    }),
  );
}

/** Lookup for the formatter: cited path -> where it can be read. */
export function citationLinks(resolved: readonly ResolvedCitation[]): Map<string, string> {
  const links = new Map<string, string>();
  for (const citation of resolved) {
    if (citation.url) links.set(citation.path, citation.url);
  }
  return links;
}
