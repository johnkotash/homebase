import React, { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { retryDesktopConnection, saveDesktopConnection, useDesktopConnection } from "../desktop/connection";
import { connectionHeadline, formErrors, type ConnMode, type ConnSnapshot, type Tone } from "../desktop/connectionRules";
import { color, font, radius, space, tint } from "../theme";
import { Btn, Dot, Icon, Segmented, T } from "./ui";

/**
 * The installed desktop app's hub connection (apps/desktop/hubConnection.mjs): Via SSH (a tunnel to the hub's server, for a PC
 * that is not on Tailscale) or Direct (a hub address this PC can reach). Shown on the first run, from the pair
 * screen and from Settings. The phone and the browser never show it.
 */

export const toneColor = (t: Tone) => (t === "ok" ? color.ok : t === "warn" ? color.warn : t === "danger" ? color.danger : color.textMuted);

/** Ticks once a second while a retry countdown is on screen. */
function useSecondTick(on: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** Where the connection stands, with Retry when it is not connected. */
export function ConnectionStatus({ snap, compact }: { snap: ConnSnapshot; compact?: boolean }) {
  const now = useSecondTick(snap.state.phase === "retrying");
  const h = connectionHeadline(snap, now);
  const tone = toneColor(h.tone);
  const canRetry = snap.state.phase === "retrying" || snap.state.phase === "error";
  return (
    <View style={[st.status, { borderColor: h.tone === "ok" || h.tone === "muted" ? color.border : tint(tone, 0.4), backgroundColor: h.tone === "ok" || h.tone === "muted" ? color.bg : tint(tone, 0.08) }]}
      accessibilityRole={h.tone === "danger" ? "alert" : undefined} testID="desktop-connection-status">
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        {h.busy ? <ActivityIndicator size="small" color={color.textDim} /> : <Dot tone={tone} size={8} />}
        <T v="heading" style={{ flex: 1, fontSize: 14 }} tone={h.tone === "danger" || h.tone === "warn" ? tone : undefined}>{h.title}</T>
        {canRetry ? <Btn small icon="refresh-cw" label="Retry" onPress={retryDesktopConnection} testID="desktop-connection-retry" /> : null}
      </View>
      {h.body && !compact ? <T v="small" style={{ marginTop: 6 }} selectable>{h.body}</T> : null}
      {snap.state.error?.detail && !compact && snap.state.phase !== "connected" ? (
        <T v="mono" style={{ marginTop: 6, fontSize: 11, lineHeight: 15, color: color.textMuted }} selectable>{snap.state.error.detail}</T>
      ) : null}
    </View>
  );
}

/** The form: mode, SSH host (or hub address), Save and connect. */
export function DesktopConnectionForm({ firstRun, onSaved }: { firstRun?: boolean; onSaved?: () => void }) {
  const snap = useDesktopConnection((s) => s.snap);
  const cfg = snap?.config;
  const [mode, setMode] = useState<ConnMode>(cfg?.mode ?? "ssh");
  const [sshHost, setSshHost] = useState(cfg?.sshHost ?? "homebase-server");
  const [remotePort, setRemotePort] = useState(String(cfg?.remotePort ?? 8787));
  const [directUrl, setDirectUrl] = useState(cfg?.directUrl || "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  if (!snap || !cfg) return null;

  const dirty = !snap.configured || mode !== cfg.mode || (mode === "ssh" ? sshHost.trim() !== cfg.sshHost || Number(remotePort) !== cfg.remotePort : directUrl.trim().replace(/\/+$/, "") !== cfg.directUrl);
  const submit = async () => {
    const e = formErrors({ mode, sshHost, directUrl, remotePort });
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    const r = await saveDesktopConnection({ mode, sshHost: sshHost.trim(), remotePort: Number(remotePort), directUrl: directUrl.trim(), localPort: cfg.localPort });
    setBusy(false);
    if (!r.ok) return setErrors(r.errors);
    onSaved?.();
  };

  const field = (label: string, key: string, value: string, set: (v: string) => void, placeholder: string, hint?: string) => (
    <>
      <T v="micro" style={st.label}>{label}</T>
      <TextInput value={value} onChangeText={set} autoCapitalize="none" autoCorrect={false} style={[st.input, errors[key] ? { borderColor: tint(color.danger, 0.6) } : null]}
        placeholder={placeholder} placeholderTextColor={color.textMuted} accessibilityLabel={label} onSubmitEditing={submit} testID={`conn-${key}`} />
      {errors[key] ? <T v="small" tone={color.danger} style={{ marginTop: 4 }}>{errors[key]}</T> : hint ? <T v="small" muted style={{ marginTop: 4 }}>{hint}</T> : null}
    </>
  );

  return (
    <View>
      <T v="micro" style={st.label}>How this PC reaches the hub</T>
      <Segmented<ConnMode> value={mode} onChange={(v) => { setMode(v); setErrors({}); }}
        options={[{ value: "ssh", label: "Via SSH", icon: "terminal" }, { value: "direct", label: "Direct", icon: "globe" }]} />
      <T v="small" style={{ marginTop: space.sm }}>
        {mode === "ssh"
          ? "For a PC that is not on Tailscale. HomeBase opens an SSH tunnel with this PC's own ssh, keys and ~/.ssh/config, and keeps it up while the app is open. It never asks for or stores a password."
          : "For a PC on Tailscale (or the hub's own network): the hub's address, like http://my-server:8787 or an https://….ts.net address."}
      </T>

      {mode === "ssh" ? (
        <>
          {field("SSH host", "sshHost", sshHost, setSshHost, "homebase-server", "An alias from ~/.ssh/config, or user@host. `ssh <host>` must work in a terminal without a password.")}
          {field("Hub port on that host", "remotePort", remotePort, setRemotePort, "8787")}
        </>
      ) : (
        field("Hub address", "directUrl", directUrl, setDirectUrl, "http://my-server:8787")
      )}
      {errors.mode ? <T v="small" tone={color.danger} style={{ marginTop: space.sm }}>{errors.mode}</T> : null}

      <Btn label={busy ? "Saving…" : firstRun ? "Connect" : dirty ? "Save and reconnect" : "Reconnect"} kind="primary" icon="link-2" busy={busy}
        onPress={dirty ? submit : retryDesktopConnection} style={{ marginTop: space.xl }} testID="conn-save" />
      {snap.configured ? <View style={{ marginTop: space.lg }}><ConnectionStatus snap={snap} /></View> : null}
    </View>
  );
}

/** First run of the installed app: nothing else shows until a connection is chosen. */
export function DesktopConnectionSetup() {
  return (
    <ScrollView style={{ flex: 1, backgroundColor: color.bg }} contentContainerStyle={st.scroll} keyboardShouldPersistTaps="handled">
      <View style={st.card}>
        <View style={st.brand}>
          <View style={st.mark}><View style={st.markDot} /></View>
          <T v="display">HomeBase</T>
        </View>
        <T v="title" style={{ marginTop: space.lg }}>Connect to your hub</T>
        <T v="small" style={{ marginTop: 4 }}>
          The hub runs on your server. Choose how this PC reaches it; you can change this later in Settings → Desktop connection. Next you pair this PC with a one-time code.
        </T>
        <DesktopConnectionForm firstRun />
        <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.lg, alignItems: "flex-start" }}>
          <Icon name="info" size={14} tone={color.textMuted} style={{ marginTop: 2 }} />
          <T v="small" muted style={{ flex: 1 }}>Via SSH needs the OpenSSH client (built into Windows) and a key that the server accepts. Test it in a terminal: ssh &lt;host&gt;</T>
        </View>
      </View>
    </ScrollView>
  );
}

const st = StyleSheet.create({
  scroll: { flexGrow: 1, alignItems: "center", justifyContent: "center", padding: space.lg },
  card: { width: "100%", maxWidth: 480, backgroundColor: color.surface, borderRadius: radius.xl, borderWidth: 1, borderColor: color.border, padding: space.xl },
  brand: { flexDirection: "row", alignItems: "center", gap: space.lg },
  mark: { width: 40, height: 40, borderRadius: 10, borderWidth: 4, borderColor: color.accent, alignItems: "center", justifyContent: "center", transform: [{ rotate: "45deg" }] },
  markDot: { width: 11, height: 11, borderRadius: 6, backgroundColor: color.accent },
  label: { marginTop: space.lg, marginBottom: 6 },
  input: {
    height: 48, borderRadius: radius.md, borderWidth: 1, borderColor: color.borderStrong, backgroundColor: color.bg, color: color.text, fontSize: 15,
    paddingHorizontal: space.lg, outlineStyle: "none", fontFamily: font.mono,
  } as any,
  status: { borderRadius: radius.md, borderWidth: 1, padding: space.md },
});
