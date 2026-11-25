import { router, useLocalSearchParams } from "expo-router";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, StyleSheet, View } from "react-native";
import { FILES_CAPABILITY, TERMINAL_CAPABILITY, isLiveRun, newId, type Approval, type Message, type MessageAttachment } from "@homebase/protocol";
import { attachState } from "../../src/attachments";
import { MessagePictures } from "../../src/components/Attachments";
import { ApprovalCard } from "../../src/components/ApprovalCard";
import { RunStatusChip } from "../../src/components/bits";
import { Composer } from "../../src/components/Composer";
import { GmailDraftCard } from "../../src/components/GmailCards";
import { GeneratedImageCardView, ImageIssueCardView, ImagesSwitch, MakerMark } from "../../src/components/ImageCards";
import { liveImageWork } from "../../src/images";
import { AnswerMarkdown } from "../../src/components/NoteMarkdown";
import { VaultCaptureCard } from "../../src/components/VaultCards";
import { ModeSwitch, ModeTag } from "../../src/components/ModeSwitch";
import { ModelSwitch, SessionMarker } from "../../src/components/ModelPicker";
import { FoldersSwitch } from "../../src/components/Folders";
import { Placeholder } from "../../src/components/lists";
import { LeftOffBar, SessionList, SessionSheet } from "../../src/components/sessions";
import { BrowserBar } from "../../src/components/BrowserPanel";
import { Btn, Empty, Icon, IconBtn, T } from "../../src/components/ui";
import { clock } from "../../src/format";
import { Header, Split } from "../../src/layout/Shell";
import { MODE, agentModes, effectiveMode, modeWords } from "../../src/modes";
import { useMap, useNow, useOne, useRunStream, useSetting, useSync } from "../../src/sync/hooks";
import { mutate } from "../../src/sync/session";
import { color, radius, space, tint } from "../../src/theme";
import { startFolder } from "../../src/workspace/model";
import { speak, stopSpeaking } from "../../src/voice/tts";

type Item =
  | { kind: "message"; key: string; at: number; message: Message }
  | { kind: "approval"; key: string; at: number; approval: Approval }
  | { kind: "stream"; key: string; at: number; text: string }
  | { kind: "working"; key: string; at: number };

function Bubble({ m, pending }: { m: Message; pending: boolean }) {
  // Where the model, the effort or the agent session changed: a quiet line, not an error.
  if (m.card?.type === "session_marker") return <SessionMarker card={m.card} text={m.text} />;
  if (m.role === "system") {
    return <View style={st.system}><Icon name="alert-triangle" size={13} tone={color.danger} /><T v="small" tone={color.danger} style={{ flexShrink: 1 }}>{m.text}</T></View>;
  }
  if (m.card?.type === "vault_capture") return <View style={st.inlineApproval}><VaultCaptureCard card={m.card} /></View>;
  // An image made in the session, by OpenAI or by Claude: its own card, with the maker at the top.
  if (m.card?.type === "generated_image") return <View style={st.inlineApproval}><GeneratedImageCardView card={m.card} threadId={m.threadId} /></View>;
  if (m.card?.type === "image_issue") return <View style={st.inlineApproval}><ImageIssueCardView card={m.card} /></View>;
  if (m.card) return <View style={st.inlineApproval}><GmailDraftCard card={m.card} /></View>;
  const mine = m.role === "user";
  return (
    <View style={[st.bubbleRow, mine && { justifyContent: "flex-end" }]}>
      <View style={[st.bubble, mine ? st.mine : st.theirs, pending && { opacity: 0.6 }]}>
        {/* Pictures the owner attached: thumbnails, tap for full size. Same on every device (bytes from the hub, by id). */}
        {m.attachments?.length ? <MessagePictures items={m.attachments} /> : null}
        {/* Agent replies are markdown: headings, bold, lists, code and tables render; wikilinks become chips that open the note. */}
        {!mine ? <AnswerMarkdown text={m.text} /> : m.text.trim() ? <T selectable style={{ lineHeight: 22 }}>{m.text}</T> : null}
        <View style={st.meta}>
          {m.source === "voice" ? <Icon name="mic" size={11} tone={color.textMuted} /> : null}
          <T v="small" muted style={{ fontSize: 11 }}>{pending ? "queued" : clock(m.createdAt)}</T>
        </View>
      </View>
    </View>
  );
}

