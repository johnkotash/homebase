import { describe, expect, it } from "vitest";
import { beginDraft, draftCancel, draftEdited, draftFinal, draftPartial, joinTranscript } from "../src/voice/dictationDraft";
import { HOLD_MS, initialShortcutState, isDictationChord, shortcutStep, type DictationPhase, type KeyInput, type ShortcutAction, type ShortcutState } from "../src/voice/dictationShortcut";
import { Downsampler, HANDSFREE_PAUSE_MS, SILENCE_STOP_MS, levelToVolume, micError, silenceVerdict } from "../src/voice/desktop/policy";

const ctrlD = (time: number, extra: Partial<KeyInput> = {}): KeyInput => ({ type: "keydown", key: "d", ctrlKey: true, time, ...extra });
const up = (key: string, time: number): KeyInput => ({ type: "keyup", key, time });

/** Plays keys through the state machine the way the hook does, tracking what dictation would be doing. */
function play(keys: KeyInput[], phase: DictationPhase = "idle") {
  let state: ShortcutState = initialShortcutState;
  const actions: ShortcutAction[] = [];
  const handled: boolean[] = [];
  for (const k of keys) {
    const step = shortcutStep(state, k, phase);
    state = step.state;
    handled.push(step.handled);
    if (step.action) actions.push(step.action);
    if (step.action === "start") phase = "listening";
    if (step.action === "stop") phase = "finishing";
    if (step.action === "cancel") phase = "idle";
  }
  return { actions, handled, state, phase };
}

describe("the Ctrl+D dictation shortcut", () => {
  it("is Ctrl+D or Cmd+D, and nothing close to it", () => {
    expect(isDictationChord(ctrlD(0))).toBe(true);
    expect(isDictationChord(ctrlD(0, { key: "D" }))).toBe(true); // caps lock
    expect(isDictationChord({ type: "keydown", key: "d", metaKey: true, time: 0 })).toBe(true);
    expect(isDictationChord({ type: "keydown", key: "d", time: 0 })).toBe(false); // typing a d
    expect(isDictationChord(ctrlD(0, { shiftKey: true }))).toBe(false);
    expect(isDictationChord(ctrlD(0, { altKey: true }))).toBe(false); // AltGr combinations
    expect(isDictationChord(ctrlD(0, { metaKey: true }))).toBe(false);
    expect(isDictationChord(ctrlD(0, { key: "f" }))).toBe(false);
  });

  it("toggles: a press starts listening, the next press stops it", () => {
    const r = play([ctrlD(0), up("d", 90), up("Control", 120), ctrlD(5000), up("d", 5080)]);
    expect(r.actions).toEqual(["start", "stop"]);
  });

  it("keeps listening after a quick press is let go", () => {
    const r = play([ctrlD(0), up("d", HOLD_MS - 1)]);
    expect(r.actions).toEqual(["start"]);
    expect(r.phase).toBe("listening");
  });

  it("is push-to-talk when held: letting go stops it", () => {
    expect(play([ctrlD(0), up("d", HOLD_MS)]).actions).toEqual(["start", "stop"]);
    expect(play([ctrlD(0), up("d", 3200)]).actions).toEqual(["start", "stop"]);
  });

  it("ends a hold when either key is let go, and only once", () => {
    expect(play([ctrlD(0), up("Control", 2000), up("d", 2050)]).actions).toEqual(["start", "stop"]);
    expect(play([ctrlD(0), up("Meta", 2000)]).actions).toEqual(["start", "stop"]);
    expect(play([ctrlD(0), up("Shift", 2000)]).actions).toEqual(["start"]); // some other key
  });

  it("ignores the repeats a held key sends, but still keeps them from the page", () => {
    const r = play([ctrlD(0), ctrlD(500, { repeat: true }), ctrlD(530, { repeat: true }), up("d", 900)]);
    expect(r.actions).toEqual(["start", "stop"]);
    expect(r.handled).toEqual([true, true, true, false]);
  });

  it("stops a dictation that something else started (the mic button)", () => {
    expect(play([ctrlD(0)], "listening").actions).toEqual(["stop"]);
  });

  it("does nothing while the last pass is running, and a key let go then does not stop anything", () => {
    const r = play([ctrlD(0)], "finishing");
    expect(r.actions).toEqual([]);
    expect(r.handled).toEqual([true]);
    let s = shortcutStep(initialShortcutState, ctrlD(0), "idle").state;
    expect(shortcutStep(s, up("d", 5000), "finishing").action).toBeNull();
  });

  it("cancels with Esc while listening or finishing, and leaves Esc alone otherwise", () => {
    const esc: KeyInput = { type: "keydown", key: "Escape", time: 10 };
    expect(shortcutStep(initialShortcutState, esc, "listening")).toMatchObject({ action: "cancel", handled: true });
    expect(shortcutStep(initialShortcutState, esc, "finishing")).toMatchObject({ action: "cancel", handled: true });
    expect(shortcutStep(initialShortcutState, esc, "idle")).toMatchObject({ action: null, handled: false });
    expect(shortcutStep(initialShortcutState, { ...esc, shiftKey: true }, "listening").action).toBeNull();
  });

  it("does not turn a hold into a stop after Esc already cancelled it", () => {
    const r = play([ctrlD(0), { type: "keydown", key: "Escape", time: 800 }, up("d", 1500)]);
    expect(r.actions).toEqual(["start", "cancel"]);
  });

  it("keeps listening when the window loses focus mid-hold, because the key-up never arrives", () => {
    const r = play([ctrlD(0), { type: "blur", time: 0 }, up("d", 4000)]);
    expect(r.actions).toEqual(["start"]);
    expect(r.state.heldSince).toBeNull();
  });

  it("leaves every other key to the page", () => {
    for (const key of ["a", "Enter", "Tab", "Control", "d"]) {
      expect(shortcutStep(initialShortcutState, { type: "keydown", key, time: 0 }, "idle")).toMatchObject({ action: null, handled: false });
    }
    expect(shortcutStep(initialShortcutState, up("d", 100), "listening")).toMatchObject({ action: null, handled: false });
  });
});

