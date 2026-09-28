/**
 * Render the animated demo (site/demo/index.html) to video, frame-perfectly.
 *
 * The page's timeline is a set of paused Web Animations driven by `window.__demo.seek(ms)`,
 * so each frame is set exactly, never captured in real time. Needs a Chromium and ffmpeg:
 *
 *   npx -y -p playwright-core@1.49 node scripts/render-demo.mjs            # site/demo/demo.mp4 + poster.png
 *   npx -y -p playwright-core@1.49 node scripts/render-demo.mjs --stills 6,14,36   # preview frames only
 *
 * CHROMIUM=/path/to/chrome overrides the browser; FPS=30 the frame rate.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const page = pathToFileURL(path.join(root, "site/demo/index.html")).href + "?render";
const out = path.join(root, "site/demo");
const fps = Number(process.env.FPS ?? 30);

function findChromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
  for (const dir of fs.existsSync(cache) ? fs.readdirSync(cache).sort().reverse() : []) {
    if (!dir.startsWith("chromium")) continue;
    for (const candidate of [
      "chrome-headless-shell-mac-arm64/chrome-headless-shell",
      "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
      "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium",
      "chrome-linux/chrome",
    ]) {
      const full = path.join(cache, dir, candidate);
      if (fs.existsSync(full)) return full;
    }
  }
  return undefined;
}

const stillsArg = process.argv.indexOf("--stills");
const stills = stillsArg >= 0 ? process.argv[stillsArg + 1].split(",").map(Number) : undefined;

const browser = await chromium.launch({ executablePath: findChromium() });
const tab = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await tab.goto(page, { waitUntil: "networkidle" });
await tab.evaluate(() => window.__demo.ready);
const stage = tab.locator("#stage");
const duration = await tab.evaluate(() => window.__demo.duration);

if (stills) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-stills-"));
  for (const second of stills) {
    await tab.evaluate((ms) => window.__demo.seek(ms), second * 1000);
    await stage.screenshot({ path: path.join(dir, `t${String(second).padStart(3, "0")}.png`) });
  }
  console.log(dir);
} else {
  const frames = fs.mkdtempSync(path.join(os.tmpdir(), "demo-frames-"));
  const total = Math.ceil((duration / 1000) * fps);
  for (let frame = 0; frame <= total; frame += 1) {
    await tab.evaluate((ms) => window.__demo.seek(ms), (frame * 1000) / fps);
    await stage.screenshot({ path: path.join(frames, `f${String(frame).padStart(5, "0")}.png`) });
    if (frame % (fps * 10) === 0) console.log(`frame ${frame}/${total}`);
  }
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", path.join(frames, "f%05d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-preset", "slow", "-movflags", "+faststart", path.join(out, "demo.mp4")]);
  // The poster: the cited-answer frame, which says the most at a glance.
  fs.copyFileSync(path.join(frames, `f${String(Math.round(14 * fps)).padStart(5, "0")}.png`), path.join(out, "poster.png"));
  fs.rmSync(frames, { recursive: true, force: true });
  console.log(`wrote ${path.join(out, "demo.mp4")}`);
}
await browser.close();
