#!/usr/bin/env node
// Runs a WAV file through the desktop dictation engine, without Electron and without a microphone.
//   node scripts/stt-check.mjs clip.wav [--profile fast|accurate] [--device auto|gpu|cpu] [--realtime]
// --realtime feeds the file at speaking speed and prints the live text, the way the app sees it.
// The model is read from (and on first use downloaded to) the same folder the app uses.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? undefined : args[i + 1];
};
const file = args.find((a, i) => !a.startsWith("--") && !(args[i - 1]?.startsWith("--") && args[i - 1] !== "--realtime"));
if (!file) {
  console.error("usage: node scripts/stt-check.mjs clip.wav [--profile fast|accurate] [--device auto|gpu|cpu] [--realtime]");
  process.exit(2);
}
process.env.HB_STT_MODEL_DIR ||= process.platform === "win32" && process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, "HomeBase", "models") : join(homedir(), ".cache", "homebase", "models");

const { DictationSession, SAMPLE_RATE } = await import("../apps/desktop/sttCore.mjs");
const { loadEngine } = await import("../apps/desktop/sttWorker.mjs");

/** 16-bit PCM WAV of any rate and channel count, as 16 kHz mono floats. */
function readWav(path) {
  const b = readFileSync(path);
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") throw new Error("Not a WAV file");
  let off = 12, fmt = null;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4), size = b.readUInt32LE(off + 4);
    if (id === "fmt ") fmt = { format: b.readUInt16LE(off + 8), channels: b.readUInt16LE(off + 10), rate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    if (id === "data") {
      if (!fmt || fmt.format !== 1 || fmt.bits !== 16) throw new Error("Only 16-bit PCM WAV files are supported");
      const n = Math.floor(Math.min(size, b.length - off - 8) / 2 / fmt.channels);
      const mono = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let c = 0; c < fmt.channels; c++) s += b.readInt16LE(off + 8 + (i * fmt.channels + c) * 2);
        mono[i] = s / fmt.channels / 32768;
      }
      if (fmt.rate === SAMPLE_RATE) return mono;
      const m = Math.floor((n * SAMPLE_RATE) / fmt.rate), out = new Float32Array(m);
      for (let i = 0; i < m; i++) {
        const x = (i * fmt.rate) / SAMPLE_RATE, j = Math.floor(x), t = x - j;
        out[i] = mono[j] * (1 - t) + (mono[j + 1] ?? mono[j]) * t;
      }
      return out;
    }
    off += 8 + size + (size % 2);
  }
  throw new Error("No audio data in the WAV file");
}

const audio = readWav(file);
let t = performance.now();
const eng = await loadEngine({
  profile: flag("profile"), device: flag("device"),
  onStatus: (s) => s.phase === "downloading" && process.stderr.write(`\rdownloading ${s.label} ${s.progress}%   `),
});
console.log(`engine: ${eng.label} (${eng.name}), ready in ${Math.round(performance.now() - t)} ms; model folder ${process.env.HB_STT_MODEL_DIR}`);

const session = new DictationSession({ transcribe: async (samples) => (await eng.asr(samples)).text });
const realtime = args.includes("--realtime");
const CHUNK = SAMPLE_RATE / 10;
if (realtime) {
  const began = performance.now();
  let live = true, shown = null;
  const loop = (async () => {
    while (live) {
      const text = await session.partial();
      if (text !== null && text !== shown) console.log(`  ${((performance.now() - began) / 1000).toFixed(1)} s  ${(shown = text)}`);
      await new Promise((r) => setTimeout(r, text === null ? 100 : 20));
    }
  })();
  for (let i = 0; i < audio.length; i += CHUNK) {
    session.push(audio.subarray(i, i + CHUNK));
    await new Promise((r) => setTimeout(r, 100));
  }
  live = false;
  t = performance.now();
  const text = await session.finish();
  await loop;
  console.log(`final (${Math.round(performance.now() - t)} ms after the last word, ${(audio.length / SAMPLE_RATE).toFixed(1)} s of audio):\n${text}`);
} else {
  for (let i = 0; i < audio.length; i += CHUNK) session.push(audio.subarray(i, i + CHUNK));
  t = performance.now();
  const text = await session.finish();
  console.log(`final (${Math.round(performance.now() - t)} ms for ${(audio.length / SAMPLE_RATE).toFixed(1)} s of audio):\n${text}`);
}
process.exit(0);
