import { Stack, router, useLocalSearchParams } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import { Keyboard, PixelRatio, Platform, Pressable, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SEAT_LABEL, type BrowserState } from "@homebase/protocol";
import {
  HAND_BACK_NOTES, NO_ZOOM, addressToUrl, enterControl, handBackThread, leaveAction, linkHealth, offerPhonePage, phoneSize, seatControls, type Size, type ViewZoom,
} from "../../src/browser";
import { bdbg } from "../../src/browserDebug";
import { useBrowser } from "../../src/browserLive";
import { BrowserSettingsSheet, SignInSheet, handBack } from "../../src/components/BrowserPanel";
import { BrowserView, PageTyping } from "../../src/components/BrowserView";
import { Field, Input, Sheet } from "../../src/components/Sheet";
import { Btn, Chip, Divider, Icon, IconBtn, T, Tag } from "../../src/components/ui";
import { useLayout } from "../../src/layout/Shell";
import { useOne, useSync } from "../../src/sync/hooks";
import { browserControl, syncStore } from "../../src/sync/session";
import { color, radius, space, tint } from "../../src/theme";

/**
 * The agent's browser, full screen (docs/BROWSER-AGENT-PLAN.md 0.8): a browser of its own, apart from the
 * chat. Opening it takes the browser over (on a phone the page is laid out for the phone's own screen);
 * closing it, or "Hand back to agent", gives it back, with an optional note to the session. The route's id
 * is the connector that runs the browser; `thread` is the session to tell, `signin=1` opens privately.
 *
 * The same screen on the phone and the desktop: fingers and the phone's keyboard on one, the mouse and the
 * keyboard on the other.
 */
