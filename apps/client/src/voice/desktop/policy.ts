/**
 * Small rules for desktop dictation that need no microphone and no window, so they can be tested.
 */

/** Louder than this (RMS, 0 to 1) counts as the owner talking, not the room. */
export const VOICE_RMS = 0.012;
/** A dictation that was latched on and then left alone ends itself after this much silence. */
export const SILENCE_STOP_MS = 15_000;
/** Hands-free listening ends an utterance after this much silence, like the phone's recognizer. */
export const HANDSFREE_PAUSE_MS = 1_200;
export const HANDSFREE_WAIT_MS = 8_000;

export type SilenceVerdict = "continue" | "finish" | "no-speech";

/**
 * What to do with a dictation, given how long it has been quiet.
 * finish: stop and keep what was said. no-speech: nothing was ever heard; stop and say so.
 */
export function silenceVerdict(i: { mode: "ptt" | "handsfree"; heardVoice: boolean; msSinceVoice: number; msSinceStart: number }): SilenceVerdict {
  if (i.mode === "handsfree") {
    if (i.heardVoice) return i.msSinceVoice >= HANDSFREE_PAUSE_MS ? "finish" : "continue";
    return i.msSinceStart >= HANDSFREE_WAIT_MS ? "no-speech" : "continue";
  }
  if (i.heardVoice) return i.msSinceVoice >= SILENCE_STOP_MS ? "finish" : "continue";
  return i.msSinceStart >= SILENCE_STOP_MS ? "no-speech" : "continue";
}

/**
 * Microphone loudness on the scale the phone's recognizer reports (about -2 quiet to 10 loud), so the
 * mic button's level ring moves the same way on both.
 */
export function levelToVolume(rms: number): number {
  const level = Math.max(0, Math.min(1, Math.sqrt(Math.max(0, rms) / 0.2)));
  return level * 12 - 2;
}

/** A clear sentence for each way opening the microphone can fail. */
export function micError(err: unknown): { code: string; message: string } {
  const name = (err as { name?: string } | null)?.name ?? "";
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
    return { code: "no-microphone", message: "No microphone found. Plug one in, or choose an input device in Windows sound settings." };
  }
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    return { code: "mic-blocked", message: "The microphone is blocked. In Windows Settings, open Privacy & security, Microphone, and let desktop apps use it." };
  }
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return { code: "mic-busy", message: "The microphone could not be opened. Another app may be using it." };
  }
  return { code: "mic-failed", message: (err as Error | null)?.message || "The microphone could not be opened." };
}

/**
 * Turns audio at the device's rate into 16 kHz, a block at a time. Each output sample is the average of
 * the input samples it covers, which is enough of a low-pass for speech.
 */
export class Downsampler {
  private readonly ratio: number;
  private pos = 0; // how far into the current output sample the input has got, in input samples
  private sum = 0;
  private count = 0;
  constructor(readonly fromRate: number, readonly toRate = 16000) {
    this.ratio = fromRate / toRate;
  }
  push(input: Float32Array): Float32Array {
    if (this.ratio === 1) return input;
    const out = new Float32Array(Math.ceil((input.length + this.pos) / this.ratio) + 1);
    let n = 0;
    for (let i = 0; i < input.length; i++) {
      this.sum += input[i];
      this.count++;
      this.pos++;
      if (this.pos >= this.ratio) {
        out[n++] = this.sum / this.count;
        this.pos -= this.ratio;
        this.sum = 0;
        this.count = 0;
      }
    }
    return out.subarray(0, n);
  }
}
