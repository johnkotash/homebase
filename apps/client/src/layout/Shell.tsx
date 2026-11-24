import { router, usePathname } from "expo-router";
import React, { useMemo } from "react";
import { unreadCount } from "@homebase/protocol";
import { Pressable, ScrollView, StyleSheet, View, useWindowDimensions, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, IconBtn, T, type IconName } from "../components/ui";
import { features } from "../platform";
import { isOpen, useList, useMap, usePendingApprovals, useSync } from "../sync/hooks";
import { breakpoint, color, radius, space, tint } from "../theme";

export function useLayout() {
  const { width, height } = useWindowDimensions();
  return { width, height, wide: width >= breakpoint.rail, split: width >= breakpoint.split };
}

export const TABS: Array<{ key: string; href: string; label: string; icon: IconName; match: RegExp }> = [
  { key: "index", href: "/", label: "Home", icon: "home", match: /^\/$/ },
  { key: "inbox", href: "/inbox", label: "Inbox", icon: "inbox", match: /^\/inbox/ },
  { key: "chats", href: "/chats", label: "Sessions", icon: "message-square", match: /^\/chats/ },
  { key: "projects", href: "/projects", label: "Projects", icon: "folder", match: /^\/projects/ },
  { key: "agents", href: "/agents", label: "Agents", icon: "cpu", match: /^\/(agents|runs)/ },
  { key: "notes", href: "/notes", label: "Notes", icon: "file-text", match: /^\/notes/ },
];

export function useBadges() {
  const approvals = usePendingApprovals().length;
  const inbox = useList("inbox_items").filter((i) => isOpen(i) && (i.priority === "P0" || i.priority === "P1")).length;
  // Sessions where an agent said something the owner has not had on screen yet. Read state comes from the hub, so every device agrees.
  const threads = useMap("threads");
  const sessions = useMemo(() => unreadCount(Object.values(threads)), [threads]);
  return { approvals, inbox, sessions };
}

/** Left rail for widths of 900 px and above. Same destinations as the bottom tabs. */
export function Rail() {
  const path = usePathname();
  const badges = useBadges();
  const ws = useSync((s) => Object.values(s.entities.workspace)[0]);
  const status = useSync((s) => s.status);
  const item = (key: string, href: string, label: string, icon: IconName, active: boolean, badge?: number, badgeTone: string = color.p0) => (
    <Pressable
      key={key}
      accessibilityRole="link"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      onPress={() => router.navigate(href as any)}
      style={({ hovered }: any) => [st.railItem, active && st.railActive, hovered && !active && { backgroundColor: color.surface2 }]}
    >
      <Icon name={icon} size={19} tone={active ? color.accent : color.textDim} />
      <T v="heading" style={{ fontSize: 14, flex: 1 }} tone={active ? color.text : color.textDim}>{label}</T>
      {badge ? <View style={[st.railBadge, { backgroundColor: tint(badgeTone, 0.18) }]}><T v="small" tone={badgeTone} style={st.railBadgeText}>{badge}</T></View> : null}
    </Pressable>
  );
  return (
    <View style={st.rail}>
      <View style={st.brand}>
        <View style={st.mark}><View style={st.markDot} /></View>
        <View>
          <T v="heading" style={{ fontSize: 17 }}>HomeBase</T>
          <T v="small" muted numberOfLines={1} style={{ fontSize: 11 }}>{ws?.name ?? "Workspace"}</T>
        </View>
      </View>
      <View style={{ gap: 2 }}>
        {TABS.map((t) => item(t.key, t.href, t.label, t.icon, t.match.test(path),
          t.key === "inbox" ? badges.inbox : t.key === "chats" ? badges.sessions : undefined,
          // Amber is for urgency (P0/P1 in the inbox). Unread sessions are information: white, like the rest of the chrome.
          t.key === "chats" ? color.accent : color.p1))}
      </View>
      <T v="micro" style={{ marginTop: space.xl, marginBottom: space.sm, paddingHorizontal: space.md }}>Queue</T>
      <View style={{ gap: 2 }}>
        {item("approvals", "/approvals", "Approvals", "shield", /^\/approvals/.test(path), badges.approvals)}
        {features.drivingMode ? item("drive", "/drive", "Driving mode", "navigation", /^\/drive/.test(path)) : null}
      </View>
      <View style={{ flex: 1 }} />
      {item("settings", "/settings", "Settings", "settings", /^\/settings/.test(path))}
      <View style={st.railFoot}>
        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: status === "online" ? color.ok : status === "offline" ? color.danger : color.warn }} />
        <T v="small" muted style={{ fontSize: 11 }}>{status === "online" ? "Synced live" : status === "offline" ? "Offline" : "Connecting"}</T>
      </View>
    </View>
  );
}

