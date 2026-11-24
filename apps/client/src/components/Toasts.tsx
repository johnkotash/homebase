import { router } from "expo-router";
import React from "react";
import { Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { dismissToast, useSession, type Toast } from "../sync/session";
import { breakpoint, color, radius, space, tint } from "../theme";
import { Icon, IconBtn, T } from "./ui";

/**
 * In-app toasts. A stack in the top-right corner of a wide window and across the top of a phone, so
 * a toast never sits on the composer, the mode switch or the bottom tabs. Each one opens what it is
 * about when pressed, closes with its ✕, and goes away by itself after a few seconds.
 *
 * Which notifications become toasts at all is decided in `notifications/rules.ts`: never for the
 * session on screen, and not while the app is out of view (that is a system notification instead).
 */
function ToastCard({ toast }: { toast: Toast }) {
  const tone = toast.tone === "error" ? color.danger : color.accent;
  const open = () => {
    dismissToast(toast.id);
    if (toast.link) router.push(toast.link as any);
  };
  return (
    <View style={[st.toast, { borderColor: toast.tone === "error" ? tint(tone, 0.55) : color.borderStrong }]} accessibilityRole="alert" testID="toast">
      <Pressable onPress={open} accessibilityRole={toast.link ? "link" : "button"} accessibilityLabel={`${[toast.title, toast.body].filter(Boolean).map((t) => t!.replace(/[.\s]+$/, "")).join(". ")}. ${toast.link ? "Open" : "Dismiss"}`}
        style={({ hovered, pressed }: any) => [st.body, hovered && { backgroundColor: color.surface2 }, pressed && { opacity: 0.8 }]}>
        <View style={[st.bar, { backgroundColor: tone }]} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T v="heading" numberOfLines={1} style={{ fontSize: 14 }}>{toast.title}</T>
          {toast.body ? <T v="small" numberOfLines={2}>{toast.body}</T> : null}
        </View>
        {toast.link ? <Icon name="chevron-right" size={16} tone={color.textMuted} /> : null}
      </Pressable>
      <View style={st.divider} />
      <IconBtn icon="x" label="Dismiss notification" size={16} onPress={() => dismissToast(toast.id)} style={st.close} />
    </View>
  );
}

export function ToastHost() {
  const toasts = useSession((s) => s.toasts);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  if (!toasts.length) return null;
  const wide = width >= breakpoint.rail;
  return (
    <View pointerEvents="box-none" style={[st.wrap, wide ? st.wrapWide : [st.wrapNarrow, { top: insets.top + space.sm }]]} accessibilityLiveRegion="polite" testID="toasts">
      {/* Newest on top, nearest the corner. */}
      {[...toasts].reverse().map((t) => <ToastCard key={t.id} toast={t} />)}
    </View>
  );
}

const st = StyleSheet.create({
  wrap: { position: "absolute", gap: space.sm, zIndex: 50 },
  // A phone: across the top, under the status bar. A wide window: a column in the top-right corner.
  wrapNarrow: { left: 0, right: 0, alignItems: "center", paddingHorizontal: space.md },
  wrapWide: { top: space.md, right: space.md, width: 380, alignItems: "stretch" },
  toast: {
    width: "100%", maxWidth: 460, flexDirection: "row", alignItems: "stretch", backgroundColor: color.surface, borderRadius: radius.md, borderWidth: 1, overflow: "hidden",
    shadowColor: "#000", shadowOpacity: 0.6, shadowRadius: 20, shadowOffset: { width: 0, height: 8 }, elevation: 12,
  },
  body: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.md, paddingRight: space.sm },
  bar: { width: 3, alignSelf: "stretch", borderRadius: 2, marginLeft: space.sm },
  divider: { width: 1, backgroundColor: color.border },
  close: { width: 40, height: "auto", alignSelf: "stretch", borderRadius: 0 },
});
