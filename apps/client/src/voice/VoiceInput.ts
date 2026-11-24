import { Platform } from "react-native";
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";
import { isElectron } from "../sync/session";
import { DesktopRecognizer } from "./desktop/DesktopRecognizer";
import { desktopStt } from "./desktop/bridge";

/** "status" is only sent by the desktop engine: { phase: "loading" | "downloading" | "ready", progress?, label? }. */
export type VoiceEvent = "partial" | "final" | "error" | "volume" | "end" | "status";
export interface VoiceStartOptions { mode: "ptt" | "handsfree"; contextualStrings?: string[] }

/** One interface, two implementations: the device recognizer now, a streaming cloud recognizer at MVP. */
export interface VoiceInput {
  start(opts: VoiceStartOptions): void;
  stop(): void;
  /** Stops and throws away what was heard: only "end" follows. */
  cancel?(): void;
  /** True when the final text arrives a moment after `stop()` (the desktop engine's last pass). */
  readonly slowFinal?: boolean;
  on(event: VoiceEvent, cb: (payload: any) => void): () => void;
}

export type Availability = "available" | "unavailable" | "hidden";

/**
 * hidden: no mic at all (a desktop shell without the dictation bridge; Electron has no Web Speech backend).
 * The desktop app is "available" through its own engine: Whisper on this PC (docs/DESKTOP-DICTATION.md).
 * unavailable: the platform should have it but this device has no speech service.
 */
export function voiceAvailability(): Availability {
  if (Platform.OS === "web") {
    if (desktopStt()) return "available";
    const hasApi = typeof window !== "undefined" && ("webkitSpeechRecognition" in window || "SpeechRecognition" in window);
    return !hasApi || isElectron ? "hidden" : "available";
  }
  try {
    return ExpoSpeechRecognitionModule.isRecognitionAvailable() ? "available" : "unavailable";
  } catch {
    return "unavailable";
  }
}

export async function ensureVoicePermission(): Promise<boolean> {
  // Desktop: the shell grants its own window the microphone; a blocked or missing one is reported when recording starts.
  if (desktopStt()) return true;
  try {
    const r = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    return r.granted;
  } catch {
    return false;
  }
}

/** Android SpeechRecognizer / iOS SFSpeechRecognizer / Web Speech API through expo-speech-recognition. */
export class DeviceRecognizer implements VoiceInput {
  private handlers: Record<VoiceEvent, Set<(p: any) => void>> = { partial: new Set(), final: new Set(), error: new Set(), volume: new Set(), end: new Set(), status: new Set() };
  private subs: Array<{ remove(): void }> = [];
  private active = false;

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
    const M = ExpoSpeechRecognitionModule;
    this.subs = [
      M.addListener("result", (e) => {
        const text = e.results?.[0]?.transcript ?? "";
        this.emit(e.isFinal ? "final" : "partial", text);
      }),
      M.addListener("error", (e) => {
        // "no-speech" and "aborted" are normal ends of a push-to-talk hold, not failures.
        if (e.error !== "no-speech" && e.error !== "aborted") this.emit("error", { code: e.error, message: e.message });
      }),
      M.addListener("volumechange", (e) => this.emit("volume", e.value)),
      M.addListener("end", () => {
        this.cleanup();
        this.emit("end");
      }),
    ];
    let onDevice = false;
    try {
      onDevice = Platform.OS !== "web" && M.supportsOnDeviceRecognition();
    } catch {}
    try {
      M.start({
        lang: "en-US", interimResults: true, maxAlternatives: 1, addsPunctuation: true,
        continuous: opts.mode === "ptt" && !(Platform.OS === "android" && Number(Platform.Version) < 33),
        requiresOnDeviceRecognition: false,
        contextualStrings: opts.contextualStrings?.slice(0, 80),
        volumeChangeEventOptions: { enabled: true, intervalMillis: 120 },
        androidIntentOptions: onDevice ? { EXTRA_PREFER_OFFLINE: true } as any : undefined,
      });
    } catch (err) {
      this.cleanup();
      this.emit("error", { code: "start-failed", message: (err as Error).message });
      this.emit("end");
    }
  }

  stop() {
    if (!this.active) return;
    try {
      ExpoSpeechRecognitionModule.stop();
    } catch {
      this.cleanup();
      this.emit("end");
    }
  }

  cancel() {
    if (!this.active) return;
    try {
      ExpoSpeechRecognitionModule.abort(); // ends without a final result
    } catch {
      this.cleanup();
      this.emit("end");
    }
  }

  private cleanup() {
    this.active = false;
    for (const s of this.subs) s.remove();
    this.subs = [];
  }
}

/** The recognizer for this device: Whisper through the desktop shell, or the platform's own. */
export function createRecognizer(): VoiceInput {
  return desktopStt() ? new DesktopRecognizer() : new DeviceRecognizer();
}
