import { describe, expect, it } from "vitest";
// @ts-ignore plain ESM, shared with the Electron main process and the model process
import { DictationSession, MAX_CHUNK_SAMPLES, PROFILES, SAMPLE_RATE, allowsMicrophone, cleanTranscript, createProgress, createSttBroker, findCutPoint, hasSpeech, resolveEngine, rms, toSamples, trimSilence } from "../sttCore.mjs";

const sec = (s: number) => Math.round(s * SAMPLE_RATE);
const silence = (s: number) => new Float32Array(sec(s));
/** A steady tone: stands in for speech of a given loudness. */
const tone = (s: number, amp = 0.1) => Float32Array.from({ length: sec(s) }, (_, i) => amp * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE));
const concat = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const feed = (s: DictationSession, audio: Float32Array, chunk = sec(0.1)) => {
  for (let i = 0; i < audio.length; i += chunk) s.push(audio.subarray(i, i + chunk));
};

/**
 * A stand-in for the model. "Words" are one-second tones whose loudness says which word it is
 * (word k has amplitude 0.05 + k * 0.01), so a test can tell exactly which words a clip held.
 */
const WORD = (k: number) => tone(1, 0.05 + k * 0.01);
function fakeModel() {
  const clips: number[] = [];
  const transcribe = async (samples: Float32Array) => {
    clips.push(samples.length / SAMPLE_RATE);
    const words: number[] = [];
    const frame = sec(0.05);
    let run = 0, peak = 0;
    for (let i = 0; i + frame <= samples.length; i += frame) {
      const level = rms(samples, i, i + frame);
      if (level > 0.02) {
        run++;
        peak = Math.max(peak, level);
      } else {
        if (run >= 10) words.push(Math.round((peak * Math.SQRT2 - 0.05) / 0.01));
        run = 0;
        peak = 0;
      }
    }
    if (run >= 10) words.push(Math.round((peak * Math.SQRT2 - 0.05) / 0.01));
    return words.map((w) => `w${w}`).join(" ");
  };
  return { transcribe, clips };
}
const speech = (count: number, gapS = 0.6) => concat(...Array.from({ length: count }, (_, k) => concat(WORD(k), silence(gapS))));

describe("which speech model to run", () => {
  it("defaults to the fast profile, graphics card first on Windows", () => {
    const e = resolveEngine({ platform: "win32" });
    expect(e.profile).toBe("fast");
    expect(e.model).toBe(PROFILES.fast.model);
    expect(e.variants.map((v: any) => v.name)).toEqual(["gpu", "cpu"]);
  });

  it("uses the processor where DirectML does not exist, even when the card was asked for", () => {
    expect(resolveEngine({ platform: "linux" }).variants.map((v: any) => v.name)).toEqual(["cpu"]);
    expect(resolveEngine({ platform: "darwin", device: "gpu" }).variants.map((v: any) => v.name)).toEqual(["cpu"]);
  });

  it("honours a forced device and falls back to the default for an unknown profile", () => {
    expect(resolveEngine({ platform: "win32", device: "cpu" }).variants.map((v: any) => v.name)).toEqual(["cpu"]);
    expect(resolveEngine({ platform: "win32", device: "gpu", profile: "accurate" }).variants.map((v: any) => v.name)).toEqual(["gpu"]);
    expect(resolveEngine({ platform: "win32", profile: "accurate" }).model).toBe(PROFILES.accurate.model);
    expect(resolveEngine({ platform: "win32", profile: "__proto__" }).profile).toBe("fast");
    expect(resolveEngine({ platform: "win32", profile: "huge" }).profile).toBe("fast");
  });

  it("keeps every download under 500 MB", () => {
    for (const p of Object.values(PROFILES) as any[]) for (const v of p.variants) expect(v.sizeMB).toBeLessThan(500);
  });
});

