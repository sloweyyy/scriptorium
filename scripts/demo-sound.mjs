/**
 * The demo's soundtrack, synthesized from the page's own cue list (window.__demo.cues), so every
 * sound lands on the frame that causes it. Nothing is sampled or downloaded: each cue is a few
 * sines or a little filtered noise, mixed over a quiet pad, in plain JavaScript.
 *
 * Deterministic: the noise comes from a seeded generator, so a re-render is byte-identical.
 * scripts/render-demo.mjs writes the result as a WAV, then loudness-normalizes it with ffmpeg.
 */
import fs from "node:fs";

export const SAMPLE_RATE = 48000;
const TAU = Math.PI * 2;

/** mulberry32: a tiny seeded PRNG, so noise is the same on every render. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Attack then exponential decay, in seconds. */
const env = (t, attack, decay) => (t < attack ? t / attack : Math.exp(-(t - attack) / decay));

/** A voice: sum of partials [ratio, gain], with a pitch that can glide from f0 to f1. */
function tone(out, at, { f0, f1 = f0, dur, attack = 0.004, decay = 0.08, gain = 0.2, partials = [[1, 1]], glide = dur }) {
  const n = Math.floor(dur * SAMPLE_RATE);
  const phases = partials.map(() => 0);
  for (let i = 0; i < n; i += 1) {
    const t = i / SAMPLE_RATE;
    const k = Math.min(1, t / glide);
    const f = f0 * Math.pow(f1 / f0, k);
    let v = 0;
    partials.forEach(([ratio, g], p) => {
      phases[p] += (TAU * f * ratio) / SAMPLE_RATE;
      v += Math.sin(phases[p]) * g;
    });
    // A short release so a voice never ends on a click.
    const tail = Math.min(1, (n - i) / (0.01 * SAMPLE_RATE));
    add(out, at + i, v * env(t, attack, decay) * gain * tail);
  }
}

/** Noise through a one-pole low-pass whose cutoff follows `cutoff(t)`. */
function noise(out, at, { dur, gain, cutoff, shape, seed }) {
  const next = rng(seed);
  const n = Math.floor(dur * SAMPLE_RATE);
  let y = 0;
  let hp = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / SAMPLE_RATE;
    const alpha = 1 - Math.exp((-TAU * cutoff(t / dur)) / SAMPLE_RATE);
    y += alpha * (next() * 2 - 1 - y);
    hp += 0.02 * (y - hp); // strip the rumble, keep the air
    add(out, at + i, (y - hp) * shape(t / dur) * gain);
  }
}

function add(out, index, value) {
  if (index >= 0 && index < out.length) out[index] += value;
}