function Thread({ id }: { id: string }) {
  const thread = useOne("threads", id);
  const agent = useSync((s) => (thread?.agentId ? s.entities.agents[thread.agentId] : undefined));
  const project = useSync((s) => (thread?.projectId ? s.entities.projects[thread.projectId] : undefined));
  const [organising, setOrganising] = useState(false);
  const messages = useMap("messages");
  const approvals = useMap("approvals");
  const runs = useMap("runs");
  const serverMessages = useSync((s) => s.server.messages);
  const now = useNow();
  const defaultReadBack = useSetting("voice.readBack", false);
  const [readBack, setReadBack] = useState<boolean | null>(null);
  const reading = readBack ?? defaultReadBack;
  const list = useRef<FlatList<Item>>(null);

  const threadRuns = useMemo(() => Object.values(runs).filter((r) => r.threadId === id).sort((a, b) => a.createdAt - b.createdAt), [runs, id]);
  const liveRun = threadRuns.filter((r) => isLiveRun(r.status)).at(-1);
  const lastRun = threadRuns.at(-1);
  const stream = useRunStream(liveRun?.id, !!liveRun);
  // While OpenAI is making an image, the "working" line says so instead of naming the agent.
  const imageWork = liveImageWork(useSync((s) => (liveRun ? s.runEvents[liveRun.id] : undefined)));

  const items = useMemo<Item[]>(() => {
    const runIds = new Set(threadRuns.map((r) => r.id));
    const out: Item[] = [];
    for (const m of Object.values(messages)) if (m.threadId === id) out.push({ kind: "message", key: m.id, at: m.createdAt, message: m });
    for (const a of Object.values(approvals)) if (runIds.has(a.runId)) out.push({ kind: "approval", key: a.id, at: a.requestedAt, approval: a });
    out.sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : 1));
    if (liveRun) {
      if (stream) out.push({ kind: "stream", key: "stream", at: now, text: stream });
      else if (liveRun.status !== "waiting_approval") out.push({ kind: "working", key: "working", at: now });
    }
    return out;
  }, [messages, approvals, threadRuns, id, liveRun, stream, now]);

  // Keep the newest item in view as messages, approvals and streamed text arrive.
  const tailKey = `${items.length}:${items.at(-1)?.key}:${stream.length}:${Object.values(approvals).filter((a) => a.status === "pending").length}`;
  useEffect(() => {
    const timers = [60, 250, 600].map((ms) => setTimeout(() => list.current?.scrollToEnd({ animated: ms > 60 }), ms));
    return () => timers.forEach(clearTimeout);
  }, [tailKey]);

  // Read-back of new assistant messages. (Marking the session read is done once for the whole app, in notifications/Attention.tsx.)
  const lastSpoken = useRef<string | null>(null);
  const primed = useRef(false);
  useEffect(() => {
    const msgs = items.filter((i): i is Extract<Item, { kind: "message" }> => i.kind === "message");
    const lastAssistant = [...msgs].reverse().find((i) => i.message.role === "assistant");
    if (!primed.current) {
      primed.current = true; // never read history aloud when the screen opens
      lastSpoken.current = lastAssistant?.key ?? null;
      return;
    }
    if (reading && lastAssistant && lastAssistant.key !== lastSpoken.current) speak(lastAssistant.message.text);
    lastSpoken.current = lastAssistant?.key ?? null;
  }, [items, id, reading]);
  useEffect(() => () => stopSpeaking(), []);

  if (!thread) return <Placeholder icon="message-square" title="Session not found" />;

  const send = (text: string, source: "text" | "voice", attachments?: MessageAttachment[]) =>
    void mutate("message.send", { threadId: id, messageId: newId("msg"), text, source, ...(attachments?.length ? { attachments } : {}) });
  // Pictures: any agent that says it can look at them, and a thread with no agent (the owner's own notes).
  const pictures = attachState(agent, !!thread.agentId);
  // The mode the next run starts in. A live run shows the mode it is actually in.
  const modes = agentModes(agent);
  const mode = effectiveMode(agent, thread);
  const shownRun = liveRun ?? lastRun;
  // Files, the editor and the terminal on the agent's machine, starting in the folder this session works in.
  const hostFiles = !!agent?.capabilities?.includes(FILES_CAPABILITY);
  const hostTerminal = !!agent?.capabilities?.includes(TERMINAL_CAPABILITY);
  const workFolder = agent ? startFolder({ threadCwd: thread.cwd, lastRunCwd: lastRun?.cwd, projectCwd: project?.defaultCwd, agentDefault: agent.defaultCwd, workspaces: agent.workspaces }) : null;
  const openWorkspace = (term: boolean) =>
    router.push(`/workspace?agent=${encodeURIComponent(agent!.id)}${workFolder ? `&path=${encodeURIComponent(workFolder)}` : ""}${term ? "&terminal=1" : ""}` as any);
  const composerHint = agent && agent.status !== "online" ? `${agent.name} is offline. Your message is saved and the run starts when its connector is back.`
    : agent?.statusNote ?? (mode ? modeWords(mode, agent).short : undefined);

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: color.bg }} behavior={Platform.OS === "web" ? undefined : "padding"}>
      <View style={st.head}>
        <Header
          title={thread.title}
          subtitle={`${project?.name ?? "Unsorted"} · ${agent ? `${agent.name} · ${agent.status !== "online" ? "offline" : agent.statusNote ? "needs setup" : "online"}` : "no agent"}`}
          back="/chats"
          right={
            <>
              {hostFiles ? <IconBtn icon="code" label={`Files and editor on ${agent!.name}'s machine${workFolder ? `, in ${workFolder}` : ""}`} testID="open-files" onPress={() => openWorkspace(false)} /> : null}
              {hostTerminal ? <IconBtn icon="terminal" label="Terminal on the agent's machine" testID="open-terminal" onPress={() => openWorkspace(true)} /> : null}
              {/* One button for everything that organises the session: project, name, note, pin, archive. */}
              <IconBtn icon="folder" label={project ? `In ${project.name}. File, rename, pin or add a note` : "Unsorted. File, rename, pin or add a note"} active={!!project}
                onPress={() => setOrganising(true)} />
              <IconBtn icon={reading ? "volume-2" : "volume-x"} label={reading ? "Read-back on" : "Read-back off"} active={reading}
                onPress={() => { if (reading) stopSpeaking(); setReadBack(!reading); }} />
            </>
          }
        />
        {lastRun && (liveRun || lastRun.status === "failed" || lastRun.status === "offline") ? (
          <View style={st.runBar}>
            <RunStatusChip status={(liveRun ?? lastRun).status} />
            {liveRun && shownRun?.mode ? <ModeTag mode={shownRun.mode} /> : null}
            <T v="small" style={{ flex: 1 }} numberOfLines={1} onPress={() => router.navigate(`/runs/${(liveRun ?? lastRun).id}` as any)}>
              {liveRun ? "View the run timeline" : lastRun.error ?? "Open the run"}
            </T>
            {liveRun ? <Btn small kind="danger" icon="square" label="Cancel" onPress={() => void mutate("run.cancel", { runId: liveRun.id })} />
              : <Btn small kind="ghost" icon="list" label="Run" onPress={() => router.navigate(`/runs/${lastRun.id}` as any)} />}
          </View>
        ) : null}
        <LeftOffBar thread={thread} agent={agent} live={!!liveRun} now={now} onEdit={() => setOrganising(true)} />
        {/* The agent's browser, live: only for an agent whose connector runs one. Opens to the picture and the take-over buttons. */}
        <BrowserBar agent={agent} liveRun={liveRun} threadId={id} />
      </View>
      <SessionSheet threadId={organising ? id : null} onClose={() => setOrganising(false)} />
      <FlatList
        ref={list}
        data={items}
        keyExtractor={(i) => i.key}
        style={{ flex: 1 }}
        contentContainerStyle={st.listContent}
        onLayout={() => list.current?.scrollToEnd({ animated: false })}
        ListEmptyComponent={
          <Empty icon={agent ? "cpu" : "edit-3"} title={agent ? `Ask ${agent.name} to do something` : "A thread for your own notes"}
            body={agent ? (agent.vault || agent.key === "notes" ? "Dictate or type something for today's note, or ask a question about your notes. Answers cite the notes they came from." : agent.kind === "claude" ? (mode ? `${MODE[mode].label} mode: ${modeWords(mode, agent).short} Change it with the switch above the message box.` : "Ask for something in its working directory. File edits and shell commands wait for your approval.") : "Try “deploy the staging fix” to see an approval, or ask a question with a “?”.") : "Messages here sync to every device. No agent is listening."} />
        }
        renderItem={({ item }) => {
          if (item.kind === "message") return <Bubble m={item.message} pending={!serverMessages[item.message.id]} />;
          if (item.kind === "approval") return <View style={st.inlineApproval}><ApprovalCard approval={item.approval} now={now} /></View>;
          if (item.kind === "stream") {
            return (
              <View style={st.bubbleRow}>
                <View style={[st.bubble, st.theirs, { borderColor: tint(color.accent, 0.5) }]}>
                  <AnswerMarkdown text={item.text} streaming />
                  <T tone={color.accent} style={{ lineHeight: 18 }}>▍</T>
                </View>
              </View>
            );
          }
          if (imageWork) return <View style={st.working} testID="image-working"><MakerMark maker={imageWork.maker} small /><T v="small" tone={color.accent}>{imageWork.text}…</T></View>;
          return <View style={st.working}><View style={st.dot} /><T v="small" tone={color.accent}>{agent?.name ?? "Agent"} is working…</T></View>;
        }}
      />
      <Composer
        onSend={send}
        placeholder={agent ? `Message ${agent.name}` : "Write a message"}
        attach={{ refusal: pictures.refusal }}
        accessory={agent ? (
          // Above the message box, always: how much the agent may do alone, and what the next reply runs on.
          // The hint sits beside the two switches when there is room and wraps under them on a phone.
          <View style={st.accessory}>
            {mode ? (
              <ModeSwitch mode={mode} override={thread.mode ?? null} agentDefault={effectiveMode(agent, null) ?? "manual"} modes={modes}
                live={!!liveRun} liveMode={liveRun?.mode ?? null} mail={!!agent.gmail} notes={!!agent.vault || agent.key === "notes"}
                onChange={(next) => void mutate("mode.set", { scope: "thread", id, mode: next })} />
            ) : null}
            <ModelSwitch thread={thread} agent={agent} live={!!liveRun} liveModel={liveRun?.model ?? null} hasHistory={thread.lastRunStatus != null || !!lastRun} />
            {/* Which folders the agent has here: the one it works in, and any next to it. Only for an agent that takes folders. */}
            <FoldersSwitch thread={thread} agent={agent} project={project} live={!!liveRun} hasHistory={thread.lastRunStatus != null || !!lastRun} />
            {/* Who makes images in this session: only for an agent whose connector offers image tools. */}
            <ImagesSwitch thread={thread} agent={agent} project={project} />
            {composerHint ? <T v="small" muted numberOfLines={2} style={st.accessoryHint}>{composerHint}</T> : null}
          </View>
        ) : undefined}
      />
    </KeyboardAvoidingView>
  );
}