describe("audio helpers", () => {
  it("tells speech from a quiet room", () => {
    expect(hasSpeech(silence(2))).toBe(false);
    expect(hasSpeech(tone(2, 0.002))).toBe(false); // hiss
    expect(hasSpeech(concat(silence(1), tone(0.1, 0.1), silence(1)))).toBe(false); // a click, too short to be a word
    expect(hasSpeech(concat(silence(1), tone(0.4, 0.05), silence(1)))).toBe(true);
  });

  it("trims the silence around what was said and keeps a little padding", () => {
    const clip = trimSilence(concat(silence(3), tone(1), silence(5)));
    expect(clip.length / SAMPLE_RATE).toBeGreaterThan(1.3);
    expect(clip.length / SAMPLE_RATE).toBeLessThan(1.7);
    expect(trimSilence(silence(4)).length).toBe(0);
  });

  it("cuts a long clip in a pause, never inside a word", () => {
    // Words from 0 to 9 s, a pause from 9 to 9.6 s, words from 9.6 s on.
    const audio = concat(tone(9), silence(0.6), tone(8));
    const cut = findCutPoint(audio, { fromS: 4, toS: 15 }) / SAMPLE_RATE;
    expect(cut).toBeGreaterThan(9);
    expect(cut).toBeLessThan(9.6);
  });

  it("takes the later of two equally quiet pauses, so more text is settled", () => {
    const audio = concat(tone(5), silence(0.6), tone(5), silence(0.6), tone(5));
    const cut = findCutPoint(audio, { fromS: 2, toS: 14 }) / SAMPLE_RATE;
    expect(cut).toBeGreaterThan(10.6); // the second pause is from 10.6 to 11.2 s
    expect(cut).toBeLessThan(11.2);
  });
});

describe("cleaning what the model wrote", () => {
  it("drops non-speech tags and tidies the spacing", () => {
    expect(cleanTranscript(" [BLANK_AUDIO] ")).toBe("");
    expect(cleanTranscript("(silence)")).toBe("");
    expect(cleanTranscript(" Check the deploy  [Music]  and tell me . ")).toBe("Check the deploy and tell me.");
    expect(cleanTranscript("Open the ticket (the one from Monday).")).toBe("Open the ticket (the one from Monday).");
    expect(cleanTranscript(undefined as any)).toBe("");
  });

  it("drops the lone word Whisper invents for a noise, and keeps real short answers", () => {
    expect(cleanTranscript(" you")).toBe("");
    expect(cleanTranscript("You.")).toBe("");
    expect(cleanTranscript(" . ")).toBe("");
    expect(cleanTranscript("Yes.")).toBe("Yes.");
    expect(cleanTranscript("Thank you.")).toBe("Thank you.");
    expect(cleanTranscript("You can deploy it.")).toBe("You can deploy it.");
  });
});

