/**
 * `pnpm resign` — move approvals onto the current signing key, after a rotation.
 *
 * Rotating: set the new key as SCRIPTORIUM_SIGNING_KEY, put the old one in
 * SCRIPTORIUM_PREVIOUS_SIGNING_KEYS (still verifies, never signs), run this, then drop the old
 * key. Only a note that ALREADY verifies under a previous key is re-signed; one that verifies
 * under no key is reported and left alone — this never turns an unapproved edit into law.
 * `--dry-run` reports without writing.
 */
import path from "node:path";
import { loadConfig, previousSigningKeys, resignApproval, signedWith, Vault } from "@scriptorium/core";
import { withdrawnLessons } from "@scriptorium/scribe";

const config = loadConfig();
const dryRun = process.argv.includes("--dry-run");
const current = config.signingKey;
const previous = previousSigningKeys();
if (!current) {
  console.error("✗ SCRIPTORIUM_SIGNING_KEY is not set: there is no key to sign with.");
  process.exit(1);
}

const vault = new Vault(config.vaultDir);
// A rule a human withdrew is never moved onto the new key, whatever its note says now.
const withdrawn = await withdrawnLessons(config.jira.stateDir);
let moved = 0;
let already = 0;
const refused: string[] = [];
for (const dir of ["_lessons", "_memory"]) {
  for (const relPath of await vault.listNotes(dir)) {
    const note = await vault.readNote(relPath);
    if (note.frontmatter.status !== "approved") continue;
    if (dir === "_lessons" && typeof note.frontmatter.id === "string" && withdrawn.has(note.frontmatter.id)) {
      refused.push(relPath);
      continue;
    }
    const signer = signedWith(note.frontmatter, note.body, [current, ...previous]);
    if (signer === current) {
      already += 1;
    } else if (signer) {
      if (!dryRun) await vault.writeNote(relPath, note.body, { ...note.frontmatter, approval_sig: resignApproval(note.frontmatter, note.body, current) });
      moved += 1;
    } else {
      refused.push(relPath);
    }
  }
}
console.log(`${dryRun ? "(dry run) " : ""}${moved} re-signed with the current key, ${already} already on it.`);
for (const relPath of refused) console.log(`⚠ ${relPath}: verifies under no key — left alone; re-approve it if it should apply.`);
console.log(`\nThe control file (${path.join(config.jira.stateDir, "control.json")}) is re-signed the next time an admin changes a control.`);