/** Page header. Tab roots show a large title; detail routes show a back button on narrow layouts. */
export function Header({ title, subtitle, back, right, large }: { title: string; subtitle?: string; back?: string | boolean; right?: React.ReactNode; large?: boolean }) {
  const { wide } = useLayout();
  const badges = useBadges();
  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace((typeof back === "string" ? back : "/") as any);
  };
  return (
    <View style={[st.header, large && { paddingTop: space.md }]}>
      {back ? <IconBtn icon="arrow-left" label="Back" onPress={goBack} tone={color.text} style={{ marginLeft: -10 }} /> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <T v={large ? "display" : "title"} numberOfLines={1} accessibilityRole="header">{title}</T>
        {subtitle ? <T v="small" muted numberOfLines={1}>{subtitle}</T> : null}
      </View>
      {right}
      {!wide && large ? (
        <>
          <IconBtn icon="shield" label={`Approvals, ${badges.approvals} pending`} badge={badges.approvals} onPress={() => router.push("/approvals")} />
          <IconBtn icon="settings" label="Settings" onPress={() => router.push("/settings")} />
        </>
      ) : null}
    </View>
  );
}

export function Screen({ children, scroll = true, style, contentStyle, pad = true, maxWidth = 860 }: {
  children: React.ReactNode; scroll?: boolean; style?: StyleProp<ViewStyle>; contentStyle?: StyleProp<ViewStyle>; pad?: boolean; maxWidth?: number;
}) {
  const inner = [{ width: "100%" as const, maxWidth, alignSelf: "center" as const }, pad && { paddingHorizontal: space.lg }, contentStyle];
  if (!scroll) return <View style={[st.screen, style]}><View style={[inner, { flex: 1 }]}>{children}</View></View>;
  return (
    <ScrollView style={[st.screen, style]} contentContainerStyle={[inner, { paddingBottom: space.xxl + 8 }]} keyboardShouldPersistTaps="handled">
      {children}
    </ScrollView>
  );
}

/**
 * Master-detail: list left, detail right at 1100 px and above. Below that only `show` is rendered,
 * so the same route files serve phones and desktops.
 */
export function Split({ list, detail, show }: { list: React.ReactNode; detail: React.ReactNode; show: "list" | "detail" }) {
  const { split } = useLayout();
  if (!split) return <View style={st.screen}>{show === "list" ? list : detail}</View>;
  return (
    <View style={[st.screen, { flexDirection: "row" }]}>
      <View style={st.master}>{list}</View>
      <View style={{ flex: 1, minWidth: 0 }}>{detail}</View>
    </View>
  );
}

export function TopInset() {
  const insets = useSafeAreaInsets();
  return <View style={{ height: insets.top, backgroundColor: color.bg }} />;
}

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg },
  header: { flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: 60, paddingVertical: space.sm },
  rail: { width: 236, backgroundColor: color.surface, borderRightWidth: 1, borderRightColor: color.border, padding: space.md, paddingTop: space.lg },
  brand: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.sm, marginBottom: space.xl },
  mark: {
    width: 34, height: 34, borderRadius: 9, borderWidth: 3, borderColor: color.accent, alignItems: "center", justifyContent: "center",
    transform: [{ rotate: "45deg" }],
  },
  markDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: color.accent },
  railItem: { flexDirection: "row", alignItems: "center", gap: space.md, height: 44, paddingHorizontal: space.md, borderRadius: radius.md },
  railActive: { backgroundColor: color.surface3 },
  railBadge: { minWidth: 22, height: 20, borderRadius: 10, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 },
  railBadgeText: { fontSize: 11, fontFamily: "SpaceGrotesk_600SemiBold" },
  railFoot: { flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: space.md, paddingTop: space.md },
  master: { width: 400, borderRightWidth: 1, borderRightColor: color.border },
});
