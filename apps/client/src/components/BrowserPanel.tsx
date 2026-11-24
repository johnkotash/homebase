import { router } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { DEFAULT_BROWSER_BUDGET, browserStatusLine, newId, normalizeSite, type Agent, type BrowserControl, type BrowserState, type Run } from "@homebase/protocol";
import { handBackMessage, hasBrowser, lastBrowserStep, needsOwnerApprovals, parseHHMM, seatControls } from "../browser";
import { useBrowser } from "../browserLive";
import { dayTime } from "../format";
import { useLayout } from "../layout/Shell";
import { useSync } from "../sync/hooks";
import { browserControl, mutate, syncStore } from "../sync/session";
import { color, radius, space, tint } from "../theme";
import { ConfirmDialog } from "./bits";
import { BrowserView } from "./BrowserView";
import { Field, Input, Sheet } from "./Sheet";
import { Btn, Divider, Icon, IconBtn, T, Tag, Toggle } from "./ui";

/**
 * The browser as the owner meets it (docs/BROWSER-AGENT-PLAN.md 4.6): a strip in a session that opens to the
 * live picture, the buttons that say who drives, the private sign-in, and the rules agents browse under.
 * The same components on the phone and the desktop.
 */

/**
 * Hands the browser back and answers any "the browser needs you" card that is waiting on it, so the agent goes
 * on. With a note and a session, the note then goes to that session as the owner's own message: to the run
 * that is waiting, or as a new turn that tells the agent to carry on.
 */
export function handBack(connectorId: string, state: BrowserState | null, action: "release" | "done" | "resume", note?: { text: string | null; threadId: string | null }): boolean {
  if (!browserControl(connectorId, { action })) return false;
  for (const a of needsOwnerApprovals(Object.values(syncStore.getState().entities.approvals), state?.runId)) {
    void mutate("approval.decide", { approvalId: a.id, decision: "approve" });
  }
  const text = handBackMessage(note?.text);
  if (text && note?.threadId) void mutate("message.send", { threadId: note.threadId, messageId: newId("msg"), text, source: "text" });
  return true;
}

/** Opens the full-screen browser, which takes it over (or signs in privately) as it opens. */
export function openBrowser(connectorId: string, opts: { threadId?: string | null; signin?: boolean } = {}) {
  const q = [opts.threadId ? `thread=${encodeURIComponent(opts.threadId)}` : null, opts.signin ? "signin=1" : null].filter(Boolean).join("&");
  router.navigate(`/browser/${connectorId}${q ? `?${q}` : ""}` as any);
}

// ---------------------------------------------------------------- private sign-in

export function SignInSheet({ connectorId, visible, onClose, site }: { connectorId: string; visible: boolean; onClose: () => void; site: string | null }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (visible) setUrl("");
  }, [visible]);
  const go = (address?: string) => {
    if (browserControl(connectorId, { action: "signin", ...(address?.trim() ? { url: address.trim() } : {}) })) onClose();
  };
  return (
    <Sheet visible={visible} title="Sign in to a site" subtitle="Privately, by your own hand" onClose={onClose} testID="browser-signin-sheet">
      <T v="small">
        You sign in on the site's own page, in the live view. While you do, nothing is recorded: no picture is kept, nothing goes on a timeline, and no agent sees the
        page or what you type. The browser keeps the session afterwards, so agents can use the site without ever holding your password.
      </T>
      <Field label="Site address" hint={site ? `Leave empty to sign in on the page that is open now (${site}).` : "Leave empty to sign in on the page that is open now."}>
        <Input value={url} onChangeText={setUrl} placeholder="https://example.com/login" autoCapitalize="none" autoCorrect={false} keyboardType="url"
          onSubmitEditing={() => go(url)} accessibilityLabel="Site address" />
      </Field>
      <T v="small" muted>Sign in only to sites an agent needs. Not your email, not your bank.</T>
      <Btn kind="primary" icon="lock" label="Open privately" onPress={() => go(url)} testID="browser-signin-open" />
    </Sheet>
  );
}

// ---------------------------------------------------------------- the rules agents browse under

function SiteList({ sites, empty, onRemove }: { sites: string[]; empty: string; onRemove: (site: string) => void }) {
  if (!sites.length) return <T v="small" muted>{empty}</T>;
  return (
    <View style={{ gap: 4 }}>
      {sites.map((s) => (
        <View key={s} style={st.siteRow}>
          <T style={{ flex: 1 }} numberOfLines={1}>{s}</T>
          <IconBtn icon="x" label={`Remove ${s}`} size={16} onPress={() => onRemove(s)} />
        </View>
      ))}
    </View>
  );
}

