import {
  BROWSER_APPROVAL, BROWSER_CAPABILITY, BROWSER_LINK, type Agent, type Approval, type BrowserControl, type BrowserFocus, type BrowserInput, type BrowserSeat, type BrowserState, type BrowserStep,
} from "@homebase/protocol";

/**
 * The browser view's arithmetic and wording (docs/BROWSER-AGENT-PLAN.md 4.6). Pure, so the phone and the
 * desktop place a tap on the same spot of the page and the tests can check it.
 */

export interface Size { width: number; height: number }
export interface Rect extends Size { left: number; top: number }

/**
 * Where a picture sits inside a box when it is shown whole, with its own proportions: centred, or at the
 * top (the full-screen browser, where the page starts under the address bar as in a phone's browser).
 */
export function containRect(box: Size, pic: Size, align: "center" | "top" = "center"): Rect {
  if (box.width <= 0 || box.height <= 0 || pic.width <= 0 || pic.height <= 0) return { left: 0, top: 0, width: 0, height: 0 };
  const scale = Math.min(box.width / pic.width, box.height / pic.height);
  const width = pic.width * scale;
  const height = pic.height * scale;
  return { left: (box.width - width) / 2, top: align === "top" ? 0 : (box.height - height) / 2, width, height };
}

/**
 * The phone's fit: the page as wide as the screen, from the top, as in a phone's browser. A page taller than
 * the box (for a moment, while the keyboard opens and the page is laid out again) runs on under its bottom edge.
 */
export function fitWidthRect(box: Size, pic: Size): Rect {
  if (box.width <= 0 || box.height <= 0 || pic.width <= 0 || pic.height <= 0) return { left: 0, top: 0, width: 0, height: 0 };
  return { left: 0, top: 0, width: box.width, height: pic.height * (box.width / pic.width) };
}

// ---------------------------------------------------------------- the owner's own zoom of the picture

/** A pinch on the phone zooms the picture, not the page: `scale` 1 to 4, and how far it is moved. */
export interface ViewZoom { scale: number; x: number; y: number }
export const NO_ZOOM: ViewZoom = { scale: 1, x: 0, y: 0 };
export const MAX_ZOOM = 4;

/** The picture as drawn, after the owner's zoom: the fitted rectangle, scaled and moved. */
export function zoomedRect(rect: Rect, zoom: ViewZoom): Rect {
  return { left: rect.left + zoom.x, top: rect.top + zoom.y, width: rect.width * zoom.scale, height: rect.height * zoom.scale };
}

/** Keeps a zoomed picture over its box: no empty band opens at an edge while it is larger than the box. At 1× it sits where it was fitted. */
export function clampZoom(rect: Rect, box: Size, zoom: ViewZoom): ViewZoom {
  const scale = Math.max(1, Math.min(MAX_ZOOM, zoom.scale));
  if (scale <= 1.001) return NO_ZOOM;
  const w = rect.width * scale;
  const h = rect.height * scale;
  const axis = (pos: number, start: number, size: number, room: number) => {
    // The drawn edge is start + pos. When the picture is larger than the room, it may not leave a gap at either end.
    if (size <= room) return (room - size) / 2 - start;
    return Math.min(-start, Math.max(room - size - start, pos));
  };
  return { scale, x: axis(zoom.x, rect.left, w, box.width), y: axis(zoom.y, rect.top, h, box.height) };
}

/**
 * Two fingers: the zoom that keeps the point that was under the fingers at the start under their middle now,
 * scaled by how far apart they have moved.
 */
export function pinchZoom(rect: Rect, box: Size, start: { zoom: ViewZoom; center: { x: number; y: number }; distance: number }, now: { center: { x: number; y: number }; distance: number }): ViewZoom {
  const z0 = start.zoom;
  const scale = Math.max(1, Math.min(MAX_ZOOM, z0.scale * (start.distance > 0 ? now.distance / start.distance : 1)));
  const r0 = zoomedRect(rect, z0);
  // The point of the picture (as a fraction) that was under the fingers.
  const fx = r0.width > 0 ? (start.center.x - r0.left) / r0.width : 0;
  const fy = r0.height > 0 ? (start.center.y - r0.top) / r0.height : 0;
  const w = rect.width * scale;
  const h = rect.height * scale;
  return clampZoom(rect, box, { scale, x: now.center.x - fx * w - rect.left, y: now.center.y - fy * h - rect.top });
}

