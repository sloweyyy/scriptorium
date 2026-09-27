import { sourceHash, type Vault } from "@scriptorium/core";

/**
 * "The page that quietly went stale" — the gap that matters most, and the one nothing
 * watched. A doc records a hash of its source PRD when it is approved; this compares every
 * published doc against its source as it is NOW. Pure and deterministic: same vault, same
 * report, no clocks.
 */

export type Freshness = "fresh" | "stale" | "source-missing" | "unbaselined";

export interface DocFreshness {
  doc: string;
  status: Freshness;
  source?: string;
}

export async function checkStaleness(vault: Vault): Promise<DocFreshness[]> {
  const report: DocFreshness[] = [];
  for (const relPath of await vault.listNotes("docs")) {
    const note = await vault.readNote(relPath);
    const source = typeof note.frontmatter.source === "string" ? note.frontmatter.source.replace(/^\[\[|\]\]$/g, "") : undefined;
    const baseline = typeof note.frontmatter.source_hash === "string" ? note.frontmatter.source_hash : undefined;
    // Docs published before baselines existed are reported as such — never as stale, which
    // would flood a queue with work nobody can check.
    if (!source || !baseline) {
      report.push({ doc: relPath, status: "unbaselined", source });
      continue;
    }
    const sourcePath = `${source.replace(/\.md$/, "")}.md`;
    if (!(await vault.exists(sourcePath))) {
      report.push({ doc: relPath, status: "source-missing", source });
      continue;
    }
    const now = sourceHash((await vault.readNote(sourcePath)).body);
    report.push({ doc: relPath, status: now === baseline ? "fresh" : "stale", source });
  }
  return report.sort((a, b) => a.doc.localeCompare(b.doc));
}
