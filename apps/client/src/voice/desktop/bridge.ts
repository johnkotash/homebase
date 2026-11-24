/**
 * The dictation bridge the desktop shell puts on `window` (apps/desktop/preload.cjs). The model runs in
 * the shell, not in this page: the page records the microphone and hands the audio over.
 */
export type SttEvent =
  | { id: string; type: "status"; phase: "loading" | "downloading" | "ready" | "full"; progress?: number; label?: string }
  | { id: string; type: "partial"; text: string }
  | { id: string; type: "final"; text: string; ms?: number; audioS?: number; engine?: string }
  | { id: string; type: "error"; code: string; message: string };

export interface SttBridge {
  /** Starts a dictation. The model is loaded (and, the first time, downloaded) in the background. */
  start(opts?: { profile?: string }): Promise<{ id: string }>;
  /** 16 kHz mono samples, in order. */
  audio(id: string, samples: Float32Array): void;
  /** Ends the dictation; a "final" (or "error") event follows. */
  stop(id: string): void;
  /** Drops the dictation; no event follows. */
  cancel(id: string): void;
  onEvent(cb: (e: SttEvent) => void): () => void;
}

export function desktopStt(): SttBridge | undefined {
  if (typeof window === "undefined") return undefined;
  const b = (window as any).homebaseDesktopStt as SttBridge | undefined;
  return b && typeof b.start === "function" ? b : undefined;
}

/** Which model the desktop uses: "fast" or "accurate". Kept on this PC only; unset means the shell's default. */
const PROFILE_KEY = "homebase.stt.profile";
export type SttProfile = "fast" | "accurate";
export function getSttProfile(): SttProfile | undefined {
  try {
    const v = window.localStorage.getItem(PROFILE_KEY);
    return v === "fast" || v === "accurate" ? v : undefined;
  } catch {
    return undefined;
  }
}
export function setSttProfile(p: SttProfile) {
  try {
    window.localStorage.setItem(PROFILE_KEY, p);
  } catch {}
}
