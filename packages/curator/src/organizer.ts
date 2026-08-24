import path from "node:path";
import { firstHeading, slugify, type Note, type Vault } from "@scriptorium/core";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);

export interface OrganizeResult {
  action: "filed-prd" | "filed-doc" | "filed-design" | "filed-reference" | "skipped";
  from: string;
  to?: string;
  note?: string;
}

function classifyMarkdown(note: Note): "prd" | "docs" | "reference" {
  const kind = String(note.frontmatter.kind ?? "").toLowerCase();
  if (kind === "prd") return "prd";
  // Retrieved external material: kept apart from what this team authored.
  if (kind === "reference") return "reference";
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
    // An explicit slug wins: retrieved pages carry stable ids and often share a title.
    const slug = typeof note.frontmatter.slug === "string" && note.frontmatter.slug ? slugify(note.frontmatter.slug) : slugify(feature);
    const to = `${kind}/${slug}.md`;
    const KINDS = { prd: "prd", docs: "doc", reference: "reference" } as const;
    await vault.writeNote(to, note.body, {
      ...note.frontmatter,
      kind: KINDS[kind],
      feature,
      filed: new Date().toISOString(),
    });
    await vault.deleteFile(relPath);
    await linkRelated(vault, slug);
    await updateMoc(vault);
    const action = kind === "prd" ? "filed-prd" : kind === "reference" ? "filed-reference" : "filed-doc";
    return { action, from: relPath, to };
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

/**
 * A lesson's line in the index says where it stands with a human.
 *
 * Without this the index lists approved, proposed and rejected rules as identical
 * wikilinks — and the index is a vault note like any other, so "what are the house rules?"
 * retrieves it and reads a refused rule as a rule. Closing that on the notes themselves
 * (`rejectionNotice`) is not enough while the note that *lists* them says nothing: the
 * index has no status of its own to carry.
 */
function lessonStanding(status: unknown): string {
  if (status === "approved") return " — approved, applies to every draft";
  if (status === "rejected") return " — REJECTED by a human, never apply this";
  return " — proposed, not yet judged by a human";
}

async function sectionFor(vault: Vault, dir: string, limit?: number): Promise<string[]> {
  const lines: string[] = [];
  for (const relPath of await vault.listNotes(dir)) {
    const note = await vault.readNote(relPath);
    const title =
      (typeof note.frontmatter.feature === "string" && note.frontmatter.feature) ||
      firstHeading(note.body) ||
      path.basename(relPath, ".md");
    const standing = dir === "_lessons" ? lessonStanding(note.frontmatter.status) : "";
    lines.push(`- [[${relPath.replace(/\.md$/, "")}|${title}]]${standing}`);
  }
  if (limit && lines.length > limit) {
    // Retrieved reference material is bulk; the index stays a map, not a dump.
    return [...lines.slice(0, limit), `- _…and ${lines.length - limit} more in \`${dir}/\`_`];
  }
  return lines.length ? lines : ["- _none yet_"];
}

/** Regenerate index.md (the MOC) deterministically — idempotent by construction. */
export async function updateMoc(vault: Vault): Promise<void> {
  const sections: Array<[string, string, number?]> = [
    ["Product docs", "docs"],
    ["PRDs", "prd"],
    ["Designs", "design"],
    ["Reference (retrieved sources)", "reference", 10],
    ["Open gaps", "_gaps"],
    ["Lessons", "_lessons"],
  ];
  const lines: string[] = ["# Vault index", "", "_Maintained by Curator._", ""];
  for (const [heading, dir, limit] of sections) {
    lines.push(`## ${heading}`, "", ...(await sectionFor(vault, dir, limit)), "");
  }
  await vault.writeNote("index.md", lines.join("\n"));
}
