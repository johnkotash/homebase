import { router, useLocalSearchParams } from "expo-router";
import React, { useState } from "react";
import { StyleSheet, View } from "react-native";
import { newId, type Priority } from "@homebase/protocol";
import { AgentAvatar, PriorityChip, SlaCountdown, SourceIcon } from "../../src/components/bits";
import { InboxList, Placeholder } from "../../src/components/lists";
import { Btn, Card, Chip, Divider, Icon, Row, SectionTitle, T, Tag } from "../../src/components/ui";
import { SOURCE, dayTime } from "../../src/format";
import { commsAgent, draftReplyPrompt, gmailRef, isInjectionFlag } from "../../src/gmail";
import { Header, Screen, Split } from "../../src/layout/Shell";
import { useList, useNow, useOne, useSync } from "../../src/sync/hooks";
import { mutate, showToast } from "../../src/sync/session";
import { color, priorityColor, radius, space } from "../../src/theme";

const PRIORITIES: Priority[] = ["P0", "P1", "P2", "P3"];

function tomorrowAt9(now: number) {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

function Detail({ id }: { id: string }) {
  const item = useOne("inbox_items", id);
  const now = useNow();
  const agents = useList("agents", (a, b) => a.name.localeCompare(b.name));
  const policy = useSync((s) => (item?.slaPolicyId ? s.entities.sla_policies[item.slaPolicyId] : undefined));
  const linked = useSync((s) => (item?.linkedThreadId ? s.entities.threads[item.linkedThreadId] : undefined));
  const [handing, setHanding] = useState(false);
  if (!item) return <Placeholder icon="inbox" title="Item not found" body="It may have been removed on another device." />;
  const closed = item.status === "responded" || item.status === "done";
  const mail = gmailRef(item);
  const flag = isInjectionFlag(item);
  const comms = commsAgent(agents);
  const draftReply = () => {
    if (!mail || !comms) return;
    const threadId = newId("thr");
    void mutate("thread.create", { threadId, title: `Reply: ${item.title}`.slice(0, 120), agentId: comms.id });
    void mutate("message.send", { threadId, messageId: newId("msg"), text: draftReplyPrompt(item, mail), source: "text" });
    void mutate("inbox.update", { itemId: item.id, status: "in_progress", assignedAgentId: comms.id, linkedThreadId: threadId });
    showToast(`${comms.name} is drafting a reply`, item.title, "ok");
    router.navigate(`/chats/${threadId}` as any);
  };
  const update = (patch: Parameters<typeof mutate<"inbox.update">>[1]) => void mutate("inbox.update", patch);

  const handTo = (agentId: string, agentName: string) => {
    const threadId = newId("thr");
    const prompt = [`Handle this ${SOURCE[item.source].label} item.`, `Title: ${item.title}`, item.sender ? `From: ${item.sender}` : "", item.clientLabel ? `Client: ${item.clientLabel}` : "", "", item.body ?? item.snippet ?? ""]
      .filter((l, i) => l !== "" || i === 4).join("\n").trim();
    void mutate("thread.create", { threadId, title: item.title.slice(0, 120), agentId });
    void mutate("message.send", { threadId, messageId: newId("msg"), text: prompt, source: "text" });
    void mutate("inbox.update", { itemId: item.id, status: "in_progress", assignedAgentId: agentId, linkedThreadId: threadId });
    showToast(`Handed to ${agentName}`, item.title, "ok");
    setHanding(false);
    router.navigate(`/chats/${threadId}` as any);
  };

  return (
    <Screen>
      <Header title={SOURCE[item.source].label} subtitle={`Received ${dayTime(item.receivedAt)}`} back="/inbox" />
      <View style={st.top}>
        <SourceIcon source={item.source} size={44} />
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <T v="title" selectable>{item.title}</T>
          <T v="small" selectable>{[item.sender, item.clientLabel].filter(Boolean).join(" · ")}</T>
        </View>
      </View>
      <View style={st.tags}>
        <PriorityChip priority={item.priority} solid />
        <SlaCountdown item={item} now={now} long />
        <Tag label={item.status.replace("_", " ").toUpperCase()} tone={closed ? color.ok : color.textDim} />
      </View>

      <Card style={{ marginTop: space.lg, gap: space.sm }}>
        <View style={st.h}><Icon name="filter" size={14} /><T v="micro">Why this priority</T></View>
        <T>{item.triageReason ?? "No triage reason recorded."}</T>
        {item.slaDueAt ? (
          <>
            <Divider style={{ marginVertical: space.xs }} />
            <View style={st.h}><Icon name="clock" size={14} /><T v="micro">Response deadline</T></View>
            <T>{dayTime(item.slaDueAt)}{policy ? `  ·  ${policy.name}` : ""}</T>
            {item.respondedAt ? <T v="small" tone={color.ok}>Responded {dayTime(item.respondedAt)}. The clock is stopped.</T> : item.status === "snoozed" ? <T v="small">Snoozed until {dayTime(item.snoozeUntil ?? now)}. The SLA clock keeps running.</T> : null}
          </>
        ) : null}
      </Card>

      <View style={st.actions}>
        {closed ? (
          <Btn label="Reopen" icon="rotate-ccw" onPress={() => update({ itemId: item.id, status: "triaged" })} grow />
        ) : (
          <>
            <Btn label="Mark responded" kind="primary" icon="corner-up-left" onPress={() => update({ itemId: item.id, status: "responded" })} grow testID="mark-responded" />
            <Btn label="Done" kind="ok" icon="check" onPress={() => update({ itemId: item.id, status: "done" })} grow />
          </>
        )}
      </View>
      {closed ? null : (
        <View style={st.actions}>
          <Btn label="Snooze 1 h" icon="moon" small onPress={() => update({ itemId: item.id, status: "snoozed", snoozeUntil: now + 3_600_000 })} grow />
          <Btn label="Tomorrow 9:00" icon="sunrise" small onPress={() => update({ itemId: item.id, status: "snoozed", snoozeUntil: tomorrowAt9(now) })} grow />
          {item.status === "snoozed" ? <Btn label="Wake" icon="sun" small onPress={() => update({ itemId: item.id, status: "triaged" })} grow /> : null}
        </View>
      )}

      {mail && !flag && !linked && comms ? (
        <View style={st.actions}>
          <Btn label={`Draft reply with ${comms.name}`} icon="edit-3" onPress={draftReply} grow testID="draft-reply"
            disabled={!!comms.statusNote || comms.status !== "online"} />
        </View>
      ) : null}
      {mail && !flag && !linked && comms && (comms.statusNote || comms.status !== "online") ? (
        <T v="small" tone={color.warn} style={{ marginTop: space.sm }}>{comms.status !== "online" ? `${comms.name} is offline.` : comms.statusNote}</T>
      ) : null}
      {flag ? (
        <Card tone={color.warn} pad={space.md} style={{ marginTop: space.md, gap: 6 }}>
          <View style={st.h}><Icon name="alert-triangle" size={14} tone={color.warn} /><T v="micro" tone={color.warn}>Security flag</T></View>
          <T v="small">This email reads like it is trying to give instructions to an AI agent. The Comms agent treats mail as data and was told not to act on it. Nothing was sent or changed. Open it in Gmail yourself before trusting the sender.</T>
        </Card>
      ) : null}

      <SectionTitle title="Change priority" />
      <View style={st.tags}>
        {PRIORITIES.map((p) => <Chip key={p} label={p} tone={priorityColor[p]} selected={item.priority === p} onPress={() => item.priority !== p && update({ itemId: item.id, priority: p })} />)}
      </View>

      <SectionTitle title="Hand to agent" />
      {linked ? (
        <Card onPress={() => router.navigate(`/chats/${linked.id}` as any)} pad={space.md}>
          <View style={st.h}><Icon name="message-square" tone={color.accent} /><T style={{ flex: 1 }} numberOfLines={1}>Open thread: {linked.title}</T><Icon name="chevron-right" /></View>
        </Card>
      ) : handing ? (
        <Card pad={4}>
          {agents.map((a) => (
            <Row key={a.id} onPress={() => handTo(a.id, a.name)} style={{ paddingHorizontal: space.md, minHeight: 56 }} accessibilityLabel={`Hand to ${a.name}`}>
              <View style={[st.h, { gap: space.md }]}>
                <AgentAvatar name={a.name} online={a.status === "online"} size={34} />
                <View style={{ flex: 1 }}><T v="heading" style={{ fontSize: 14 }}>{a.name}</T><T v="small" numberOfLines={1}>{a.status === "online" ? a.description : "Offline — the run starts when its connector returns"}</T></View>
              </View>
            </Row>
          ))}
          {agents.length === 0 ? <T v="small" muted style={{ padding: space.md }}>No agents registered yet.</T> : null}
          <Btn label="Cancel" kind="ghost" small onPress={() => setHanding(false)} style={{ margin: space.sm }} />
        </Card>
      ) : (
        <Btn label="Hand to an agent" icon="cpu" onPress={() => setHanding(true)} />
      )}

      <SectionTitle title="Message" />
      <View style={st.bodyBox}><T selectable style={{ lineHeight: 23 }}>{item.body ?? item.snippet ?? "No body."}</T></View>
      {mail || flag ? <T v="small" muted style={{ marginTop: space.sm }}>Only the sender, subject and snippet are kept in HomeBase. The full email stays in Gmail; the Comms agent reads it there when you ask.</T> : null}
      {item.externalUrl ? <T v="small" muted style={{ marginTop: space.sm }} selectable>{mail || flag ? "Open in Gmail" : "Source link (simulated)"}: {item.externalUrl}</T> : null}
    </Screen>
  );
}

export default function InboxItemScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Split show="detail" list={<InboxList selectedId={id} />} detail={<Detail id={id} key={id} />} />;
}

const st = StyleSheet.create({
  top: { flexDirection: "row", gap: space.md, alignItems: "flex-start", marginTop: space.sm },
  tags: { flexDirection: "row", gap: space.sm, flexWrap: "wrap", alignItems: "center", marginTop: space.md },
  h: { flexDirection: "row", alignItems: "center", gap: 6 },
  actions: { flexDirection: "row", gap: space.sm, marginTop: space.md, flexWrap: "wrap" },
  bodyBox: { backgroundColor: color.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: color.border, padding: space.lg },
});
