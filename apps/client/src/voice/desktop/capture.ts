import { Downsampler } from "./policy";

/**
 * Records the default microphone in the desktop window and hands out 16 kHz mono audio, about ten
 * chunks a second. Web only: this file is never loaded on the phone.
 */
export interface MicCapture {
  /** Stops recording. Resolves once the last bit of audio has been handed out. */
  stop(flush?: boolean): Promise<void>;
}

const TARGET_RATE = 16000;

// Runs on the audio thread. Collects a tenth of a second, then posts it.
const WORKLET = `
class HbCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(Math.round(sampleRate / 10));
    this.n = 0;
    this.port.onmessage = (e) => {
      if (e.data === "flush") { this.flush(); this.port.postMessage("flushed"); }
    };
  }
  flush() {
    if (this.n) { this.port.postMessage(this.buf.slice(0, this.n)); this.n = 0; }
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) this.flush();
      }
    }
    return true;
  }
}
registerProcessor("hb-capture", HbCapture);
`;

function rmsOf(a: Float32Array): number {
  if (!a.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s / a.length);
}

/**
 * Opens the microphone. Rejects with the browser's own error (NotFoundError, NotAllowedError, ...) when
 * there is no microphone or it is blocked; `micError` in policy.ts turns that into a sentence.
 */
export async function startMicCapture(h: { onChunk(samples: Float32Array): void; onLevel?(rms: number): void; onLost?(): void }): Promise<MicCapture> {
  const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  if (!media?.getUserMedia) throw Object.assign(new Error("No microphone API"), { name: "NotFoundError" });
  const stream = await media.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });

  const AC: typeof AudioContext = (window as any).AudioContext ?? (window as any).webkitAudioContext;
  let ctx: AudioContext;
  try {
    ctx = new AC({ sampleRate: TARGET_RATE, latencyHint: "interactive" }); // the browser resamples for us
  } catch {
    ctx = new AC();
  }
  const down = new Downsampler(ctx.sampleRate, TARGET_RATE);
  let live = true;
  const deliver = (block: Float32Array) => {
    if (!live) return;
    const samples = down.push(block);
    if (!samples.length) return;
    h.onLevel?.(rmsOf(samples));
    h.onChunk(samples);
  };

  const source = ctx.createMediaStreamSource(stream);
  // A silent path to the output keeps the graph running without playing the microphone back.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  mute.connect(ctx.destination);

  let worklet: AudioWorkletNode | null = null;
  let script: ScriptProcessorNode | null = null;
  let flushed: (() => void) | null = null;
  try {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    worklet = new AudioWorkletNode(ctx, "hb-capture", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit", channelInterpretation: "speakers" });
    worklet.port.onmessage = (e) => {
      if (e.data === "flushed") flushed?.();
      else if (e.data instanceof Float32Array) deliver(e.data);
    };
    source.connect(worklet);
    worklet.connect(mute);
  } catch {
    // Older engines, or a page that may not load a worklet: the main-thread recorder does the same job.
    worklet = null;
    script = ctx.createScriptProcessor(4096, 1, 1);
    script.onaudioprocess = (e) => deliver(new Float32Array(e.inputBuffer.getChannelData(0)));
    source.connect(script);
    script.connect(mute);
  }
  if (ctx.state === "suspended") await ctx.resume().catch(() => {});

  const track = stream.getAudioTracks()[0];
  const lost = () => live && h.onLost?.();
  track?.addEventListener("ended", lost); // unplugged, or the device was disabled

  return {
    async stop(flush = true) {
      if (!live) return;
      if (flush && worklet) {
        // Ask the audio thread for the part of a chunk it is still holding, so the last word is whole.
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 200);
          flushed = () => {
            clearTimeout(t);
            resolve();
          };
          worklet!.port.postMessage("flush");
        });
      }
      live = false;
      track?.removeEventListener("ended", lost);
      try {
        source.disconnect();
        worklet?.disconnect();
        script?.disconnect();
        mute.disconnect();
      } catch {}
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close().catch(() => {}); // not awaited: the final text should not wait for the audio device to close
    },
  };
}