describe("one dictation", () => {
  it("gives live text as audio arrives, and nothing new until more audio arrives", async () => {
    const m = fakeModel();
    const s = new DictationSession({ transcribe: m.transcribe });
    expect(await s.partial()).toBeNull(); // nothing recorded yet
    feed(s, concat(WORD(0), silence(0.6)));
    expect(await s.partial()).toBe("w0");
    expect(await s.partial()).toBeNull();
    feed(s, concat(WORD(1), silence(0.6)));
    expect(await s.partial()).toBe("w0 w1");
  });

  it("finishes with everything that was said", async () => {
    const m = fakeModel();
    const s = new DictationSession({ transcribe: m.transcribe });
    feed(s, speech(3));
    expect(await s.partial()).toBe("w0 w1 w2");
    feed(s, concat(WORD(3), silence(0.3)));
    expect(await s.finish()).toBe("w0 w1 w2 w3");
  });

  it("does not run the model again when the last live pass already read everything", async () => {
    const m = fakeModel();
    const s = new DictationSession({ transcribe: m.transcribe });
    feed(s, speech(2));
    await s.partial();
    expect(m.clips.length).toBe(1);
    expect(await s.finish()).toBe("w0 w1");
    expect(m.clips.length).toBe(1);
  });

  it("waits for a live pass that is still running, then reads the rest", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const m = fakeModel();
    let calls = 0;
    const s = new DictationSession({ transcribe: async (a: Float32Array) => { if (calls++ === 0) await gate; return m.transcribe(a); } });
    feed(s, speech(1));
    const live = s.partial();
    await Promise.resolve();
    feed(s, concat(WORD(1), silence(0.3)));
    expect(await s.partial()).toBeNull(); // one pass at a time
    const final = s.finish();
    release();
    expect(await live).toBeNull(); // the dictation was closed while it ran
    expect(await final).toBe("w0 w1");
  });

  it("never sends silence to the model, which would invent words for it", async () => {
    const m = fakeModel();
    const s = new DictationSession({ transcribe: m.transcribe });
    feed(s, silence(5));
    expect(await s.partial()).toBe("");
    expect(await s.finish()).toBe("");
    expect(m.clips.length).toBe(0);
  });

  it("keeps a long dictation whole: each pass is under 30 seconds and no word is lost or repeated", async () => {
    const m = fakeModel();
    const s = new DictationSession({ transcribe: m.transcribe });
    const audio = speech(60); // 96 seconds
    const want = Array.from({ length: 60 }, (_, k) => `w${k}`).join(" ");
    let last = "";
    for (let at = 0; at < audio.length; at += sec(1)) {
      feed(s, audio.subarray(at, at + sec(1)));
      const text = await s.partial();
      if (text !== null) {
        expect(want.startsWith(text)).toBe(true); // live text only ever grows along what was said
        last = text;
      }
    }
    expect(last.split(" ").length).toBeGreaterThan(55);
    expect(await s.finish()).toBe(want);
    expect(Math.max(...m.clips)).toBeLessThan(30);
  });

  it("also splits a long recording that never had a live pass", async () => {
    const m = fakeModel();
    const s = new DictationSession({ transcribe: m.transcribe });
    feed(s, speech(40)); // 64 seconds, handed over at once
    expect(await s.finish()).toBe(Array.from({ length: 40 }, (_, k) => `w${k}`).join(" "));
    expect(Math.max(...m.clips)).toBeLessThan(30);
  });

  it("drops everything on cancel", async () => {
    const m = fakeModel();
    const s = new DictationSession({ transcribe: m.transcribe });
    feed(s, speech(2));
    s.cancel();
    expect(await s.partial()).toBeNull();
    feed(s, speech(1));
    expect(s.seconds).toBeCloseTo(3.2, 1); // nothing is recorded after a cancel
  });

  it("stops recording at its length limit and says it is full", () => {
    const s = new DictationSession({ transcribe: async () => "", maxS: 2 });
    expect(s.full).toBe(false);
    feed(s, tone(5));
    expect(s.full).toBe(true);
    expect(s.seconds).toBe(2);
  });
});

describe("audio arriving over IPC", () => {
  it("accepts samples in the shapes IPC can deliver them", () => {
    const f = Float32Array.from([0.5, -0.5, 0.25]);
    expect(toSamples(f)).toBe(f);
    expect(Array.from(toSamples(f.buffer)!)).toEqual([0.5, -0.5, 0.25]);
    // A Buffer that starts at an odd offset inside a larger ArrayBuffer.
    const big = new Uint8Array(1 + f.byteLength);
    big.set(new Uint8Array(f.buffer), 1);
    expect(Array.from(toSamples(Buffer.from(big.buffer, 1, f.byteLength))!)).toEqual([0.5, -0.5, 0.25]);
  });

  it("refuses anything that is not a sensible chunk of audio", () => {
    expect(toSamples("audio")).toBeNull();
    expect(toSamples(null)).toBeNull();
    expect(toSamples({ length: 4 })).toBeNull();
    expect(toSamples(new Float32Array(0))).toBeNull();
    expect(toSamples(new Uint8Array(7))).toBeNull(); // not whole samples
    expect(toSamples(new Float32Array(MAX_CHUNK_SAMPLES + 1))).toBeNull();
    expect(toSamples(new Float32Array(MAX_CHUNK_SAMPLES))).not.toBeNull();
  });
});