describe("dictated text landing in the composer", () => {
  it("joins spoken words to typed text with one space", () => {
    expect(joinTranscript("", "Check the deploy.")).toBe("Check the deploy.");
    expect(joinTranscript("Hi team, ", " check the deploy. ")).toBe("Hi team, check the deploy.");
    expect(joinTranscript("Hi team,", "")).toBe("Hi team,");
    expect(joinTranscript("  ", "  ")).toBe("");
  });

  it("shows live text without piling one partial on top of the last", () => {
    const d = beginDraft("Reply to Sam:");
    expect(draftPartial(d, "tell him")).toBe("Reply to Sam: tell him");
    expect(draftPartial(d, "tell him the form")).toBe("Reply to Sam: tell him the form");
    expect(draftPartial(d, "")).toBe("Reply to Sam:");
  });

  it("keeps the final text for review, and adds the next dictation after it", () => {
    let d = beginDraft("");
    const first = draftFinal(d, "Check the staging deploy.");
    expect(first.text).toBe("Check the staging deploy.");
    d = beginDraft(first.draft.base); // Ctrl+D again
    expect(draftPartial(d, "Then draft")).toBe("Check the staging deploy. Then draft");
    expect(draftFinal(d, "Then draft the email.").text).toBe("Check the staging deploy. Then draft the email.");
  });

  it("puts the box back on cancel: typed text stays, the cancelled words go", () => {
    const d = beginDraft("Reply to Sam:");
    draftPartial(d, "no wait");
    expect(draftCancel(d)).toBe("Reply to Sam:");
    expect(draftCancel(beginDraft(""))).toBe("");
  });

  it("cancel also undoes words that were already final in the same dictation", () => {
    // The phone's recognizer can deliver several finals while the mic stays open.
    let d = beginDraft("Note:");
    d = draftFinal(d, "first sentence.").draft;
    expect(draftPartial(d, "second")).toBe("Note: first sentence. second");
    expect(draftCancel(d)).toBe("Note:");
  });

  it("adds later words to what was typed in between", () => {
    let d = beginDraft("");
    d = draftFinal(d, "Check the deploy.").draft;
    d = draftEdited(d, "Check the staging deploy.");
    expect(draftFinal(d, "Thanks.").text).toBe("Check the staging deploy. Thanks.");
  });
});

