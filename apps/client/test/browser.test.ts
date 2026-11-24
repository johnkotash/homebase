import { describe, expect, it } from "vitest";
import { BROWSER_APPROVAL, DEFAULT_BROWSER_SETTINGS, browserStatusLine, type Approval, type BrowserState } from "@homebase/protocol";
import {
  HAND_BACK_NOTES, NO_ZOOM, addressToUrl, browserToolWords, clampZoom, containRect, dragToWheel, enterControl, fitWidthRect, flingSteps, handBackMessage, handBackThread, hasBrowser,
  keyInput, lastBrowserStep, leaveAction, linkHealth, modifiersOf, needsOwnerApprovals, offerPhonePage, pageKeyboard, panZoom, parseHHMM, phoneSize, pinchZoom, seatControls, shouldRaiseKeyboard, sizeChanged, textDiff,
  toFraction, touchToPage, typingInputs, zoomedRect,
} from "../src/browser";
import { sameClientSession } from "../src/sync/sessionKey";

const state = (over: Partial<BrowserState> = {}): BrowserState => ({
  running: true, unavailable: null, seat: "agent", needs: null, url: "https://example.com/", title: "Example Domain", site: "example.com", tabs: 1,
  viewport: { width: 1280, height: 800 }, layout: "desktop", browser: "Chrome/159.0.0.0", headless: false, note: null, budget: { site: "example.com", usedHour: 14, usedDay: 30, nextAt: null },
  settings: DEFAULT_BROWSER_SETTINGS, signedIn: [], runId: "run_1", last: null, viewers: 1, updatedAt: 1, ...over,
});

describe("browser view: where a tap lands", () => {
  it("fits the picture inside the box and keeps its proportions", () => {
    // A wide desktop pane: the page is pillarboxed.
    expect(containRect({ width: 1600, height: 500 }, { width: 1280, height: 800 })).toEqual({ left: 400, top: 0, width: 800, height: 500 });
    // A phone held upright: the page is letterboxed.
    expect(containRect({ width: 400, height: 700 }, { width: 1280, height: 800 })).toEqual({ left: 0, top: 225, width: 400, height: 250 });
    expect(containRect({ width: 0, height: 0 }, { width: 1280, height: 800 }).width).toBe(0);
  });

  it("turns a point on the screen into a fraction of the page, the same on any screen", () => {
    const phone = containRect({ width: 400, height: 700 }, { width: 1280, height: 800 });
    const desk = containRect({ width: 1600, height: 500 }, { width: 1280, height: 800 });
    // The middle of the page, on both.
    expect(toFraction({ x: 200, y: 350 }, phone)).toEqual({ x: 0.5, y: 0.5 });
    expect(toFraction({ x: 800, y: 250 }, desk)).toEqual({ x: 0.5, y: 0.5 });
    // A quarter in from the left, three quarters down.
    expect(toFraction({ x: 100, y: 225 + 187.5 }, phone)).toEqual({ x: 0.25, y: 0.75 });
    // The bars beside the picture are not the page.
    expect(toFraction({ x: 200, y: 100 }, phone)).toBeNull();
    expect(toFraction({ x: 100, y: 250 }, desk)).toBeNull();
  });
});

