// The model process for desktop dictation. Electron starts it with utilityProcess.fork (stt.mjs) on the
// first dictation, so the model's memory, and any crash in its native code, stay out of the window.
// Plain Node can import it too: scripts/stt-check.mjs runs a WAV file through the same code.
//
// In:  { t: "start", id, profile?, device? } | { t: "audio", id, samples } | { t: "stop", id } | { t: "cancel", id }
// Out: { t: "status", id, phase, progress?, label? } | { t: "partial", id, text } | { t: "full", id }
//      | { t: "final", id, text, ms, audioS, engine } | { t: "error", id, code, message }
import { mkdirSync } from "node:fs";
import { DictationSession, SAMPLE_RATE, createProgress, resolveEngine } from "./sttCore.mjs";

const port = process.parentPort; // set when Electron forked this file
const post = (m) => port?.postMessage(m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODEL_DIR = process.env.HB_STT_MODEL_DIR;
const DEBUG = process.env.HB_STT_DEBUG === "1";

let engine = null; // { key, ready: Promise<{ asr, name, label }> }
let current = null; // { id, session, sent }

/** Loads the model for a profile, trying the graphics card first and the processor second. */
export function loadEngine({ profile, device, onStatus = () => {} } = {}) {
  const want = resolveEngine({ profile, device });
  const key = `${want.profile}:${want.variants.map((v) => v.name).join(",")}`;
  if (engine?.key === key) return engine.ready;
  const previous = engine?.ready;
  const ready = (async () => {
    // One model in memory at a time.
    await previous?.then((e) => e.asr.dispose?.(), () => {});
    const { env, pipeline } = await import("@huggingface/transformers");
    if (MODEL_DIR) {
      mkdirSync(MODEL_DIR, { recursive: true });
      env.cacheDir = MODEL_DIR;
    }
    let lastError = null;
    for (const v of want.variants) {
      // Already downloaded: load it without touching the network. Otherwise fetch it once.
      for (const local of [true, false]) {
        try {
          const progress = createProgress();
          if (!local) onStatus({ phase: "downloading", progress: 0, label: want.label });
          const asr = await pipeline("automatic-speech-recognition", want.model, {
            device: v.device, dtype: v.dtype, local_files_only: local,
            progress_callback: local ? undefined : (e) => {
              const pct = progress.update(e);
              if (pct !== null) onStatus({ phase: "downloading", progress: pct, label: want.label });
            },
          });
          onStatus({ phase: "loading", label: want.label });
          // The first pass compiles the graph (seconds on a graphics card). Do it now, and learn here,
          // not mid-dictation, whether this variant really runs on this machine.
          await asr(new Float32Array(SAMPLE_RATE).fill(0.0001));
          return { asr, name: v.name, label: want.label, profile: want.profile };
        } catch (err) {
          lastError = err;
          if (!local) console.error(`[stt] ${want.model} (${v.name}) did not load: ${err?.message ?? err}`);
        }
      }
    }
    throw lastError ?? new Error("No speech model could be loaded");
  })();
  engine = { key, ready };
  ready.catch(() => {
    if (engine?.ready === ready) engine = null; // let the next dictation try again
  });
  return ready;
}

const errorFor = (err) => {
  const message = String(err?.message ?? err);
  const offline = /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network|Unable to connect|local_files_only/i.test(message);
  return offline
    ? { code: "model-missing", message: "The speech model is not on this PC yet and could not be downloaded. Connect to the internet once so HomeBase can fetch it." }
    : { code: "engine", message: `The speech engine could not start: ${message.split("\n")[0].slice(0, 200)}` };
};

async function start({ id, profile, device }) {
  if (current) current.session.cancel();
  const me = { id, session: null, sent: null, ready: null };
  current = me;
  const status = (s) => current === me && post({ t: "status", id, ...s });
  status({ phase: "loading" });
  me.ready = loadEngine({ profile, device, onStatus: status });
  me.ready.catch(() => {}); // reported below
  let eng;
  me.session = new DictationSession({
    transcribe: async (samples) => {
      const t0 = performance.now();
      const out = await eng.asr(samples);
      const text = Array.isArray(out) ? out.map((o) => o.text).join(" ") : out.text;
      // HB_STT_DEBUG=1: one line per pass in the shell's log, to see what the model heard and how long it took.
      if (DEBUG) console.error(`[stt] pass: ${(samples.length / SAMPLE_RATE).toFixed(1)} s of audio in ${Math.round(performance.now() - t0)} ms -> ${JSON.stringify(text.trim())}`);
      return text;
    },
  });
  try {
    eng = await me.ready;
  } catch (err) {
    if (current === me) {
      current = null;
      post({ t: "error", id, ...errorFor(err) });
    }
    return;
  }
  me.engine = eng;
  status({ phase: "ready", label: eng.label });
  // Live text while the owner talks.
  while (current === me && !me.session.closed) {
    let text = null;
    try {
      text = await me.session.partial();
    } catch (err) {
      console.error("[stt] partial pass failed:", err?.message ?? err);
    }
    if (current !== me || me.session.closed) break;
    if (text !== null && text !== me.sent) {
      me.sent = text;
      post({ t: "partial", id, text });
    }
    if (me.session.full) {
      post({ t: "full", id });
      break;
    }
    await sleep(text === null ? 100 : 20);
  }
}

async function stop({ id }) {
  const me = current;
  if (!me || me.id !== id) return;
  const t0 = performance.now();
  try {
    const eng = await me.ready;
    const text = await me.session.finish();
    if (current !== me) return; // cancelled while the last pass ran
    current = null;
    post({ t: "final", id, text, ms: Math.round(performance.now() - t0), audioS: Math.round(me.session.seconds * 10) / 10, engine: `${eng.label} (${eng.name})` });
  } catch (err) {
    if (current !== me) return;
    current = null;
    post({ t: "error", id, ...errorFor(err) });
  }
}

function onMessage(m) {
  if (!m || typeof m !== "object") return;
  if (m.t === "start") void start(m);
  else if (m.t === "audio") {
    if (current?.id === m.id && m.samples instanceof Float32Array) current.session?.push(m.samples);
  } else if (m.t === "stop") void stop(m);
  else if (m.t === "cancel") {
    if (current?.id === m.id) {
      current.session?.cancel();
      current = null;
    }
  }
}

if (port) {
  port.on("message", (e) => onMessage(e.data));
  process.on("uncaughtException", (err) => {
    console.error("[stt] uncaught:", err);
    if (current) post({ t: "error", id: current.id, code: "engine", message: "The speech engine hit an error. Try again." });
    current = null;
  });
}
