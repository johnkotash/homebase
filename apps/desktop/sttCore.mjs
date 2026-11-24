// Speech-to-text for the desktop window: the parts that need neither Electron nor the model, so they
// can be tested (apps/desktop/test/stt.test.ts). sttWorker.mjs runs the model, stt.mjs wires the IPC.
//
// The engine is Whisper, run locally through onnxruntime (see docs/DESKTOP-DICTATION.md for why).
// Whisper is not a streaming recognizer: it turns a clip of up to 30 seconds into text in one pass.
// DictationSession makes that feel live. While you talk it re-reads the clip so far about once a
// second (the "partial" text), and when the clip gets long it settles everything up to a quiet moment
// and starts a new clip, so a dictation can be as long as you like.

export const SAMPLE_RATE = 16000;
/** Whisper reads at most 30 seconds in one pass; stay a little under. */
export const MAX_PASS_S = 28;

/**
 * Which model to run, and how. Each profile lists what to try in order: the graphics card first
 * (DirectML, Windows only), then the processor, which works everywhere.
 * Sizes are the download, kept in the model folder (never in the source tree).
 */
export const PROFILES = {
  fast: {
    label: "Whisper base.en",
    model: "onnx-community/whisper-base.en",
    variants: [
      { name: "gpu", platforms: ["win32"], device: "dml", dtype: "fp32", sizeMB: 291 },
      { name: "cpu", device: "cpu", dtype: "q8", sizeMB: 77 },
    ],
  },
  accurate: {
    label: "Whisper small.en",
    model: "onnx-community/whisper-small.en",
    variants: [
      // The half-precision decoder of this model does not load in onnxruntime, so only the encoder (the
      // heavy part) runs on the graphics card.
      { name: "gpu", platforms: ["win32"], device: { encoder_model: "dml", decoder_model_merged: "cpu" }, dtype: { encoder_model: "fp16", decoder_model_merged: "q8" }, sizeMB: 334 },
      { name: "cpu", device: "cpu", dtype: "q8", sizeMB: 249 },
    ],
  },
};
export const DEFAULT_PROFILE = "fast";

/**
 * The variants to try, in order. `device`: "auto" (graphics card, then processor), "gpu" or "cpu".
 * @returns {{ profile: string, label: string, model: string, variants: any[] }}
 */
export function resolveEngine({ profile, device = "auto", platform = process.platform } = {}) {
  const key = profile && Object.hasOwn(PROFILES, profile) ? profile : DEFAULT_PROFILE;
  const p = PROFILES[key];
  const usable = p.variants.filter((v) => !v.platforms || v.platforms.includes(platform));
  const want = device === "cpu" || device === "gpu" ? device : "auto";
  let variants = want === "auto" ? usable : usable.filter((v) => v.name === want);
  if (!variants.length) variants = usable.filter((v) => v.name === "cpu"); // asked for a card this platform cannot use
  return { profile: key, label: p.label, model: p.model, variants };
}

// ---------------------------------------------------------------- audio helpers

/** Root mean square of a stretch of samples: how loud it is, 0 (silence) to about 0.5 (shouting). */
export function rms(samples, from = 0, to = samples.length) {
  const a = Math.max(0, from), b = Math.min(samples.length, to);
  if (b <= a) return 0;
  let sum = 0;
  for (let i = a; i < b; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (b - a));
}

const FRAME = Math.round(SAMPLE_RATE * 0.03); // 30 ms
/** How much silence after the last sound a pass must have heard before later silence is skipped. */
const QUIET_TAIL = Math.round(SAMPLE_RATE * 0.3);
/** Above a quiet room's hiss, below soft speech. */
export const SPEECH_RMS = 0.006;

/** True when at least `minMs` of the clip is louder than a quiet room. Whisper invents words for silence, so silence never reaches it. */
export function hasSpeech(samples, { threshold = SPEECH_RMS, minMs = 150 } = {}) {
  let loud = 0;
  const need = Math.ceil(minMs / 30);
  for (let i = 0; i + FRAME <= samples.length; i += FRAME) {
    if (rms(samples, i, i + FRAME) > threshold && ++loud >= need) return true;
  }
  return false;
}