export function BrowserSettingsSheet({ connectorId, state, visible, onClose }: { connectorId: string; state: BrowserState | null; visible: boolean; onClose: () => void }) {
  const settings = state?.settings;
  const budget = settings?.budget ?? DEFAULT_BROWSER_BUDGET;
  const [perHour, setPerHour] = useState("");
  const [gap, setGap] = useState("");
  const [perDay, setPerDay] = useState("");
  const [anyTime, setAnyTime] = useState(false);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [actSite, setActSite] = useState("");
  const [blockSite, setBlockSite] = useState("");
  const [forget, setForget] = useState(false);
  useEffect(() => {
    if (!visible) return;
    setPerHour(String(budget.pagesPerHour));
    setGap(String(budget.minGapSec));
    setPerDay(String(budget.pagesPerDay));
    setAnyTime(!budget.hours);
    setStart(budget.hours?.start ?? DEFAULT_BROWSER_BUDGET.hours!.start);
    setEnd(budget.hours?.end ?? DEFAULT_BROWSER_BUDGET.hours!.end);
    // Only when the sheet opens: typing must not be overwritten by a state message.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);
  const send = (control: BrowserControl) => browserControl(connectorId, control);
  const num = (v: string, min: number, max: number) => (Number.isFinite(Number(v)) && v.trim() !== "" && Number(v) >= min && Number(v) <= max ? Number(v) : null);
  const next = {
    pagesPerHour: num(perHour, 1, 5000), minGapSec: num(gap, 0, 600), pagesPerDay: num(perDay, 1, 50000),
    hours: anyTime ? null : parseHHMM(start) && parseHHMM(end) ? { start: parseHHMM(start)!, end: parseHHMM(end)! } : undefined,
  };
  const valid = next.pagesPerHour != null && next.minGapSec != null && next.pagesPerDay != null && next.hours !== undefined;
  const changed = valid && JSON.stringify(next) !== JSON.stringify(budget);
  const savePace = () => {
    if (valid) send({ action: "settings", settings: { budget: { pagesPerHour: Math.round(next.pagesPerHour!), minGapSec: next.minGapSec!, pagesPerDay: Math.round(next.pagesPerDay!), hours: next.hours ?? null } } });
  };
  const here = state?.site ?? null;
  const acts = settings?.actSites ?? [];
  const blocked = settings?.blockedSites ?? [];
  const addBlocked = () => {
    const site = normalizeSite(blockSite);
    if (!site || !settings) return;
    send({ action: "settings", settings: { blockedSites: [...blocked.filter((s) => s !== site), site] } });
    setBlockSite("");
  };
  return (
    <Sheet visible={visible} title="Browser rules" subtitle="What agents may do in this browser" onClose={onClose} testID="browser-settings-sheet">
      <T v="small">
        Agents may always open pages, read them and follow links. Clicking buttons, typing and submitting forms asks you each time in Manual mode. In Auto mode it is allowed
        without asking only on the sites listed here. Passwords, codes and card numbers are never typed by an agent.
      </T>

      <Field label="Sites where agents may act in Auto mode">
        <SiteList sites={acts} empty="None yet. Every action asks, in every mode." onRemove={(site) => send({ action: "disallow_site", site })} />
        <View style={st.addRow}>
          <Input value={actSite} onChangeText={setActSite} placeholder="example.com" autoCapitalize="none" autoCorrect={false} style={{ flex: 1 }} accessibilityLabel="A site where agents may act"
            onSubmitEditing={() => { if (normalizeSite(actSite) && send({ action: "allow_site", site: actSite })) setActSite(""); }} />
          <Btn small label="Add" icon="plus" disabled={!normalizeSite(actSite)} onPress={() => { if (send({ action: "allow_site", site: actSite })) setActSite(""); }} />
        </View>
        {here && !acts.includes(here) ? <Btn small kind="ghost" icon="plus" label={`Add ${here}, the site that is open`} onPress={() => send({ action: "allow_site", site: here })} /> : null}
      </Field>

      <Field label="Pace, per site" hint="Counted for agents only. What you do by hand is not counted.">
        <View style={st.paceRow}>
          <View style={st.pace}><T v="small" muted>Pages an hour</T><Input value={perHour} onChangeText={setPerHour} keyboardType="number-pad" accessibilityLabel="Pages an hour" /></View>
          <View style={st.pace}><T v="small" muted>Seconds between</T><Input value={gap} onChangeText={setGap} keyboardType="number-pad" accessibilityLabel="Seconds between pages" /></View>
          <View style={st.pace}><T v="small" muted>Pages a day</T><Input value={perDay} onChangeText={setPerDay} keyboardType="number-pad" accessibilityLabel="Pages a day" /></View>
        </View>
        <View style={st.toggleRow}>
          <T style={{ flex: 1 }}>Agents may browse at any hour</T>
          <Toggle value={anyTime} onChange={setAnyTime} label="Agents may browse at any hour" />
        </View>
        {anyTime ? null : (
          <View style={st.paceRow}>
            <View style={st.pace}><T v="small" muted>From</T><Input value={start} onChangeText={setStart} placeholder="07:00" accessibilityLabel="Agents may browse from" /></View>
            <View style={st.pace}><T v="small" muted>Until</T><Input value={end} onChangeText={setEnd} placeholder="22:00" accessibilityLabel="Agents may browse until" /></View>
          </View>
        )}
        <Btn small kind={changed ? "primary" : "secondary"} label={valid ? "Save pace" : "Check the numbers"} icon="check" disabled={!changed} onPress={savePace} testID="browser-save-pace" />
      </Field>

      <Field label="Sites agents may not open">
        <SiteList sites={blocked} empty="None." onRemove={(site) => settings && send({ action: "settings", settings: { blockedSites: blocked.filter((s) => s !== site) } })} />
        <View style={st.addRow}>
          <Input value={blockSite} onChangeText={setBlockSite} placeholder="example.com" autoCapitalize="none" autoCorrect={false} style={{ flex: 1 }} accessibilityLabel="A site agents may not open" onSubmitEditing={addBlocked} />
          <Btn small label="Add" icon="plus" disabled={!normalizeSite(blockSite)} onPress={addBlocked} />
        </View>
      </Field>

      <Field label="Signed in, by your word" hint="HomeBase keeps the site and the time you said you were done. The session itself lives in the browser's own profile, on the machine that runs it.">
        {state?.signedIn.length ? state.signedIn.map((s) => <T key={s.site} v="small">{s.site} · {dayTime(s.at)}</T>) : <T v="small" muted>Nothing yet.</T>}
      </Field>

      <Divider />
      {state ? <T v="small" muted>{[state.browser, state.headless ? "no window" : "windowed", `${state.tabs} tab${state.tabs === 1 ? "" : "s"}`, state.note].filter(Boolean).join(" · ")}</T> : null}
      <View style={{ flexDirection: "row", gap: space.sm, flexWrap: "wrap" }}>
        <Btn small kind="ghost" icon="power" label="Close the browser" disabled={!state?.running} onPress={() => send({ action: "stop" })} />
        <Btn small kind="danger" icon="log-out" label="Sign out everywhere" onPress={() => setForget(true)} />
      </View>
      <ConfirmDialog visible={forget} title="Sign out everywhere?" body="The browser is closed and its profile is deleted: every site you signed in to here forgets it. Your rules are kept."
        confirmLabel="Delete the profile" onCancel={() => setForget(false)} onConfirm={() => { setForget(false); send({ action: "forget" }); }} />
    </Sheet>
  );
}

// ---------------------------------------------------------------- the strip in a session

/**
 * In a session whose agent has the browser: one line saying what the browser is doing, which opens to the
 * live picture to watch. Taking over opens the full-screen browser (the same screen on the phone and the
 * desktop), which takes the browser as it opens and hands it back as it closes. Watching is what switches
 * the picture on, so a closed strip costs nothing.
 */
export function BrowserBar({ agent, liveRun, threadId }: { agent: Agent | undefined; liveRun?: Run; threadId?: string | null }) {
  const { wide, height } = useLayout();
  const [open, setOpen] = useState(false);
  const [rules, setRules] = useState(false);
  const connectorId = hasBrowser(agent) ? agent.connectorId : null;
  const live = useBrowser(connectorId, open);
  const events = useSync((s) => (liveRun ? s.runEvents[liveRun.id] : undefined));
  const last = useMemo(() => lastBrowserStep(events), [events]);
  // The agent has just started using the browser in this run: show it, once, without being asked.
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    if (!liveRun || !last || shown === liveRun.id) return;
    setShown(liveRun.id);
    setOpen(true);
  }, [liveRun, last, shown]);
  if (!connectorId) return null;
  const state = live.state;
  const c = seatControls(state);
  const needs = state?.seat === "needs_owner";
  const line = open ? browserStatusLine(live.known ? state : undefined).replace(/^Browser not connected$/, "Connecting…")
    : last ? `Agent in the browser: ${last.text}` : "The agent has a browser you can watch";
  const take = () => openBrowser(connectorId, { threadId });
  return (
    <View style={st.bar} testID="browser-bar">
      <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={open ? "Hide the browser" : "Watch the browser"}
        style={({ hovered }: any) => [st.barHead, hovered && { backgroundColor: color.surface2 }]}>
        <Icon name="globe" size={16} tone={needs ? color.p1 : last || open ? color.text : color.textDim} />
        <T v="small" style={{ flex: 1 }} numberOfLines={1} tone={needs ? color.p1 : undefined}>{line}</T>
        {open && state?.seat === "signin" ? <Tag label="PRIVATE" icon="lock" /> : null}
        <T v="small" muted>{open ? "Hide" : "Watch"}</T>
        <Icon name={open ? "chevron-up" : "chevron-down"} size={16} />
      </Pressable>
      {open ? (
        <View style={st.barBody}>
          <Pressable onPress={state?.running ? take : undefined} accessibilityRole="button" accessibilityLabel="Open the browser full screen and take over" disabled={!state?.running}>
            <BrowserView connectorId={connectorId} live={live} drives={false} style={{ height: Math.round(Math.min(wide ? 460 : 260, height * (wide ? 0.42 : 0.32))) }} />
          </Pressable>
          {needs && state?.needs ? (
            <View style={[st.banner, { borderColor: tint(color.p1, 0.6), backgroundColor: tint(color.p1, 0.08) }]} testID="browser-banner">
              <Icon name="alert-circle" size={15} tone={color.p1} />
              <T v="small" tone={color.p1} style={{ flex: 1 }}>Needs you: {state.needs.reason}.</T>
            </View>
          ) : null}
          <View style={st.buttons}>
            {state && !state.unavailable ? (
              c.drives ? <Btn small kind="primary" icon="maximize-2" label="Back to the browser" onPress={take} testID="browser-take" />
                : <Btn small kind={needs ? "primary" : "secondary"} icon="mouse-pointer" label="Take over" onPress={take} testID="browser-take" />
            ) : null}
            {c.drives ? <Btn small kind="ghost" icon="corner-up-left" label="Hand back" onPress={() => c.primary && c.primary.action !== "take" && handBack(connectorId, state, c.primary.action)} testID="browser-release" /> : null}
            {c.canPause ? <Btn small kind="ghost" icon="pause" label="Pause" onPress={() => browserControl(connectorId, { action: "pause" })} testID="browser-pause" /> : null}
            {state?.seat === "paused" ? <Btn small kind="ghost" icon="play" label="Resume" onPress={() => handBack(connectorId, state, "resume")} testID="browser-resume" /> : null}
            {c.canSignIn ? <Btn small kind="ghost" icon="lock" label="Sign in" onPress={() => openBrowser(connectorId, { threadId, signin: true })} testID="browser-signin" /> : null}
            <Btn small kind="ghost" icon="sliders" label="Rules" onPress={() => setRules(true)} testID="browser-rules" />
          </View>
          <BrowserSettingsSheet connectorId={connectorId} state={state} visible={rules} onClose={() => setRules(false)} />
        </View>
      ) : null}
    </View>
  );
}

const st = StyleSheet.create({
  bar: { borderWidth: 1, borderColor: color.border, borderRadius: radius.md, marginBottom: space.sm, overflow: "hidden", backgroundColor: color.surface },
  barHead: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 44, paddingHorizontal: space.md },
  barBody: { padding: space.md, paddingTop: 0, gap: space.sm },
  banner: { flexDirection: "row", alignItems: "center", gap: space.sm, borderWidth: 1, borderColor: color.border, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: 8 },
  buttons: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  addressRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  siteRow: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 36, paddingLeft: space.md, borderWidth: 1, borderColor: color.border, borderRadius: radius.sm },
  addRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  paceRow: { flexDirection: "row", gap: space.sm },
  toggleRow: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 40 },
  pace: { flex: 1, gap: 4 },
});
