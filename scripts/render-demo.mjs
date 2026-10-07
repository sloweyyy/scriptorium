/**
 * Render the animated demo (site/demo/index.html) to video, frame-perfectly, with its soundtrack.
 *
 * The page's timeline is a set of paused Web Animations driven by `window.__demo.seek(ms)`,
 * so each frame is set exactly, never captured in real time. The same page lists its sound
 * cues (`window.__demo.cues`); scripts/demo-sound.mjs synthesizes the soundtrack from them, so
 * sound and picture come from one timeline. Needs a Chromium and ffmpeg:
 *
 *   npx -y -p playwright-core@1.49 node scripts/render-demo.mjs            # both themes, below
 *   npx -y -p playwright-core@1.49 node scripts/render-demo.mjs --stills 6,14,36   # preview frames only
 *   npx -y -p playwright-core@1.49 node scripts/render-demo.mjs --audio-only        # new soundtrack, same picture
 *
 * Writes, per theme: site/demo/demo.mp4, highlight.mp4 (the 20-second cut the project page
 * plays) and poster.png (dark), and the same with -light. THEMES=light renders one;
 * CHROMIUM=/path/to/chrome overrides the browser; FPS=30 the rate.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { soundtrack, writeWav, SAMPLE_RATE } from "./demo-sound.mjs";

const require = createRequire(import.meta.url);
/** playwright-core from the repo, or from the `npx -p playwright-core` that runs this (on PATH). */
function loadPlaywright() {
  try {
    return require("playwright-core");
  } catch {
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      const candidate = path.join(dir, "..", "playwright-core");
      if (dir.endsWith(path.join("node_modules", ".bin")) && fs.existsSync(candidate)) return require(candidate);
    }
    throw new Error("playwright-core not found: run this with npx -y -p playwright-core@1.49 node scripts/render-demo.mjs");
  }
}
const { chromium } = loadPlaywright();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pageFor = (theme) => `${pathToFileURL(path.join(root, "site/demo/index.html")).href}?render&theme=${theme}`;
const themes = (process.env.THEMES ?? "dark,light").split(",");
const suffix = (theme) => (theme === "dark" ? "" : `-${theme}`);
const out = path.join(root, "site/demo");
const fps = Number(process.env.FPS ?? 30);
/** Loudness target: -16 LUFS integrated, true peak under -1.5 dBTP. */
const LOUDNESS = { I: -16, TP: -1.5, LRA: 11 };
const CROSSFADE = 0.4;

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

const ffmpeg = (args) => execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args]);

/**
 * The cues as a WAV at the loudness target. A soundtrack of short cues is mostly quiet with a
 * few peaks, so a gentle compressor evens the peaks first; then one measured gain moves it to
 * -16 LUFS, or less if that would push a true peak past -1.5 dBTP. Nothing is limited hard.
 */
function renderSoundtrack(cues, durationMs, dir) {
  const raw = path.join(dir, "raw.wav");
  writeWav(raw, soundtrack(cues, durationMs));
  const target = `I=${LOUDNESS.I}:TP=${LOUDNESS.TP}:LRA=${LOUDNESS.LRA}`;
  const compressed = path.join(dir, "compressed.wav");
  ffmpeg(["-i", raw, "-af", "acompressor=threshold=0.06:ratio=3:attack=3:release=120:knee=4", "-c:a", "pcm_f32le", compressed]);
  const m = measure(compressed, `loudnorm=${target}:print_format=json`);
  const gain = Math.min(LOUDNESS.I - Number(m.input_i), LOUDNESS.TP - Number(m.input_tp));
  const normalized = path.join(dir, "soundtrack.wav");
  ffmpeg(["-i", compressed, "-af", `volume=${gain.toFixed(2)}dB`, "-ar", String(SAMPLE_RATE), "-ac", "1", "-c:a", "pcm_f32le", normalized]);
  const after = measure(normalized, `loudnorm=${target}:print_format=json`);
  console.log(`soundtrack: ${cues.length} cues, ${Number(after.input_i).toFixed(1)} LUFS, true peak ${Number(after.input_tp).toFixed(1)} dBTP (gain ${gain.toFixed(1)} dB)`);
  return normalized;
}

/** ffmpeg's loudnorm measurement, parsed from the JSON it prints on stderr. */
function measure(file, filter) {
  const run = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", filter, "-f", "null", "-"], { encoding: "utf8" });
  const json = run.stderr.slice(run.stderr.lastIndexOf("{"), run.stderr.lastIndexOf("}") + 1);
  if (run.status !== 0 || !json) throw new Error(`loudness measurement failed: ${run.stderr.slice(-400)}`);
  return JSON.parse(json);
}