/** Cuts the silence before the first and after the last sound, keeping `padMs` on each side. */
export function trimSilence(samples, { threshold = SPEECH_RMS, padMs = 240 } = {}) {
  let first = -1, last = -1;
  for (let i = 0; i + FRAME <= samples.length; i += FRAME) {
    if (rms(samples, i, i + FRAME) > threshold) {
      if (first < 0) first = i;
      last = i + FRAME;
    }
  }
  if (first < 0) return samples.subarray(0, 0);
  const pad = Math.round((padMs / 1000) * SAMPLE_RATE);
  return samples.subarray(Math.max(0, first - pad), Math.min(samples.length, last + pad));
}

/**
 * Where to split a long clip: the middle of a pause of `windowMs` between `fromS` and `toS`, so the
 * cut lands between words and not inside one. Of the pauses that are about as quiet as the quietest
 * one, the last is taken: more of the clip is settled, and less is left to read again.
 */
export function findCutPoint(samples, { fromS, toS, windowMs = 300 } = {}) {
  const win = Math.round((windowMs / 1000) * SAMPLE_RATE);
  const step = Math.round(SAMPLE_RATE * 0.05);
  const start = Math.max(0, Math.round(fromS * SAMPLE_RATE));
  const end = Math.min(samples.length, Math.round(toS * SAMPLE_RATE));
  const levels = [];
  let quietest = Infinity;
  for (let i = start; i + win <= end; i += step) {
    const level = rms(samples, i, i + win);
    levels.push([i, level]);
    if (level < quietest) quietest = level;
  }
  if (!levels.length) return Math.min(samples.length, end);
  // A real microphone never gives true silence: a pause is anything near the quietest stretch, or below soft speech.
  const pause = Math.max(quietest * 1.5, Math.min(SPEECH_RMS, quietest * 4));
  let best = levels[0][0];
  for (const [i, level] of levels) if (level <= pause) best = i;
  return best + Math.round(win / 2);
}

// ---------------------------------------------------------------- text helpers

// Whisper writes these for sounds that are not speech. They are not something the owner said.
const NON_SPEECH = /[\[(]\s*(blank[ _]?audio|silence|silent|no (audio|speech|sound)|inaudible|music( playing)?|applause|laughter|laughs|noise|background noise|static|sound|sounds|beep|sigh|sighs|cough|coughs|coughing|breathing|typing|keyboard clicking|clicking|click)\s*[\])]/gi;

/** One clean line of text from a model reply: no non-speech tags, single spaces. */
export function cleanTranscript(text) {
  if (typeof text !== "string") return "";
  const clean = text.replace(NON_SPEECH, " ").replace(/\s+/g, " ").replace(/\s+([,.!?;:])/g, "$1").trim();
  // A lone "you" is what Whisper writes for a cough or a chair, and never a whole message. Punctuation alone is nothing.
  return /^(you)?[\s.,!?-]*$/i.test(clean) ? "" : clean;
}

/** Joins settled text and the next piece with one space. */
export const joinText = (a, b) => (a && b ? `${a} ${b}` : a || b || "");

// ---------------------------------------------------------------- one dictation

/**
 * One dictation, from the first sample to the final text. `transcribe(samples)` is the model: a clip of
 * at most 30 seconds in, text out. Only one call runs at a time.
 */
export class DictationSession {
  /**
   * @param {{ transcribe: (samples: Float32Array) => Promise<string>, settleAfterS?: number, keepS?: number, maxS?: number }} o
   *   settleAfterS: once the open clip is this long, settle its start (a short open clip keeps each pass quick). keepS: always keep at least this
   *   much of the end open, because the last words are still changing. maxS: a hard cap on the whole dictation.
   */
  constructor({ transcribe, settleAfterS = 12, keepS = 1.5, maxS = 600 }) {
    this.transcribe = transcribe;
    this.settleAfterS = settleAfterS;
    this.keepS = keepS;
    this.maxSamples = Math.round(maxS * SAMPLE_RATE);
    /** Text that will not change any more. */
    this.settled = "";
    /** The open clip, as the chunks that arrived. */
    this.chunks = [];
    this.openSamples = 0;
    this.totalSamples = 0;
    /** `totalSamples` when the last pass started: a new pass is only worth it when this has moved. */
    this.readUpTo = -1;
    this.lastPartial = "";
    /** Where the last loud 30 ms of the whole dictation ended, in samples; -1 before any sound. */
    this.lastVoiceAt = -1;
    this.frameSum = 0;
    this.frameCount = 0;
    this.queue = Promise.resolve();
    this.closed = false;
  }

