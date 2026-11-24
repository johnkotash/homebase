import { router } from "expo-router";
import React, { useMemo, useState } from "react";
import { FlatList, ScrollView, StyleSheet, View } from "react-native";
import { isLiveRun, type Agent, type Approval, type InboxItem, type Run } from "@homebase/protocol";
import { ago, senderName } from "../format";
import { Header } from "../layout/Shell";
import { byUrgency, isOpen, useList, useMap, useNow, useSync } from "../sync/hooks";
import { color, priorityColor, radius, space } from "../theme";
import { AgentAvatar, PriorityChip, RiskBadge, RunStatusChip, SlaCountdown, SourceIcon } from "./bits";
import { Chip, Empty, Icon, Row, T, Tag } from "./ui";

const pane = { flex: 1, backgroundColor: color.bg } as const;
const padH = { paddingHorizontal: space.lg } as const;

// ---------------------------------------------------------------- inbox
type InboxFilter = "All" | "P0" | "P1" | "P2" | "P3" | "Snoozed" | "Done";
const FILTERS: InboxFilter[] = ["All", "P0", "P1", "P2", "P3", "Snoozed", "Done"];

export function InboxRow({ item, now, selected, compact }: { item: InboxItem; now: number; selected?: boolean; compact?: boolean }) {
  const closed = item.status === "done" || item.status === "responded";
  return (
    <Row selected={selected} onPress={() => router.navigate(`/inbox/${item.id}` as any)} accessibilityLabel={`${item.priority} ${item.title}`} style={compact ? { paddingHorizontal: space.md } : undefined}>
      <View style={st.rowH}>
        <SourceIcon source={item.source} />
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <T v="heading" numberOfLines={2} style={[{ fontSize: 15 }, closed && { color: color.textDim }]}>{item.title}</T>
          <T v="small" numberOfLines={1}>
            {[senderName(item.sender), item.clientLabel].filter(Boolean).join(" · ")}
          </T>
          <View style={[st.rowH, { gap: 6, marginTop: 3 }]}>
            <PriorityChip priority={item.priority} />
            <SlaCountdown item={item} now={now} />
            {item.status === "snoozed" ? <Tag label="SNOOZED" icon="moon" /> : null}
            {item.status === "in_progress" ? <Tag label="IN PROGRESS" tone={color.p2} /> : null}
            {item.linkedThreadId ? <Tag label="WITH AGENT" tone={color.accent} icon="cpu" /> : null}
          </View>
        </View>
        <T v="small" muted style={{ fontSize: 12 }}>{ago(item.receivedAt, now)}</T>
      </View>
    </Row>
  );
}

export function InboxList({ selectedId }: { selectedId?: string }) {
  const items = useList("inbox_items");
  const now = useNow();
  const [filter, setFilter] = useState<InboxFilter>("All");
  const counts = useMemo(() => {
    const c: Record<InboxFilter, number> = { All: 0, P0: 0, P1: 0, P2: 0, P3: 0, Snoozed: 0, Done: 0 };
    for (const i of items) {
      if (i.status === "snoozed") c.Snoozed++;
      else if (!isOpen(i)) c.Done++;
      else {
        c.All++;
        c[i.priority]++;
      }
    }
    return c;
  }, [items]);
  const shown = useMemo(() => {
    const f = items.filter((i) =>
      filter === "Snoozed" ? i.status === "snoozed" : filter === "Done" ? i.status === "done" || i.status === "responded"
      : isOpen(i) && (filter === "All" || i.priority === filter));
    return filter === "Done" ? f.sort((a, b) => b.updatedAt - a.updatedAt) : f.sort(byUrgency);
  }, [items, filter]);
  return (
    <View style={pane}>
      <View style={padH}><Header title="Inbox" subtitle={`${counts.All} open · sorted by priority, then deadline`} large /></View>
      <View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.chips}>
          {FILTERS.map((f) => (
            <Chip key={f} label={f} count={counts[f]} selected={filter === f} onPress={() => setFilter(f)}
              tone={f in priorityColor ? priorityColor[f as keyof typeof priorityColor] : undefined} />
          ))}
        </ScrollView>
      </View>
      <FlatList
        data={shown}
        keyExtractor={(i) => i.id}
        renderItem={({ item }) => <InboxRow item={item} now={now} selected={item.id === selectedId} />}
        contentContainerStyle={{ paddingHorizontal: space.sm, paddingBottom: space.xxl, flexGrow: 1 }}
        ListEmptyComponent={<Empty icon="inbox" title={filter === "All" ? "Inbox zero" : `Nothing in ${filter}`} body="New items arrive here live, already triaged and on an SLA clock." />}
      />
    </View>
  );
}