export default function ThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Split show="detail" list={<SessionList selectedId={id} />} detail={<Thread id={id} key={id} />} />;
}

const st = StyleSheet.create({
  head: { paddingHorizontal: space.lg, borderBottomWidth: 1, borderBottomColor: color.border },
  runBar: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingBottom: space.sm },
  accessory: { flex: 1, minWidth: 0, flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: space.sm, rowGap: 6 },
  accessoryHint: { flexGrow: 1, flexShrink: 1, flexBasis: 200, minWidth: 0 },
  listContent: { padding: space.lg, gap: space.sm, flexGrow: 1, width: "100%", maxWidth: 860, alignSelf: "center" },
  bubbleRow: { flexDirection: "row" },
  bubble: { maxWidth: "86%", borderRadius: radius.lg, paddingHorizontal: space.lg, paddingVertical: space.md, borderWidth: 1, gap: 4 },
  mine: { backgroundColor: tint(color.accent, 0.13), borderColor: tint(color.accent, 0.28), borderBottomRightRadius: 6 },
  theirs: { backgroundColor: color.surface, borderColor: color.border, borderBottomLeftRadius: 6 },
  meta: { flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-end" },
  system: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "center", paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: tint(color.danger, 0.1), maxWidth: "92%" },
  inlineApproval: { marginVertical: space.xs, maxWidth: 560, width: "100%" },
  working: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.accent },
});