const stillsArg = process.argv.indexOf("--stills");
const stills = stillsArg >= 0 ? process.argv[stillsArg + 1].split(",").map(Number) : undefined;
const audioOnly = process.argv.includes("--audio-only");
const soundArg = process.argv.indexOf("--sound");
/** --sound <file.wav>: write the soundtrack alone, to listen to, and render nothing else. */
const soundOnly = soundArg >= 0 ? path.resolve(process.argv[soundArg + 1]) : undefined;

const browser = await chromium.launch({ executablePath: findChromium() });
for (const theme of themes) {
  const tab = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  await tab.goto(pageFor(theme), { waitUntil: "networkidle" });
  await tab.evaluate(() => window.__demo.ready);
  const stage = tab.locator("#stage");
  const { duration, cues, highlight, posterAt } = await tab.evaluate(() => {
    const { duration, cues, highlight, posterAt } = window.__demo;
    return { duration, cues, highlight, posterAt };
  });

  if (stills) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `demo-stills-${theme}-`));
    for (const second of stills) {
      await tab.evaluate((ms) => window.__demo.seek(ms), second * 1000);
      await stage.screenshot({ path: path.join(dir, `t${String(second).padStart(3, "0")}.png`) });
    }
    console.log(dir);
    await tab.close();
    continue;
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), `demo-render-${theme}-`));
  const video = path.join(out, `demo${suffix(theme)}.mp4`);
  const audio = renderSoundtrack(cues, duration, work);
  if (soundOnly) {
    fs.copyFileSync(audio, soundOnly);
    console.log(`wrote ${soundOnly}`);
    fs.rmSync(work, { recursive: true, force: true });
    break;
  }

  if (audioOnly) {
    // Keep the picture that is already there; replace only its sound.
    const picture = path.join(work, "picture.mp4");
    ffmpeg(["-i", video, "-map", "0:v:0", "-c", "copy", picture]);
    mux(picture, audio, video);
  } else {
    const frames = path.join(work, "frames");
    fs.mkdirSync(frames);
    const total = Math.ceil((duration / 1000) * fps);
    for (let frame = 0; frame <= total; frame += 1) {
      await tab.evaluate((ms) => window.__demo.seek(ms), (frame * 1000) / fps);
      await stage.screenshot({ path: path.join(frames, `f${String(frame).padStart(5, "0")}.png`) });
      if (frame % (fps * 10) === 0) console.log(`${theme}: frame ${frame}/${total}`);
    }
    const picture = path.join(work, "picture.mp4");
    ffmpeg(["-framerate", String(fps), "-i", path.join(frames, "f%05d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-preset", "slow", picture]);
    mux(picture, audio, video);
    fs.copyFileSync(path.join(frames, `f${String(Math.round((posterAt / 1000) * fps)).padStart(5, "0")}.png`), path.join(out, `poster${suffix(theme)}.png`));
  }
  console.log(`wrote ${video}`);
  const clip = path.join(out, `highlight${suffix(theme)}.mp4`);
  cutHighlight(video, highlight, clip);
  console.log(`wrote ${clip}`);
  fs.rmSync(work, { recursive: true, force: true });
  await tab.close();
}
await browser.close();

/** Picture + soundtrack: mono AAC at 64k keeps the sound small next to the video. */
function mux(picture, audio, target) {
  ffmpeg(["-i", picture, "-i", audio, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "64k", "-ac", "1", "-ar", String(SAMPLE_RATE), "-shortest", "-movflags", "+faststart", target]);
}

/** The highlight: each range cut from the full video, joined by a short crossfade in picture and sound. */
function cutHighlight(source, ranges, target) {
  const parts = ranges.map(([from, to], i) => {
    const a = (from / 1000).toFixed(3);
    const b = (to / 1000).toFixed(3);
    return `[0:v]trim=start=${a}:end=${b},setpts=PTS-STARTPTS[v${i}];[0:a]atrim=start=${a}:end=${b},asetpts=PTS-STARTPTS[a${i}]`;
  });
  let graph = parts.join(";");
  let offset = 0;
  let v = "v0";
  let a = "a0";
  for (let i = 1; i < ranges.length; i += 1) {
    offset += (ranges[i - 1][1] - ranges[i - 1][0]) / 1000 - CROSSFADE;
    graph += `;[${v}][v${i}]xfade=transition=fade:duration=${CROSSFADE}:offset=${offset.toFixed(3)}[vx${i}];[${a}][a${i}]acrossfade=d=${CROSSFADE}[ax${i}]`;
    v = `vx${i}`;
    a = `ax${i}`;
  }
  ffmpeg(["-i", source, "-filter_complex", graph, "-map", `[${v}]`, "-map", `[${a}]`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "22", "-preset", "slow", "-c:a", "aac", "-b:a", "64k", "-ac", "1", "-movflags", "+faststart", target]);
}
