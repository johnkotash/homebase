import { SpaceGrotesk_500Medium, SpaceGrotesk_600SemiBold, SpaceGrotesk_700Bold, useFonts } from "@expo-google-fonts/space-grotesk";
import { Stack, router, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import React, { useEffect } from "react";
import { ActivityIndicator, AppState, Platform, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ConnectionBanner } from "../src/components/bits";
import { ToastHost } from "../src/components/Toasts";
import { Rail, TopInset, useLayout } from "../src/layout/Shell";
import { dismissNotification, presentNotification, setupNotifications } from "../src/notifications";
import { Attention } from "../src/notifications/Attention";
import { followHubAddress, initSession, onNotify, reconnectNow, syncStore, useSession } from "../src/sync/session";
import { DesktopConnectionSetup } from "../src/components/DesktopConnection";
import { initDesktopConnection, useDesktopConnection } from "../src/desktop/connection";
import { color } from "../src/theme";

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({ SpaceGrotesk_500Medium, SpaceGrotesk_600SemiBold, SpaceGrotesk_700Bold });
  const { ready, session } = useSession();
  const segments = useSegments();
  const { wide } = useLayout();
  const first = segments[0] as string | undefined;
  const onPair = first === "pair";
  // Desktop app only: how this PC reaches the hub. Open with or without a pairing.
  const onConnection = first === "connection";
  // The installed desktop app asks how to reach the hub before anything else (first run).
  const needsConnection = useDesktopConnection((s) => !!s.snap && !s.snap.configured);
  // The full-screen browser is a browser of its own: no rail, no connection banner (it shows the connection itself).
  const immersive = onPair || first === "drive" || first === "browser";

  useEffect(() => {
    void initSession();
    // Installed desktop app: the shell's tunnel (or direct address) says where the hub is; the pairing follows it.
    const offConn = initDesktopConnection((url) => void followHubAddress(url));
    void setupNotifications();
    // Hub notify frames: nothing, an in-app toast or a system notification, by what is on screen (notifications/rules.ts).
    const off = onNotify((n) => void presentNotification(n));
    // A handled approval disappears from the notification shade on every device.
    let prev = syncStore.getState().entities.approvals;
    const unsub = syncStore.subscribe((s) => {
      if (s.entities.approvals === prev) return;
      for (const a of Object.values(s.entities.approvals)) if (a.status !== "pending" && prev[a.id]?.status === "pending") dismissNotification(a.id);
      prev = s.entities.approvals;
    });
    const app = AppState.addEventListener("change", (st) => st === "active" && reconnectNow());
    if (Platform.OS === "web") {
      document.title = "HomeBase";
      // Dark scrollbars and form controls to match the theme.
      const style = document.createElement("style");
      style.textContent = ":root{color-scheme:dark}*{scrollbar-width:thin;scrollbar-color:#3A3A3A transparent}body{background:#000000}";
      document.head.appendChild(style);
    }
    return () => {
      offConn();
      off();
      unsub();
      app.remove();
    };
  }, []);

  // Pairing gate: nothing but /pair until this device holds a token.
  useEffect(() => {
    if (!ready) return;
    if (!session && !onPair && !onConnection) router.replace("/pair");
    else if (session && onPair) router.replace("/");
  }, [ready, session, onPair, onConnection]);

  if (!ready || (!fontsLoaded && !fontError)) {
    return <View style={{ flex: 1, backgroundColor: color.bg, alignItems: "center", justifyContent: "center" }}><ActivityIndicator color={color.accent} /></View>;
  }

  if (needsConnection) {
    return (
      <SafeAreaProvider>
        <DesktopConnectionSetup />
        <StatusBar style="light" />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <View style={{ flex: 1, backgroundColor: color.bg, flexDirection: "row" }}>
        {wide && session && !immersive ? <Rail /> : null}
        <View style={{ flex: 1, minWidth: 0 }}>
          <TopInset />
          {immersive ? null : <ConnectionBanner />}
          <Stack screenOptions={{ headerShown: false, title: "HomeBase", contentStyle: { backgroundColor: color.bg }, animation: wide ? "none" : "slide_from_right" }} />
        </View>
      </View>
      {session ? <Attention /> : null}
      <ToastHost />
      <StatusBar style="light" />
    </SafeAreaProvider>
  );
}
