import { router } from "expo-router";
import React, { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { isLiveRun } from "@homebase/protocol";
import { ApprovalCard } from "../../src/components/ApprovalCard";
import { AgentAvatar, RunStatusChip } from "../../src/components/bits";
import { InboxRow } from "../../src/components/lists";
import { ProjectStrip } from "../../src/components/projects";
import { QuickCapture } from "../../src/components/QuickCapture";
import { Card, Icon, Row, SectionTitle, T } from "../../src/components/ui";
import { ago } from "../../src/format";
import { Header, Screen, useLayout } from "../../src/layout/Shell";
import { features } from "../../src/platform";
import { byUrgency, isOpen, useList, useMap, useNow, usePendingApprovals, useSync } from "../../src/sync/hooks";
import { color, radius, space, tint } from "../../src/theme";

function Stat({ value, label, tone, icon, onPress }: { value: number; label: string; tone: string; icon: React.ComponentProps<typeof Icon>["name"]; onPress: () => void }) {
  const hot = value > 0;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${value} ${label}`}
      style={({ pressed, hovered }: any) => [st.stat, hot && { borderColor: tint(tone, 0.45), backgroundColor: tint(tone, 0.07) }, hovered && { opacity: 0.92 }, pressed && { opacity: 0.8 }]}>
      <View style={st.statHead}><Icon name={icon} size={15} tone={hot ? tone : color.textMuted} /><T v="micro" tone={hot ? tone : undefined} numberOfLines={1}>{label}</T></View>
      <T v="num" tone={hot ? color.text : color.textMuted} style={{ fontSize: 34, lineHeight: 38 }}>{value}</T>
    </Pressable>
  );
}

export default function Home() {
  const now = useNow();
  const { split } = useLayout();
  const approvals = usePendingApprovals();
  const items = useList("inbox_items");
  const runs = useList("runs");
  const agents = useMap("agents");
  const threads = useMap("threads");
  const ws = useSync((s) => Object.values(s.entities.workspace)[0]);
  const synced = useSync((s) => s.synced);

  const open = useMemo(() => items.filter(isOpen).sort(byUrgency), [items]);
  const atRisk = open.filter((i) => i.slaState === "warning" || i.slaState === "breached" || (i.slaDueAt != null && i.slaDueAt <= now));
  const riskIds = new Set(atRisk.map((i) => i.id));
  const urgent = open.filter((i) => (i.priority === "P0" || i.priority === "P1") && !riskIds.has(i.id));
  const p0 = open.filter((i) => i.priority === "P0").length;
  const live = runs.filter((r) => isLiveRun(r.status)).sort((a, b) => b.createdAt - a.createdAt);

  const date = new Date(now).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const needs = approvals.length + atRisk.length + p0;

  const queue = (
    <>
      <SectionTitle title="Pending approvals" count={approvals.length} tone={approvals.length ? color.p1 : undefined} action="All approvals" onAction={() => router.push("/approvals")} />
      {approvals.length === 0 ? (
        <Card pad={space.md}><View style={st.calm}><Icon name="check-circle" tone={color.ok} /><T v="small">No agent is waiting on you.</T></View></Card>
      ) : (
        <View style={{ gap: space.sm }}>{approvals.slice(0, 4).map((a) => <ApprovalCard key={a.id} approval={a} now={now} compact />)}</View>
      )}

      <SectionTitle title="SLA at risk" count={atRisk.length} tone={atRisk.length ? color.danger : undefined} action="Inbox" onAction={() => router.navigate("/inbox")} />
      <Card pad={4}>
        {atRisk.length === 0 ? <View style={[st.calm, { padding: space.md }]}><Icon name="clock" tone={color.ok} /><T v="small">Every open item is inside its response window.</T></View> : null}
        {atRisk.slice(0, 4).map((i) => <InboxRow key={i.id} item={i} now={now} compact />)}
      </Card>

      <SectionTitle title="P0 and P1" count={urgent.length} tone={urgent.length ? color.p1 : undefined} />
      <Card pad={4}>
        {urgent.length === 0 ? <View style={[st.calm, { padding: space.md }]}><Icon name="inbox" /><T v="small">Nothing else urgent today.</T></View> : null}
        {urgent.slice(0, 5).map((i) => <InboxRow key={i.id} item={i} now={now} compact />)}
      </Card>
    </>
  );

  const side = (
    <>
      <SectionTitle title="Running agents" count={live.length} tone={live.length ? color.accent : undefined} action="Agents" onAction={() => router.navigate("/agents")} />
      <Card pad={4}>
        {live.length === 0 ? <View style={[st.calm, { padding: space.md }]}><Icon name="cpu" /><T v="small">No runs in flight. Start one from Sessions or Agents.</T></View> : null}
        {live.map((r) => {
          const a = agents[r.agentId];
          return (
            <Row key={r.id} onPress={() => router.navigate((r.threadId ? `/chats/${r.threadId}` : `/runs/${r.id}`) as any)} style={{ paddingHorizontal: space.md }} accessibilityLabel={`Run by ${a?.name}`}>
              <View style={st.runRow}>
                <AgentAvatar name={a?.name ?? "Agent"} online={a?.status === "online"} size={36} />
                <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                  <T v="heading" style={{ fontSize: 14 }} numberOfLines={1}>{r.threadId ? threads[r.threadId]?.title ?? a?.name : a?.name}</T>
                  <T v="small" numberOfLines={1}>{r.prompt}</T>
                  <RunStatusChip status={r.status} />
                </View>
                <T v="small" muted style={{ fontSize: 12 }}>{ago(r.createdAt, now)}</T>
              </View>
            </Row>
          );
        })}
      </Card>

      <View style={{ height: space.xl }} />
      <QuickCapture />

      {/* Phone only: the desktop window and the browser have no driving mode (src/platform.ts). */}
      {features.drivingMode ? (
        <Pressable onPress={() => router.push("/drive")} accessibilityRole="button" accessibilityLabel="Start driving mode"
          style={({ pressed, hovered }: any) => [st.drive, hovered && { borderColor: color.accent }, pressed && { opacity: 0.8 }]}>
          <View style={st.driveIcon}><Icon name="navigation" size={20} tone={color.accentInk} /></View>
          <View style={{ flex: 1 }}>
            <T v="heading">Driving mode</T>
            <T v="small">Hands-free queue: approvals, then P0, then P1, read aloud.</T>
          </View>
          <Icon name="chevron-right" />
        </Pressable>
      ) : null}
    </>
  );

  return (
    <Screen maxWidth={split ? 1180 : 760}>
      <Header title="Today" subtitle={`${date}${ws ? ` · ${ws.name}` : ""}`} large />
      <View style={st.hero}>
        <T v="small" tone={needs ? color.text : color.textDim} style={{ fontSize: 15 }}>
          {!synced ? "Syncing your workspace…" : needs ? `${needs} thing${needs === 1 ? "" : "s"} need${needs === 1 ? "s" : ""} you right now.` : "You're clear. Nothing needs you right now."}
        </T>
      </View>
      <View style={st.stats}>
        <Stat value={approvals.length} label="Approvals" tone={color.p1} icon="shield" onPress={() => router.push("/approvals")} />
        <Stat value={atRisk.length} label="SLA at risk" tone={color.danger} icon="clock" onPress={() => router.navigate("/inbox")} />
        <Stat value={p0} label="P0 open" tone={color.p0} icon="alert-triangle" onPress={() => router.navigate("/inbox")} />
        <Stat value={live.length} label="Agents live" tone={color.accent} icon="zap" onPress={() => router.navigate("/agents")} />
      </View>
      <ProjectStrip />
      {split ? (
        <View style={{ flexDirection: "row", gap: space.xl }}>
          <View style={{ flex: 1.15, minWidth: 0 }}>{queue}</View>
          <View style={{ flex: 1, minWidth: 0 }}>{side}</View>
        </View>
      ) : (
        <>{queue}{side}</>
      )}
    </Screen>
  );
}

const st = StyleSheet.create({
  hero: { marginTop: -2, marginBottom: space.md },
  stats: { flexDirection: "row", gap: space.sm, flexWrap: "wrap" },
  stat: { flexGrow: 1, flexBasis: 140, minHeight: 92, borderRadius: radius.lg, borderWidth: 1, borderColor: color.border, backgroundColor: color.surface, padding: space.md, justifyContent: "space-between" },
  statHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  calm: { flexDirection: "row", alignItems: "center", gap: space.sm },
  runRow: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
  drive: {
    marginTop: space.lg, flexDirection: "row", alignItems: "center", gap: space.md, padding: space.lg, borderRadius: radius.lg, borderWidth: 1,
    borderColor: color.borderStrong, backgroundColor: color.surface2, minHeight: 76,
  },
  driveIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: color.accent, alignItems: "center", justifyContent: "center" },
});