// The session list (what used to be the thread list here) is in ./sessions.tsx.

// ---------------------------------------------------------------- agents
export function RunRow({ run, now, agentName, selected }: { run: Run; now: number; agentName?: string; selected?: boolean }) {
  return (
    <Row selected={selected} onPress={() => router.navigate(`/runs/${run.id}` as any)} style={{ minHeight: 56 }} accessibilityLabel={`Run ${run.prompt}`}>
      <View style={[st.rowH, { alignItems: "center" }]}>
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <T numberOfLines={1} style={{ fontSize: 14 }}>{run.prompt}</T>
          <View style={[st.rowH, { gap: 6 }]}>
            <RunStatusChip status={run.status} />
            {agentName ? <T v="small" muted style={{ fontSize: 12 }}>{agentName}</T> : null}
          </View>
        </View>
        <T v="small" muted style={{ fontSize: 12 }}>{ago(run.createdAt, now)}</T>
      </View>
    </Row>
  );
}

export function AgentList({ selectedId }: { selectedId?: string }) {
  const agents = useList("agents");
  const connectors = useMap("connectors");
  const runs = useList("runs");
  const now = useNow();
  const groups = useMemo(() => {
    const m = new Map<string, Agent[]>();
    for (const a of agents) {
      const k = a.connectorId ?? "";
      m.set(k, [...(m.get(k) ?? []), a]);
    }
    return [...m.entries()].map(([id, list]) => ({ id, connector: connectors[id], list: list.sort((a, b) => a.name.localeCompare(b.name)) }));
  }, [agents, connectors]);
  const recent = useMemo(() => [...runs].sort((a, b) => b.createdAt - a.createdAt).slice(0, 12), [runs]);
  const agentById = useMap("agents");
  return (
    <ScrollView style={pane} contentContainerStyle={{ paddingBottom: space.xxl }}>
      <View style={padH}><Header title="Agents" subtitle={`${agents.filter((a) => a.status === "online").length} of ${agents.length} online`} large /></View>
      {groups.length === 0 ? <Empty icon="cpu" title="No agents yet" body="Start a connector (npm run dev:connector) and its agents appear here." /> : null}
      {groups.map((g) => (
        <View key={g.id} style={{ marginBottom: space.md }}>
          <View style={[st.groupHead, padH]}>
            <Icon name="server" size={14} tone={g.connector?.status === "online" ? color.ok : color.textMuted} />
            <T v="micro" tone={color.textDim}>{g.connector?.name ?? "Waiting for a connector"}</T>
            <Tag label={g.connector?.status === "online" ? "ONLINE" : "OFFLINE"} tone={g.connector?.status === "online" ? color.ok : color.textMuted} />
          </View>
          <View style={{ paddingHorizontal: space.sm }}>
            {g.list.map((a) => {
              const live = runs.filter((r) => r.agentId === a.id && isLiveRun(r.status)).length;
              return (
                <Row key={a.id} selected={a.id === selectedId} onPress={() => router.navigate(`/agents/${a.id}` as any)} accessibilityLabel={`Agent ${a.name}`}>
                  <View style={st.rowH}>
                    <AgentAvatar name={a.name} online={a.status === "online"} />
                    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                      <T v="heading" style={{ fontSize: 15 }}>{a.name}</T>
                      <T v="small" numberOfLines={2}>{a.description}</T>
                      {a.statusNote ? <T v="small" tone={color.warn} accessibilityLabel={`Agent status: ${a.statusNote}`}>{a.statusNote}</T> : null}
                    </View>
                    {live ? <Tag label={`${live} LIVE`} tone={color.accent} icon="zap" /> : <Icon name="chevron-right" tone={color.textMuted} />}
                  </View>
                </Row>
              );
            })}
          </View>
        </View>
      ))}
      <View style={[st.groupHead, padH, { marginTop: space.md }]}><T v="micro">Recent runs</T></View>
      <View style={{ paddingHorizontal: space.sm }}>
        {recent.length === 0 ? <T v="small" muted style={{ padding: space.md }}>No runs yet.</T> : null}
        {recent.map((r) => <RunRow key={r.id} run={r} now={now} agentName={agentById[r.agentId]?.name} />)}
      </View>
    </ScrollView>
  );
}

