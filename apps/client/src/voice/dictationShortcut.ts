/**
 * The Ctrl+D dictation shortcut as a small state machine, apart from the DOM so it can be tested.
 *
 * It behaves like the mic button, and like dictation in Claude's own apps:
 *   - press Ctrl+D: start listening. Press Ctrl+D again: stop, and the text stays in the box for review.
 *   - hold Ctrl+D while you talk and let go: the same, as push-to-talk. A hold is HOLD_MS or longer:
 *     longer than the mic button's 300 ms, because a slow key press must not end a dictation it just started.
 *   - Esc: cancel. Nothing is added and the box goes back to what it held.
 * On a Mac, Cmd+D does the same.
 */
export const HOLD_MS = 600;

export type DictationPhase = "idle" | "listening" | "finishing";
export type ShortcutAction = "start" | "stop" | "cancel" | null;

export interface ShortcutState {
  /** When the Ctrl+D that started this dictation went down, while the keys are still held. */
  heldSince: number | null;
}
export const initialShortcutState: ShortcutState = { heldSince: null };

export interface KeyInput {
  type: "keydown" | "keyup" | "blur";
  key?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  /** Milliseconds, from any clock that only moves forward. */
  time: number;
}

/** Ctrl+D (or Cmd+D), with no other modifier. */
export function isDictationChord(e: KeyInput): boolean {
  return (e.key === "d" || e.key === "D") && !!e.ctrlKey !== !!e.metaKey && !e.altKey && !e.shiftKey;
}

export interface ShortcutStep {
  state: ShortcutState;
  action: ShortcutAction;
  /** True when the key belongs to dictation: the caller stops the browser and the page from also acting on it. */
  handled: boolean;
}

export function shortcutStep(state: ShortcutState, e: KeyInput, phase: DictationPhase): ShortcutStep {
  if (e.type === "blur") return { state: initialShortcutState, action: null, handled: false }; // the key-up may never arrive; keep listening
  if (e.type === "keydown") {
    if (isDictationChord(e)) {
      if (e.repeat) return { state, action: null, handled: true }; // the key is being held
      if (phase === "idle") return { state: { heldSince: e.time }, action: "start", handled: true };
      if (phase === "listening") return { state: initialShortcutState, action: "stop", handled: true };
      return { state: initialShortcutState, action: null, handled: true }; // the last pass is running
    }
    if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && phase !== "idle") {
      return { state: initialShortcutState, action: "cancel", handled: true };
    }
    return { state, action: null, handled: false };
  }
  // keyup: letting go of either key ends a hold.
  if (state.heldSince !== null && (e.key === "d" || e.key === "D" || e.key === "Control" || e.key === "Meta")) {
    const held = e.time - state.heldSince;
    return { state: initialShortcutState, action: held >= HOLD_MS && phase !== "finishing" ? "stop" : null, handled: false };
  }
  return { state, action: null, handled: false };
}