describe("desktop dictation rules", () => {
  it("ends a latched dictation after a long silence and keeps what was said", () => {
    expect(silenceVerdict({ mode: "ptt", heardVoice: true, msSinceVoice: 3000, msSinceStart: 9000 })).toBe("continue");
    expect(silenceVerdict({ mode: "ptt", heardVoice: true, msSinceVoice: SILENCE_STOP_MS, msSinceStart: 60_000 })).toBe("finish");
  });

  it("says so when nothing was heard at all", () => {
    expect(silenceVerdict({ mode: "ptt", heardVoice: false, msSinceVoice: 99_999, msSinceStart: 5000 })).toBe("continue");
    expect(silenceVerdict({ mode: "ptt", heardVoice: false, msSinceVoice: 99_999, msSinceStart: SILENCE_STOP_MS })).toBe("no-speech");
  });

  it("ends a hands-free utterance after a short pause, like the phone", () => {
    expect(silenceVerdict({ mode: "handsfree", heardVoice: true, msSinceVoice: 400, msSinceStart: 3000 })).toBe("continue");
    expect(silenceVerdict({ mode: "handsfree", heardVoice: true, msSinceVoice: HANDSFREE_PAUSE_MS, msSinceStart: 3000 })).toBe("finish");
    expect(silenceVerdict({ mode: "handsfree", heardVoice: false, msSinceVoice: 0, msSinceStart: 9000 })).toBe("no-speech");
  });

  it("reports loudness on the phone recognizer's scale", () => {
    expect(levelToVolume(0)).toBe(-2);
    expect(levelToVolume(1)).toBe(10);
    expect(levelToVolume(-1)).toBe(-2);
    expect(levelToVolume(0.05)).toBeGreaterThan(levelToVolume(0.01));
    expect(levelToVolume(0.05)).toBeGreaterThan(2);
    expect(levelToVolume(0.05)).toBeLessThan(10);
  });

  it("explains a missing or blocked microphone in plain words", () => {
    expect(micError({ name: "NotFoundError" })).toMatchObject({ code: "no-microphone" });
    expect(micError({ name: "NotFoundError" }).message).toMatch(/No microphone found/);
    expect(micError({ name: "NotAllowedError" })).toMatchObject({ code: "mic-blocked" });
    expect(micError({ name: "NotReadableError" })).toMatchObject({ code: "mic-busy" });
    expect(micError(new Error("boom"))).toEqual({ code: "mic-failed", message: "boom" });
    expect(micError(null).code).toBe("mic-failed");
  });

  it("brings 48 kHz audio down to 16 kHz without losing or inventing samples", () => {
    const d = new Downsampler(48000);
    const block = Float32Array.from({ length: 480 }, (_, i) => (i % 3 === 0 ? 0.3 : 0)); // each output covers 0.3, 0, 0
    const out = d.push(block);
    expect(out.length).toBe(160);
    expect(out[0]).toBeCloseTo(0.1, 5);
    expect(out[159]).toBeCloseTo(0.1, 5);
  });

  it("keeps its place across blocks of any size, and passes 16 kHz straight through", () => {
    const d = new Downsampler(44100);
    let total = 0;
    for (let i = 0; i < 100; i++) total += d.push(new Float32Array(441).fill(0.2)).length; // one second in all
    expect(Math.abs(total - 16000)).toBeLessThanOrEqual(1);
    const same = new Float32Array(160).fill(0.5);
    expect(new Downsampler(16000).push(same)).toBe(same);
  });
});
