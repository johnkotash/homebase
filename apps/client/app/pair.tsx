import Constants from "expo-constants";
import React, { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { router } from "expo-router";
import { ConnectionStatus } from "../src/components/DesktopConnection";
import { Btn, Icon, T } from "../src/components/ui";
import { useDesktopConnection } from "../src/desktop/connection";
import { connectedHubUrl, targetLabel } from "../src/desktop/connectionRules";
import { DEFAULT_HUB_URL, isElectron, pairDevice } from "../src/sync/session";
import { color, font, radius, space, tint } from "../src/theme";

const defaultName = Platform.OS === "web" ? (isElectron ? "Desktop app" : "Web browser") : Constants.deviceName ?? "Android phone";

export default function PairScreen() {
  const [url, setUrl] = useState(DEFAULT_HUB_URL);
  const [code, setCode] = useState("");
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Installed desktop app: the shell connects to the hub (SSH tunnel or direct), so there is no address to type.
  const conn = useDesktopConnection((s) => s.snap);
  const shellHub = conn ? connectedHubUrl(conn.state) : null;

  const formatted = (v: string) => {
    const raw = v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    return raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
  };
  const complete = code.replace("-", "").length === 8;

  const submit = async () => {
    if (busy) return;
    if (!complete) return setError("Enter the 8-character code the hub printed, like ABCD-EFGH.");
    if (conn && !shellHub) return setError("Not connected to the hub yet. Wait for the connection above, or change it.");
    setBusy(true);
    setError(null);
    const r = await pairDevice({ url: shellHub ?? url, code, name });
    setBusy(false);
    if (!r.ok) setError(r.message);
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: color.bg }} behavior={Platform.OS === "web" ? undefined : "padding"}>
      <ScrollView contentContainerStyle={st.scroll} keyboardShouldPersistTaps="handled">
        <View style={st.card}>
          <View style={st.brand}>
            <View style={st.mark}><View style={st.markDot} /></View>
            <T v="display">HomeBase</T>
          </View>
          <T v="title" style={{ marginTop: space.lg }}>Pair this device</T>
          <T v="small" style={{ marginTop: 4 }}>
            {conn ? "Enter a one-time pairing code from the hub." : "Enter your hub's address (http:// or https://) and a one-time pairing code."} After pairing, this device holds only its own token: no API keys, no vault files.
          </T>

          {conn ? (
            <>
              <View style={[st.h, st.label]}>
                <T v="micro" style={{ flex: 1 }}>Hub · {targetLabel(conn.config)}</T>
                <Btn small kind="ghost" label="Change" icon="settings" onPress={() => router.push("/connection")} testID="pair-change-connection" />
              </View>
              <ConnectionStatus snap={conn} />
            </>
          ) : (
            <>
              <T v="micro" style={st.label}>Server URL</T>
              <TextInput value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" style={st.input}
                placeholder="https://… or http://…:8787" placeholderTextColor={color.textMuted} accessibilityLabel="Server URL" testID="pair-url" />
            </>
          )}

          <T v="micro" style={st.label}>Pairing code</T>
          <TextInput value={code} onChangeText={(v) => setCode(formatted(v))} autoCapitalize="characters" autoCorrect={false} style={[st.input, st.code]}
            placeholder="ABCD-EFGH" placeholderTextColor={color.textMuted} accessibilityLabel="Pairing code" maxLength={9} onSubmitEditing={submit} testID="pair-code" />

          <T v="micro" style={st.label}>Device name</T>
          <TextInput value={name} onChangeText={setName} style={st.input} placeholder="Pixel 10 Pro" placeholderTextColor={color.textMuted}
            accessibilityLabel="Device name" maxLength={60} testID="pair-name" />

          {error ? (
            <View style={st.error} accessibilityRole="alert">
              <Icon name="alert-circle" size={16} tone={color.danger} />
              <T v="small" tone={color.danger} style={{ flex: 1 }}>{error}</T>
            </View>
          ) : null}

          <Btn label={busy ? "Pairing…" : "Pair device"} kind="primary" icon="link" onPress={submit} busy={busy} style={{ marginTop: space.xl }} testID="pair-submit" />
          <T v="small" muted style={{ marginTop: space.lg, textAlign: "center" }}>
            {conn
              ? "Need a code? Open Settings → Devices on your phone, or run on the hub's server: npm run pair-code"
              : "Need a code? Run `npm run pair-code` on the machine that runs the hub, or open Settings → Devices on a device that is already paired."}
          </T>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const st = StyleSheet.create({
  scroll: { flexGrow: 1, alignItems: "center", justifyContent: "center", padding: space.lg },
  card: { width: "100%", maxWidth: 440, backgroundColor: color.surface, borderRadius: radius.xl, borderWidth: 1, borderColor: color.border, padding: space.xl },
  brand: { flexDirection: "row", alignItems: "center", gap: space.lg },
  mark: { width: 40, height: 40, borderRadius: 10, borderWidth: 4, borderColor: color.accent, alignItems: "center", justifyContent: "center", transform: [{ rotate: "45deg" }] },
  markDot: { width: 11, height: 11, borderRadius: 6, backgroundColor: color.accent },
  label: { marginTop: space.lg, marginBottom: 6 },
  h: { flexDirection: "row", alignItems: "center" },
  input: {
    height: 52, borderRadius: radius.md, borderWidth: 1, borderColor: color.borderStrong, backgroundColor: color.bg, color: color.text, fontSize: 16,
    paddingHorizontal: space.lg, outlineStyle: "none",
  } as any,
  code: { fontFamily: font.mono, fontSize: 22, letterSpacing: 4, textAlign: "center" },
  error: { flexDirection: "row", gap: space.sm, alignItems: "flex-start", marginTop: space.lg, padding: space.md, borderRadius: radius.md, backgroundColor: tint(color.danger, 0.1), borderWidth: 1, borderColor: tint(color.danger, 0.35) },
});
