import path from "node:path";
import { firstHeading, slugify, type Note, type Vault } from "@scriptorium/core";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);

export interface OrganizeResult {
  action: "filed-prd" | "filed-doc" | "filed-design" | "skipped";
  from: string;
  to?: string;
  note?: string;
}

function classifyMarkdown(note: Note): "prd" | "docs" {
  const kind = String(note.frontmatter.kind ?? "").toLowerCase();
  if (kind === "prd") return "prd";
  if (kind === "doc" || kind === "docs") return "docs";
  if (/(^|\W)prd(\W|$)/i.test(note.relPath) || /##\s*(requirements|problem)/i.test(note.body)) return "prd";
  return "docs";
}

/** File one _inbox item into its place: classify, normalize frontmatter, link, refresh the index note. */
export async function organizeInboxFile(vault: Vault, relPath: string): Promise<OrganizeResult> {
  const extension = path.extname(relPath).toLowerCase();
  const basename = path.basename(relPath);

  if (IMAGE_EXTENSIONS.has(extension)) {
    const to = `design/${basename}`;
    await vault.moveFile(relPath, to);
    // Sidecar note makes the image addressable in wikilinks and the graph.
    const sidecar = `design/${basename.slice(0, -extension.length)}.md`;
    if (!(await vault.exists(sidecar))) {
      await vault.writeNote(sidecar, `![[${basename}]]`, { kind: "design", added: new Date().toISOString() });
    }
    await updateMoc(vault);
    return { action: "filed-design", from: relPath, to };
  }

  if (extension === ".md") {
    const note = await vault.readNote(relPath);
    const kind = classifyMarkdown(note);
    const feature = String(note.frontmatter.feature ?? firstHeading(note.body) ?? basename.replace(/\.md$/, ""));
    const slug = slugify(feature);
    const to = `${kind}/${slug}.md`;
    await vault.writeNote(to, note.body, {
      ...note.frontmatter,
      kind: kind === "prd" ? "prd" : "doc",
      feature,
      filed: new Date().toISOString(),
    });
    await vault.deleteFile(relPath);
    await linkRelated(vault, slug);
    await updateMoc(vault);
    return { action: kind === "prd" ? "filed-prd" : "filed-doc", from: relPath, to };
  }

  return { action: "skipped", from: relPath, note: `unsupported file type: ${extension || "none"}` };
}

/** Cross-link prd/docs notes that share a feature slug via `related` frontmatter. */
export async function linkRelated(vault: Vault, slug: string): Promise<void> {
  const candidates = [`prd/${slug}.md`, `docs/${slug}.md`, `design/${slug}.md`];
  const existing: string[] = [];
  for (const candidate of candidates) {
    if (await vault.exists(candidate)) existing.push(candidate);
  }
  if (existing.length < 2) return;

  for (const relPath of existing) {
    const note = await vault.readNote(relPath);
    const related = existing.filter((other) => other !== relPath).map((other) => `[[${other.replace(/\.md$/, "")}]]`);
    await vault.writeNote(relPath, note.body, { ...note.frontmatter, related });
  }
}

/**
 * The publish -> organize hook. Scribe writes straight into `docs/`, which the `_inbox`
 * watcher never sees, so the librarian is called explicitly once a doc is approved.
 */
export async function organizePublishedDoc(vault: Vault, relPath: string): Promise<void> {
  const slug = path.basename(relPath, ".md");
  await linkRelated(vault, slug);
  await updateMoc(vault);
}

async function sectionFor(vault: Vault, dir: string): Promise<string[]> {
  const lines: string[] = [];
  for (const relPath of await vault.listNotes(dir)) {
    const note = await vault.readNote(relPath);
    const title =
      (typeof note.frontmatter.feature === "string" && note.frontmatter.feature) ||
      firstHeading(note.body) ||
      path.basename(relPath, ".md");
    lines.push(`- [[${relPath.replace(/\.md$/, "")}|${title}]]`);
  }
  return lines.length ? lines : ["- _none yet_"];
}

/** Regenerate index.md (the MOC) deterministically — idempotent by construction. */
export async function updateMoc(vault: Vault): Promise<void> {
  const sections: Array<[string, string]> = [
    ["Product docs", "docs"],
    ["PRDs", "prd"],
    ["Designs", "design"],
    ["Open gaps", "_gaps"],
    ["Lessons", "_lessons"],
  ];
  const lines: string[] = ["# Vault index", "", "_Maintained by Curator._", ""];
  for (const [heading, dir] of sections) {
    lines.push(`## ${heading}`, "", ...(await sectionFor(vault, dir)), "");
  }
  await vault.writeNote("index.md", lines.join("\n"));
}