describe("model download progress", () => {
  it("adds the files up into one percentage", () => {
    const p = createProgress();
    expect(p.update({ status: "initiate", file: "config.json" })).toBeNull();
    expect(p.update({ status: "progress", file: "encoder.onnx", loaded: 20, total: 80 })).toBe(25);
    expect(p.update({ status: "progress", file: "decoder.onnx", loaded: 0, total: 120 })).toBe(10);
    expect(p.update({ status: "progress", file: "decoder.onnx", loaded: 60, total: 120 })).toBe(40);
    expect(p.update({ status: "done", file: "encoder.onnx" })).toBe(70);
    expect(p.update({ status: "done", file: "decoder.onnx" })).toBe(100);
    expect(p.update(null)).toBeNull();
  });
});

describe("microphone permission", () => {
  const dev = "http://localhost:8081";
  it("allows audio for the app's own pages", () => {
    expect(allowsMicrophone("media", { mediaTypes: ["audio"], securityOrigin: "http://localhost:8081/" }, dev)).toBe(true);
    expect(allowsMicrophone("media", { mediaType: "audio", requestingOrigin: "http://localhost:8081" }, dev)).toBe(true);
    expect(allowsMicrophone("media", { mediaTypes: ["audio"], requestingUrl: "app://homebase/chats/abc" }, "app://homebase")).toBe(true);
  });

  it("refuses the camera, the screen and every other permission", () => {
    expect(allowsMicrophone("media", { mediaTypes: ["video"], securityOrigin: dev }, dev)).toBe(false);
    expect(allowsMicrophone("media", { mediaTypes: ["audio", "video"], securityOrigin: dev }, dev)).toBe(false);
    expect(allowsMicrophone("media", { mediaType: "unknown", requestingOrigin: dev }, dev)).toBe(false);
    expect(allowsMicrophone("media", { securityOrigin: dev }, dev)).toBe(false);
    expect(allowsMicrophone("display-capture", { mediaTypes: ["audio"], securityOrigin: dev }, dev)).toBe(false);
    expect(allowsMicrophone("geolocation", { securityOrigin: dev }, dev)).toBe(false);
  });

  it("refuses any other origin, including another app:// host and another port", () => {
    expect(allowsMicrophone("media", { mediaTypes: ["audio"], securityOrigin: "https://example.com" }, dev)).toBe(false);
    expect(allowsMicrophone("media", { mediaTypes: ["audio"], securityOrigin: "http://localhost:9999" }, dev)).toBe(false);
    expect(allowsMicrophone("media", { mediaTypes: ["audio"], requestingUrl: "app://evil/" }, "app://homebase")).toBe(false);
    expect(allowsMicrophone("media", { mediaTypes: ["audio"], requestingUrl: "file:///C:/x.html" }, "app://homebase")).toBe(false);
    expect(allowsMicrophone("media", { mediaTypes: ["audio"] }, dev)).toBe(false);
  });
});