/** One finger on a zoomed picture moves it. */
export function panZoom(rect: Rect, box: Size, zoom: ViewZoom, dx: number, dy: number): ViewZoom {
  return clampZoom(rect, box, { ...zoom, x: zoom.x + dx, y: zoom.y + dy });
}

/** A finger on the screen, as a position on the page (fractions), through the fit and the owner's zoom. Null beside the page. */
export function touchToPage(point: { x: number; y: number }, rect: Rect, zoom: ViewZoom = NO_ZOOM): { x: number; y: number } | null {
  return toFraction(point, zoomedRect(rect, zoom));
}

/**
 * A drag on the picture, as a scroll of the page: the page moves with the finger, so dragging up scrolls down.
 * `pagePerPoint` is how many page pixels one screen point is.
 */
export function dragToWheel(dx: number, dy: number, pagePerPoint: number): { dx: number; dy: number } {
  const lim = (v: number) => Math.round(Math.max(-5000, Math.min(5000, v))) || 0;
  return { dx: lim(-dx * pagePerPoint), dy: lim(-dy * pagePerPoint) };
}

/** After a flick, a few more scroll steps that slow down, so a page can be thrown as on a phone. Points per frame of ~16 ms. */
export function flingSteps(velocity: { x: number; y: number }, opts: { friction?: number; min?: number; max?: number } = {}): Array<{ dx: number; dy: number }> {
  const friction = opts.friction ?? 0.9;
  const min = opts.min ?? 0.6;
  const max = opts.max ?? 40;
  const steps: Array<{ dx: number; dy: number }> = [];
  let vx = velocity.x;
  let vy = velocity.y;
  if (Math.hypot(vx, vy) < 1.5) return steps;
  while (Math.hypot(vx, vy) > min && steps.length < max) {
    steps.push({ dx: vx, dy: vy });
    vx *= friction;
    vy *= friction;
  }
  return steps;
}

// ---------------------------------------------------------------- the phone's own screen

/**
 * The page size a phone asks for when it takes over: its picture area in CSS pixels (a point on the phone
 * is a CSS pixel, as in the phone's own browser) and how sharp to draw it. The connector bounds both again.
 */
export function phoneSize(box: Size, pixelRatio: number): { width: number; height: number; scale: number } | null {
  if (box.width < 200 || box.height < 200) return null;
  const clamp = (v: number, lo: number, hi: number) => Math.round(Math.max(lo, Math.min(hi, v)));
  const width = clamp(box.width, 320, 1024);
  const height = clamp(box.height, 400, 1600);
  return { width, height, scale: Math.max(1, Math.min(3, Math.round((pixelRatio || 1) * 8) / 8)) };
}

/**
 * Whether the page's field that has the focus should bring the phone's keyboard up now: the owner tapped
 * inside it (`tapped` moved on, also for a field that already had the focus), or the focus moved to a new
 * field right after the owner's own tap or key. A tap on a link while a search box keeps the focus does not.
 */
export function shouldRaiseKeyboard(o: {
  /** The node's tap count when this screen last looked (null: nothing seen yet, the screen just opened). */
  lastTapped: number | null;
  /** The focus `seq` this screen last saw (null: no field had the focus). */
  lastSeq: number | null;
  next: BrowserFocus | null | undefined;
  /** The owner tapped or typed a moment ago. */
  ownActionRecent: boolean;
}): boolean {
  const next = o.next;
  if (!next) return false;
  if (o.lastTapped != null && next.tapped != null && next.tapped > o.lastTapped) return true;
  return o.ownActionRecent && next.seq !== o.lastSeq;
}

/** Whether a new size is worth laying the page out again for: small changes (a toolbar appearing) are not. */
export function sizeChanged(a: Size | null | undefined, b: Size | null | undefined): boolean {
  if (!a || !b) return a !== b;
  return Math.abs(a.width - b.width) > 8 || Math.abs(a.height - b.height) > 40;
}

/** A point in the box as a fraction of the picture (0 to 1 each way). Null when it is beside the picture. */
export function toFraction(point: { x: number; y: number }, rect: Rect): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const x = (point.x - rect.left) / rect.width;
  const y = (point.y - rect.top) / rect.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

/** DevTools' modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export function modifiersOf(e: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

const NAMED = new Set(["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"]);

/**
 * A key on the desktop keyboard as input for the browser. Null for keys that are not passed on: the
 * modifier keys alone, function keys, and the shortcuts that belong to this app's own window.
 */