let seedCounter = 1;
/** One synthesizer per cue type. `jitter` (0..1, seeded per cue) keeps repeats from sounding stamped. */
const VOICES = {
  // A light UI tick: something appears.
  tick: (out, at, j) => tone(out, at, { f0: 1500 * (0.96 + j * 0.08), dur: 0.09, attack: 0.002, decay: 0.022, gain: 0.07, partials: [[1, 1], [2.02, 0.25]] }),
  // A key blip, very quiet: one per typed step.
  type: (out, at, j) => {
    tone(out, at, { f0: 2600 * (0.9 + j * 0.2), dur: 0.03, attack: 0.001, decay: 0.006, gain: 0.028 });
    noise(out, at, { dur: 0.025, gain: 0.035, cutoff: () => 5000, shape: (x) => 1 - x, seed: seedCounter++ });
  },
  // A request leaving through the policy gate: a small rising glide.
  packet: (out, at) => tone(out, at, { f0: 480, f1: 820, dur: 0.18, attack: 0.01, decay: 0.07, gain: 0.05, partials: [[1, 1], [2, 0.15]] }),
  // A record coming back: the same glide, a fifth higher, brighter.
  packetBack: (out, at) => tone(out, at, { f0: 720, f1: 1180, dur: 0.18, attack: 0.008, decay: 0.07, gain: 0.05, partials: [[1, 1], [3, 0.1]] }),
  // A chapter change: a soft band of air that opens and closes.
  whoosh: (out, at) => noise(out, at, { dur: 0.6, gain: 0.15, cutoff: (x) => 300 + 2600 * Math.sin(Math.PI * x), shape: (x) => Math.pow(Math.sin(Math.PI * Math.min(1, x * 1.15)), 2), seed: seedCounter++ }),
  // Neutral: nothing found, held, skipped, already done.
  soft: (out, at) => tone(out, at, { f0: 392, dur: 0.35, attack: 0.01, decay: 0.09, gain: 0.07, partials: [[1, 1], [2, 0.2]] }),
  // Approved: two bell notes, a fifth apart.
  chime: (out, at) => {
    const bell = [[1, 1], [2.0, 0.28], [3.01, 0.1], [4.2, 0.04]];
    tone(out, at, { f0: 659.25, dur: 1.6, attack: 0.004, decay: 0.42, gain: 0.09, partials: bell });
    tone(out, at + Math.round(0.09 * SAMPLE_RATE), { f0: 987.77, dur: 1.8, attack: 0.004, decay: 0.55, gain: 0.08, partials: bell });
  },
  // Refused: two low notes stepping down, rounded, never harsh.
  deny: (out, at) => {
    const reed = [[1, 1], [3, 0.18], [5, 0.05]];
    tone(out, at, { f0: 311.13, dur: 0.16, attack: 0.006, decay: 0.12, gain: 0.11, partials: reed });
    tone(out, at + Math.round(0.14 * SAMPLE_RATE), { f0: 233.08, dur: 0.32, attack: 0.006, decay: 0.16, gain: 0.12, partials: reed });
  },
  // The "exactly once" stamp: a soft low thud with a paper click on top.
  thump: (out, at) => {
    tone(out, at, { f0: 150, f1: 52, dur: 0.35, attack: 0.002, decay: 0.12, gain: 0.12, glide: 0.18 });
    noise(out, at, { dur: 0.04, gain: 0.06, cutoff: () => 3500, shape: (x) => 1 - x, seed: seedCounter++ });
  },
  // Title and end cards: a slow, open chord.
  swell: (out, at) => {
    for (const [f, g] of [[220, 0.05], [277.18, 0.04], [329.63, 0.04], [440, 0.03], [659.25, 0.015]]) {
      tone(out, at, { f0: f, dur: 3.2, attack: 0.5, decay: 1.1, gain: g, partials: [[1, 1], [2, 0.12]] });
    }
  },
};

/** A barely-there pad under everything: a low open fifth that breathes, faded in and out. */
function bed(out) {
  const voices = [[110, 0.017, 0.07], [164.81, 0.013, 0.05], [246.94, 0.007, 0.09], [329.63, 0.004, 0.11]];
  const total = out.length / SAMPLE_RATE;
  const phases = voices.map(() => 0);
  for (let i = 0; i < out.length; i += 1) {
    const t = i / SAMPLE_RATE;
    const fade = Math.min(1, t / 2.5, (total - t) / 3);
    let v = 0;
    voices.forEach(([f, g, lfo], p) => {
      phases[p] += (TAU * f * (1 + 0.0015 * Math.sin(TAU * 0.13 * t + p))) / SAMPLE_RATE;
      v += Math.sin(phases[p]) * g * (0.65 + 0.35 * Math.sin(TAU * lfo * t + p * 1.7));
    });
    out[i] += v * Math.max(0, fade);
  }
}

/**
 * The soundtrack for `cues` ({type, t} in ms) over `durationMs`. Repeats of one type closer than
 * `minGap` ms are merged, so a burst of pops reads as a flourish, not a buzz.
 */
export function soundtrack(cues, durationMs, { minGap = 55 } = {}) {
  seedCounter = 1;
  const out = new Float32Array(Math.ceil((durationMs / 1000 + 0.5) * SAMPLE_RATE));
  bed(out);
  const lastAt = {};
  const jitter = rng(7);
  for (const { type, t } of [...cues].sort((a, b) => a.t - b.t)) {
    const voice = VOICES[type];
    if (!voice) throw new Error(`demo sound: no voice for cue "${type}"`);
    const j = jitter();
    if (lastAt[type] !== undefined && t - lastAt[type] < minGap) continue;
    lastAt[type] = t;
    voice(out, Math.round((t / 1000) * SAMPLE_RATE), j);
  }
  // A soft ceiling: nothing reaches full scale, whatever stacks up.
  for (let i = 0; i < out.length; i += 1) out[i] = Math.tanh(out[i] * 1.2) / 1.2;
  return out;
}

/** A 32-bit float mono WAV. */
export function writeWav(file, samples) {
  const header = Buffer.alloc(44);
  const bytes = samples.length * 4;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + bytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20); // IEEE float
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(32, 34);
  header.write("data", 36);
  header.writeUInt32LE(bytes, 40);
  fs.writeFileSync(file, Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, bytes)]));
}
