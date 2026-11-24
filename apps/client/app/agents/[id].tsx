import { router, useLocalSearchParams } from "expo-router";
import React, { useMemo, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { newId } from "@homebase/protocol";
import { AgentAvatar } from "../../src/components/bits";
import { AgentList, Placeholder, RunRow } from "../../src/components/lists";
import { ModeOptions } from "../../src/components/ModeSwitch";
import { AgentModelDefaults } from "../../src/components/ModelPicker";
import { AgentFolders } from "../../src/components/Folders";
import { AgentImagesFacts } from "../../src/components/ImageCards";
import { Btn, Card, Chip, Icon, SectionTitle, T, Tag } from "../../src/components/ui";
import { dayTime } from "../../src/format";
import { MAIL_SECRETS_NOTE, MODE, SECRETS_NOTE, agentModes, authFacts, effectiveMode } from "../../src/modes";
import { gmailFacts } from "../../src/gmail";
import { Header, Screen, Split } from "../../src/layout/Shell";
import { useList, useNow, useOne, useSync } from "../../src/sync/hooks";
import { mutate } from "../../src/sync/session";
import { color, radius, space } from "../../src/theme";

function Detail({ id }: { id: string }) {
  const agent = useOne("agents", id);
  const connector = useSync((s) => (agent?.connectorId ? s.entities.connectors[agent.connectorId] : undefined));
  const runs = useList("runs");
  const now = useNow();
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState<string | null>(null);
  const history = useMemo(() => runs.filter((r) => r.agentId === id).sort((a, b) => b.createdAt - a.createdAt), [runs, id]);
  if (!agent) return <Placeholder icon="cpu" title="Agent not found" />;
  const online = agent.status === "online";
  const modes = agentModes(agent);
  const defaultMode = effectiveMode(agent, null);

  const start = () => {
    const text = prompt.trim();
    if (!text) return;
    const runId = newId("run");
    void mutate("run.start", { runId, agentId: agent.id, prompt: text, options: cwd ? { cwd } : undefined });
    setPrompt("");
    router.navigate(`/runs/${runId}` as any);
  };

  return (
    <Screen>
      <Header title={agent.name} subtitle={`${connector?.name ?? "No connector yet"} · ${agent.kind} adapter`} back="/agents" />
      <Card style={{ gap: space.md, marginTop: space.sm }}>
        <View style={st.h}>
          <AgentAvatar name={agent.name} online={online} size={48} />
          <View style={{ flex: 1, gap: 4 }}>
            <View style={st.wrap}>
              <Tag label={online ? "ONLINE" : "OFFLINE"} tone={online ? color.ok : color.textMuted} />
              {agent.statusNote ? <Tag label="NEEDS SETUP" tone={color.warn} icon="alert-triangle" /> : null}
            </View>
            {agent.statusNote ? <T tone={color.warn} selectable accessibilityLabel={`Agent status: ${agent.statusNote}`}>{agent.statusNote}</T> : null}
            <T>{agent.description || "No description."}</T>
          </View>
        </View>
        {agent.capabilities.length ? (
          <View style={st.wrap}>{agent.capabilities.map((c) => <Tag key={c} label={c} tone={c.startsWith("mcp:") ? color.p2 : color.textDim} />)}</View>
        ) : null}
        <T v="small" muted>
          {defaultMode ? `Default mode: ${MODE[defaultMode].label}. ` : `Permission profile: ${agent.permissionProfile}. `}
          {agent.gmail ? "Sending an email always waits for your approval." : "Risk is classified on the connector; risky actions wait for your approval."}
        </T>
      </Card>

      {defaultMode ? (
        <>
          <SectionTitle title="Default mode" />
          <Card style={{ gap: space.md }}>
            <T v="small">New chats with {agent.name} start in this mode. A chat can override it from its message box.</T>
            <ModeOptions value={defaultMode} modes={modes} onChange={(m) => m && void mutate("mode.set", { scope: "agent", id: agent.id, mode: m })} mail={!!agent.gmail} />
            <View style={st.note}><Icon name="lock" size={13} tone={color.textMuted} /><T v="small" muted style={{ flex: 1 }}>{agent.gmail ? MAIL_SECRETS_NOTE : SECRETS_NOTE} Everything the agent does without asking is on the run timeline and in the audit log.</T></View>
          </Card>
        </>
      ) : null}

      <SectionTitle title="Default model and effort" />
      <Card style={{ gap: space.md }}><AgentModelDefaults agent={agent} /></Card>

      {/* Its default folders, and the folders its connector has approved on that machine. */}
      <SectionTitle title="Folders" />
      <Card style={{ gap: space.md }}><AgentFolders agent={agent} /></Card>

      {agent.images ? (
        <>
          {/* Which providers can make images in this agent's sessions, and how each one's plan stands. */}
          <SectionTitle title="Images" />
          <Card style={{ gap: space.md }}><AgentImagesFacts agent={agent} /></Card>
        </>
      ) : null}

      {agent.gmail ? (
        <>
          <SectionTitle title="Gmail" />
          <Card pad={space.md} style={{ gap: 2 }}>
            {gmailFacts(agent.gmail, dayTime).map((f) => (
              <View key={f.label} style={st.fact} accessibilityLabel={`${f.label}: ${f.value}`}>
                <View style={st.factHead}>
                  <T v="micro" style={{ flex: 1 }}>{f.label}</T>
                  {f.ok === true ? <Icon name="check" size={13} tone={color.ok} /> : f.ok === false ? <Icon name="alert-triangle" size={13} tone={color.warn} /> : null}
                </View>
                <T v="heading" selectable style={{ fontSize: 15 }} tone={f.ok === false ? color.warn : color.text}>{f.value}</T>
                {f.note ? <T v="small" muted>{f.note}</T> : null}
              </View>
            ))}
            <View style={[st.note, { paddingTop: space.sm }]}>
              <Icon name="eye-off" size={13} tone={color.textMuted} />
              <T v="small" muted style={{ flex: 1 }}>The Gmail token stays on the connector machine. It is never sent to the hub or to this app. Email text is treated as untrusted: the agent is told never to follow instructions found in mail, and suspicious mail is flagged in your inbox.</T>
            </View>
          </Card>
        </>
      ) : null}

      {agent.auth ? (
        <>
          <SectionTitle title="Authentication" />
          <Card pad={space.md} style={{ gap: 2 }}>
            {authFacts(agent.auth, dayTime).map((f) => (
              <View key={f.label} style={st.fact} accessibilityLabel={`${f.label}: ${f.value}`}>
                <View style={st.factHead}>
                  <T v="micro" style={{ flex: 1 }}>{f.label}</T>
                  {f.ok === true ? <Icon name="check" size={13} tone={color.ok} /> : f.ok === false ? <Icon name="alert-triangle" size={13} tone={color.warn} /> : null}
                </View>
                <T v="heading" selectable style={{ fontSize: 15 }} tone={f.ok === false ? color.warn : color.text}>{f.value}</T>
                {f.note ? <T v="small" muted>{f.note}</T> : null}
              </View>
            ))}
            <View style={[st.note, { paddingTop: space.sm }]}>
              <Icon name="eye-off" size={13} tone={color.textMuted} />
              <T v="small" muted style={{ flex: 1 }}>Facts reported by the connector. HomeBase never reads, stores or sends a token, an account name or the contents of a credential file.</T>
            </View>
          </Card>
        </>
      ) : null}

      <SectionTitle title="Start a run" />
      <Card style={{ gap: space.md }}>
        <TextInput value={prompt} onChangeText={setPrompt} multiline placeholder={`What should ${agent.name} do?`} placeholderTextColor={color.textMuted}
          style={st.input} accessibilityLabel="Run prompt" />
        {agent.workspaces.length ? (
          <View>
            <T v="micro" style={{ marginBottom: space.sm }}>Working directory (optional)</T>
            <View style={st.wrap}>
              <Chip label="Default" selected={cwd === null} onPress={() => setCwd(null)} />
              {agent.workspaces.map((w) => <Chip key={w.cwd} label={w.label} icon="folder" selected={cwd === w.cwd} onPress={() => setCwd(w.cwd)} />)}
            </View>
            {cwd ? <T v="mono" tone={color.textDim} style={{ marginTop: space.sm, fontSize: 12 }}>{cwd}</T> : null}
          </View>
        ) : null}
        <Btn label={online ? "Start run" : "Queue run (agent offline)"} kind="primary" icon="play" onPress={start} disabled={!prompt.trim() || !agent.connectorId} />
        {!agent.connectorId ? <T v="small" tone={color.warn}>This agent has no connector yet. Start one with `npm run dev:connector`.</T> : null}
      </Card>

      <SectionTitle title="Run history" count={history.length} />
      <Card pad={4}>
        {history.length === 0 ? <T v="small" muted style={{ padding: space.md }}>No runs yet.</T> : null}
        {history.slice(0, 30).map((r) => <RunRow key={r.id} run={r} now={now} />)}
      </Card>
    </Screen>
  );
}

export default function AgentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Split show="detail" list={<AgentList selectedId={id} />} detail={<Detail id={id} key={id} />} />;
}

const st = StyleSheet.create({
  h: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  note: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  fact: { paddingVertical: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.border, gap: 2 },
  factHead: { flexDirection: "row", alignItems: "center", gap: space.sm },
  input: {
    minHeight: 96, borderRadius: radius.md, borderWidth: 1, borderColor: color.borderStrong, backgroundColor: color.bg, color: color.text, fontSize: 15,
    lineHeight: 21, padding: space.md, textAlignVertical: "top", outlineStyle: "none",
  } as any,
});
