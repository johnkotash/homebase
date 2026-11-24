import { AppState, Platform } from "react-native";
import { create } from "zustand";
import type { Presence } from "./rules";

/**
 * Where the owner is looking: the route on screen and whether the app is in front. The notification
 * rules and the read tracker both read it, so "in view" means one thing everywhere.
 *   desktop / browser  the window has focus and is visible (not minimized, not a background tab)
 *   phone              the app is in the foreground
 */
function readFocus(): boolean {
  if (Platform.OS === "web") {
    if (typeof document === "undefined") return true;
    return document.visibilityState === "visible" && document.hasFocus();
  }
  return AppState.currentState !== "background" && AppState.currentState !== "inactive";
}

export const usePresence = create<Presence>(() => ({ path: "/", focused: readFocus() }));
export const getPresence = (): Presence => usePresence.getState();

export function setPresencePath(path: string) {
  if (usePresence.getState().path !== path) usePresence.setState({ path });
}

/** Keeps `focused` current. Returns the function that stops watching. */
export function watchPresence(): () => void {
  const sync = () => {
    const focused = readFocus();
    if (focused !== usePresence.getState().focused) usePresence.setState({ focused });
  };
  sync();
  if (Platform.OS === "web") {
    if (typeof window === "undefined") return () => {};
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }
  const sub = AppState.addEventListener("change", sync);
  return () => sub.remove();
}
