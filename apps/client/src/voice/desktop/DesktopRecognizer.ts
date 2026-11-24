import type { VoiceEvent, VoiceInput, VoiceStartOptions } from "../VoiceInput";
import { desktopStt, getSttProfile, type SttBridge, type SttEvent } from "./bridge";
import { startMicCapture, type MicCapture } from "./capture";
import { VOICE_RMS, levelToVolume, micError, silenceVerdict } from "./policy";

/** After stopping: no word from the engine for this long (not even download progress) means it is stuck. */
const ENGINE_SILENT_MS = 90_000;

/**
 * Dictation in the desktop window. This page records the microphone; the desktop shell runs Whisper on
 * this PC and sends back the text (live while you talk, and once more when you stop). Same events as
 * the phone's recognizer, so every screen that dictates works unchanged.
 */
export class DesktopRecognizer implements VoiceInput {
  /** The last pass runs after you stop, so "final" arrives a moment after `stop()`. */
  readonly slowFinal = true;
  private handlers: Record<VoiceEvent, Set<(p: any) => void>> = { partial: new Set(), final: new Set(), error: new Set(), volume: new Set(), end: new Set(), status: new Set() };
  private bridge: SttBridge | undefined = desktopStt();
  private run = 0; // goes up with every start, so late answers from an old dictation are ignored
  private active = false;
  private stopping = false;
  private id: string | null = null;
  private capture: MicCapture | null = null;
  private off: (() => void) | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;

  private emit(e: VoiceEvent, p?: unknown) {
    this.handlers[e].forEach((h) => h(p));
  }

  on(event: VoiceEvent, cb: (payload: any) => void) {
    this.handlers[event].add(cb);
    return () => void this.handlers[event].delete(cb);
  }

  start(opts: VoiceStartOptions) {
    if (this.active) return;
    this.active = true;
    this.stopping = false;
    void this.begin(++this.run, opts);
  }

  private async begin(run: number, opts: VoiceStartOptions) {
    const bridge = this.bridge;
    if (!bridge) return this.fail(run, { code: "service-not-allowed", message: "Dictation is not available in this window." });
    let id: string;
    try {
      // Starting the engine first gives the model its head start while the microphone opens.
      id = (await bridge.start({ profile: getSttProfile() })).id;
    } catch (err) {
      return this.fail(run, { code: "engine", message: (err as Error).message || "The speech engine could not start." });
    }
    if (run !== this.run || !this.active) return void bridge.cancel(id); // cancelled while starting
    this.id = id;
    this.off = bridge.onEvent((e) => this.onEvent(run, e));

    const startedAt = Date.now();
    let lastVoiceAt = 0;
    let heardVoice = false;
    let capture: MicCapture;
    try {
      capture = await startMicCapture({
        onChunk: (samples) => {
          // Also while stopping: the last words are still on their way out of the audio thread.
          if (run === this.run && this.id === id) bridge.audio(id, samples);
        },
        onLevel: (rms) => {
          if (run !== this.run || this.stopping) return;
          this.emit("volume", levelToVolume(rms));
          const now = Date.now();
          if (rms > VOICE_RMS) {
            heardVoice = true;
            lastVoiceAt = now;
          }
          const verdict = silenceVerdict({ mode: opts.mode, heardVoice, msSinceVoice: now - lastVoiceAt, msSinceStart: now - startedAt });
          if (verdict === "finish") this.stop();
          else if (verdict === "no-speech") {
            // Hands-free waits quietly, like the phone. A dictation that heard nothing says so.
            if (opts.mode === "ptt") this.emit("error", { code: "no-speech-heard", message: "Didn't hear anything. Check which microphone Windows is using and that it isn't muted." });
            this.cancel();
          }
        },
        onLost: () => {
          if (run !== this.run) return;
          this.emit("error", { code: "mic-lost", message: "The microphone was disconnected." });
          this.stop();
        },
      });
    } catch (err) {
      bridge.cancel(id);
      return this.fail(run, micError(err));
    }
    if (run !== this.run || !this.active) return void capture.stop(false); // cancelled while the microphone opened
    this.capture = capture;
    if (this.stopping) void this.finish(run); // released before the microphone was open
  }

  private onEvent(run: number, e: SttEvent) {
    if (run !== this.run || e.id !== this.id) return;
    if (this.stopping) this.kick(run); // still alive (a download reports progress)
    if (e.type === "status") {
      if (e.phase === "full") this.stop(); // the dictation reached its length limit
      else this.emit("status", { phase: e.phase, progress: e.progress, label: e.label });
    } else if (e.type === "partial") {
      if (!this.stopping) this.emit("partial", e.text);
    } else if (e.type === "final") {
      console.debug(`[dictation] ${e.audioS ?? "?"} s of audio, final text ${e.ms ?? "?"} ms after stop, ${e.engine ?? "engine unknown"}`);
      this.cleanup();
      if (e.text) this.emit("final", e.text);
      this.emit("end");
    } else if (e.type === "error") {
      void this.capture?.stop(false);
      this.cleanup();
      this.emit("error", { code: e.code, message: e.message });
      this.emit("end");
    }
  }

  /** Stops recording and asks for the final text. "final" and "end" follow when the last pass is done. */
  stop() {
    if (!this.active || this.stopping) return;
    this.stopping = true;
    if (this.capture) void this.finish(this.run);
    // Otherwise the microphone is still opening; begin() finishes as soon as it is.
  }

  private async finish(run: number) {
    const capture = this.capture;
    this.capture = null;
    await capture?.stop(true).catch(() => {});
    if (run !== this.run || !this.id) return;
    this.emit("volume", -2);
    this.bridge?.stop(this.id);
    this.kick(run);
  }

  /** Stops recording and throws the dictation away. Only "end" follows. */
  cancel() {
    if (!this.active) return;
    const id = this.id;
    const capture = this.capture;
    this.cleanup();
    void capture?.stop(false);
    if (id) this.bridge?.cancel(id);
    this.emit("end");
  }

  private fail(run: number, e: { code: string; message: string }) {
    if (run !== this.run) return;
    this.cleanup();
    this.emit("error", e);
    this.emit("end");
  }

  private kick(run: number) {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      if (run !== this.run || !this.active) return;
      const id = this.id;
      const capture = this.capture;
      this.cleanup();
      void capture?.stop(false);
      if (id) this.bridge?.cancel(id);
      this.emit("error", { code: "engine-timeout", message: "The speech engine did not answer. Try again." });
      this.emit("end");
    }, ENGINE_SILENT_MS);
  }

  private cleanup() {
    this.run++;
    this.active = false;
    this.stopping = false;
    this.id = null;
    this.capture = null;
    this.off?.();
    this.off = null;
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }
}