describe("the broker between the window and the model process", () => {
  function harness(opts: { idleMs?: number } = {}) {
    const workers: any[] = [];
    const events: Array<{ owner: number; e: any }> = [];
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    const fork = () => {
      const handlers = new Map<string, (a: any) => void>();
      const w = {
        sent: [] as any[], killed: false,
        postMessage: (m: any) => void w.sent.push(m),
        on: (ev: string, fn: (a: any) => void) => void handlers.set(ev, fn),
        kill: () => void (w.killed = true),
        say: (m: any) => handlers.get("message")!(m),
        exit: (code = 1) => handlers.get("exit")!(code),
      };
      workers.push(w);
      return w;
    };
    const broker = createSttBroker({
      fork, send: (owner: number, e: any) => void events.push({ owner, e }), idleMs: opts.idleMs ?? 1000,
      engine: { profile: "fast", device: "auto" },
      setTimer: (fn: () => void, ms: number) => {
        const t = { fn, ms, cleared: false };
        timers.push(t);
        return t;
      },
      clearTimer: (t: any) => void (t.cleared = true),
    });
    const runTimers = () => timers.splice(0).filter((t) => !t.cleared).forEach((t) => t.fn());
    return { broker, workers, events, runTimers };
  }
  const chunk = () => new Float32Array(1600).fill(0.1);

  it("starts the model process on the first dictation and relays audio, live text and the final text", () => {
    const h = harness();
    expect(h.broker.running).toBe(false);
    const { id } = h.broker.start(7);
    expect(h.workers.length).toBe(1);
    expect(h.workers[0].sent[0]).toEqual({ t: "start", id, profile: "fast", device: "auto" });
    expect(h.broker.audio(7, id, chunk())).toBe(true);
    expect(h.workers[0].sent[1].t).toBe("audio");
    h.workers[0].say({ t: "status", id, phase: "ready", label: "Whisper base.en" });
    h.workers[0].say({ t: "partial", id, text: "check the" });
    expect(h.broker.stop(7, id)).toBe(true);
    expect(h.broker.audio(7, id, chunk())).toBe(false); // nothing more after stop
    h.workers[0].say({ t: "final", id, text: "Check the deploy.", ms: 400, audioS: 2 });
    expect(h.events.map((x) => [x.owner, x.e.type])).toEqual([[7, "status"], [7, "partial"], [7, "final"]]);
    expect(h.events[2].e.text).toBe("Check the deploy.");
    expect(h.broker.active).toBeNull();
  });

  it("only takes audio and commands from the window that owns the dictation", () => {
    const h = harness();
    const { id } = h.broker.start(7);
    expect(h.broker.audio(8, id, chunk())).toBe(false);
    expect(h.broker.audio(7, "stt_other", chunk())).toBe(false);
    expect(h.broker.audio(7, id, "not audio")).toBe(false);
    expect(h.broker.stop(8, id)).toBe(false);
    expect(h.broker.cancel(8, id)).toBe(false);
    expect(h.workers[0].sent.length).toBe(1); // only the start
  });

  it("drops the running dictation when a new one starts, and ignores its late answers", () => {
    const h = harness();
    const a = h.broker.start(7);
    const b = h.broker.start(7);
    expect(h.workers.length).toBe(1);
    expect(h.workers[0].sent.map((m: any) => m.t)).toEqual(["start", "cancel", "start"]);
    h.workers[0].say({ t: "final", id: a.id, text: "old" });
    expect(h.events).toEqual([]);
    h.workers[0].say({ t: "partial", id: b.id, text: "new" });
    expect(h.events.length).toBe(1);
  });

  it("cancels quietly: nothing is delivered afterwards", () => {
    const h = harness();
    const { id } = h.broker.start(7);
    expect(h.broker.cancel(7, id)).toBe(true);
    h.workers[0].say({ t: "final", id, text: "too late" });
    expect(h.events).toEqual([]);
    expect(h.broker.active).toBeNull();
  });

  it("tells the window when the model process dies, and starts a fresh one next time", () => {
    const h = harness();
    const { id } = h.broker.start(7);
    h.workers[0].exit(1);
    expect(h.events[0].e).toMatchObject({ id, type: "error", code: "engine-crashed" });
    expect(h.broker.running).toBe(false);
    h.broker.start(7);
    expect(h.workers.length).toBe(2);
  });

  it("stops the model process after it has been idle, but never during a dictation", () => {
    const h = harness();
    const { id } = h.broker.start(7);
    h.runTimers();
    expect(h.workers[0].killed).toBe(false);
    h.broker.stop(7, id);
    h.workers[0].say({ t: "final", id, text: "done" });
    const again = h.broker.start(7); // used again before the timer ran: the timer is void
    h.runTimers();
    expect(h.workers[0].killed).toBe(false);
    h.broker.cancel(7, again.id);
    h.runTimers();
    expect(h.workers[0].killed).toBe(true);
    expect(h.broker.running).toBe(false);
  });

  it("drops a dictation when its window closes or reloads", () => {
    const h = harness();
    const { id } = h.broker.start(7);
    h.broker.ownerGone(9); // some other window
    expect(h.broker.active?.id).toBe(id);
    h.broker.ownerGone(7);
    expect(h.broker.active).toBeNull();
    expect(h.workers[0].sent.at(-1)).toEqual({ t: "cancel", id });
  });

  it("passes on an engine error and frees the slot", () => {
    const h = harness();
    const { id } = h.broker.start(7);
    h.workers[0].say({ t: "error", id, code: "model-missing", message: "No model" });
    expect(h.events[0].e).toEqual({ id, type: "error", code: "model-missing", message: "No model" });
    expect(h.broker.active).toBeNull();
  });
});

