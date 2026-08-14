/** Rasterize samples/wireframes/*.svg to PNG (Claude vision does not take SVG). */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const dir = "samples/wireframes";
const files = (await fs.readdir(dir)).filter((name) => name.endsWith(".svg"));

for (const file of files) {
  const source = path.join(dir, file);
  const target = source.replace(/\.svg$/, ".png");
  await sharp(source, { density: 144 }).resize({ width: 1200 }).png().toFile(target);
  console.log(`${source} -> ${target}`);
}
if (!files.length) console.log("no SVG wireframes found");