export function keyInput(e: { key: string; code?: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }, type: "down" | "up"): BrowserInput | null {
  const key = e.key === " " || e.key === "Spacebar" ? "Space" : e.key;
  const modifiers = modifiersOf(e);
  const command = !!(e.ctrlKey || e.metaKey);
  if (key.length === 1) {
    // Ctrl+V is handled as a paste of text; Ctrl+R, Ctrl+W and friends stay with this window.
    if (command && !/^[acxzy]$/i.test(key)) return null;
    return { kind: "key", type, key, code: e.code?.slice(0, 32), modifiers, ...(type === "down" && !command && !e.altKey ? { text: key } : {}) };
  }
  if (key === "Space") return { kind: "key", type, key: "Space", code: "Space", modifiers };
  if (!NAMED.has(key)) return null;
  return { kind: "key", type, key, code: e.code?.slice(0, 32), modifiers };
}

// ---------------------------------------------------------------- the phone's keyboard, streamed to the page

/**
 * What changed between two versions of the text in the phone's typing field: how many characters were
 * taken off its end and what was put on. Autocorrect, a suggestion picked from the strip and swipe typing
 * all arrive as "the text is now this", so the page is told the difference, not the whole text again.
 */
export function textDiff(prev: string, next: string): { backspaces: number; insert: string } {
  // Compared by code point, so an emoji is one character to take back, as it is on the page.
  const a = Array.from(prev);
  const b = Array.from(next);
  let same = 0;
  while (same < a.length && same < b.length && a[same] === b[same]) same++;
  return { backspaces: a.length - same, insert: b.slice(same).join("") };
}

/**
 * The browser input that turns the page's field from `prev` into `next`: Backspace as often as needed,
 * then the new text. A new line is the Enter key (a text area takes it as a line, a form as "send").
 */
export function typingInputs(prev: string, next: string): BrowserInput[] {
  const { backspaces, insert } = textDiff(prev, next);
  const out: BrowserInput[] = [];
  if (backspaces > 0) out.push({ kind: "key", type: "press", key: "Backspace", ...(backspaces > 1 ? { repeat: Math.min(500, backspaces) } : {}) });
  const parts = insert.replace(/\r\n?/g, "\n").split("\n");
  parts.forEach((part, i) => {
    if (i > 0) out.push({ kind: "key", type: "press", key: "Enter" });
    for (let at = 0; at < part.length; at += 4000) out.push({ kind: "text", text: part.slice(at, at + 4000) });
  });
  return out;
}

export interface PageKeyboard {
  keyboardType: "default" | "email-address" | "url" | "phone-pad" | "numeric" | "number-pad" | "web-search";
  secureTextEntry: boolean;
  autoCapitalize: "none" | "sentences";
  autoCorrect: boolean;
  multiline: boolean;
  returnKeyType: "go" | "next" | "search" | "default" | "done";
  autoComplete: "off" | "email" | "password" | "url" | "tel" | "one-time-code";
  label: string;
}

/** The phone keyboard that suits the page's field: an email keyboard for an email field, a private one for a password. */
export function pageKeyboard(focus: BrowserFocus | null | undefined): PageKeyboard {
  const t = (focus?.inputType ?? "text").toLowerCase();
  const base: PageKeyboard = { keyboardType: "default", secureTextEntry: false, autoCapitalize: "sentences", autoCorrect: true, multiline: false, returnKeyType: "go", autoComplete: "off", label: "Typing into the page" };
  if (focus?.secret) {
    const code = t !== "password";
    return { ...base, secureTextEntry: true, autoCapitalize: "none", autoCorrect: false, autoComplete: code ? "one-time-code" : "password", label: code ? "Typing a code, privately" : "Typing a password, privately" };
  }
  if (focus?.multiline || t === "multiline") return { ...base, multiline: true, returnKeyType: "default", label: "Typing into the page" };
  switch (t) {
    case "email": return { ...base, keyboardType: "email-address", autoCapitalize: "none", autoCorrect: false, autoComplete: "email", returnKeyType: "next" };
    case "url": return { ...base, keyboardType: "url", autoCapitalize: "none", autoCorrect: false, autoComplete: "url" };
    case "tel": return { ...base, keyboardType: "phone-pad", autoCapitalize: "none", autoCorrect: false, autoComplete: "tel", returnKeyType: "next" };
    case "number": return { ...base, keyboardType: "numeric", autoCapitalize: "none", autoCorrect: false, returnKeyType: "next" };
    case "search": return { ...base, keyboardType: "web-search", returnKeyType: "search" };
    default: return base;
  }
}

