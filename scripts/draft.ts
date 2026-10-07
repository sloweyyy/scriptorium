/**
 * End-to-end Scribe pipeline without Slack:
 *   pnpm draft samples/prd-001-scheduled-maintenance.md [wireframe.png ...]
 * Runs contract -> draft (with vision) -> lint, writes the draft to out/.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { docSlug, geminiModel, loadConfig, Vault, type ImageInput } from "@scriptorium/core";
import { checkContract, draftDoc, formatContractQuestions, formatLintFindings, withdrawnLessons } from "@scriptorium/scribe";

const [prdPath, ...imagePaths] = process.argv.slice(2);
if (!prdPath) {
  console.error("usage: pnpm draft <prd.md> [image.png ...]");
  process.exit(1);
}

const config = loadConfig();
const vault = new Vault(config.vaultDir);
await vault.ensure();

const prdRaw = await fs.readFile(prdPath, "utf8");
const contract = checkContract(prdRaw);
if (!contract.ok) {
  console.error("🚫 Contract failed — the PRD is missing:");
  console.error(formatContractQuestions(contract).replace(/\*/g, ""));
  process.exit(1);
}
console.log("✅ contract OK");

const MEDIA_TYPES: Record<string, ImageInput["mediaType"]> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const images: ImageInput[] = [];
for (const imagePath of imagePaths) {
  const mediaType = MEDIA_TYPES[path.extname(imagePath).toLowerCase()];
  if (!mediaType) {
    console.warn(`skipping ${imagePath} — unsupported image type (Claude vision takes png/jpeg/webp/gif)`);
    continue;
  }
  images.push({ mediaType, base64: (await fs.readFile(imagePath)).toString("base64") });
}
console.log(`drafting via ${config.provider} with ${config.provider === "gemini" ? geminiModel() : config.model}, ${images.length} design image(s) attached…`);

const result = await draftDoc(vault, prdRaw, images, { withdrawn: await withdrawnLessons(config.jira.stateDir) });

console.log("\n----- lint -----");
console.log(formatLintFindings(result.lint));
console.log(`applied lessons: ${result.appliedLessons.join(", ") || "(none yet)"}`);

const slug = docSlug(String(contract.frontmatter.feature));
const outPath = path.join("out", `draft-${slug}.md`);
await fs.mkdir("out", { recursive: true });
await fs.writeFile(outPath, result.markdown + "\n");
console.log(`\n📝 draft written to ${outPath}`);
