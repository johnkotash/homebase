import React, { useEffect, useRef, useState } from "react";
import { AppState, Image, Keyboard, Platform, StyleSheet, TextInput, View, type GestureResponderEvent, type LayoutChangeEvent } from "react-native";
import type { BrowserFocus, BrowserInput } from "@homebase/protocol";
import {
  NO_ZOOM, clampZoom, containRect, dragToWheel, fitWidthRect, flingSteps, keyInput, pageKeyboard, panZoom, pinchZoom, shouldRaiseKeyboard, toFraction, touchToPage, typingInputs, zoomedRect,
  type Rect, type Size, type ViewZoom,
} from "../browser";
import { bdbg } from "../browserDebug";
import type { LiveBrowser } from "../browserLive";
import { browserInput } from "../sync/session";
import { color, radius, space } from "../theme";
import { Icon, IconBtn, T } from "./ui";

/**
 * The live picture of a connector's browser (docs/BROWSER-AGENT-PLAN.md 0), and, while the owner holds the
 * seat, their hands on it.
 *
 * Desktop: the mouse, the wheel and the keyboard go straight to the page.
 * Phone: a tap is a tap where the finger was; a drag scrolls the page (and a flick keeps it going); two fingers
 * zoom and move the picture itself, and while it is zoomed one finger moves it. Positions are measured from
 * the screen (pageX/pageY against the view's own place on screen), never from `locationX`, which on Android's
 * new architecture can be relative to whichever child was under the finger.
 *
 * Nothing typed or tapped here is kept by this app: each event is sent and forgotten.
 */

const clamp = (v: number, lim: number) => Math.max(-lim, Math.min(lim, v));
const TAP_SLOP = 10;
const TAP_MS = 700;

function Notice({ icon, text }: { icon: React.ComponentProps<typeof Icon>["name"]; text: string }) {
  return (
    <View style={st.notice} pointerEvents="none">
      <Icon name={icon} size={22} tone={color.textMuted} />
      <T v="small" muted style={{ textAlign: "center", maxWidth: 360 }}>{text}</T>
    </View>
  );
}

/**
 * Two picture layers: the new frame is drawn over the one on screen and only replaces it once it has
 * loaded, so the page never blinks to empty between frames.
 */
