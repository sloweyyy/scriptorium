import fs from "node:fs/promises";
import path from "node:path";
import { parseMarkdown, slugify, type Vault } from "@scriptorium/core";
import { organizeInboxFile, updateMoc } from "./organizer";

/**
 * Seeding the reference corpus — Curator's demo knowledge.
 *
 * `vault/reference/` is derived, never authored, and is not committed: it is regenerated
 * from `corpus/`, where each page carries the `source_url` it was retrieved from. That is
 * what lets an answer drawn from this material be traced back to the page it came from.
 *
 * This lives in the package rather than in the seeding script because the deployed agent
 * needs it too. It did not have it: `.gcloudignore` excluded both the derived vault and the
 * corpus it derives from, so the running instance held six notes and could answer nothing
 * about the product the corpus is *about* — every such question came back NOT_IN_KB, from a
 * knowledge base that was supposed to be grounded in exactly that material.
 */

export interface SeedResult {
  /** Notes written into the vault this run. */
  filed: number;
  /** Pages found in the corpus directory. */
  found: number;
  /** Pages whose frontmatter could not be read; named so a bad page is fixable. */
  skipped: string[];
}

export interface SeedOptions {
  /**
   * Leave the notes in `_inbox` for the watcher to file, instead of filing them directly.
   * The slower path on purpose: it demonstrates the watcher doing its job.
   */
  inboxOnly?: boolean;
}

/** Copy a retrieved corpus into the vault, preserving each page's provenance. */
export async function seedCorpus(vault: Vault, corpusDir: string, options: SeedOptions = {}): Promise<SeedResult> {
  const entries = (await fs.readdir(corpusDir))
    .filter((name) => name.endsWith(".md") && name.toLowerCase() !== "readme.md")
    .sort();

  const result: SeedResult = { filed: 0, found: entries.length, skipped: [] };

  for (const name of entries) {
    const raw = await fs.readFile(path.join(corpusDir, name), "utf8");
    let frontmatter: Record<string, unknown>;
    let body: string;
    try {
      ({ frontmatter, body } = parseMarkdown(raw));
    } catch {
      // One malformed page must not stop the run — record which, and move on.
      result.skipped.push(name);
      continue;
    }
    const slug = slugify(name.replace(/\.md$/, ""));
    const title = String(frontmatter.title ?? name.replace(/\.md$/, ""));

    await vault.writeNote(`_inbox/${slug}.md`, body, {
      kind: "reference",
      slug,
      feature: title,
      source_url: frontmatter.source_url,
      source: frontmatter.source ?? path.basename(corpusDir),
      retrieved: frontmatter.retrieved,
      tags: frontmatter.category ? [String(frontmatter.category)] : undefined,
    });

    if (!options.inboxOnly) {
      const filed = await organizeInboxFile(vault, `_inbox/${slug}.md`);
      if (filed.action !== "skipped") result.filed += 1;
    }
  }

  await updateMoc(vault);
  return result;
}

/**
 * Seed on boot, but only into a vault that has no reference material yet.
 *
 * Idempotent by that check rather than by content, because re-filing 60-odd notes on every
 * restart would rewrite the whole tree and churn the index for no gain. Returns null when
 * there is nothing to do — no corpus shipped, or the vault already has it — so a caller can
 * stay quiet instead of logging a no-op every start.
 */
export async function seedCorpusIfEmpty(vault: Vault, corpusDir: string): Promise<SeedResult | null> {
  const existing = await vault.listNotes("reference");
  if (existing.length) return null;
  try {
    await fs.access(corpusDir);
  } catch {
    return null;
  }
  const result = await seedCorpus(vault, corpusDir);
  return result.found ? result : null;
}
