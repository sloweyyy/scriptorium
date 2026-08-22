/**
 * Seed the vault with a retrieved reference corpus — Curator's demo knowledge:
 *   pnpm seed:corpus                  # file everything into vault/reference/ now
 *   pnpm seed:corpus --inbox          # drop into vault/_inbox and let a running `pnpm dev` file it
 *   pnpm seed:corpus --dir corpus/x   # a different corpus
 *
 * Every note keeps its `source_url`, so an answer Curator gives from this material can be
 * traced back to the page it came from. Reference notes are never authored by an agent.
 *
 * The work itself lives in `@scriptorium/curator` because the deployed agent seeds on boot too —
 * a running instance with no reference material answers NOT_IN_KB to every question about
 * the very product its corpus documents.
 */
import { loadConfig, Vault } from "@scriptorium/core";
import { seedCorpus } from "@scriptorium/curator";

const argv = process.argv.slice(2);
const inboxOnly = argv.includes("--inbox");
const dirIndex = argv.indexOf("--dir");
const corpusDir = dirIndex >= 0 ? argv[dirIndex + 1] ?? "corpus" : "corpus";

const config = loadConfig();
const vault = new Vault(config.vaultDir);
await vault.ensure();

const result = await seedCorpus(vault, corpusDir, { inboxOnly });

if (!result.found) {
  console.error(`no markdown found in ${corpusDir}`);
  process.exit(1);
}
for (const name of result.skipped) {
  console.warn(`⚠️  skipped ${name}: unreadable frontmatter`);
}

console.log(
  inboxOnly
    ? `📥 dropped ${result.found} note(s) from ${corpusDir} into vault/_inbox — the watcher will file them`
    : `📚 filed ${result.filed}/${result.found} note(s) from ${corpusDir} into vault/reference/`,
);
console.log("Ask Curator about them in Slack; every answer cites the note, and each note carries its source_url.");