// ---------------------------------------------------------------- taking over and handing back

/**
 * Opening the full-screen browser takes it over: what to send, or null when there is nothing to take (no
 * browser, or the owner already holds it at the right size). A phone asks for its own screen as the page.
 */
export function enterControl(state: BrowserState | null | undefined, opts: { phone: boolean; size: { width: number; height: number; scale: number } | null; signin?: boolean }): BrowserControl | null {
  if (!state || state.unavailable) return null;
  const layout = opts.phone && opts.size ? { layout: "phone" as const, size: opts.size } : {};
  if (opts.signin && state.seat !== "signin") return { action: "signin", ...layout };
  if (state.seat === "owner" || state.seat === "signin") {
    if (!opts.phone || !opts.size) return null;
    const same = state.layout === "phone" && !sizeChanged(state.viewport, opts.size);
    return same ? null : { action: "layout", layout: "phone", size: opts.size };
  }
  return { action: "take", ...layout };
}

/**
 * The page in front is a site's computer page shown in the phone layout (the agent opened it as a desktop):
 * the screen offers to load it again, which brings the site's phone page. Never offered to a watcher.
 */
export function offerPhonePage(state: BrowserState | null | undefined): boolean {
  return !!state?.running && (state.seat === "owner" || state.seat === "signin") && state.layout === "phone" && state.pageLayout === "desktop";
}

/** Leaving the full-screen browser hands it back: Done after a private sign-in (the site is noted), Release otherwise. */
export function leaveAction(state: BrowserState | null | undefined): "release" | "done" | null {
  if (!state) return null;
  if (state.seat === "signin") return "done";
  if (state.seat === "owner") return "release";
  return null;
}

/** Ready-made notes for the hand-back, one tap each. */
export const HAND_BACK_NOTES = ["Done, continue", "I logged in, continue", "I filled it in, please check and continue", "Stop here, I'll take it from here"] as const;