// ---------------------------------------------------------------- approvals
export function ApprovalRow({ a, now, selected }: { a: Approval; now: number; selected?: boolean }) {
  const agent = useSync((s) => (a.agentId ? s.entities.agents[a.agentId] : undefined));
  const pending = a.status === "pending";
  const tone = a.status === "approved" ? color.ok : a.status === "denied" ? color.danger : color.textMuted;
  return (
    <Row selected={selected} onPress={() => router.navigate(`/approvals/${a.id}` as any)} accessibilityLabel={`Approval ${a.title}, ${a.status}`}>
      <View style={st.rowH}>
        <View style={[st.scratch, pending && { backgroundColor: "rgba(255,178,36,0.12)" }]}>
          <Icon name={a.kind === "question" ? "help-circle" : a.kind === "plan" ? "map" : "shield"} size={18} tone={pending ? color.p1 : color.textMuted} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <T v="heading" numberOfLines={1} style={{ fontSize: 15 }}>{a.title}</T>
          <T v="small" numberOfLines={1}>{agent?.name ?? "Agent"}{a.summary ? ` · ${a.summary}` : ""}</T>
          <View style={[st.rowH, { gap: 6, marginTop: 3 }]}>
            <RiskBadge risk={a.risk} />
            {pending ? null : <Tag label={a.status.toUpperCase()} tone={tone} />}
          </View>
        </View>
        <T v="small" muted style={{ fontSize: 12 }}>{ago(a.decidedAt ?? a.requestedAt, now)}</T>
      </View>
    </Row>
  );
}

export function ApprovalsList({ selectedId }: { selectedId?: string }) {
  const approvals = useList("approvals");
  const now = useNow();
  const pending = approvals.filter((a) => a.status === "pending").sort((a, b) => a.requestedAt - b.requestedAt);
  const history = approvals.filter((a) => a.status !== "pending").sort((a, b) => (b.decidedAt ?? b.requestedAt) - (a.decidedAt ?? a.requestedAt));
  return (
    <ScrollView style={pane} contentContainerStyle={{ paddingBottom: space.xxl, flexGrow: 1 }}>
      <View style={padH}><Header title="Approvals" subtitle="Agents wait here until you decide" back="/" /></View>
      <View style={[st.groupHead, padH]}><T v="micro" tone={pending.length ? color.p1 : undefined}>Pending</T><T v="micro" tone={color.textDim}>{pending.length}</T></View>
      <View style={{ paddingHorizontal: space.sm }}>
        {pending.length === 0 ? <T v="small" muted style={{ padding: space.md }}>Nothing is waiting on you.</T> : null}
        {pending.map((a) => <ApprovalRow key={a.id} a={a} now={now} selected={a.id === selectedId} />)}
      </View>
      <View style={[st.groupHead, padH, { marginTop: space.lg }]}><T v="micro">History</T><T v="micro" tone={color.textDim}>{history.length}</T></View>
      <View style={{ paddingHorizontal: space.sm }}>
        {history.map((a) => <ApprovalRow key={a.id} a={a} now={now} selected={a.id === selectedId} />)}
      </View>
    </ScrollView>
  );
}

export function Placeholder({ icon, title, body }: { icon: React.ComponentProps<typeof Empty>["icon"]; title: string; body?: string }) {
  return <View style={[pane, { justifyContent: "center" }]}><Empty icon={icon} title={title} body={body} /></View>;
}

const st = StyleSheet.create({
  rowH: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
  chips: { paddingHorizontal: space.lg, gap: space.sm, paddingBottom: space.md, paddingTop: 2 },
  scratch: { width: 40, height: 40, borderRadius: 13, backgroundColor: color.surface2, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: color.border },
  groupHead: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.sm },
  search: {
    flexDirection: "row", alignItems: "center", gap: space.sm, backgroundColor: color.surface, borderRadius: radius.md, borderWidth: 1, borderColor: color.border,
    paddingHorizontal: space.md, height: 46,
  },
  searchInput: { flex: 1, color: color.text, fontSize: 15, height: 44, outlineStyle: "none" } as any,
});
