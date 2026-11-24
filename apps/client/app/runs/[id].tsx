import { router, useLocalSearchParams } from "expo-router";
import React, { useMemo, useState } from "react";
import { ActivityIndicator, StyleSheet, TextInput, View } from "react-native";
import { EFFORT_LABEL, isLiveRun, modelLabel, offersModels } from "@homebase/protocol";
import { ApprovalCard } from "../../src/components/ApprovalCard";
import { RunStatusChip } from "../../src/components/bits";
import { AgentList, Placeholder } from "../../src/components/lists";
import { ModeTag } from "../../src/components/ModeSwitch";
import { MODE } from "../../src/modes";
import { RunTimeline } from "../../src/components/RunTimeline";
import { Btn, Card, IconBtn, SectionTitle, T } from "../../src/components/ui";
import { dayTime } from "../../src/format";
import { Header, Screen, Split } from "../../src/layout/Shell";
import { useList, useNow, useOne, useRunEvents, useRunStream, useSync } from "../../src/sync/hooks";
import { mutate } from "../../src/sync/session";
import { color, radius, space } from "../../src/theme";

const secs = (ms: number) => (ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);

function Fact({ label, value }: { label: string; value: string }) {
  return <View style={st.fact}><T v="micro">{label}</T><T v="heading" style={{ fontSize: 15 }} numberOfLines={1}>{value}</T></View>;
}

function Detail({ id }: { id: string }) {
  const run = useOne("runs", id);
  const agent = useSync((s) => (run ? s.entities.agents[run.agentId] : undefined));
  const approvals = useList("approvals");
  const now = useNow(1000);
  const live = !!run && isLiveRun(run.status);
  const { events, loading } = useRunEvents(id, run?.status);
  const stream = useRunStream(id, live);
  const [input, setInput] = useState("");
  const mine = useMemo(() => approvals.filter((a) => a.runId === id).sort((a, b) => a.requestedAt - b.requestedAt), [approvals, id]);
  if (!run) return <Placeholder icon="activity" title="Run not found" />;
  const elapsed = run.durationMs ?? (run.startedAt ? (run.endedAt ?? now) - run.startedAt : 0);

  const sendInput = () => {
    const text = input.trim();
    if (!text) return;
    void mutate("run.input", { runId: id, text });
    setInput("");
  };

  return (
    <Screen>
      <Header title="Run" subtitle={`${agent?.name ?? "Agent"} · started ${dayTime(run.startedAt ?? run.createdAt)}`} back="/agents"
        right={run.threadId ? <IconBtn icon="message-square" label="Open thread" onPress={() => router.navigate(`/chats/${run.threadId}` as any)} /> : null} />
      <Card style={{ gap: space.md, marginTop: space.sm }}>
        <View style={st.h}>
          <RunStatusChip status={run.status} />
          {run.mode ? <ModeTag mode={run.mode} /> : null}
          <View style={{ flex: 1 }} />
          {live || run.status === "offline" ? <Btn small kind="danger" icon="square" label="Cancel run" onPress={() => void mutate("run.cancel", { runId: id })} testID="cancel-run" /> : null}
        </View>
        <T v="heading" selectable>{run.prompt}</T>
        {run.summary ? <T selectable tone={color.textDim}>{run.summary}</T> : null}
        {run.error ? <T selectable tone={color.danger}>{run.error}</T> : null}
        <View style={st.facts}>
          <Fact label="Duration" value={elapsed ? secs(elapsed) : "—"} />
          <Fact label="Cost" value={run.costUsd != null ? `$${run.costUsd.toFixed(2)}` : "—"} />
          <Fact label="Turns" value={run.numTurns != null ? String(run.numTurns) : "—"} />
          <Fact label="Ended" value={run.endedAt ? dayTime(run.endedAt) : live ? "In flight" : "—"} />
          {run.mode ? <Fact label="Mode" value={MODE[run.mode].label} /> : null}
          {agent && offersModels(agent) ? <Fact label="Model" value={modelLabel(run.model ?? agent.configModel ?? null)} /> : null}
          {agent && offersModels(agent) ? <Fact label="Effort" value={run.effort ? EFFORT_LABEL[run.effort] : "Default"} /> : null}
        </View>
        {run.cwd ? <T v="mono" tone={color.textMuted} style={{ fontSize: 12 }}>{run.cwd}</T> : null}
      </Card>

      {mine.filter((a) => a.status === "pending").map((a) => <View key={a.id} style={{ marginTop: space.md }}><ApprovalCard approval={a} now={now} /></View>)}

      {live ? (
        <>
          <SectionTitle title="Send input" />
          <View style={st.inputRow}>
            <TextInput value={input} onChangeText={setInput} placeholder="A follow-up for the agent" placeholderTextColor={color.textMuted} style={st.input}
              onSubmitEditing={sendInput} accessibilityLabel="Input for the run" />
            <Btn label="Send" icon="arrow-up" kind="primary" onPress={sendInput} disabled={!input.trim()} />
          </View>
        </>
      ) : null}

      <SectionTitle title="Timeline" count={events.length} />
      {loading && events.length === 0 ? <ActivityIndicator color={color.accent} style={{ margin: space.xl }} /> : null}
      {!loading && events.length === 0 && !stream ? <T v="small" muted>{live ? "Waiting for the first event…" : "No events were recorded."}</T> : null}
      <RunTimeline events={events} streaming={live ? stream : undefined} />
    </Screen>
  );
}

export default function RunScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Split show="detail" list={<AgentList />} detail={<Detail id={id} key={id} />} />;
}

const st = StyleSheet.create({
  h: { flexDirection: "row", alignItems: "center", gap: space.sm },
  facts: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  fact: { flexGrow: 1, flexBasis: 110, backgroundColor: color.bg, borderRadius: radius.md, borderWidth: 1, borderColor: color.border, padding: space.md, gap: 4 },
  inputRow: { flexDirection: "row", gap: space.sm, alignItems: "center" },
  input: {
    flex: 1, height: 48, borderRadius: radius.md, borderWidth: 1, borderColor: color.borderStrong, backgroundColor: color.surface, color: color.text,
    fontSize: 15, paddingHorizontal: space.lg, outlineStyle: "none",
  } as any,
});