/** The owner's note as their next message in the session, or null for none. */
export function handBackMessage(note: string | null | undefined): string | null {
  const t = (note ?? "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, 2000) : null;
}

/** The session to tell, in order: the one the view was opened from, the run the browser is working for. */
export function handBackThread(opts: { threadParam?: string | null; runId?: string | null; runs: Record<string, { threadId?: string | null }> }): string | null {
  if (opts.threadParam) return opts.threadParam;
  const run = opts.runId ? opts.runs[opts.runId] : undefined;
  return run?.threadId ?? null;
}

/** What was typed in the address bar, as an address: a web address as it is, anything else as a search. */
export function addressToUrl(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t;
  if (!/\s/.test(t) && (/^[^/]+\.[a-z0-9-]{2,}(:\d+)?([/?#].*)?$/i.test(t) || /^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#].*)?$/i.test(t))) return t;
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
}

// ---------------------------------------------------------------- the connection, in a word

export interface LinkHealth { label: string; tone: "ok" | "slow" | "down" }

/**
 * How the live picture is doing, from the round trip the browser node measures for its pictures (`rtt`) and how
 * many arrived lately. A page that does not change sends no pictures, so a quiet view is not a slow one: only a
 * measured slow round trip says "Slow connection", and then the node is already sending lighter pictures. It
 * never holds a tap or a key back.
 */
export function linkHealth(opts: { online: boolean; known: boolean; running: boolean; frameTimes: number[]; now: number; rtt?: number | null }): LinkHealth {
  if (!opts.online) return { label: "Offline", tone: "down" };
  if (!opts.known) return { label: "Connecting", tone: "slow" };
  if (!opts.running) return { label: "Connected", tone: "ok" };
  const ms = opts.rtt != null && Number.isFinite(opts.rtt) ? Math.round(opts.rtt) : null;
  if (ms != null && ms > BROWSER_LINK.slowMs) return { label: `Slow connection · ${ms} ms`, tone: "slow" };
  const recent = opts.frameTimes.filter((t) => opts.now - t <= 3000);
  const fps = recent.length >= 2 ? Math.round(recent.length / 3) : 0;
  return { label: ["Live", fps ? `${fps} fps` : null, ms != null ? `${ms} ms` : null].filter(Boolean).join(" · "), tone: "ok" };
}

export const hasBrowser = (agent: Pick<Agent, "capabilities" | "connectorId"> | null | undefined): agent is Pick<Agent, "capabilities"> & { connectorId: string } =>
  !!agent?.connectorId && (agent.capabilities ?? []).includes(BROWSER_CAPABILITY);

export interface SeatControls {
  /** The owner's mouse and keys reach the page. */
  drives: boolean;
  primary: { action: "take" | "release" | "done" | "resume"; label: string; icon: "mouse-pointer" | "corner-up-left" | "check" | "play" } | null;
  canPause: boolean;
  canSignIn: boolean;
  /** One line above the picture when the state needs saying. */
  banner: { text: string; tone: "private" | "needs" | "quiet" } | null;
}

/** Which buttons the view shows for a seat. The same on the phone and the desktop. */
export function seatControls(state: BrowserState | null | undefined): SeatControls {
  if (!state || state.unavailable) return { drives: false, primary: null, canPause: false, canSignIn: false, banner: state?.unavailable ? { text: state.unavailable, tone: "quiet" } : null };
  const seat: BrowserSeat = state.seat;
  switch (seat) {
    case "owner":
      return { drives: true, primary: { action: "release", label: "Hand back to the agent", icon: "corner-up-left" }, canPause: false, canSignIn: true, banner: { text: "You are driving. The agent waits until you hand the browser back.", tone: "quiet" } };
    case "signin":
      return { drives: true, primary: { action: "done", label: "Done, hand back", icon: "check" }, canPause: false, canSignIn: false, banner: { text: "Private: nothing here is recorded. Sign in on the site's own page; no agent sees what you type.", tone: "private" } };
    case "needs_owner":
      return { drives: false, primary: { action: "take", label: "Take over", icon: "mouse-pointer" }, canPause: false, canSignIn: true, banner: { text: `Needs you: ${state.needs?.reason ?? "the agent is waiting for you"}.`, tone: "needs" } };
    case "paused":
      return { drives: false, primary: { action: "resume", label: "Resume the agent", icon: "play" }, canPause: false, canSignIn: true, banner: { text: "Paused. The agent's next step waits.", tone: "quiet" } };
    default:
      return { drives: false, primary: { action: "take", label: state.running ? "Take over" : "Open the browser", icon: "mouse-pointer" }, canPause: state.running, canSignIn: true, banner: null };
  }
}

/** The needs-you cards that handing the browser back should answer, so the agent does not keep waiting on a card. */
export function needsOwnerApprovals(approvals: Iterable<Approval>, runId: string | null | undefined): Approval[] {
  const out: Approval[] = [];
  for (const a of approvals) if (a.status === "pending" && a.tool === BROWSER_APPROVAL.needsOwner && (!runId || a.runId === runId)) out.push(a);
  return out;
}

/** The last thing an agent did in the browser during a run, from the run's own events. */
export function lastBrowserStep(events: Array<{ kind: string; at: number; data: Record<string, unknown> }> | null | undefined): { step: BrowserStep; at: number; text: string } | null {
  for (let i = (events?.length ?? 0) - 1; i >= 0; i--) {
    const e = events![i];
    const step = e.kind === "system" ? (e.data.browser as BrowserStep | undefined) : undefined;
    if (step && typeof step.action === "string") return { step, at: e.at, text: [step.action, step.site ?? step.title].filter(Boolean).join(" · ") };
  }
  return null;
}

const TOOL_WORDS: Record<string, string> = {
  browser_open: "open", browser_snapshot: "read page", browser_scroll: "scroll", browser_find: "find", browser_back: "back", browser_tabs: "tabs", browser_status: "status",
  browser_click: "click", browser_type: "type", browser_press_key: "key", browser_select: "choose", browser_request_owner: "ask for you",
};

/** How a browser tool call reads on a run's timeline: "Browser · open" and where, instead of the tool's id. Null for other tools. */
export function browserToolWords(tool: string | null | undefined, input: unknown): { label: string; title: string } | null {
  const m = /^mcp__browser__(browser_[a-z_]+)$/.exec(tool ?? "");
  if (!m) return null;
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const title = s(i.url) || s(i.reason) || s(i.direction) || s(i.key) || (m[1] === "browser_find" ? s(i.text) : "") || (s(i.ref) ? `element ${s(i.ref)}` : "") || s(i.action);
  return { label: `Browser · ${TOOL_WORDS[m[1]] ?? m[1].replace(/^browser_/, "").replace(/_/g, " ")}`, title };
}

/** "HH:MM" or null, from what was typed in a settings field. */
export function parseHHMM(text: string): string | null {
  const m = /^\s*(\d{1,2})[:.]?(\d{2})\s*$/.exec(text);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}` : null;
}