describe("browser view: the desktop keyboard", () => {
  it("passes on letters, named keys and editing shortcuts, with their modifiers", () => {
    expect(keyInput({ key: "a", code: "KeyA" }, "down")).toEqual({ kind: "key", type: "down", key: "a", code: "KeyA", modifiers: 0, text: "a" });
    expect(keyInput({ key: "A", code: "KeyA", shiftKey: true }, "down")).toMatchObject({ key: "A", modifiers: 8, text: "A" });
    expect(keyInput({ key: "a", code: "KeyA" }, "up")).toEqual({ kind: "key", type: "up", key: "a", code: "KeyA", modifiers: 0 });
    expect(keyInput({ key: "Enter", code: "Enter" }, "down")).toEqual({ kind: "key", type: "down", key: "Enter", code: "Enter", modifiers: 0 });
    expect(keyInput({ key: " ", code: "Space" }, "down")).toMatchObject({ key: "Space" });
    // Select all, copy, cut, undo: the page's own shortcuts, sent without text.
    expect(keyInput({ key: "a", code: "KeyA", ctrlKey: true }, "down")).toEqual({ kind: "key", type: "down", key: "a", code: "KeyA", modifiers: 2 });
    expect(modifiersOf({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15);
  });

  it("keeps this window's own shortcuts and bare modifier keys to itself", () => {
    for (const key of ["r", "w", "t", "l", "v"]) expect(keyInput({ key, ctrlKey: true }, "down"), key).toBeNull();
    for (const key of ["Shift", "Control", "Alt", "Meta", "F5", "F12", "CapsLock"]) expect(keyInput({ key }, "down"), key).toBeNull();
  });
});

describe("browser view: who drives, in buttons", () => {
  it("the agent drives: take over, pause, sign in", () => {
    expect(seatControls(state())).toMatchObject({ drives: false, primary: { action: "take", label: "Take over" }, canPause: true, canSignIn: true, banner: null });
    expect(seatControls(state({ running: false })).primary).toMatchObject({ action: "take", label: "Open the browser" });
  });

  it("the owner drives: the page takes their hands and one button hands it back", () => {
    expect(seatControls(state({ seat: "owner" }))).toMatchObject({ drives: true, primary: { action: "release" }, canPause: false });
  });

  it("private sign-in says that nothing is recorded, and ends with Done", () => {
    const c = seatControls(state({ seat: "signin" }));
    expect(c).toMatchObject({ drives: true, primary: { action: "done" }, canSignIn: false, banner: { tone: "private" } });
    expect(c.banner!.text).toMatch(/nothing here is recorded/);
  });

  it("needs-you names the reason and offers the wheel; paused offers resume", () => {
    const c = seatControls(state({ seat: "needs_owner", needs: { reason: "example.com is asking you to sign in", site: "example.com", since: 1 } }));
    expect(c).toMatchObject({ drives: false, primary: { action: "take" }, banner: { tone: "needs", text: "Needs you: example.com is asking you to sign in." } });
    expect(seatControls(state({ seat: "paused" })).primary).toMatchObject({ action: "resume" });
    expect(seatControls(null)).toMatchObject({ drives: false, primary: null });
    expect(seatControls(state({ unavailable: "No browser was found on this machine." }))).toMatchObject({ primary: null, banner: { text: "No browser was found on this machine." } });
  });

  it("the status line says who drives, where, and how much of the allowance is used", () => {
    expect(browserStatusLine(state())).toBe("Agent driving · example.com · 14 of 40 pages this hour");
    expect(browserStatusLine(state({ seat: "owner" }))).toBe("You are driving · example.com");
    expect(browserStatusLine(state({ seat: "signin" }))).toBe("Private sign-in · example.com");
    expect(browserStatusLine(state({ running: false }))).toMatch(/closed/);
    expect(browserStatusLine(null)).toBe("Browser not connected");
  });
});

describe("browser view: small rules", () => {
  it("only an agent whose connector runs a browser shows one", () => {
    expect(hasBrowser({ capabilities: ["code", "browser"], connectorId: "con_1" })).toBe(true);
    expect(hasBrowser({ capabilities: ["code"], connectorId: "con_1" })).toBe(false);
    expect(hasBrowser({ capabilities: ["browser"], connectorId: null })).toBe(false);
    expect(hasBrowser(undefined)).toBe(false);
  });

  it("handing back answers the waiting needs-you card of that run, and no other approval", () => {
    const a = (over: Partial<Approval>): Approval => ({ id: "apr_1", runId: "run_1", status: "pending", tool: BROWSER_APPROVAL.needsOwner, kind: "tool", risk: "medium", title: "x", requestedAt: 1, ...over } as Approval);
    const all = [a({ id: "apr_1" }), a({ id: "apr_2", tool: BROWSER_APPROVAL.act }), a({ id: "apr_3", status: "approved" }), a({ id: "apr_4", runId: "run_2" }), a({ id: "apr_5", tool: "Bash" })];
    expect(needsOwnerApprovals(all, "run_1").map((x) => x.id)).toEqual(["apr_1"]);
    expect(needsOwnerApprovals(all, null).map((x) => x.id)).toEqual(["apr_1", "apr_4"]);
  });

  it("finds the agent's last step in the browser among a run's events", () => {
    const events = [
      { kind: "system", at: 1, data: { message: "Browser · Opened · example.com", browser: { action: "Opened", url: "https://example.com/", title: "Example Domain", site: "example.com" } } },
      { kind: "tool_call", at: 2, data: { tool: "Read" } },
      { kind: "system", at: 3, data: { message: "Browser · Followed \"Learn more\" · iana.org", browser: { action: "Followed \"Learn more\"", url: "https://www.iana.org/", title: "IANA", site: "iana.org" } } },
      { kind: "system", at: 4, data: { message: "Mode changed" } },
    ];
    expect(lastBrowserStep(events)).toMatchObject({ at: 3, text: "Followed \"Learn more\" · iana.org" });
    expect(lastBrowserStep([])).toBeNull();
    expect(lastBrowserStep(undefined)).toBeNull();
  });

  it("reads the hours typed into the rules", () => {
    expect(parseHHMM("7:00")).toBe("07:00");
    expect(parseHHMM("22.30")).toBe("22:30");
    expect(parseHHMM("0700")).toBe("07:00");
    expect(parseHHMM("25:00")).toBeNull();
    expect(parseHHMM("soon")).toBeNull();
  });
});

describe("browser view: the run timeline", () => {
  it("names a browser tool call in words, and leaves other tools alone", () => {
    expect(browserToolWords("mcp__browser__browser_open", { url: "https://example.com/" })).toEqual({ label: "Browser · open", title: "https://example.com/" });
    expect(browserToolWords("mcp__browser__browser_click", { ref: "e12" })).toEqual({ label: "Browser · click", title: "element e12" });
    // What is typed is on the approval card and in the step's own input, not in its title.
    expect(browserToolWords("mcp__browser__browser_type", { ref: "e3", text: "red shoes" })).toEqual({ label: "Browser · type", title: "element e3" });
    expect(browserToolWords("mcp__browser__browser_request_owner", { reason: "sign in" })).toEqual({ label: "Browser · ask for you", title: "sign in" });
    expect(browserToolWords("mcp__browser__browser_find", { text: "regatta" })?.title).toBe("regatta");
    expect(browserToolWords("Bash", { command: "ls" })).toBeNull();
    expect(browserToolWords("mcp__images__openai_image", {})).toBeNull();
  });
});

describe("full-screen browser: where a finger lands", () => {
  it("fits the page to the phone's width from the top, and a tap lands on the same page point at any zoom", () => {
    // A phone-sized page (390 x 700) on a 390 x 640 view: as wide as the screen, running on under the bottom edge.
    const rect = fitWidthRect({ width: 390, height: 640 }, { width: 390, height: 700 });
    expect(rect).toEqual({ left: 0, top: 0, width: 390, height: 700 });
    expect(touchToPage({ x: 195, y: 350 }, rect)).toEqual({ x: 0.5, y: 0.5 });
    // A desktop page on the same phone: the full width, at the top; below it is not the page.
    const desk = fitWidthRect({ width: 390, height: 640 }, { width: 1280, height: 800 });
    expect(desk.top).toBe(0);
    expect(desk.width).toBe(390);
    expect(touchToPage({ x: 100, y: 600 }, desk)).toBeNull();
    // The view at twice the size, moved so that the page's middle is at the top-left corner of the screen.
    const zoom = { scale: 2, x: -390, y: -700 };
    expect(zoomedRect(rect, zoom)).toEqual({ left: -390, top: -700, width: 780, height: 1400 });
    expect(touchToPage({ x: 0, y: 0 }, rect, zoom)).toEqual({ x: 0.5, y: 0.5 });
    expect(touchToPage({ x: 195, y: 350 }, rect, zoom)).toEqual({ x: 0.75, y: 0.75 });
  });

  it("a pinch keeps the point under the fingers where it is, within 1x to 4x, and a zoomed picture never shows an empty edge", () => {
    const box = { width: 400, height: 800 };
    const rect = fitWidthRect(box, { width: 400, height: 800 });
    const z = pinchZoom(rect, box, { zoom: NO_ZOOM, center: { x: 100, y: 200 }, distance: 100 }, { center: { x: 100, y: 200 }, distance: 200 });
    expect(z.scale).toBe(2);
    // The page point that was under the fingers (0.25, 0.25) is still under them.
    expect(touchToPage({ x: 100, y: 200 }, rect, z)).toEqual({ x: 0.25, y: 0.25 });
    expect(pinchZoom(rect, box, { zoom: NO_ZOOM, center: { x: 0, y: 0 }, distance: 100 }, { center: { x: 0, y: 0 }, distance: 1000 }).scale).toBe(4);
    expect(pinchZoom(rect, box, { zoom: z, center: { x: 100, y: 200 }, distance: 200 }, { center: { x: 100, y: 200 }, distance: 50 })).toEqual(NO_ZOOM);
    // Panning far to the right stops at the picture's left edge.
    const panned = panZoom(rect, box, z, 5000, 0);
    expect(zoomedRect(rect, panned).left).toBe(0);
    expect(clampZoom(rect, box, { scale: 2, x: -5000, y: -5000 })).toEqual({ scale: 2, x: -400, y: -800 });
  });

  it("a drag scrolls the page with the finger, in page pixels, and a flick goes on and slows down", () => {
    // Dragging up by 100 points on a picture drawn at half size: the page scrolls down by 200 pixels.
    expect(dragToWheel(0, -100, 2)).toEqual({ dx: 0, dy: 200 });
    expect(dragToWheel(30, 0, 1)).toEqual({ dx: -30, dy: 0 });
    expect(dragToWheel(0, -10_000, 2).dy).toBe(5000);
    const steps = flingSteps({ x: 0, y: -20 });
    expect(steps.length).toBeGreaterThan(5);
    expect(Math.abs(steps[1].dy)).toBeLessThan(Math.abs(steps[0].dy));
    expect(flingSteps({ x: 0, y: 0.5 })).toEqual([]);
  });

  it("asks for the phone's own screen as the page, within bounds; small changes do not lay the page out again", () => {
    // The Fold's cover screen: its own pixel ratio, so the page is drawn as sharp as the screen (round 8 capped it at 2).
    expect(phoneSize({ width: 411.4, height: 731.6 }, 2.625)).toEqual({ width: 411, height: 732, scale: 2.625 });
    expect(phoneSize({ width: 411.4, height: 731.6 }, 3.5)).toEqual({ width: 411, height: 732, scale: 3 });
    expect(phoneSize({ width: 880, height: 2000 }, 1.5)).toEqual({ width: 880, height: 1600, scale: 1.5 });
    expect(phoneSize({ width: 100, height: 100 }, 2)).toBeNull();
    expect(sizeChanged({ width: 411, height: 732 }, { width: 411, height: 740 })).toBe(false);
    // The keyboard opening takes a few hundred points off the height.
    expect(sizeChanged({ width: 411, height: 732 }, { width: 411, height: 420 })).toBe(true);
  });

  it("an address is opened as it is, anything else is searched for", () => {
    expect(addressToUrl("example.com")).toBe("example.com");
    expect(addressToUrl("https://example.com/a b")).toBe("https://example.com/a b");
    expect(addressToUrl("shop.example.co.uk/basket?x=1")).toBe("shop.example.co.uk/basket?x=1");
    expect(addressToUrl("127.0.0.1:4173/")).toBe("127.0.0.1:4173/");
    expect(addressToUrl("red shoes")).toBe("https://www.google.com/search?q=red%20shoes");
    expect(addressToUrl("weather")).toBe("https://www.google.com/search?q=weather");
    expect(addressToUrl("   ")).toBeNull();
  });
});

describe("full-screen browser: the phone's keyboard, streamed to the page", () => {
  it("sends only the difference: letters added, letters taken back, a word autocorrected", () => {
    expect(textDiff("", "hel")).toEqual({ backspaces: 0, insert: "hel" });
    expect(textDiff("hello", "help")).toEqual({ backspaces: 2, insert: "p" });
    expect(textDiff("teh ", "the ")).toEqual({ backspaces: 3, insert: "he " });
    // An emoji is one character to take back.
    expect(textDiff("hi \u{1F44B}", "hi ")).toEqual({ backspaces: 1, insert: "" });
    expect(typingInputs("", "abc")).toEqual([{ kind: "text", text: "abc" }]);
    expect(typingInputs("abc", "ab")).toEqual([{ kind: "key", type: "press", key: "Backspace" }]);
    expect(typingInputs("abcd", "ab")).toEqual([{ kind: "key", type: "press", key: "Backspace", repeat: 2 }]);
    expect(typingInputs("teh", "the")).toEqual([{ kind: "key", type: "press", key: "Backspace", repeat: 2 }, { kind: "text", text: "he" }]);
    expect(typingInputs("same", "same")).toEqual([]);
  });

  it("a new line is the Enter key, so a text area gets a line and a form is sent", () => {
    expect(typingInputs("line1", "line1\nline2")).toEqual([{ kind: "key", type: "press", key: "Enter" }, { kind: "text", text: "line2" }]);
    expect(typingInputs("", "\n")).toEqual([{ kind: "key", type: "press", key: "Enter" }]);
    // A paste longer than one message is sent in pieces.
    const long = "x".repeat(9000);
    expect(typingInputs("", long).map((i) => (i.kind === "text" ? i.text.length : 0))).toEqual([4000, 4000, 1000]);
  });

  it("raises the keyboard that suits the field, and a private one for a password or a code", () => {
    expect(pageKeyboard({ seq: 1, inputType: "email", secret: false, multiline: false })).toMatchObject({ keyboardType: "email-address", autoCapitalize: "none", autoCorrect: false, secureTextEntry: false });
    expect(pageKeyboard({ seq: 1, inputType: "password", secret: true, multiline: false })).toMatchObject({ secureTextEntry: true, autoCorrect: false, autoComplete: "password" });
    // A field that is a secret by its name (a code) is private too, with a keyboard for codes.
    expect(pageKeyboard({ seq: 1, inputType: "text", secret: true, multiline: false })).toMatchObject({ secureTextEntry: true, autoComplete: "one-time-code" });
    expect(pageKeyboard({ seq: 1, inputType: "multiline", secret: false, multiline: true })).toMatchObject({ multiline: true, autoCorrect: true });
    expect(pageKeyboard({ seq: 1, inputType: "url", secret: false, multiline: false }).keyboardType).toBe("url");
    expect(pageKeyboard({ seq: 1, inputType: "search", secret: false, multiline: false }).returnKeyType).toBe("search");
    expect(pageKeyboard(null).keyboardType).toBe("default");
  });
});

describe("full-screen browser: taking over and handing back", () => {
  const size = { width: 411, height: 732, scale: 2 };
  it("opening the screen takes the browser, at the phone's size; on the desktop without a size", () => {
    expect(enterControl(state(), { phone: true, size })).toEqual({ action: "take", layout: "phone", size });
    expect(enterControl(state(), { phone: false, size: null })).toEqual({ action: "take" });
    expect(enterControl(state({ seat: "needs_owner" }), { phone: true, size })).toMatchObject({ action: "take" });
    expect(enterControl(state({ seat: "paused" }), { phone: true, size })).toMatchObject({ action: "take" });
    expect(enterControl(state({ running: false }), { phone: true, size })).toMatchObject({ action: "take" });
    expect(enterControl(state(), { phone: true, size, signin: true })).toEqual({ action: "signin", layout: "phone", size });
    expect(enterControl(null, { phone: true, size })).toBeNull();
    expect(enterControl(state({ unavailable: "No browser" }), { phone: true, size })).toBeNull();
  });

  it("already driving: nothing, or only a new size when the screen changed (the keyboard opened)", () => {
    const driving = state({ seat: "owner", layout: "phone", viewport: { width: 411, height: 732 } });
    expect(enterControl(driving, { phone: true, size })).toBeNull();
    expect(enterControl(driving, { phone: true, size: { ...size, height: 420 } })).toEqual({ action: "layout", layout: "phone", size: { ...size, height: 420 } });
    // A private sign-in stays private when the screen opens again.
    expect(enterControl(state({ seat: "signin", layout: "phone", viewport: { width: 411, height: 732 } }), { phone: true, size })).toBeNull();
    expect(enterControl(state({ seat: "owner" }), { phone: false, size: null })).toBeNull();
  });

  it("offers the site's phone page when the page in front was loaded as a computer page, only to the one driving", () => {
    expect(offerPhonePage(state({ seat: "owner", layout: "phone", pageLayout: "desktop" }))).toBe(true);
    expect(offerPhonePage(state({ seat: "owner", layout: "phone", pageLayout: "phone" }))).toBe(false);
    expect(offerPhonePage(state({ seat: "agent", layout: "phone", pageLayout: "desktop" }))).toBe(false);
    expect(offerPhonePage(state({ seat: "owner", layout: "desktop", pageLayout: "desktop" }))).toBe(false);
    // A node from round 8 does not say: nothing is offered.
    expect(offerPhonePage(state({ seat: "owner", layout: "phone" }))).toBe(false);
  });

  it("leaving hands back: Done after a private sign-in, Release after driving, nothing when the agent already has it", () => {
    expect(leaveAction(state({ seat: "owner" }))).toBe("release");
    expect(leaveAction(state({ seat: "signin" }))).toBe("done");
    expect(leaveAction(state({ seat: "agent" }))).toBeNull();
    expect(leaveAction(state({ seat: "paused" }))).toBeNull();
    expect(leaveAction(null)).toBeNull();
  });

  it("the note goes to the session the screen was opened from, or the one the browser works for", () => {
    expect(handBackMessage("  Done,   I logged in,\ncontinue ")).toBe("Done, I logged in, continue");
    expect(handBackMessage("   ")).toBeNull();
    expect(handBackMessage(null)).toBeNull();
    expect(HAND_BACK_NOTES.length).toBeGreaterThan(1);
    const runs = { run_1: { threadId: "thr_run" } };
    expect(handBackThread({ threadParam: "thr_open", runId: "run_1", runs })).toBe("thr_open");
    expect(handBackThread({ threadParam: null, runId: "run_1", runs })).toBe("thr_run");
    expect(handBackThread({ threadParam: null, runId: null, runs })).toBeNull();
  });

  it("says how the connection is from the measured round trip, not from a quiet page", () => {
    const now = 10_000;
    expect(linkHealth({ online: false, known: true, running: true, frameTimes: [], now })).toMatchObject({ tone: "down", label: "Offline" });
    expect(linkHealth({ online: true, known: true, running: true, frameTimes: [9000, 9300, 9600, 9900, 8000, 7500], now })).toEqual({ label: "Live · 2 fps", tone: "ok" });
    expect(linkHealth({ online: true, known: true, running: true, frameTimes: [9000, 9300, 9600, 9900, 8000, 7500], now, rtt: 140 })).toEqual({ label: "Live · 2 fps · 140 ms", tone: "ok" });
    // A page that does not change sends no pictures: still live, not slow (round 8 said "Slow connection" after any such tap).
    expect(linkHealth({ online: true, known: true, running: true, frameTimes: [], now })).toEqual({ label: "Live", tone: "ok" });
    expect(linkHealth({ online: true, known: true, running: true, frameTimes: [], now, rtt: 120 })).toEqual({ label: "Live · 120 ms", tone: "ok" });
    // Only a slow measured round trip says so; the node is lightening the pictures meanwhile.
    expect(linkHealth({ online: true, known: true, running: true, frameTimes: [9900], now, rtt: 1200 })).toEqual({ label: "Slow connection · 1200 ms", tone: "slow" });
    expect(linkHealth({ online: true, known: false, running: false, frameTimes: [], now }).label).toBe("Connecting");
  });
});

describe("full-screen browser: when the phone's keyboard comes up", () => {
  const f = (seq: number, tapped?: number) => ({ seq, inputType: "multiline", secret: false, multiline: true, ...(tapped != null ? { tapped } : {}) });
  it("a tap into the field raises it, also into a field that already had the focus", () => {
    expect(shouldRaiseKeyboard({ lastTapped: 3, lastSeq: 2, next: f(2, 4), ownActionRecent: true })).toBe(true);
    expect(shouldRaiseKeyboard({ lastTapped: 3, lastSeq: 2, next: f(2, 4), ownActionRecent: false })).toBe(true);
  });

  it("a tap elsewhere (a link) while a search box keeps the focus does not (round 8 raised it on every tap)", () => {
    expect(shouldRaiseKeyboard({ lastTapped: 3, lastSeq: 2, next: f(2, 3), ownActionRecent: true })).toBe(false);
  });

  it("the screen opening on a page with a field in focus does not; the focus moving after the owner's own tap does", () => {
    expect(shouldRaiseKeyboard({ lastTapped: null, lastSeq: null, next: f(2, 0), ownActionRecent: false })).toBe(false);
    expect(shouldRaiseKeyboard({ lastTapped: 0, lastSeq: 2, next: f(3, 0), ownActionRecent: true })).toBe(true);
    expect(shouldRaiseKeyboard({ lastTapped: 0, lastSeq: 2, next: f(3, 0), ownActionRecent: false })).toBe(false);
    expect(shouldRaiseKeyboard({ lastTapped: 0, lastSeq: 2, next: null, ownActionRecent: true })).toBe(false);
    // A node from round 8 sends no tap count: the focus moving after a tap still raises it.
    expect(shouldRaiseKeyboard({ lastTapped: null, lastSeq: null, next: f(5), ownActionRecent: true })).toBe(true);
  });
});

describe("the app's hub connection survives the app's root mounting again", () => {
  it("keeps the running connection for the same pairing, replaces it for another", () => {
    const a = { url: "http://100.101.102.103:8787", token: "t1" };
    expect(sameClientSession(a, { ...a })).toBe(true);
    expect(sameClientSession(a, { ...a, token: "t2" })).toBe(false);
    expect(sameClientSession(a, { ...a, url: "http://10.0.2.2:8787" })).toBe(false);
    expect(sameClientSession(null, a)).toBe(false);
    expect(sameClientSession(a, null)).toBe(false);
  });
});
