import { router } from "expo-router";
import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { USAGE_SETTING, USAGE_WINDOW_LABEL, UsageWindowKey, type UsageSnapshot, type UsageWindow } from "@homebase/protocol";
import { ago } from "../format";
import { useNow, useSetting } from "../sync/hooks";
import { color, radius, space, tint } from "../theme";
import { Icon, T } from "./ui";

/**
 * Claude plan usage (issue #4): the 5-hour and weekly windows from the last Claude run. The numbers come only from
 * what the CLI printed, so they are as of that run; a window whose reset time has passed shows as reset.
 */

export function usageTone(w: Pick<UsageWindow, "pct" | "status">): string {
  if (w.status === "rejected" || w.pct >= 95) return color.danger;
  if (w.pct >= 80) return color.p1;
  return color.ok;
}

export function resetLabel(at: number | null, now: number): string {
  if (at == null) return "";
  const d = new Date(at);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return sameDay ? time : `${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

/** What one window shows now: a window whose reset passed is "reset" until the next run reports. */
export function windowView(w: UsageWindow, now: number) {
  const reset = w.resetsAt != null && w.resetsAt <= now;
  return { reset, pct: reset ? 0 : Math.min(100, w.pct), tone: reset ? color.ok : usageTone(w) };
}

function Bar({ pct, tone }: { pct: number; tone: string }) {
  return (
    <View style={st.track}>
      <View style={[st.fill, { width: `${Math.max(pct, pct > 0 ? 2 : 0)}%`, backgroundColor: tone }]} />
    </View>
  );
}

/** The full meter: a card with both windows, reset times and "as of". */
export function UsageMeter() {
  const usage = useSetting<UsageSnapshot | null>(USAGE_SETTING, null);
  const now = useNow(30_000);
  return (
    <View style={st.card} accessibilityLabel="Claude usage">
      <View style={st.head}>
        <Icon name="activity" size={15} tone={color.textMuted} />
        <T v="micro" style={{ flex: 1 }}>Claude usage</T>
        {usage ? <T v="small" muted style={{ fontSize: 11 }}>as of {ago(usage.at, now) || "now"}</T> : null}
      </View>
      {!usage ? (
        <T v="small" muted>No reading yet. The meter fills in after the next Claude run.</T>
      ) : (
        <View style={{ gap: space.sm }}>
          {UsageWindowKey.options.map((key) => {
            const w = usage.windows[key];
            if (!w) return null;
            const v = windowView(w, now);
            return (
              <View key={key} style={{ gap: 4 }} accessibilityLabel={`${USAGE_WINDOW_LABEL[key]} window ${Math.round(v.pct)} percent`}>
                <View style={st.line}>
                  <T v="heading" style={{ fontSize: 13, width: 58 }}>{USAGE_WINDOW_LABEL[key]}</T>
                  <T v="num" tone={v.tone} style={{ fontSize: 15, width: 52 }}>{v.reset ? "—" : `${Math.round(v.pct)}%`}</T>
                  <T v="small" muted numberOfLines={1} style={{ flex: 1, textAlign: "right", fontSize: 12 }}>
                    {v.reset ? "reset; updates on the next run" : w.status === "rejected" ? `limit reached · resets ${resetLabel(w.resetsAt, now)}` : w.resetsAt ? `resets ${resetLabel(w.resetsAt, now)}` : ""}
                  </T>
                </View>
                <Bar pct={v.pct} tone={v.tone} />
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

/** A small two-line version for the desktop side rail; opens Home. */
export function UsageMini() {
  const usage = useSetting<UsageSnapshot | null>(USAGE_SETTING, null);
  const now = useNow(30_000);
  if (!usage) return null;
  return (
    <Pressable onPress={() => router.navigate("/")} accessibilityRole="button" accessibilityLabel="Claude usage"
      style={({ hovered }: any) => [st.mini, hovered && { backgroundColor: color.surface2 }]}>
      {UsageWindowKey.options.map((key) => {
        const w = usage.windows[key];
        if (!w) return null;
        const v = windowView(w, now);
        return (
          <View key={key} style={{ gap: 3 }}>
            <View style={st.line}>
              <T v="small" muted style={{ fontSize: 11, flex: 1 }}>{USAGE_WINDOW_LABEL[key]}</T>
              <T v="small" tone={v.tone} style={{ fontSize: 11 }}>{v.reset ? "reset" : `${Math.round(v.pct)}%`}</T>
            </View>
            <Bar pct={v.pct} tone={v.tone} />
          </View>
        );
      })}
    </Pressable>
  );
}

const st = StyleSheet.create({
  card: { marginTop: space.md, borderRadius: radius.lg, borderWidth: 1, borderColor: color.border, backgroundColor: color.surface, padding: space.md, gap: space.sm },
  head: { flexDirection: "row", alignItems: "center", gap: 6 },
  line: { flexDirection: "row", alignItems: "center", gap: space.sm },
  track: { height: 6, borderRadius: 3, backgroundColor: tint(color.ok, 0.12), overflow: "hidden" },
  fill: { height: 6, borderRadius: 3 },
  mini: { marginHorizontal: space.sm, marginBottom: space.sm, padding: space.sm, borderRadius: radius.md, gap: 6 },
});