describe("pauses", () => {
  it("rests the model while the owner is silent, and answers at once when they stop after a pause", async () => {
    const m = fakeModel();
    const s = new DictationSession({ transcribe: m.transcribe });
    feed(s, concat(WORD(0), silence(0.6)));
    expect(await s.partial()).toBe("w0");
    expect(m.clips.length).toBe(1);
    for (let i = 0; i < 10; i++) {
      feed(s, silence(1));
      expect(await s.partial()).toBeNull();
    }
    expect(m.clips.length).toBe(1); // ten seconds of silence, not one more pass
    expect(await s.finish()).toBe("w0");
    expect(m.clips.length).toBe(1);
  });

  it("reads again as soon as there is sound after the pause", async () => {
    const m = fakeModel();
    const s = new DictationSession({ transcribe: m.transcribe });
    feed(s, concat(WORD(0), silence(0.6)));
    await s.partial();
    feed(s, silence(3));
    expect(await s.partial()).toBeNull();
    feed(s, concat(WORD(1), silence(0.2)));
    expect(await s.partial()).toBe("w0 w1");
    expect(m.clips.length).toBe(2);
  });

  it("does not skip the last pass when the live pass stopped mid-word", async () => {
    const m = fakeModel();
    const s = new DictationSession({ transcribe: m.transcribe });
    feed(s, concat(WORD(0), silence(0.6), tone(0.5, 0.07))); // the pass starts while word 2 is being said
    await s.partial();
    feed(s, concat(tone(0.5, 0.07), silence(1))); // the rest of the word, then silence
    expect(await s.finish()).toBe("w0 w2");
    expect(m.clips.length).toBe(2);
  });
});

describe("audio that arrives while the model is busy", () => {
  /** Feeds the dictation in real-time fashion: the next second of audio lands while each pass is still running. */
  async function streamed(audio: Float32Array, opts: Record<string, unknown> = {}) {
    const m = fakeModel();
    let at = 0;
    const more = (s: DictationSession) => {
      feed(s, audio.subarray(at, at + sec(1)));
      at += sec(1);
    };
    const s: DictationSession = new DictationSession({
      ...opts,
      transcribe: async (clip: Float32Array) => {
        if (at < audio.length) more(s); // the owner keeps talking during the pass
        await Promise.resolve();
        return m.transcribe(clip);
      },
    });
    more(s);
    while (at < audio.length) {
      if ((await s.partial()) === null) more(s);
    }
    return { text: await s.finish(), clips: m.clips };
  }

  it("loses nothing when a long dictation is settled mid-stream", async () => {
    const want = Array.from({ length: 60 }, (_, k) => `w${k}`).join(" ");
    const r = await streamed(speech(60));
    expect(r.text).toBe(want);
    expect(Math.max(...r.clips)).toBeLessThan(30);
  });

  it("loses nothing with a short settle window either", async () => {
    const want = Array.from({ length: 30 }, (_, k) => `w${k}`).join(" ");
    expect((await streamed(speech(30), { settleAfterS: 6, keepS: 1 })).text).toBe(want);
  });
});
