import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { initialShortcutState, shortcutStep, type DictationPhase } from "./dictationShortcut";

/** "Ctrl+D", or "Cmd+D" on a Mac: for hints next to the composer. */
export const dictationShortcutLabel = Platform.OS === "web" && typeof navigator !== "undefined" && /mac/i.test(navigator.platform ?? "") ? "Cmd+D" : "Ctrl+D";

// The composer that was opened last owns the shortcut, so two composers never both start recording.
const owners: symbol[] = [];

/**
 * Binds Ctrl+D (start / stop), a held Ctrl+D (push-to-talk) and Esc (cancel) to a dictation, for as long
 * as the component is on screen. Desktop window and browser only; the phone has no keyboard shortcut.
 * The rules are in dictationShortcut.ts.
 */
export function useDictationShortcut(d: { available: boolean; listening: boolean; finishing: boolean; start(): void; stop(): void; cancel(): void }, enabled = true) {
  const live = useRef(d);
  live.current = d;
  const on = enabled && d.available && Platform.OS === "web";

  useEffect(() => {
    if (!on || typeof window === "undefined") return;
    const me = Symbol("composer");
    owners.push(me);
    let state = initialShortcutState;
    const phase = (): DictationPhase => (live.current.finishing ? "finishing" : live.current.listening ? "listening" : "idle");
    const handle = (type: "keydown" | "keyup") => (e: KeyboardEvent) => {
      if (owners[owners.length - 1] !== me) return;
      const p = phase();
      // A sheet or dialog on top has the keyboard: do not start a dictation into the box behind it.
      if (p === "idle" && type === "keydown" && (e.target as Element | null)?.closest?.("[aria-modal=true]")) return;
      const step = shortcutStep(state, { type, key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, repeat: e.repeat, time: e.timeStamp }, p);
      state = step.state;
      if (step.handled) {
        e.preventDefault();
        e.stopPropagation();
      }
      if (step.action === "start") live.current.start();
      else if (step.action === "stop") live.current.stop();
      else if (step.action === "cancel") live.current.cancel();
    };
    const down = handle("keydown"), up = handle("keyup");
    const blur = () => {
      state = shortcutStep(state, { type: "blur", time: 0 }, phase()).state;
    };
    // Capture phase: the shortcut wins before a focused text field sees the key.
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", blur);
      const i = owners.indexOf(me);
      if (i >= 0) owners.splice(i, 1);
    };
  }, [on]);
}
