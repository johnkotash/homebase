import { Tabs, router } from "expo-router";
import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, T } from "../../src/components/ui";
import { TABS, useBadges, useLayout } from "../../src/layout/Shell";
import { color, space } from "../../src/theme";

function TabBar({ state }: { state: { index: number; routes: Array<{ key: string; name: string }> } }) {
  const insets = useSafeAreaInsets();
  const badges = useBadges();
  return (
    <View style={[st.bar, { paddingBottom: Math.max(insets.bottom, 8) }]} accessibilityRole="tablist">
      {state.routes.map((route, i) => {
        const tab = TABS.find((t) => t.key === route.name);
        if (!tab) return null;
        const focused = state.index === i;
        // Home: approvals waiting. Inbox: open P0/P1 items. Sessions: sessions with unread agent output.
        const badge = tab.key === "inbox" ? badges.inbox : tab.key === "index" ? badges.approvals : tab.key === "chats" ? badges.sessions : 0;
        return (
          <Pressable
            key={route.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: focused }}
            accessibilityLabel={tab.key === "chats" && badge ? `${tab.label}, ${badge} unread` : tab.label}
            onPress={() => { if (!focused) router.navigate(tab.href as any); }}
            style={st.tab}
          >
            <View style={[st.pill, focused && { backgroundColor: color.accentDim }]}>
              <Icon name={tab.icon} size={21} tone={focused ? color.accent : color.textMuted} />
              {badge ? <View style={[st.badge, { backgroundColor: tab.key === "index" ? color.p0 : tab.key === "chats" ? color.accent : color.p1 }]}><T style={st.badgeText}>{badge > 9 ? "9+" : badge}</T></View> : null}
            </View>
            <T v="small" numberOfLines={1} tone={focused ? color.text : color.textMuted} style={st.label}>{tab.label}</T>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Bottom tabs under 900 px. At 900 px and above the root layout shows a left rail instead. */
export default function TabsLayout() {
  const { wide } = useLayout();
  return (
    <Tabs
      screenOptions={{ headerShown: false, title: "HomeBase", sceneStyle: { backgroundColor: color.bg } }}
      tabBar={(props: any) => (wide ? null : <TabBar {...props} />)}
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="inbox" />
      <Tabs.Screen name="chats" />
      <Tabs.Screen name="projects" />
      <Tabs.Screen name="agents" />
      <Tabs.Screen name="notes" />
    </Tabs>
  );
}

const st = StyleSheet.create({
  bar: { flexDirection: "row", backgroundColor: color.surface, borderTopWidth: 1, borderTopColor: color.border, paddingTop: 8, paddingHorizontal: space.xs },
  tab: { flex: 1, alignItems: "center", gap: 3, minHeight: 52, justifyContent: "center" },
  // Six tabs: the pill and label are sized so they still fit a 360 dp wide phone.
  pill: { width: 50, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  label: { fontSize: 10.5, fontFamily: "SpaceGrotesk_500Medium" },
  badge: { position: "absolute", top: -2, right: 6, minWidth: 17, height: 17, borderRadius: 9, alignItems: "center", justifyContent: "center", paddingHorizontal: 4, borderWidth: 2, borderColor: color.surface },
  badgeText: { color: "#12060A", fontSize: 9, lineHeight: 12, fontWeight: "800" },
});
