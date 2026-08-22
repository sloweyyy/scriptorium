import fs from "node:fs/promises";
import path from "node:path";
import { parseMarkdown, toPosix, Vault } from "@scriptorium/core";
import {
  EXTERNAL_STRIP_KEYS,
  includePatterns,
  isIncluded,
  RETRIEVED_MARKER_KEY,
  type PublishTarget,
} from "./allowlist";
import { transformBodyLinks, transformFrontmatter } from "./links";

export interface StageInput {
  vault: Vault;
  target: PublishTarget;
  /** Directory the resolved include-list is staged into. Created if missing. */
  destDir: string;
}

export interface StageResult {
  target: PublishTarget;
  destDir: string;
  /** Vault-relative posix paths that were staged, sorted. */
  files: string[];
  /** Wikilink targets dropped by the external transform, for reporting. */
  droppedLinks: string[];
}

/** Raw recursive walk — deliberately NOT `Vault.listNotes`, which only sees `.md`. */
async function walkFiles(root: string, prefix = ""): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await walkFiles(root, rel)));
    else found.push(toPosix(rel));
  }
  return found.sort();
}

/**
 * Stage the resolved include-list into `destDir`, then prove two things about what
 * actually landed there. Both gates throw: a violation means the allowlist logic itself is
 * wrong, and "filter the bad file out and carry on" would hide that. Only a divergence
 * against the docs repo (see `publishToRepo`) is a structured, recoverable result.
 *
 * Gate 1 — nothing outside the include-list is staged. It is asserted against a raw
 * filesystem walk of `destDir` (not the list it just wrote), so it catches a stale file
 * already sitting in the destination and any non-`.md` stray. What it cannot catch is a bug
 * in `isIncluded` itself — anything the allowlist wrongly admits is in the list and passes.
 * `NEVER_PUBLISH` and gate 2 are the backstops for that.
 *
 * Gate 2 — no staged file carries `source_url` frontmatter. That key is the marker every
 * retrieved reference note carries, and this gate keys on content rather than path, so it
 * still fires for a reference note that somehow ended up under `docs/`.
 */
export async function stageVault(input: StageInput): Promise<StageResult> {
  const { vault, target, destDir } = input;

  const files = (await vault.listNotes()).filter((relPath) => isIncluded(relPath, target)).sort();
  const included = new Set(files);

  await fs.mkdir(destDir, { recursive: true });
  const staging = new Vault(destDir);
  const droppedLinks: string[] = [];

  for (const relPath of files) {
    const note = await vault.readNote(relPath);
    if (target === "internal") {
      // Quartz reads the vault's own shape: wikilinks, backlinks and provenance intact.
      await staging.writeNote(relPath, note.body, note.frontmatter);
      continue;
    }
    const { body, dropped } = transformBodyLinks(relPath, note.body, included);
    droppedLinks.push(...dropped);
    await staging.writeNote(relPath, body, transformFrontmatter(note.frontmatter, EXTERNAL_STRIP_KEYS, included));
  }

  const staged = await walkFiles(destDir);

  const strays = staged.filter((relPath) => !included.has(relPath));
  if (strays.length) {
    throw new Error(
      `publish gate 1: ${strays.length} staged file(s) outside the ${target} include-list ` +
        `(${includePatterns(target).join(", ")}): ${strays.join(", ")}`,
    );
  }

  const retrieved: string[] = [];
  for (const relPath of staged) {
    const raw = await fs.readFile(path.join(destDir, relPath), "utf8");
    if (RETRIEVED_MARKER_KEY in parseMarkdown(raw).frontmatter) retrieved.push(relPath);
  }
  if (retrieved.length) {
    throw new Error(
      `publish gate 2: ${retrieved.length} staged file(s) carry ${RETRIEVED_MARKER_KEY} ` +
        `(retrieved third-party content never publishes): ${retrieved.join(", ")}`,
    );
  }

  return { target, destDir, files, droppedLinks: [...new Set(droppedLinks)].sort() };
}
