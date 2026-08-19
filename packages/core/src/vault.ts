import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";

export const VAULT_DIRS = ["_inbox", "prd", "design", "docs", "reference", "_lessons", "_gaps"] as const;
export type VaultDir = (typeof VAULT_DIRS)[number];

export type Frontmatter = Record<string, unknown>;

export interface Note {
  relPath: string;
  frontmatter: Frontmatter;
  body: string;
  raw: string;
}

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "untitled"
  );
}

export function parseMarkdown(raw: string): { frontmatter: Frontmatter; body: string } {
  const parsed = matter(raw);
  return { frontmatter: parsed.data as Frontmatter, body: parsed.content.trim() };
}

export function firstHeading(markdown: string): string | undefined {
  return markdown.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim();
}

export function extractWikilinks(text: string): string[] {
  const links = new Set<string>();
  for (const match of text.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
    const target = match[1]?.trim();
    if (target) links.add(target);
  }
  return [...links];
}

/** An Obsidian-compatible markdown vault. All writes go through here so paths can't escape it. */
export class Vault {
  constructor(readonly root: string) {}

  abs(relPath: string): string {
    const rootAbs = path.resolve(this.root);
    const resolved = path.resolve(rootAbs, relPath);
    if (resolved !== rootAbs && !resolved.startsWith(rootAbs + path.sep)) {
      throw new Error(`Path escapes the vault: ${relPath}`);
    }
    return resolved;
  }

  async ensure(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    for (const dir of VAULT_DIRS) {
      await fs.mkdir(path.join(this.root, dir), { recursive: true });
    }
    if (!(await this.exists("index.md"))) {
      await fs.writeFile(path.join(this.root, "index.md"), "# Vault index\n\n_Maintained by Curator._\n");
    }
  }

  async exists(relPath: string): Promise<boolean> {
    try {
      await fs.access(this.abs(relPath));
      return true;
    } catch {
      return false;
    }
  }

  async readNote(relPath: string): Promise<Note> {
    const raw = await fs.readFile(this.abs(relPath), "utf8");
    const { frontmatter, body } = parseMarkdown(raw);
    return { relPath: toPosix(relPath), frontmatter, body, raw };
  }

  async writeNote(relPath: string, body: string, frontmatter: Frontmatter = {}): Promise<void> {
    const absPath = this.abs(relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    const cleaned = Object.fromEntries(Object.entries(frontmatter).filter(([, value]) => value !== undefined));
    const content = body.trim() + "\n";
    const raw = Object.keys(cleaned).length ? matter.stringify(content, cleaned) : content;
    await fs.writeFile(absPath, raw);
  }

  async deleteFile(relPath: string): Promise<void> {
    await fs.rm(this.abs(relPath), { force: true });
  }

  async moveFile(fromRel: string, toRel: string): Promise<void> {
    const to = this.abs(toRel);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.rename(this.abs(fromRel), to);
  }

  /** All markdown notes under `dir` (or the whole vault), vault-relative posix paths. */
  async listNotes(dir?: string): Promise<string[]> {
    const start = dir ? this.abs(dir) : path.resolve(this.root);
    const found: string[] = [];
    const walk = async (current: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory()) await walk(entryPath);
        else if (entry.name.endsWith(".md")) found.push(toPosix(path.relative(this.root, entryPath)));
      }
    };
    await walk(start);
    return found.sort();
  }
}
