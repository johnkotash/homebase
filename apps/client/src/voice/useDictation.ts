import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform } from "react-native";
import { syncStore } from "../sync/session";
import { createRecognizer, ensureVoicePermission, voiceAvailability, type Availability, type VoiceInput } from "./VoiceInput";

export type DictationState = "idle" | "listening" | "denied" | "error";

function contextualStrings(): string[] {
  const e = syncStore.getState().entities;
  const out = new Set<string>();
  for (const a of Object.values(e.agents)) out.add(a.name);
  for (const t of Object.values(e.threads)) out.add(t.title);
  for (const i of Object.values(e.inbox_items)) if (i.clientLabel) out.add(i.clientLabel);
  // Client names and their "also heard as" variants from the vault's Clients.md, so the recognizer gets them right.
  for (const a of Object.values(e.agents)) for (const h of a.vault?.hints ?? []) out.add(h);
  return [...out];
}

const buzz = (kind: "start" | "stop") => {
  if (Platform.OS === "web") return;
  void Haptics.impactAsync(kind === "start" ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light).catch(() => {});
};

/**
 * Push-to-talk dictation. `onPartial` fires with the live transcript, `onFinal` once per utterance.
 * `availability` is "unavailable" when the device has no speech service; the UI says so plainly.
 *
 * `cancel()` stops and throws away what was heard (`onCancel` fires, `onFinal` does not).
 * On the desktop the final text arrives a moment after `stop()`: `finishing` is true for that moment,
 * and `notice` says what the engine is doing while its model is loaded or downloaded.
 */
export function useDictation(handlers: { onPartial?: (text: string) => void; onFinal?: (text: string) => void; onCancel?: () => void; mode?: "ptt" | "handsfree" }) {
  const availability: Availability = useMemo(() => voiceAvailability(), []);
  const [state, setState] = useState<DictationState>("idle");
  const [partial, setPartial] = useState("");
  const [level, setLevel] = useState(0);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const rec = useRef<VoiceInput | null>(null);
  const cancelled = useRef(false);
  const busy = useRef<"no" | "listening" | "finishing">("no");
  const waiters = useRef<Array<() => void>>([]);
  const started = useRef(false); // the recognizer itself is running (permission was granted)
  const h = useRef(handlers);
  h.current = handlers;
  const lastPartial = useRef("");
  const gotFinal = useRef(false);

  useEffect(() => {
    const r = createRecognizer();
    rec.current = r;
    const offs = [
      r.on("partial", (t: string) => {
        if (cancelled.current) return;
        lastPartial.current = t;
        setPartial(t);
        h.current.onPartial?.(t);
      }),
      r.on("final", (t: string) => {
        if (!t || cancelled.current) return;
        gotFinal.current = true;
        lastPartial.current = "";
        setPartial("");
        h.current.onFinal?.(t);
      }),
      r.on("volume", (v: number) => setLevel(Math.max(0, Math.min(1, (v + 2) / 12)))),
      r.on("error", (e: { code: string; message: string }) => {
        setErrorText(e.code === "not-allowed" ? "Microphone permission is off" : e.code === "service-not-allowed" || e.code === "language-not-supported" ? "Speech recognition unavailable on this device" : e.message || "Speech recognition failed");
        setState(e.code === "not-allowed" ? "denied" : "error");
      }),
      r.on("status", (st: { phase: string; progress?: number }) => {
        setNotice(st.phase === "downloading" ? `Downloading the speech model${st.progress ? ` (${st.progress}%)` : ""}. This happens once. Keep talking, nothing is lost.` : st.phase === "loading" ? "Getting the speech model ready…" : null);
      }),
      r.on("end", () => {
        // Some recognizers end without a final result; keep what was heard.
        if (!cancelled.current && !gotFinal.current && lastPartial.current) h.current.onFinal?.(lastPartial.current);
        busy.current = "no";
        started.current = false;
        setFinishing(false);
        setNotice(null);
        waiters.current.splice(0).forEach((w) => w());
        lastPartial.current = "";
        setPartial("");
        setLevel(0);
        setState((s) => (s === "listening" ? "idle" : s));
        buzz("stop");
      }),
    ];
    return () => {
      offs.forEach((o) => o());
      // Leaving the screen: the desktop engine drops the dictation instead of running a last pass nobody will see.
      if (r.slowFinal && r.cancel) r.cancel();
      else r.stop();
    };
  }, []);

  const start = useCallback(async () => {
    if (availability !== "available" || busy.current !== "no") return;
    busy.current = "listening";
    cancelled.current = false;
    setErrorText(null);
    const ok = await ensureVoicePermission(); // asked at first use, not at launch
    if (!ok) {
      busy.current = "no";
      setState("denied");
      setErrorText("Microphone permission is off");
      return;
    }
    gotFinal.current = false;
    lastPartial.current = "";
    setState("listening");
    buzz("start");
    started.current = true;
    rec.current?.start({ mode: h.current.mode ?? "ptt", contextualStrings: contextualStrings() });
  }, [availability]);

  /** Stops listening. The promise resolves once the recognizer has delivered its final text. */
  const stop = useCallback((): Promise<void> => {
    const r = rec.current;
    if (!r || busy.current === "no" || !started.current) return Promise.resolve();
    const done = new Promise<void>((resolve) => waiters.current.push(resolve));
    if (busy.current === "listening") {
      busy.current = "finishing";
      if (r.slowFinal) setFinishing(true);
      r.stop();
    }
    return done;
  }, []);

  /** Stops and throws away this dictation, including text that is still being worked out. */
  const cancel = useCallback(() => {
    const r = rec.current;
    if (!r || busy.current === "no" || !started.current) return;
    cancelled.current = true;
    lastPartial.current = "";
    setPartial("");
    if (r.cancel) r.cancel();
    else r.stop();
    h.current.onCancel?.();
  }, []);

  return {
    availability, state, partial, level, errorText, start, stop, cancel, finishing, notice,
    /** True when the final text takes a moment after stopping (desktop). */
    slowFinal: !!rec.current?.slowFinal,
    listening: state === "listening",
  };
}