export default function BrowserScreen() {
  const { id, thread, signin } = useLocalSearchParams<{ id: string; thread?: string; signin?: string }>();
  const connector = useOne("connectors", id);
  const live = useBrowser(id);
  const state = live.state;
  const online = useSync((s) => s.status === "online");
  const insets = useSafeAreaInsets();
  const { wide } = useLayout();
  const phone = Platform.OS !== "web";
  const c = seatControls(state);
  // What the screen knew before the connection dropped (the app in the background) is not trusted until the hub
  // answers again: a stale "you drive" would re-size the page under the agent.
  const drives = c.drives && online;

  const [box, setBox] = useState<Size | null>(null);
  const [zoom, setZoom] = useState<ViewZoom>(NO_ZOOM);
  const [menu, setMenu] = useState(false);
  const [rules, setRules] = useState(false);
  const [signInSheet, setSignInSheet] = useState(false);
  const [handing, setHanding] = useState(false);
  const [note, setNote] = useState("");
  const [keyboard, setKeyboard] = useState(false);
  const [summon, setSummon] = useState(0);
  // When the owner last tapped the page or typed: a field that takes the focus then raises the keyboard.
  const actedAt = useRef(0);
  const [editing, setEditing] = useState(false);
  const [address, setAddress] = useState("");
  const [now, setNow] = useState(Date.now());
  // The phone's keyboard: the screen makes room for it itself (measured against where this screen ends on the
  // window, so it is right whether Android resizes the window or draws the keyboard over it), and the bottom
  // bar steps aside meanwhile: the typing strip above the keyboard has what is needed.
  const root = useRef<React.ComponentRef<typeof View>>(null);
  const rootBottom = useRef(0);
  const kbTop = useRef<number | null>(null);
  const [kbRoom, setKbRoom] = useState(0);
  const roomNow = () => setKbRoom(kbTop.current == null ? 0 : Math.max(0, Math.round(rootBottom.current - kbTop.current)));
  const measureRoot = () => root.current?.measureInWindow((_x: number, y: number, _w: number, h: number) => { if (Number.isFinite(y) && h > 0) { rootBottom.current = y + h; roomNow(); } });
  useEffect(() => {
    if (Platform.OS === "web") return;
    const a = Keyboard.addListener("keyboardDidShow", (e) => { kbTop.current = e.endCoordinates.screenY; measureRoot(); roomNow(); });
    const b = Keyboard.addListener("keyboardDidHide", () => { kbTop.current = null; roomNow(); });
    return () => { a.remove(); b.remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const kbUp = kbRoom > 0;

  // The latest state for the moment the screen closes, and whether it was already handed back by hand.
  const latest = useRef<BrowserState | null>(state);
  latest.current = state;
  const handedBack = useRef(false);
  const entered = useRef(false);

  // ---- taking over as the screen opens, and keeping the page the size of the screen while driving
  const size = phone && box ? phoneSize(box, PixelRatio.get()) : null;
  useEffect(() => {
    if (!live.known || !state || state.unavailable) return;
    if (phone && !size) return; // the screen's size first, so the page is laid out once, at the right size
    if (!entered.current) {
      entered.current = true;
      const ctl = enterControl(state, { phone, size, signin: signin === "1" });
      const ok = ctl ? browserControl(id, ctl) : null;
      bdbg("enter", { seat: state.seat, layout: state.layout, viewport: state.viewport, box, size, pixelRatio: PixelRatio.get(), ctl, ok });
      return;
    }
    // Typing an address: the keyboard is for the address bar, the page keeps its size.
    if (!drives || !phone || editing) return;
    // The keyboard opened or closed, or the phone was unfolded: lay the page out again for the new size.
    const ctl = enterControl(state, { phone, size });
    if (ctl?.action !== "layout") return;
    const t = setTimeout(() => { const ok = browserControl(id, ctl); bdbg("relayout", { ctl, ok }); }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.known, !!state, state?.seat, state?.layout, state?.viewport.width, state?.viewport.height, size?.width, size?.height, drives, editing]);

  useEffect(() => {
    bdbg("state", state ? { seat: state.seat, running: state.running, layout: state.layout, viewport: state.viewport, focus: state.focus ?? null, viewers: state.viewers, url: state.site } : null);
  }, [state?.seat, state?.running, state?.layout, state?.viewport.width, state?.viewport.height, state?.focus?.seq, state?.viewers]);

  // Leaving the screen hands the browser back, unless that was already done.
  useEffect(() => () => {
    if (handedBack.current) return;
    const action = leaveAction(latest.current);
    if (action) handBack(id, latest.current, action);
  }, [id]);

  // ---- the address bar follows the page until the owner starts typing in it
  useEffect(() => {
    if (!editing) setAddress(state?.url && state.url !== "about:blank" ? state.url : "");
  }, [state?.url, editing]);

  // ---- the connection, as the browser node measures it (the round trip of its pictures). Never holds input back.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const health = linkHealth({ online, known: live.known, running: !!state?.running, frameTimes: live.arrivals, now, rtt: live.rtt });

  const threadId = handBackThread({ threadParam: thread ?? null, runId: state?.runId ?? null, runs: syncStore.getState().entities.runs as any });
  // Back to where the browser was opened from; opened from a link (a notification), back to its session.
  const close = () => (router.canGoBack() ? router.back() : router.replace((threadId ? `/chats/${threadId}` : "/") as any));
  const giveBack = (text: string | null) => {
    const action = leaveAction(state) ?? (state?.seat === "paused" ? "resume" : null);
    if (action && !handBack(id, state, action, { text, threadId })) return;
    handedBack.current = true;
    setHanding(false);
    close();
  };
  const go = () => {
    const url = addressToUrl(address);
    if (!url) return;
    if (browserControl(id, { action: "goto", url })) setEditing(false);
  };
  const where = state?.running ? state.site || state.title || "A blank page" : connector?.name ? `Browser on ${connector.name}` : "Browser";
  const healthTone = health.tone === "down" ? color.p0 : health.tone === "slow" ? color.p1 : color.textDim;
  const dotTone = health.tone === "down" ? color.p0 : health.tone === "slow" ? color.p1 : color.textMuted;
  // While the owner simply drives on a phone, the page has the whole screen: no status line, no bottom bar.
  const bare = phone && drives;
  const showStatus = !bare || state?.seat === "signin" || health.tone !== "ok";

  return (
    <View ref={root} onLayout={measureRoot} style={{ flex: 1, backgroundColor: color.bg, paddingBottom: editing ? 0 : kbRoom }}>
      {/* The phone's own bars are hidden here (edge to edge); a swipe from the edge shows them for a moment. */}
      {phone ? <Stack.Screen options={{ statusBarHidden: true, navigationBarHidden: true }} /> : null}
      {/* The top bar, as in a phone's browser: close, back, the address (with reload), the keyboard, more. */}
      <View style={st.top}>
        <IconBtn icon="x" label={drives ? "Close the browser and hand it back" : "Close"} onPress={() => (drives ? setHanding(true) : close())} testID="browser-close" />
        <IconBtn icon="arrow-left" label="Back" tone={drives ? color.text : color.textMuted} onPress={() => drives && browserControl(id, { action: "back" })} />
        {editing ? (
          <TextInput value={address} onChangeText={setAddress} onSubmitEditing={go} onBlur={() => setEditing(false)} autoFocus selectTextOnFocus
            autoCapitalize="none" autoCorrect={false} keyboardType="url" returnKeyType="go" placeholder="Search or type an address" placeholderTextColor={color.textMuted}
            accessibilityLabel="Address" testID="browser-address" style={[st.pill, st.addressInput]} />
        ) : (
          <View style={[st.pill, st.pillRow]}>
            <Pressable onPress={() => drives && setEditing(true)} accessibilityRole="button" accessibilityLabel={`Address: ${state?.url ?? "none"}. Tap to type an address.`} testID="browser-address-pill"
              style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 7, alignSelf: "stretch" }}>
              <View style={[st.dot, { backgroundColor: dotTone }]} accessibilityLabel={health.label} />
              {state?.seat === "signin" ? <Icon name="lock" size={13} tone={color.text} /> : null}
              <T v="small" numberOfLines={1} style={{ flex: 1, color: color.text, fontSize: 14 }}>{where}</T>
            </Pressable>
            {state?.running ? <IconBtn icon="rotate-cw" label="Reload" size={16} tone={drives ? color.textDim : color.textMuted} onPress={() => drives && browserControl(id, { action: "reload" })} testID="browser-reload" /> : null}
          </View>
        )}
        {bare && !editing ? <IconBtn icon="type" label="Keyboard" size={18} active={keyboard} onPress={() => { setKeyboard(true); setSummon((n) => n + 1); }} testID="browser-keyboard" /> : null}
        <IconBtn icon="more-vertical" label="More" onPress={() => setMenu(true)} testID="browser-menu" />
      </View>

      {/* One quiet line when there is something to say: who drives (unless it is simply you), a private sign-in, a call for you, a slow or lost link. */}
      {showStatus ? (
        <View style={[st.status, state?.seat === "needs_owner" && { backgroundColor: tint(color.p1, 0.1) }]}>
          {state?.seat === "signin" ? <Tag label="PRIVATE" icon="lock" /> : null}
          <T v="small" numberOfLines={1} style={{ flex: 1 }} tone={state?.seat === "needs_owner" ? color.p1 : color.textDim} testID="browser-status">
            {!state ? (live.known ? "The machine that runs this browser is offline" : "Connecting…")
              : state.unavailable ? state.unavailable
              : state.seat === "signin" ? "Nothing here is recorded. No agent sees what you type."
              : state.seat === "needs_owner" ? `Needs you: ${state.needs?.reason ?? "the agent is waiting"}`
              : state.seat === "owner" ? "You are driving. The agent waits."
              : SEAT_LABEL[state.seat]}
          </T>
          <View style={[st.dot, { backgroundColor: healthTone }]} />
          <T v="small" tone={healthTone} testID="browser-link">{health.label}</T>
        </View>
      ) : null}

      {/* The agent opened this page as a computer page; loaded again, the site sends its phone page. */}
      {offerPhonePage(state) ? (
        <View style={st.offer}>
          <T v="small" muted numberOfLines={1} style={{ flex: 1 }}>This is the site's computer page.</T>
          <Chip label="Load the phone page" icon="smartphone" onPress={() => browserControl(id, { action: "reload" })} />
        </View>
      ) : null}

      <View style={{ flex: 1, minHeight: 0 }}>
        <BrowserView connectorId={id} live={live} drives={drives} fit={phone ? "width" : "contain"} zoomable={phone} zoom={zoom} onZoom={setZoom}
          onBox={setBox} style={st.page} onTapSent={() => { actedAt.current = Date.now(); }} />
        {zoom.scale > 1.01 ? <View style={st.zoomChip}><Chip label={`${zoom.scale.toFixed(1)}×`} icon="zoom-out" onPress={() => setZoom(NO_ZOOM)} /></View> : null}
      </View>

      {/* The phone's keyboard, for the page: it comes up when the owner taps into a field on the page. */}
      {drives && (phone || !wide) ? (
        <PageTyping connectorId={id} focus={state?.focus} open={keyboard} summon={summon} mayRaise={() => Date.now() - actedAt.current < 3000} onClose={() => setKeyboard(false)}
          onSent={() => { actedAt.current = Date.now(); }} />
      ) : null}

      {(kbUp && phone) || bare ? null : <View style={[st.bottom, { paddingBottom: Math.max(insets.bottom, space.sm) }]}>
        {!state || state.unavailable ? (
          <Btn label="Close" icon="x" onPress={close} grow />
        ) : drives ? (
          <>
            {!wide ? <IconBtn icon="type" label="Keyboard" active={keyboard || !!state.focus} onPress={() => { setKeyboard(true); setSummon((n) => n + 1); }} testID="browser-keyboard" /> : null}
            {wide ? <T v="small" muted style={{ flex: 1 }}>Click the page, then use your mouse and keyboard as usual.</T> : <View style={{ flex: 1 }} />}
            <Btn kind="primary" icon="corner-up-left" label="Hand back to agent" onPress={() => setHanding(true)} testID="browser-handback" />
          </>
        ) : (
          <>
            <Btn kind="primary" icon="mouse-pointer" label={state.running ? "Take over" : "Open the browser"} grow testID="browser-take"
              onPress={() => { const ctl = enterControl(state, { phone, size }); if (ctl) browserControl(id, ctl); }} />
            {c.canPause ? <Btn kind="ghost" icon="pause" label="Pause" onPress={() => browserControl(id, { action: "pause" })} /> : null}
            {state.seat === "paused" ? <Btn kind="ghost" icon="play" label="Resume" onPress={() => handBack(id, state, "resume")} /> : null}
          </>
        )}
      </View>}

      {/* Handing back: one tap, with an optional word to the agent in the session. */}
      <Sheet visible={handing} title="Hand back to the agent" subtitle={state?.seat === "signin" ? "HomeBase keeps only the site's name and the time" : "The agent goes on from this page"} onClose={() => setHanding(false)} testID="browser-handback-sheet">
        {threadId ? (
          <>
            <Field label="Tell the agent (optional)" hint="Sent to the session as your message.">
              <Input value={note} onChangeText={setNote} placeholder="e.g. Done, I logged in, continue" multiline accessibilityLabel="A note for the agent" testID="browser-handback-note" />
            </Field>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {HAND_BACK_NOTES.map((n) => <Chip key={n} label={n} selected={note === n} onPress={() => setNote(note === n ? "" : n)} />)}
            </View>
          </>
        ) : <T v="small" muted>This browser was opened outside a session, so there is no session to send a note to.</T>}
        <Btn kind="primary" icon="corner-up-left" label={threadId && note.trim() ? "Hand back and send" : "Hand back"} onPress={() => giveBack(threadId ? note : null)} testID="browser-handback-confirm" />
        <Btn kind="ghost" icon="mouse-pointer" label="Keep driving" onPress={() => setHanding(false)} />
      </Sheet>

      {/* Everything else, out of the way. */}
      <Sheet visible={menu} title="Browser" subtitle={connector?.name ? `On ${connector.name}` : undefined} onClose={() => setMenu(false)} testID="browser-menu-sheet">
        {drives ? <Btn kind="primary" icon="corner-up-left" label="Hand back to agent" onPress={() => { setMenu(false); setHanding(true); }} testID="browser-menu-handback" /> : null}
        <Btn kind="ghost" icon="arrow-right" label="Forward" disabled={!drives} onPress={() => { browserControl(id, { action: "forward" }); setMenu(false); }} />
        <Btn kind="ghost" icon="rotate-cw" label="Reload" disabled={!drives} onPress={() => { browserControl(id, { action: "reload" }); setMenu(false); }} />
        {drives && state?.seat !== "signin" ? <Btn kind="ghost" icon="lock" label="Sign in privately" onPress={() => { setMenu(false); setSignInSheet(true); }} testID="browser-signin" /> : null}
        {state?.running ? (
          <Btn kind="ghost" icon={state.layout === "phone" ? "monitor" : "smartphone"} label={state.layout === "phone" ? "Desktop layout" : "Phone layout"} testID="browser-layout"
            onPress={() => { browserControl(id, state.layout === "phone" ? { action: "layout", layout: "desktop" } : { action: "layout", layout: "phone", ...(size ? { size } : {}) }); setMenu(false); }} />
        ) : null}
        {c.canPause ? <Btn kind="ghost" icon="pause" label="Pause the agent" onPress={() => { browserControl(id, { action: "pause" }); setMenu(false); }} /> : null}
        <Btn kind="ghost" icon="sliders" label="Browser rules" onPress={() => { setMenu(false); setRules(true); }} testID="browser-rules" />
        <Divider />
        <T v="small" muted>{state ? [state.browser, `${state.viewport.width} × ${state.viewport.height}`, state.layout === "phone" ? "phone layout" : "desktop layout", state.viewers > 1 ? `${state.viewers} watching` : null, health.label].filter(Boolean).join(" · ") : "Not connected"}</T>
      </Sheet>
      <SignInSheet connectorId={id} visible={signInSheet} onClose={() => setSignInSheet(false)} site={state?.site ?? null} />
      <BrowserSettingsSheet connectorId={id} state={state} visible={rules} onClose={() => setRules(false)} />
    </View>
  );
}

const st = StyleSheet.create({
  top: { flexDirection: "row", alignItems: "center", gap: 0, paddingHorizontal: 2, paddingVertical: 3, backgroundColor: color.surface },
  pill: { flex: 1, minWidth: 0, height: 40, borderRadius: radius.pill, backgroundColor: color.surface3, paddingHorizontal: space.md, justifyContent: "center" },
  pillRow: { flexDirection: "row", alignItems: "center", paddingRight: 0 },
  zoomChip: { position: "absolute", top: space.sm, right: space.sm },
  offer: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.md, paddingVertical: 4, backgroundColor: color.surface },
  addressInput: { color: color.text, fontSize: 15 },
  status: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: space.md, minHeight: 26, backgroundColor: color.surface },
  dot: { width: 7, height: 7, borderRadius: 4 },
  page: { flex: 1, borderRadius: 0, borderWidth: 0, minHeight: 0 },
  bottom: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.md, paddingTop: space.sm, borderTopWidth: 1, borderTopColor: color.border, backgroundColor: color.surface },
});