function Picture({ uri, rect }: { uri: string; rect: Rect }) {
  const [shown, setShown] = useState(uri);
  useEffect(() => {
    // A frame that never loads must not hold the view: after a moment the newest one is simply shown.
    const t = setTimeout(() => setShown(uri), 1500);
    return () => clearTimeout(t);
  }, [uri]);
  const style = { position: "absolute" as const, left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  return (
    <>
      <Image source={{ uri: shown }} fadeDuration={0} resizeMode="stretch" accessibilityIgnoresInvertColors style={style} />
      {uri !== shown ? <Image source={{ uri }} fadeDuration={0} resizeMode="stretch" accessibilityIgnoresInvertColors style={style} onLoad={() => setShown(uri)} /> : null}
    </>
  );
}

type Gesture =
  | { mode: "pending"; x: number; y: number; at: number }
  | { mode: "scroll"; lx: number; ly: number; at: number; fx: number; fy: number; vx: number; vy: number; pendX: number; pendY: number; sent: number }
  | { mode: "pan"; lx: number; ly: number }
  | { mode: "pinch"; start: { zoom: ViewZoom; center: { x: number; y: number }; distance: number } }
  | { mode: "done" };

export function BrowserView({ connectorId, live, drives, style, fit = "contain", zoomable = false, onTapSent, onBox, zoom: zoomProp, onZoom }: {
  connectorId: string; live: LiveBrowser; drives: boolean; style?: any;
  /** "width": the page as wide as the view, from the top (the phone's full-screen browser). */
  fit?: "contain" | "width";
  /** Two fingers zoom the picture (the phone's full-screen browser). */
  zoomable?: boolean;
  onTapSent?: () => void;
  onBox?: (box: Size) => void;
  zoom?: ViewZoom;
  onZoom?: (z: ViewZoom) => void;
}) {
  const [box, setBox] = useState<Size>({ width: 0, height: 0 });
  const [ownZoom, setOwnZoom] = useState<ViewZoom>(NO_ZOOM);
  const zoom = zoomProp ?? ownZoom;
  const setZoom = (z: ViewZoom) => (onZoom ? onZoom(z) : setOwnZoom(z));
  const [focused, setFocused] = useState(false);
  const pic = live.picture;
  const viewport = live.state?.viewport ?? { width: 1280, height: 800 };
  const rect = fit === "width" ? fitWidthRect(box, pic ?? viewport) : containRect(box, pic ?? viewport);
  // A DOM element in a browser, a native view on the phone.
  const node = useRef<any>(null);
  const geo = useRef<{ rect: Rect; box: Size; viewport: Size; zoom: ViewZoom; drives: boolean }>({ rect, box, viewport, zoom, drives });
  geo.current = { rect, box, viewport, zoom, drives };
  const send = (input: BrowserInput) => {
    const ok = browserInput(connectorId, input);
    if (input.kind === "tap" || input.kind === "mouse") bdbg("send", input.kind, { x: +input.x.toFixed(4), y: +input.y.toFixed(4), ok, drives: geo.current.drives });
    else if (input.kind === "wheel") bdbg("send wheel", { dy: input.dy, ok });
  };

  // ---- desktop: the page's own mouse, wheel and keyboard, straight from the DOM
  useEffect(() => {
    if (Platform.OS !== "web" || !drives) return;
    const el = node.current as unknown as HTMLElement | null;
    if (!el?.addEventListener) return;
    const at = (e: MouseEvent) => {
      const b = el.getBoundingClientRect();
      return toFraction({ x: e.clientX - b.left, y: e.clientY - b.top }, zoomedRect(geo.current.rect, geo.current.zoom));
    };
    const button = (e: MouseEvent) => (e.button === 2 ? "right" : e.button === 1 ? "middle" : "left") as "left" | "right" | "middle";
    let held: { x: number; y: number; button: "left" | "right" | "middle" } | null = null;
    let lastMove = 0;
    const down = (e: MouseEvent) => {
      const p = at(e);
      if (!p) return;
      e.preventDefault();
      el.focus();
      held = { ...p, button: button(e) };
      send({ kind: "mouse", type: "down", ...p, button: held.button, clicks: Math.min(3, Math.max(1, e.detail || 1)) });
      onTapSent?.();
    };
    const up = (e: MouseEvent) => {
      if (!held) return;
      const p = at(e) ?? held;
      send({ kind: "mouse", type: "up", x: p.x, y: p.y, button: held.button, clicks: Math.min(3, Math.max(1, e.detail || 1)) });
      held = null;
    };
    const move = (e: MouseEvent) => {
      const now = Date.now();
      if (now - lastMove < 50) return;
      const p = at(e);
      if (!p) return;
      lastMove = now;
      if (held) held = { ...held, ...p };
      send({ kind: "mouse", type: "move", ...p });
    };
    const wheel = (e: WheelEvent) => {
      const p = at(e);
      if (!p) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? geo.current.viewport.height : 1;
      send({ kind: "wheel", ...p, dx: clamp(e.deltaX * unit, 5000), dy: clamp(e.deltaY * unit, 5000) });
    };
    const key = (type: "down" | "up") => (e: KeyboardEvent) => {
      // A paste arrives as text, through the paste event below.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") return;
      const k = keyInput(e, type);
      if (!k) return;
      e.preventDefault();
      send(k);
    };
    const keyDown = key("down");
    const keyUp = key("up");
    const paste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData("text/plain");
      if (!text) return;
      e.preventDefault();
      send({ kind: "text", text: text.slice(0, 4000) });
    };
    const menu = (e: Event) => e.preventDefault();
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    // The picture must be able to hold the keyboard, and takes it as soon as the owner drives: otherwise what
    // they type (a password, during a sign-in) would land in whichever field of this app had the focus before.
    el.tabIndex = 0;
    el.focus({ preventScroll: true });
    if (document.activeElement === el) setFocused(true);
    el.addEventListener("mousedown", down);
    window.addEventListener("mouseup", up);
    el.addEventListener("mousemove", move);
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("keydown", keyDown);
    el.addEventListener("keyup", keyUp);
    el.addEventListener("paste", paste);
    el.addEventListener("contextmenu", menu);
    el.addEventListener("focus", onFocus);
    el.addEventListener("blur", onBlur);
    return () => {
      el.removeEventListener("mousedown", down);
      window.removeEventListener("mouseup", up);
      el.removeEventListener("mousemove", move);
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("keydown", keyDown);
      el.removeEventListener("keyup", keyUp);
      el.removeEventListener("paste", paste);
      el.removeEventListener("contextmenu", menu);
      el.removeEventListener("focus", onFocus);
      el.removeEventListener("blur", onBlur);
      el.tabIndex = -1;
      if (document.activeElement === el) el.blur();
      setFocused(false);
    };
  }, [drives, connectorId]);

  // ---- phone: fingers
  const origin = useRef({ x: 0, y: 0 });
  const measure = () => node.current?.measure?.((_x: number, _y: number, w: number, h: number, px: number, py: number) => {
    bdbg("measure", { px, py, w, h });
    if (Number.isFinite(px) && Number.isFinite(py)) origin.current = { x: px, y: py };
  });
  const gesture = useRef<Gesture>({ mode: "done" });
  const fling = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopFling = () => {
    if (fling.current) clearInterval(fling.current);
    fling.current = null;
  };
  useEffect(() => stopFling, []);
  const native = Platform.OS !== "web" && (drives || zoomable);
  useEffect(() => bdbg("view", { native, drives, zoomable }), [native, drives, zoomable]);
  const local = (t: { pageX: number; pageY: number }) => ({ x: t.pageX - origin.current.x, y: t.pageY - origin.current.y });
  const touchesOf = (e: GestureResponderEvent) => {
    const list = e.nativeEvent.touches?.length ? e.nativeEvent.touches : [e.nativeEvent];
    return Array.from(list as ArrayLike<{ pageX: number; pageY: number }>).map(local);
  };
  const two = (pts: Array<{ x: number; y: number }>) => ({ center: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }, distance: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) });
  const pagePerPoint = () => {
    const r = zoomedRect(geo.current.rect, geo.current.zoom);
    return r.width > 0 ? geo.current.viewport.width / r.width : 1;
  };
  const flushScroll = (g: Extract<Gesture, { mode: "scroll" }>, force = false) => {
    const now = Date.now();
    if (!force && now - g.sent < 40) return;
    if (!g.pendX && !g.pendY) return;
    const w = dragToWheel(g.pendX, g.pendY, pagePerPoint());
    g.pendX = 0;
    g.pendY = 0;
    g.sent = now;
    if (w.dx || w.dy) send({ kind: "wheel", x: g.fx, y: g.fy, dx: w.dx, dy: w.dy });
  };
  const begin = (e: GestureResponderEvent) => {
    stopFling();
    measure();
    const pts = touchesOf(e);
    const ne = e.nativeEvent as any;
    bdbg("grant", { pageX: ne.pageX, pageY: ne.pageY, locX: ne.locationX, locY: ne.locationY, touches: ne.touches?.length, origin: origin.current, local: pts[0], rect: geo.current.rect, box: geo.current.box, viewport: geo.current.viewport, drives: geo.current.drives });
    if (pts.length >= 2 && zoomable) gesture.current = { mode: "pinch", start: { zoom: geo.current.zoom, ...two(pts) } };
    else gesture.current = { mode: "pending", x: pts[0].x, y: pts[0].y, at: Date.now() };
  };
  const moveTouch = (e: GestureResponderEvent) => {
    const pts = touchesOf(e);
    let g = gesture.current;
    if (pts.length >= 2 && zoomable && g.mode !== "pinch") {
      if (g.mode === "scroll") flushScroll(g, true);
      g = gesture.current = { mode: "pinch", start: { zoom: geo.current.zoom, ...two(pts) } };
    }
    const { rect: r, box: b } = geo.current;
    switch (g.mode) {
      case "pinch":
        if (pts.length >= 2) setZoom(pinchZoom(r, b, g.start, two(pts)));
        return;
      case "pending": {
        const p = pts[0];
        if (Math.hypot(p.x - g.x, p.y - g.y) < TAP_SLOP) return;
        if (geo.current.zoom.scale > 1.01) {
          gesture.current = { mode: "pan", lx: p.x, ly: p.y };
          setZoom(panZoom(r, b, geo.current.zoom, p.x - g.x, p.y - g.y));
          return;
        }
        if (!geo.current.drives) return;
        const f = touchToPage({ x: g.x, y: g.y }, r, geo.current.zoom) ?? { x: 0.5, y: 0.5 };
        gesture.current = { mode: "scroll", lx: p.x, ly: p.y, at: Date.now(), fx: f.x, fy: f.y, vx: 0, vy: 0, pendX: p.x - g.x, pendY: p.y - g.y, sent: 0 };
        flushScroll(gesture.current as Extract<Gesture, { mode: "scroll" }>);
        return;
      }
      case "pan": {
        const p = pts[0];
        setZoom(panZoom(r, b, geo.current.zoom, p.x - g.lx, p.y - g.ly));
        g.lx = p.x;
        g.ly = p.y;
        return;
      }
      case "scroll": {
        const p = pts[0];
        const now = Date.now();
        const dt = Math.max(1, now - g.at);
        const dx = p.x - g.lx;
        const dy = p.y - g.ly;
        // Points per 16 ms, smoothed: how fast the finger is going when it lets go.
        g.vx = g.vx * 0.6 + (dx / dt) * 16 * 0.4;
        g.vy = g.vy * 0.6 + (dy / dt) * 16 * 0.4;
        g.pendX += dx;
        g.pendY += dy;
        g.lx = p.x;
        g.ly = p.y;
        g.at = now;
        flushScroll(g);
        return;
      }
    }
  };
  const end = (e: GestureResponderEvent) => {
    const g = gesture.current;
    // A finger lifted off a pinch: the other one goes on as a pan of the picture, not as a tap.
    if (g.mode === "pinch" && (e.nativeEvent.touches?.length ?? 0) > 0) return;
    gesture.current = { mode: "done" };
    bdbg("release", { mode: g.mode, held: g.mode === "pending" ? Date.now() - g.at : undefined, drives: geo.current.drives });
    if (g.mode === "pending") {
      if (!geo.current.drives || Date.now() - g.at > TAP_MS * 3) return;
      const p = touchToPage({ x: g.x, y: g.y }, geo.current.rect, geo.current.zoom);
      bdbg("tap at", { local: { x: g.x, y: g.y }, page: p });
      if (!p) return;
      send({ kind: "tap", x: p.x, y: p.y });
      onTapSent?.();
      return;
    }
    if (g.mode === "scroll") {
      flushScroll(g, true);
      // A flick: the page keeps going for a moment and slows down, as a phone's own scrolling does.
      const steps = Date.now() - g.at < 80 ? flingSteps({ x: g.vx, y: g.vy }) : [];
      if (!steps.length) return;
      let i = 0;
      fling.current = setInterval(() => {
        // Two steps per message: about 30 messages a second at most.
        const a = steps[i++];
        const b = steps[i++];
        if (!a) return stopFling();
        const w = dragToWheel(a.dx + (b?.dx ?? 0), a.dy + (b?.dy ?? 0), pagePerPoint());
        if (w.dx || w.dy) send({ kind: "wheel", x: g.fx, y: g.fy, dx: w.dx, dy: w.dy });
        if (!b) stopFling();
      }, 33);
    }
  };

  // The zoom stays valid when the view or the picture changes size.
  useEffect(() => {
    if (zoom.scale > 1) {
      const next = clampZoom(rect, box, zoom);
      if (next.x !== zoom.x || next.y !== zoom.y || next.scale !== zoom.scale) setZoom(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box.width, box.height, rect.width, rect.height]);

  const state = live.state;
  const blank = !live.known ? <Notice icon="loader" text="Connecting to the browser…" />
    : !state ? <Notice icon="wifi-off" text="The machine that runs this browser is offline." />
    : state.unavailable ? <Notice icon="slash" text={state.unavailable} />
    : !state.running ? <Notice icon="moon" text="The browser is closed. It opens when an agent uses it, or when you take over." />
    : !pic ? <Notice icon="loader" text="Waiting for the first picture…" />
    : null;

  return (
    <View
      ref={node}
      testID="browser-view"
      collapsable={false}
      onLayout={(e: LayoutChangeEvent) => {
        const size = { width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height };
        setBox(size);
        onBox?.(size);
        measure();
      }}
      {...(native ? {
        onStartShouldSetResponder: () => { bdbg("start? yes"); return true; }, onMoveShouldSetResponder: () => true, onResponderTerminationRequest: () => false,
        onResponderGrant: begin, onResponderStart: (e: GestureResponderEvent) => { if ((e.nativeEvent.touches?.length ?? 0) >= 2) moveTouch(e); },
        onResponderMove: moveTouch, onResponderRelease: end, onResponderEnd: (e: GestureResponderEvent) => { if ((e.nativeEvent.touches?.length ?? 0) > 0 && gesture.current.mode === "pinch") gesture.current = { mode: "done" }; },
        onResponderTerminate: () => { bdbg("responder terminated", { mode: gesture.current.mode }); gesture.current = { mode: "done" }; },
      } : {})}
      accessibilityLabel={drives ? "The browser. Tap, drag and type as on the page." : "The browser, live"}
      style={[st.box, drives && st.driving, drives && focused && st.focused, Platform.OS === "web" && ({ outlineStyle: "none", cursor: drives ? "default" : "auto" } as any), style]}
    >
      {blank ?? <View pointerEvents="none" style={StyleSheet.absoluteFill}><Picture uri={pic!.uri} rect={zoomedRect(rect, zoom)} /></View>}
    </View>
  );
}

// ---------------------------------------------------------------- the phone's keyboard, for the page

/**
 * The phone's own keyboard, typing into the page. A real text field (so Android raises its keyboard, with
 * suggestions and autocorrect where they fit) whose changes are sent to the page as they happen: what was
 * taken back as Backspace, what was added as text, a new line as Enter. It opens by itself when a field on
 * the page takes the focus and closes when none has it. Its text is the owner's own and is kept nowhere.
 */
export function PageTyping({ connectorId, focus, open, summon = 0, mayRaise, onClose, onSent }: {
  connectorId: string;
  /** Whether the owner tapped or typed a moment ago: a field that takes the focus then raises the keyboard by itself (not when the screen opens on a page that has a field in focus). */
  mayRaise?: () => boolean;
  /** Changes whenever the keyboard is asked for by hand. */
  summon?: number;
  /** The page's field with the focus, from the browser node. */
  focus: BrowserFocus | null | undefined;
  /** The owner asked for the keyboard by hand (a field the node cannot see, inside another site's frame). */
  open: boolean;
  onClose: () => void;
  onSent?: () => void;
}) {
  const input = useRef<React.ComponentRef<typeof TextInput>>(null);
  const [text, setText] = useState("");
  // The strip shows only while the keyboard is up, as in a phone's own browser; the field stays mounted (hidden) so it can be raised.
  const [typing, setTyping] = useState(false);
  const shadow = useRef("");
  const seen = useRef<{ tapped: number | null; seq: number | null }>({ tapped: null, seq: null });
  const active = !!focus || open;
  const kb = pageKeyboard(focus);
  const send = (i: BrowserInput) => void browserInput(connectorId, i);

  // A new field on the page: start afresh.
  useEffect(() => {
    shadow.current = "";
    setText("");
    if (!active) input.current?.blur();
  }, [focus?.seq, active]);
  // The owner tapped into the field (also one that already had the focus), or the focus moved right after their own tap:
  // bring the keyboard up. A tap elsewhere on the page leaves it down. The short wait lets the screen settle first.
  useEffect(() => {
    const raise = shouldRaiseKeyboard({ lastTapped: seen.current.tapped, lastSeq: seen.current.seq, next: focus, ownActionRecent: !!mayRaise?.() });
    seen.current = { tapped: focus?.tapped ?? seen.current.tapped, seq: focus?.seq ?? null };
    bdbg("keyboard?", { raise, focus: focus ?? null });
    if (!raise) return;
    const t = setTimeout(() => input.current?.focus(), 120);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.seq, focus?.tapped]);
  // The keyboard put away by the system (the back gesture): the strip goes with it. And leaving the app lets go
  // of the field, or Android gives it the focus back (and raises the keyboard) when the app comes to the front.
  useEffect(() => {
    if (Platform.OS === "web") return;
    const s = Keyboard.addListener("keyboardDidHide", () => input.current?.blur());
    const a = AppState.addEventListener("change", (st) => { if (st !== "active") input.current?.blur(); });
    return () => { s.remove(); a.remove(); };
  }, []);
  // Asked for by hand (the keyboard button).
  useEffect(() => {
    if (summon && active) input.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summon]);

  const change = (next: string) => {
    for (const i of typingInputs(shadow.current, next)) send(i);
    shadow.current = next;
    setText(next);
    onSent?.();
  };
  const key = (k: string) => {
    send({ kind: "key", type: "press", key: k });
    // Enter and Tab end what was being typed: the page may have moved on to another field or another page.
    shadow.current = "";
    setText("");
    onSent?.();
  };

  if (!active) return null;
  return (
    // One container whose kind never changes: only its height and opacity follow the keyboard. Switching it between
    // a hidden absolute box (pointerEvents none) and the strip as the field took the focus made Android close the
    // input session ~15 ms after opening it (ImeTracker: HIDE_CLOSE_CURRENT_SESSION), so the keyboard flashed and vanished.
    <View style={[st.typing, !typing && st.typingHidden]} collapsable={false} testID="browser-typing">
      <Icon name={focus?.secret ? "lock" : "type"} size={15} tone={color.textDim} />
      <TextInput
        onFocus={() => setTyping(true)}
        onBlur={() => setTyping(false)}
        // A field of another kind gets a fresh text field: Android does not reliably switch a live one to a password field.
        // Only for a password field or a multi-line one: remounting closes the keyboard, and the other kinds switch live.
        key={`${kb.secureTextEntry ? "secret" : "plain"}-${kb.multiline ? "lines" : "line"}`}
        ref={input}
        value={text}
        onChangeText={change}
        // Backspace with nothing typed here yet: the page's own text is taken back, one character a press.
        onKeyPress={(e) => { if (e.nativeEvent.key === "Backspace" && !shadow.current) { send({ kind: "key", type: "press", key: "Backspace" }); onSent?.(); } }}
        // "Next" moves to the next field (Tab); "Go", "Search" and "Done" press Enter.
        onSubmitEditing={() => { if (!kb.multiline) key(kb.returnKeyType === "next" ? "Tab" : "Enter"); }}
        submitBehavior={kb.multiline ? undefined : "submit"}
        placeholder={kb.label}
        placeholderTextColor={color.textMuted}
        keyboardType={kb.keyboardType}
        secureTextEntry={kb.secureTextEntry}
        autoCapitalize={kb.autoCapitalize}
        autoCorrect={kb.autoCorrect}
        spellCheck={kb.autoCorrect}
        autoComplete={kb.autoComplete}
        importantForAutofill={kb.secureTextEntry || kb.autoComplete === "email" ? "yes" : "no"}
        multiline={kb.multiline}
        returnKeyType={kb.returnKeyType}
        accessibilityLabel={kb.label}
        testID="browser-type"
        style={st.typingInput}
      />
      <IconBtn icon="arrow-right" label="Tab: the next field" size={18} onPress={() => key("Tab")} />
      <IconBtn icon="corner-down-left" label="Enter" size={18} onPress={() => key("Enter")} />
      <IconBtn icon="chevron-down" label="Hide the keyboard" size={18} onPress={() => { input.current?.blur(); onClose(); }} />
    </View>
  );
}

const st = StyleSheet.create({
  box: { backgroundColor: color.surface, borderRadius: radius.md, borderWidth: 1, borderColor: color.border, overflow: "hidden", minHeight: 120 },
  driving: { borderColor: color.borderStrong },
  focused: { borderColor: color.accent },
  notice: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, alignItems: "center", justifyContent: "center", gap: space.sm, padding: space.lg },
  typing: { flexDirection: "row", alignItems: "center", gap: 4, paddingLeft: space.md, paddingRight: 4, borderTopWidth: 1, borderTopColor: color.border, backgroundColor: color.surface, minHeight: 48 },
  // Mounted but out of sight until the keyboard is up: a field Android can still focus (not zero-sized).
  typingHidden: { minHeight: 0, height: 1, opacity: 0, overflow: "hidden", borderTopWidth: 0 },
  typingInput: { flex: 1, color: color.text, fontSize: 16, paddingVertical: 8, maxHeight: 96 },
});
