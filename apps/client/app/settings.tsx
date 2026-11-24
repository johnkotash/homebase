import React, { useEffect, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import type { Device, SimKind } from "@homebase/protocol";
import { ConfirmDialog } from "../src/components/bits";
import { Btn, Card, Divider, Icon, IconBtn, SectionTitle, T, Tag, Toggle } from "../src/components/ui";
import { SOURCE, ago, dayTime } from "../src/format";
import { Header, Screen } from "../src/layout/Shell";
import { features, isPhoneApp } from "../src/platform";
import { ensureNotificationPermission } from "../src/notifications";
import { useList, useNow, useSetting, useSync } from "../src/sync/hooks";
import { APP_VERSION, api, mutate, resyncEverything, showToast, unpair, useSession } from "../src/sync/session";
import { clearNoteCache } from "../src/vault/cache";
import { color, font, radius, space } from "../src/theme";
import { voiceAvailability } from "../src/voice/VoiceInput";
import { desktopStt } from "../src/voice/desktop/bridge";
import { DesktopSpeechSetting } from "../src/components/DesktopSpeechSetting";
import { dictationShortcutLabel } from "../src/voice/useDictationShortcut";
import { BrowserSettingsSection } from "../src/components/BrowserShot";
import { router } from "expo-router";
import { ConnectionStatus } from "../src/components/DesktopConnection";
import { useDesktopConnection } from "../src/desktop/connection";
import { targetLabel } from "../src/desktop/connectionRules";

interface FocusWindow { enabled: boolean; days: number[]; start: string; end: string }
const SIM_KINDS: SimKind[] = ["monitor", "gmail", "clickup", "resend", "calendar"];

function Line({ label, children, hint }: { label: string; children?: React.ReactNode; hint?: string }) {
  return (
    <View style={st.line}>
      <View style={{ flex: 1, minWidth: 0 }}><T>{label}</T>{hint ? <T v="small">{hint}</T> : null}</View>
      {children}
    </View>
  );
}

function DeviceRow({ d, me, now }: { d: Device; me: boolean; now: number }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(d.name);
  const [confirm, setConfirm] = useState(false);
  const revoked = d.revokedAt != null;
  return (
    <View style={st.device}>
      <Icon name={d.platform === "android" || d.platform === "ios" ? "smartphone" : "monitor"} size={20} tone={revoked ? color.textMuted : d.online ? color.ok : color.textDim} />
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        {editing ? (
          <TextInput value={name} onChangeText={setName} autoFocus style={st.input} accessibilityLabel="Device name" maxLength={60}
            onSubmitEditing={() => { if (name.trim()) void mutate("device.update", { deviceId: d.id, name: name.trim() }); setEditing(false); }} />
        ) : (
          <View style={st.h}>
            <T v="heading" style={{ fontSize: 15, flexShrink: 1 }} numberOfLines={1} tone={revoked ? color.textMuted : undefined}>{d.name}</T>
            {me ? <Tag label="THIS DEVICE" tone={color.accent} /> : null}
            {revoked ? <Tag label="REVOKED" tone={color.danger} /> : null}
          </View>
        )}
        <T v="small" muted>{d.platform} · {revoked ? `revoked ${dayTime(d.revokedAt!)}` : d.online ? "connected now" : d.lastSeenAt ? `last seen ${ago(d.lastSeenAt, now)} ago` : "never connected"}</T>
      </View>
      {revoked ? null : editing ? (
        <Btn small kind="primary" label="Save" onPress={() => { if (name.trim()) void mutate("device.update", { deviceId: d.id, name: name.trim() }); setEditing(false); }} />
      ) : (
        <>
          <IconBtn icon="edit-2" label={`Rename ${d.name}`} size={17} onPress={() => { setName(d.name); setEditing(true); }} />
          {me ? null : <IconBtn icon="slash" label={`Revoke ${d.name}`} size={17} tone={color.danger} onPress={() => setConfirm(true)} />}
        </>
      )}
      <ConfirmDialog visible={confirm} title={`Revoke ${d.name}?`} body="Its socket closes immediately and its token stops working. It would need a new pairing code to come back."
        confirmLabel="Revoke" onCancel={() => setConfirm(false)} onConfirm={() => { setConfirm(false); void mutate("device.update", { deviceId: d.id, revoked: true }); }} />
    </View>
  );
}

export default function Settings() {
  const now = useNow();
  const session = useSession((s) => s.session);
  const status = useSync((s) => s.status);
  const queued = useSync((s) => s.outbox.length);
  const lastSeq = useSync((s) => s.lastSeq);
  const myId = useSync((s) => s.deviceId);
  const ws = useSync((s) => Object.values(s.entities.workspace)[0]);
  const devices = useList("devices", (a, b) => a.createdAt - b.createdAt);
  const integrations = useList("integrations", (a, b) => a.name.localeCompare(b.name));
  const policy = useSync((s) => Object.values(s.entities.sla_policies).find((p) => p.isDefault));
  const sendOnRelease = useSetting("voice.sendOnRelease", false);
  const readBack = useSetting("voice.readBack", false);
  const focus = useSetting<FocusWindow>("notifications.focusWindow", { enabled: false, days: [1, 2, 3, 4, 5], start: "08:00", end: "16:30" });
  const [code, setCode] = useState<{ kind: string; code: string; expiresAt: number } | null>(null);
  const [mins, setMins] = useState(String(policy?.respondWithinMinutes ?? 480));
  const [pct, setPct] = useState(String(policy?.warnAtPct ?? 75));
  const [fStart, setFStart] = useState(focus.start);
  const [fEnd, setFEnd] = useState(focus.end);
  const [unpairing, setUnpairing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const desktopConn = useDesktopConnection((s) => s.snap);
  useEffect(() => {
    if (policy) {
      setMins(String(policy.respondWithinMinutes));
      setPct(String(policy.warnAtPct));
    }
  }, [policy?.respondWithinMinutes, policy?.warnAtPct]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setFStart(focus.start);
    setFEnd(focus.end);
  }, [focus.start, focus.end]);

  const set = (key: string, value: unknown) => void mutate("settings.update", { key, value });
  const call = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      showToast("That didn't work", (e as Error).message, "error");
    }
    setBusy(null);
  };
  const newCode = (kind: "device" | "connector") => call(`code-${kind}`, async () => setCode({ kind, ...(await api<{ code: string; expiresAt: number }>("/v1/pairing-codes", { body: { kind } })) }));
  const validTime = (v: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
  const slaDirty = !!policy && (Number(mins) !== policy.respondWithinMinutes || Number(pct) !== policy.warnAtPct);
  const slaValid = Number.isFinite(Number(mins)) && Number(mins) >= 1 && Number(pct) >= 1 && Number(pct) <= 100;
  const voice = voiceAvailability();

  return (
    <Screen maxWidth={760}>
      <Header title="Settings" subtitle={`HomeBase ${APP_VERSION}${ws ? ` · ${ws.name}` : ""}`} back="/" />

      <SectionTitle title="Connection" />
      <Card style={{ gap: space.sm }}>
        <Line label="Hub" hint={session?.url}><Tag label={status.toUpperCase()} tone={status === "online" ? color.ok : status === "offline" ? color.danger : color.warn} /></Line>
        <Divider />
        <Line label="Sync position" hint={`Change #${lastSeq} · ${queued} change${queued === 1 ? "" : "s"} waiting to send`} />
        <Divider />
        <Line label="Resync everything" hint="Downloads a fresh copy of everything from the hub. Pairing and changes waiting to send are kept.">
          <Btn small icon="refresh-cw" label="Resync" testID="resync-everything"
            onPress={() => { if (resyncEverything()) showToast("Resyncing", status === "online" ? "Fetching everything from the hub." : "Everything is fetched from the hub when the connection is back.", "ok"); }} />
        </Line>
        <Divider />
        <Line label="Clear cached notes" hint="Removes the note text kept on this device for offline reading. Nothing changes in the vault.">
          <Btn small icon="hard-drive" label="Clear" busy={busy === "notes-cache"} onPress={() => call("notes-cache", async () => { const n = await clearNoteCache(); showToast("Cached notes cleared", `${n} note${n === 1 ? "" : "s"} removed from this device.`, "ok"); })} />
        </Line>
        <Divider />
        <Line label="Unpair this device" hint="Removes the token and the local cache from this device."><Btn small kind="danger" icon="log-out" label="Unpair" onPress={() => setUnpairing(true)} /></Line>
      </Card>

      {desktopConn ? (
        <>
          <SectionTitle title="Desktop connection" />
          <Card style={{ gap: space.sm }}>
            <Line label={desktopConn.config.mode === "ssh" ? "Via SSH" : "Direct"} hint={`This PC reaches the hub at ${targetLabel(desktopConn.config)}.`}>
              <Btn small icon="settings" label="Change" onPress={() => router.push("/connection")} testID="settings-desktop-connection" />
            </Line>
            <ConnectionStatus snap={desktopConn} />
          </Card>
        </>
      ) : null}

      <SectionTitle title="Devices" count={devices.filter((d) => !d.revokedAt).length} />
      <Card pad={space.md} style={{ gap: space.sm }}>
        {devices.map((d, i) => <View key={d.id}>{i ? <Divider style={{ marginBottom: space.sm }} /> : null}<DeviceRow d={d} me={d.id === myId} now={now} /></View>)}
        <Divider />
        <T v="small">Add another device or a connector. Codes work once and expire after 10 minutes.</T>
        <View style={st.btnRow}>
          <Btn small icon="smartphone" label="Code for a device" onPress={() => newCode("device")} busy={busy === "code-device"} grow />
          <Btn small icon="server" label="Code for a connector" onPress={() => newCode("connector")} busy={busy === "code-connector"} grow />
        </View>
        {code ? (
          <View style={st.codeBox} accessibilityLiveRegion="polite">
            <T v="micro">{code.kind} pairing code</T>
            <T selectable style={st.code} testID="pairing-code">{code.code}</T>
            <T v="small" muted>Expires {dayTime(code.expiresAt)}. Enter it on the new {code.kind === "device" ? "device's pairing screen" : "machine: npm run dev:connector -- --pair " + code.code}.</T>
          </View>
        ) : null}
      </Card>

      <SectionTitle title="Notifications" />
      <Card style={{ gap: space.sm }}>
        <Line label="Send a test notification" hint={isPhoneApp ? "The hub sends a notification and this phone shows it: in the app while it is open, in the notification shade while it is in the background. There is no push service yet, so nothing arrives once Android has closed the app."
          : "The hub sends a notification and this device shows it: in the app while this window is in front, as a system notification when it is not."}>
          <Btn small icon="bell" label="Test" busy={busy === "notify"} onPress={() => call("notify", async () => { await ensureNotificationPermission(true); await api("/v1/dev/notify-test", { method: "POST" }); })} />
        </Line>
        <Divider />
        <Line label="Focus window" hint="During these hours only P0 items and high-risk approvals interrupt. Everything else waits for a digest.">
          <Toggle label="Focus window" value={focus.enabled} onChange={(v) => set("notifications.focusWindow", { ...focus, enabled: v })} />
        </Line>
        <View style={st.btnRow}>
          <View style={st.field}><T v="micro">From</T><TextInput value={fStart} onChangeText={setFStart} style={st.input} accessibilityLabel="Focus window start" placeholder="08:00" placeholderTextColor={color.textMuted} maxLength={5} /></View>
          <View style={st.field}><T v="micro">Until</T><TextInput value={fEnd} onChangeText={setFEnd} style={st.input} accessibilityLabel="Focus window end" placeholder="16:30" placeholderTextColor={color.textMuted} maxLength={5} /></View>
          <Btn small label="Save hours" disabled={!validTime(fStart) || !validTime(fEnd) || (fStart === focus.start && fEnd === focus.end)}
            onPress={() => set("notifications.focusWindow", { ...focus, start: fStart, end: fEnd })} style={{ alignSelf: "flex-end" }} />
        </View>
        <T v="small" muted>Weekdays, in the workspace time zone ({ws?.timezone ?? "local"}).</T>
      </Card>

      <SectionTitle title="Voice" />
      <Card style={{ gap: space.sm }}>
        <Line label="Send on release" hint="Off: the transcript lands in the text field for review. On: releasing the mic sends it.">
          <Toggle label="Send on release" value={sendOnRelease} onChange={(v) => set("voice.sendOnRelease", v)} />
        </Line>
        <Divider />
        <Line label="Read replies aloud" hint={`Default for new sessions. Each session has its own toggle${features.drivingMode ? "; driving mode always reads" : ""}.`}>
          <Toggle label="Read replies aloud" value={readBack} onChange={(v) => set("voice.readBack", v)} />
        </Line>
        <Divider />
        <Line label="Speech recognition" hint={voice === "available" ? (desktopStt() ? `Whisper runs on this PC; nothing is sent to a speech service. ${dictationShortcutLabel} dictates in a session: press to start and stop, or hold it while you talk. Esc cancels.` : "On-device recognizer is ready.") : voice === "unavailable" ? "This device has no speech service. Typing works everywhere." : "Dictation is not offered on desktop in the prototype."}>
          <Tag label={voice === "available" ? "READY" : voice === "unavailable" ? "UNAVAILABLE" : "DESKTOP"} tone={voice === "available" ? color.ok : color.textMuted} />
        </Line>
        <DesktopSpeechSetting />
      </Card>

      <SectionTitle title="Default SLA policy" />
      <Card style={{ gap: space.md }}>
        <T v="heading">{policy?.name ?? "No default policy"}</T>
        {policy ? <T v="small">Business hours {policy.calendar.start}–{policy.calendar.end}, {policy.calendar.days.length} days a week, {policy.calendar.tz}. Time outside those hours does not count.</T> : null}
        <View style={st.btnRow}>
          <View style={st.field}><T v="micro">Respond within (business minutes)</T><TextInput value={mins} onChangeText={(v) => setMins(v.replace(/[^0-9]/g, ""))} keyboardType="number-pad" style={st.input} accessibilityLabel="Respond within minutes" /></View>
          <View style={st.field}><T v="micro">Warn at (% of the window)</T><TextInput value={pct} onChangeText={(v) => setPct(v.replace(/[^0-9]/g, ""))} keyboardType="number-pad" style={st.input} accessibilityLabel="Warn at percent" /></View>
        </View>
        <Btn label="Save policy" kind="primary" disabled={!slaDirty || !slaValid} onPress={() => set("sla.default", { respondWithinMinutes: Number(mins), warnAtPct: Number(pct) })} />
        <T v="small" muted>Saving recomputes the deadline of every open item on this policy, on all devices.</T>
      </Card>

      {/* The browser agents use, on each machine that runs one: watch it, sign in to a site, set its rules. */}
      <BrowserSettingsSection />

      <SectionTitle title="Integrations" count={integrations.length} />
      <Card pad={space.md} style={{ gap: space.sm }}>
        {integrations.map((i) => (
          <View key={i.id} style={st.h}>
            <Icon name={SOURCE[i.kind as keyof typeof SOURCE]?.icon ?? "link"} tone={SOURCE[i.kind as keyof typeof SOURCE]?.tone} />
            <T style={{ flex: 1 }} numberOfLines={1}>{i.name}</T>
            <Tag label={i.status.toUpperCase()} tone={i.status === "connected" ? color.ok : color.p2} />
          </View>
        ))}
        <T v="small" muted>All sources are simulated from fixtures in the prototype. No real account is connected.</T>
      </Card>

      <SectionTitle title="Developer" />
      <Card style={{ gap: space.md }}>
        <T v="small">Simulate an incoming item. It runs through the real triage rules and SLA policies, then syncs to every device.</T>
        <View style={[st.btnRow, { flexWrap: "wrap" }]}>
          {SIM_KINDS.map((k) => (
            <Btn key={k} small icon={SOURCE[k].icon} label={SOURCE[k].label} busy={busy === `sim-${k}`} testID={`simulate-${k}`}
              onPress={() => call(`sim-${k}`, async () => { await api("/v1/dev/simulate", { body: { kind: k } }); })} />
          ))}
        </View>
      </Card>

      <ConfirmDialog visible={unpairing} title="Unpair this device?" body="You will need a new pairing code to connect again. Changes that have not synced yet will be lost."
        confirmLabel="Unpair" onCancel={() => setUnpairing(false)} onConfirm={() => { setUnpairing(false); void unpair(); }} />
    </Screen>
  );
}

const st = StyleSheet.create({
  line: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 48 },
  h: { flexDirection: "row", alignItems: "center", gap: space.sm },
  device: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 52 },
  btnRow: { flexDirection: "row", gap: space.sm, alignItems: "center" },
  field: { flex: 1, gap: 6 },
  input: {
    height: 46, borderRadius: radius.md, borderWidth: 1, borderColor: color.borderStrong, backgroundColor: color.bg, color: color.text, fontSize: 15,
    paddingHorizontal: space.md, outlineStyle: "none",
  } as any,
  codeBox: { backgroundColor: color.bg, borderRadius: radius.md, borderWidth: 1, borderColor: color.accent, padding: space.lg, gap: 6, alignItems: "center" },
  code: { fontFamily: font.mono, fontSize: 30, lineHeight: 38, letterSpacing: 5, color: color.accent },
});
