/**
 * Seed the vault with a retrieved reference corpus — Curator's demo knowledge:
 *   pnpm seed:corpus                  # file everything into vault/reference/ now
 *   pnpm seed:corpus --inbox          # drop into vault/_inbox and let a running `pnpm dev` file it
 *   pnpm seed:corpus --dir corpus/x   # a different corpus
 *
 * Every note keeps its `source_url`, so an answer Curator gives from this material can be
 * traced back to the page it came from. Reference notes are never authored by an agent.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig, parseMarkdown, slugify, Vault } from "@scriptorium/core";
import { organizeInboxFile, updateMoc } from "@scriptorium/curator";

const argv = process.argv.slice(2);
const inboxOnly = argv.includes("--inbox");
const dirIndex = argv.indexOf("--dir");
const corpusDir = dirIndex >= 0 ? argv[dirIndex + 1] ?? "corpus" : "corpus";

const config = loadConfig();
const vault = new Vault(config.vaultDir);
await vault.ensure();

const entries = (await fs.readdir(corpusDir))
  .filter((name) => name.endsWith(".md") && name.toLowerCase() !== "readme.md")
  .sort();

if (!entries.length) {
  console.error(`no markdown found in ${corpusDir}`);
  process.exit(1);
}

let filed = 0;
for (const name of entries) {
  const raw = await fs.readFile(path.join(corpusDir, name), "utf8");
  let frontmatter: Record<string, unknown>;
  let body: string;
  try {
    ({ frontmatter, body } = parseMarkdown(raw));
  } catch (error) {
    // One malformed page must not stop the seeding run — say which, and move on.
    console.warn(`⚠️  skipped ${name}: unreadable frontmatter (${error instanceof Error ? error.message.split("\n")[0] : error})`);
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

  if (!inboxOnly) {
    const result = await organizeInboxFile(vault, `_inbox/${slug}.md`);
    if (result.action !== "skipped") filed += 1;
  }
}

await updateMoc(vault);

console.log(
  inboxOnly
    ? `📥 dropped ${entries.length} note(s) from ${corpusDir} into vault/_inbox — the watcher will file them`
    : `📚 filed ${filed}/${entries.length} note(s) from ${corpusDir} into vault/reference/`,
);
console.log("Ask Curator about them in Slack; every answer cites the note, and each note carries its source_url.");