  get seconds() {
    return this.totalSamples / SAMPLE_RATE;
  }
  /** True when the dictation has reached its cap; the caller should stop it. */
  get full() {
    return this.totalSamples >= this.maxSamples;
  }

  /** Adds microphone audio (16 kHz mono). */
  push(chunk) {
    if (this.closed || !chunk?.length) return;
    const room = this.maxSamples - this.totalSamples;
    if (room <= 0) return;
    const c = chunk.length > room ? chunk.subarray(0, room) : chunk;
    this.chunks.push(c);
    this.openSamples += c.length;
    // Note where the owner last made a sound, 30 ms at a time, across chunk borders.
    for (let i = 0; i < c.length; i++) {
      this.frameSum += c[i] * c[i];
      if (++this.frameCount === FRAME) {
        if (Math.sqrt(this.frameSum / FRAME) > SPEECH_RMS) this.lastVoiceAt = this.totalSamples + i + 1;
        this.frameSum = 0;
        this.frameCount = 0;
      }
    }
    this.totalSamples += c.length;
  }

  /** True when the last pass already heard every sound, with a little silence after it: more silence changes nothing. */
  get nothingNewToRead() {
    return this.readUpTo >= 0 && this.lastVoiceAt <= this.readUpTo - QUIET_TAIL;
  }

  open() {
    if (this.chunks.length !== 1) {
      const all = new Float32Array(this.openSamples);
      let at = 0;
      for (const c of this.chunks) {
        all.set(c, at);
        at += c.length;
      }
      this.chunks = [all];
    }
    return this.chunks[0] ?? new Float32Array(0);
  }

  async read(samples) {
    const clip = trimSilence(samples);
    if (!hasSpeech(clip)) return "";
    return cleanTranscript(await this.transcribe(clip));
  }

  /** Settles the start of the open clip while it is too long for one pass. */
  async settle(limitS) {
    while (this.openSamples / SAMPLE_RATE > limitS) {
      const all = this.open();
      const lenS = all.length / SAMPLE_RATE;
      // The settled part must itself fit in one pass, however much audio is waiting.
      const toS = Math.min(Math.max(lenS - this.keepS, lenS / 2), MAX_PASS_S);
      const cut = findCutPoint(all, { fromS: Math.min(8, toS / 2), toS });
      if (cut <= 0 || cut >= all.length) break;
      const text = await this.read(all.subarray(0, cut));
      if (this.cancelled) return;
      this.settled = joinText(this.settled, text);
      // Audio kept arriving while the model read: it sits in this.chunks after `all`, and must stay there.
      this.chunks[0] = all.slice(cut);
      this.openSamples -= cut;
    }
  }

  run(job) {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => {});
    return next;
  }

  /**
   * The text so far, or null when nothing new arrived since the last pass (or a pass is still running
   * and this one would only wait behind it).
   */
  partial({ minNewS = 0.5 } = {}) {
    if (this.closed) return Promise.resolve(null);
    if (this.totalSamples - Math.max(0, this.readUpTo) < minNewS * SAMPLE_RATE) return Promise.resolve(null);
    if (this.busy) return Promise.resolve(null);
    if (this.nothingNewToRead) {
      // A pause: the text cannot have changed, so the model rests. This also makes stopping after a pause instant.
      this.readUpTo = this.totalSamples;
      return Promise.resolve(null);
    }
    this.busy = true;
    return this.run(async () => {
      try {
        if (this.closed) return null;
        this.readUpTo = this.totalSamples;
        await this.settle(this.settleAfterS);
        this.lastPartial = joinText(this.settled, await this.read(this.open()));
        return this.closed ? null : this.lastPartial;
      } finally {
        this.busy = false;
      }
    });
  }

  /** Ends the dictation and returns everything that was said. */
  finish() {
    this.closed = true;
    return this.run(async () => {
      // A pass that already read every sample (or everything but silence) has the answer; no need to run the model again.
      if (this.readUpTo === this.totalSamples || this.nothingNewToRead) return this.lastPartial;
      await this.settle(MAX_PASS_S);
      return joinText(this.settled, await this.read(this.open()));
    });
  }

  /** Drops the dictation. A pass that is running finishes, and its text goes nowhere. */
  cancel() {
    this.closed = true;
    this.cancelled = true;
    this.chunks = [];
    this.openSamples = 0;
  }
}

// ---------------------------------------------------------------- permission and IPC guards

/**
 * True for a microphone request from the app's own pages: audio only (never the camera or the screen),
 * and only from `appOrigin` (http://localhost:8081 in dev, app://homebase for the built app).
 * `details` is what Electron hands its permission handlers.
 */
export function allowsMicrophone(permission, details, appOrigin) {
  if (permission !== "media") return false;
  const types = details?.mediaTypes ?? (details?.mediaType ? [details.mediaType] : []);
  if (!types.length || types.some((t) => t !== "audio")) return false;
  const from = details?.securityOrigin || details?.requestingUrl || details?.requestingOrigin || "";
  try {
    // Scheme and host, not `origin`: that is "null" for app:// and would match anything.
    const a = new URL(from), b = new URL(appOrigin);
    return a.protocol === b.protocol && a.host === b.host;
  } catch {
    return false;
  }
}

/** Longest single message of audio the main process accepts from the window: 5 seconds. */
export const MAX_CHUNK_SAMPLES = SAMPLE_RATE * 5;

/**
 * Audio from the window as a Float32Array, whatever shape IPC delivered it in. Null when it is not audio.
 * @returns {Float32Array | null}
 */
export function toSamples(data) {
  let out = null;
  if (data instanceof Float32Array) out = data;
  else if (data instanceof ArrayBuffer) out = data.byteLength % 4 === 0 ? new Float32Array(data) : null;
  else if (ArrayBuffer.isView(data)) {
    if (data.byteLength % 4 !== 0) return null;
    // Copy: a Buffer may sit at an offset that is not a multiple of four.
    out = new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  if (!out || out.length === 0 || out.length > MAX_CHUNK_SAMPLES) return null;
  return out;
}

/** Download progress as one number from the per-file progress events of the model loader. */
export function createProgress() {
  const files = new Map();
  return {
    /** @returns {number | null} percent of all files seen so far, or null when nothing is downloading */
    update(e) {
      if (!e || typeof e.file !== "string") return null;
      if (e.status === "progress" && Number.isFinite(e.total) && e.total > 0) files.set(e.file, { loaded: e.loaded ?? 0, total: e.total });
      else if (e.status === "done" && files.has(e.file)) files.get(e.file).loaded = files.get(e.file).total;
      else return null;
      let loaded = 0, total = 0;
      for (const f of files.values()) {
        loaded += f.loaded;
        total += f.total;
      }
      return total ? Math.min(100, Math.floor((100 * loaded) / total)) : null;
    },
  };
}

// ---------------------------------------------------------------- the broker (main process)

// Channels:
//   hb:stt-start   window -> main (invoke)  { profile? }            -> { id }
//   hb:stt-audio   window -> main (send)    id, Float32Array        16 kHz mono microphone audio
//   hb:stt-stop    window -> main (send)    id                      finish: a "final" event follows
//   hb:stt-cancel  window -> main (send)    id                      drop it: nothing follows
//   hb:stt-event   main -> window (send)    { id, type: "status" | "partial" | "final" | "error", ... }

/**
 * Sits between the windows and the model process. The model process is started on the first dictation
 * and stopped after `idleMs` without one, so its memory is only held while dictation is in use. One
 * dictation runs at a time: starting a new one drops the old one.
 *
 * `fork()` starts the model process and returns `{ postMessage(msg), on("message" | "exit", fn), kill() }`.
 * `send(ownerId, event)` delivers an event to the window that owns the dictation.
 */
export function createSttBroker({ fork, send, log = () => {}, idleMs = 10 * 60_000, engine = {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let worker = null;
  let active = null; // { id, ownerId, stopping }
  let seq = 0;
  let idle = null;

  const armIdle = () => {
    if (idle) clearTimer(idle);
    idle = null;
    if (!worker || active) return;
    idle = setTimer(() => {
      idle = null;
      if (!active) stopWorker();
    }, idleMs);
    idle?.unref?.();
  };
  const stopWorker = () => {
    const w = worker;
    worker = null;
    try {
      w?.kill();
    } catch {}
  };
  const finish = (id) => {
    if (active?.id === id) active = null;
    armIdle();
  };

  const onMessage = (w, m) => {
    if (w !== worker || !m || typeof m !== "object") return;
    if (!active || m.id !== active.id) return; // an answer for a dictation that was dropped
    const { id, ownerId } = active;
    if (m.t === "status") send(ownerId, { id, type: "status", phase: String(m.phase), progress: Number.isFinite(m.progress) ? m.progress : undefined, label: typeof m.label === "string" ? m.label : undefined });
    else if (m.t === "partial") send(ownerId, { id, type: "partial", text: String(m.text ?? "") });
    else if (m.t === "full") send(ownerId, { id, type: "status", phase: "full" });
    else if (m.t === "final") {
      finish(id);
      send(ownerId, { id, type: "final", text: String(m.text ?? ""), ms: m.ms, audioS: m.audioS, engine: m.engine });
    } else if (m.t === "error") {
      finish(id);
      send(ownerId, { id, type: "error", code: String(m.code ?? "engine"), message: String(m.message ?? "Speech recognition failed") });
    }
  };

  const ensureWorker = () => {
    if (worker) return worker;
    const w = fork();
    worker = w;
    w.on("message", (m) => onMessage(w, m));
    w.on("exit", (code) => {
      if (w !== worker) return;
      worker = null;
      log("[stt] the model process ended", code);
      if (active) {
        const { id, ownerId } = active;
        active = null;
        send(ownerId, { id, type: "error", code: "engine-crashed", message: "The speech engine stopped. Try again." });
      }
    });
    return w;
  };

  return {
    get active() {
      return active ? { ...active } : null;
    },
    get running() {
      return !!worker;
    },
    /** Starts a dictation for a window and returns its id. */
    start(ownerId, opts = {}) {
      if (active) {
        worker?.postMessage({ t: "cancel", id: active.id });
        active = null;
      }
      if (idle) clearTimer(idle);
      idle = null;
      const id = `stt_${Date.now().toString(36)}_${++seq}`;
      const profile = typeof opts?.profile === "string" ? opts.profile : engine.profile;
      active = { id, ownerId, stopping: false };
      try {
        ensureWorker().postMessage({ t: "start", id, profile, device: engine.device });
      } catch (err) {
        active = null;
        stopWorker();
        throw new Error(`The speech engine could not start: ${err?.message ?? err}`);
      }
      return { id };
    },
    audio(ownerId, id, data) {
      if (!active || active.id !== id || active.ownerId !== ownerId || active.stopping) return false;
      const samples = toSamples(data);
      if (!samples) return false;
      worker?.postMessage({ t: "audio", id, samples });
      return true;
    },
    stop(ownerId, id) {
      if (!active || active.id !== id || active.ownerId !== ownerId || active.stopping) return false;
      active.stopping = true;
      worker?.postMessage({ t: "stop", id });
      return true;
    },
    cancel(ownerId, id) {
      if (!active || active.id !== id || active.ownerId !== ownerId) return false;
      worker?.postMessage({ t: "cancel", id });
      finish(id);
      return true;
    },
    /** The window closed or reloaded: its dictation goes with it. */
    ownerGone(ownerId) {
      if (active?.ownerId !== ownerId) return;
      worker?.postMessage({ t: "cancel", id: active.id });
      finish(active.id);
    },
    dispose() {
      if (idle) clearTimer(idle);
      idle = null;
      active = null;
      stopWorker();
    },
  };
}
