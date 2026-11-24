import { router } from "expo-router";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Agent, VaultFile } from "@homebase/protocol";
import { ago } from "../format";
import { Header, useLayout } from "../layout/Shell";
import { useNow, useSync } from "../sync/hooks";
import { color, radius, space } from "../theme";
import { countDayBullets, plainSnippet } from "../vault/noteMarkdown";
import {
  addToToday, askNotes, buildTree, displayTitle, fileName, folderLabel, looksLikeQuestion, openNote, todayIn, useCaptureState, useNote, useNotesAgent,
  useVaultFiles, useVaultSearch, type TreeNode,
} from "../vault/vault";
import { useDictation } from "../voice/useDictation";
import { MicButton } from "./MicButton";
import { captureFileLabel } from "./VaultCards";
import { Btn, Card, Empty, Icon, IconBtn, Row, T, Tag } from "./ui";

// ---------------------------------------------------------------- the dictation sheet

/** After the mic is released: the transcript, editable, and what to do with it. Add to today is the default. */
export function MicSheet({ text, onChange, onAdd, onAsk, onDiscard }: { text: string | null; onChange: (t: string) => void; onAdd: () => void; onAsk: () => void; onDiscard: () => void }) {
  const insets = useSafeAreaInsets();
  const ask = !!text && looksLikeQuestion(text);
  return (
    <Modal visible={text !== null} transparent animationType="slide" onRequestClose={onDiscard} statusBarTranslucent>
      <KeyboardAvoidingView style={st.scrim} behavior={Platform.OS === "web" ? undefined : "padding"}>
        <Pressable style={{ flex: 1 }} onPress={onDiscard} accessibilityLabel="Discard dictation" />
        <View style={[st.sheet, { paddingBottom: Math.max(insets.bottom, space.lg) }]} accessibilityViewIsModal>
          <View style={st.grabber} />
          <View style={st.h}>
            <Icon name="mic" size={15} tone={color.textDim} />
            <T v="heading" style={{ flex: 1 }}>What you said</T>
            <T v="small" muted>{(text ?? "").trim().split(/\s+/).filter(Boolean).length} words</T>
          </View>
          <TextInput value={text ?? ""} onChangeText={onChange} multiline autoFocus={Platform.OS === "web"} style={st.sheetInput} accessibilityLabel="Dictated text" testID="mic-sheet-text"
            placeholder="Nothing was heard. Type it instead." placeholderTextColor={color.textMuted} textAlignVertical="top" />
          <T v="small" muted>{ask ? "This reads like a question, so Ask is first. The transcript is kept either way when you add it." : "Fix any words the recognizer got wrong. The Notes agent files it as bullets and keeps this transcript."}</T>
          <Btn label={ask ? "Ask the Notes agent" : "Add to today"} kind="primary" icon={ask ? "help-circle" : "plus"} onPress={ask ? onAsk : onAdd} disabled={!text?.trim()} testID="mic-sheet-primary" />
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <Btn label={ask ? "Add to today" : "Ask instead"} icon={ask ? "plus" : "help-circle"} onPress={ask ? onAdd : onAsk} disabled={!text?.trim()} grow testID="mic-sheet-secondary" />
            <Btn label="Discard" kind="ghost" onPress={onDiscard} grow />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ---------------------------------------------------------------- pieces

function Section({ title, right }: { title: string; right?: React.ReactNode }) {
  return <View style={st.section}><T v="micro">{title}</T>{right}</View>;
}

function NoteRow({ file, selected, now, depth = 0 }: { file: VaultFile; selected?: boolean; now: number; depth?: number }) {
  return (
    <Row selected={selected} onPress={() => openNote({ path: file.path })} accessibilityLabel={`Note ${displayTitle(file)}`} style={[st.noteRow, { paddingLeft: space.md + depth * 16 }]}>
      <Icon name="file-text" size={15} tone={selected ? color.text : color.textMuted} />
      <T numberOfLines={1} style={{ flex: 1, fontSize: 15 }} tone={selected ? color.text : color.textDim}>{depth ? fileName(file.path) : displayTitle(file)}</T>
      {depth ? null : <T v="small" muted style={{ fontSize: 12 }}>{ago(file.mtime, now)}</T>}
    </Row>
  );
}

function Folder({ node, depth, open, toggle, selectedPath, now }: { node: TreeNode; depth: number; open: Set<string>; toggle: (p: string) => void; selectedPath?: string; now: number }) {
  const isOpen = open.has(node.path);
  const label = folderLabel(node.path);
  return (
    <View>
      <Row onPress={() => toggle(node.path)} accessibilityRole="button" accessibilityState={{ expanded: isOpen }} accessibilityLabel={`Folder ${node.name}, ${node.count} notes`}
        style={[st.noteRow, { paddingLeft: space.md + depth * 16 }]}>
        <Icon name={isOpen ? "chevron-down" : "chevron-right"} size={15} tone={color.textMuted} />
        <T numberOfLines={1} style={{ flexShrink: 1, fontSize: 15, fontFamily: "SpaceGrotesk_500Medium" }}>{node.name === "_Archive" ? "Old versions" : node.name}</T>
        {label && node.name !== "_Archive" ? <Tag label={label.toUpperCase()} /> : null}
        <View style={{ flex: 1 }} />
        <T v="small" muted style={{ fontSize: 12, fontVariant: ["tabular-nums"] }}>{node.count}</T>
      </Row>
      {isOpen ? (
        <View>
          {node.folders.map((f) => <Folder key={f.path} node={f} depth={depth + 1} open={open} toggle={toggle} selectedPath={selectedPath} now={now} />)}
          {node.files.map((f) => <NoteRow key={f.id} file={f} depth={depth + 1} selected={f.path === selectedPath} now={now} />)}
        </View>
      ) : null}
    </View>
  );
}

function VaultStatus({ agent, now }: { agent: Agent; now: number }) {
  const v = agent.vault;
  if (!v) return <Card pad={space.md}><T v="small">{agent.statusNote ?? "The vault is not open on the connector yet."}</T></Card>;
  const line = (label: string, value: string, warn?: boolean) => (
    <View style={st.statusLine}><T v="small" muted style={{ width: 132 }}>{label}</T><T v="small" tone={warn ? color.warn : color.text} style={{ flex: 1 }}>{value}</T></View>
  );
  return (
    <Card pad={space.md} style={{ gap: 2 }}>
      <View style={[st.h, { marginBottom: 4 }]}><Icon name="hard-drive" size={14} tone={color.textDim} /><T v="heading" style={{ fontSize: 14, flex: 1 }}>Vault status</T><Tag label={agent.status === "online" ? "ONLINE" : "OFFLINE"} tone={agent.status === "online" ? color.ok : color.textMuted} /></View>
      {line("Notes", String(v.files))}
      {line("Last commit", v.lastCommitAt ? `${ago(v.lastCommitAt, now)} ago${v.head ? ` · ${v.head.slice(0, 7)}` : ""}`.replace("now ago", "just now") : "none yet")}
      {line("Last push", v.lastPushAt ? `${ago(v.lastPushAt, now)} ago`.replace("now ago", "just now") : v.unpushed ? "waiting" : "nothing to push since the connector started", !!v.pushError)}
      {v.unpushed ? line("Not pushed yet", `${v.unpushed} commit${v.unpushed === 1 ? "" : "s"}`) : null}
      {line("Changed outside HomeBase", v.externalChanges.files ? `${v.externalChanges.files} file${v.externalChanges.files === 1 ? "" : "s"} committed for you` : "nothing")}
      {v.pushError ? line("Push problem", v.pushError, true) : null}
      {v.diverged ? line("Remote", "The remote has commits this machine does not. Pushing is stopped; nothing was merged.", true) : null}
      {v.writesSuspended ? line("Agent writes", "Suspended until you look at the last agent commit.", true) : null}
      <T v="small" muted style={{ marginTop: 4, fontSize: 12 }}>{v.path} · times in {v.tz ?? "the vault's zone"}</T>
    </Card>
  );
}

// ---------------------------------------------------------------- the pane

/** The Notes tab: Today, Recent, Browse and Search over the vault, with the mic as the main control on a phone. */
export function NotesHome({ selectedPath }: { selectedPath?: string }) {
  const insets = useSafeAreaInsets();
  const { wide } = useLayout();
  const agent = useNotesAgent();
  const files = useVaultFiles();
  const now = useNow(30_000);
  const online = useSync((s) => s.status === "online");
  const synced = useSync((s) => s.synced);
  const [q, setQ] = useState("");
  const [showStatus, setShowStatus] = useState(false);
  const [typed, setTyped] = useState("");
  const [sheet, setSheet] = useState<string | null>(null);
  const [heard, setHeard] = useState("");
  const acc = useRef("");
  const today = todayIn(agent?.vault?.tz, now);
  const capture = useCaptureState(agent, today.ymd);
  const todayNote = useNote(files.some((f) => f.path === today.path) ? today.path : undefined);
  const bullets = todayNote.note ? countDayBullets(todayNote.note.text, today.ymd) : null;
  const search = useVaultSearch(q, files);

  const tree = useMemo(() => buildTree(files), [files]);
  const recent = useMemo(
    () => files.filter((f) => !f.path.startsWith("_Archive/") && !f.path.startsWith("Daily Notes/RAW/") && !/(^|\/)CLAUDE\.md$/i.test(f.path)).sort((a, b) => b.mtime - a.mtime).slice(0, 5),
    [files],
  );
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!selectedPath) return;
    const parts = selectedPath.split("/");
    setOpen((cur) => {
      const next = new Set(cur);
      for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join("/"));
      return next;
    });
  }, [selectedPath]);
  const toggle = (p: string) => setOpen((cur) => {
    const next = new Set(cur);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    return next;
  });

  const d = useDictation({
    onPartial: (p) => setHeard(`${acc.current} ${p}`.trim()),
    onFinal: (f) => {
      acc.current = `${acc.current} ${f}`.trim();
      setHeard(acc.current);
    },
  });
  const stop = () => {
    const done = d.stop();
    const show = () => {
      const text = acc.current || heard;
      acc.current = "";
      setHeard("");
      if (text.trim()) setSheet(text.trim());
    };
    // Give the recognizer a beat to deliver its final result, then show what was heard.
    // The desktop engine says when its last pass is done, so wait for exactly that.
    if (d.slowFinal) void done.then(show);
    else setTimeout(show, 900);
  };
  const hasMic = d.availability !== "hidden";
  const closeSheet = () => setSheet(null);
  const addTyped = () => {
    if (addToToday(agent, typed, "text")) setTyped("");
  };

  const searching = q.trim().length >= 2;
  return (
    <View style={st.pane}>
      <View style={st.padH}>
        <Header title="Notes" large subtitle={agent?.vault ? `${agent.vault.files} notes · your Obsidian vault` : undefined}
          right={agent ? <IconBtn icon="more-horizontal" label="Vault status" active={showStatus} onPress={() => setShowStatus((v) => !v)} /> : undefined} />
        <View style={st.search}>
          <Icon name="search" size={16} tone={color.textMuted} />
          <TextInput value={q} onChangeText={setQ} placeholder="Search notes" placeholderTextColor={color.textMuted} style={st.searchInput} accessibilityLabel="Search notes"
            autoCapitalize="none" autoCorrect={false} returnKeyType="search" testID="notes-search" />
          {q ? <IconBtn icon="x" label="Clear search" size={16} onPress={() => setQ("")} style={{ width: 32, height: 32 }} /> : null}
        </View>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: space.xl, flexGrow: 1 }} keyboardShouldPersistTaps="handled">
        {showStatus && agent ? <View style={[st.padH, { marginTop: space.md }]}><VaultStatus agent={agent} now={now} /></View> : null}
        {!agent || (!files.length && synced) ? (
          <Empty icon="book-open" title={agent ? "The vault is not open yet" : "No vault connected"}
            body={agent?.statusNote ?? (agent ? "The Notes agent is registered. Its notes appear here once the connector has indexed the vault." : "The Notes tab shows the Obsidian vault held by your connector. Start the connector on the machine that has it.")} />
        ) : searching ? (
          <View>
            <Section title={`Titles${search.titles.length ? ` · ${search.titles.length}` : ""}`} />
            <View style={st.list}>
              {search.titles.length === 0 ? <T v="small" muted style={st.hint}>No note has that in its title.</T> : null}
              {search.titles.map((f) => (
                <Row key={f.id} onPress={() => openNote({ path: f.path })} accessibilityLabel={`Note ${displayTitle(f)}`} style={st.hit}>
                  <T numberOfLines={1} style={{ fontSize: 15 }}>{displayTitle(f)}</T>
                  <T v="small" muted numberOfLines={1} style={{ fontSize: 12 }}>{f.path}</T>
                </Row>
              ))}
            </View>
            <Section title={`In the text${search.state === "done" ? ` · ${search.hits.length}` : ""}`} />
            <View style={st.list}>
              {search.state === "offline" ? <T v="small" muted style={st.hint}>Offline. Full-text search runs on the machine that holds the vault and needs a connection. Titles above work offline.</T> : null}
              {search.state === "searching" ? <T v="small" muted style={st.hint}>Searching the vault…</T> : null}
              {search.state === "error" ? <T v="small" tone={color.warn} style={st.hint}>{search.error}</T> : null}
              {search.state === "done" && search.hits.length === 0 ? <T v="small" muted style={st.hint}>No line in any note matches “{q.trim()}”. Your own raw notes and old versions are not searched here.</T> : null}
              {search.hits.map((h, i) => (
                <Row key={`${h.path}:${h.line}:${i}`} onPress={() => openNote({ path: h.path, line: h.line })} accessibilityLabel={`Match in ${h.title}, line ${h.line}`} style={st.hit}>
                  <View style={st.h}>
                    <T numberOfLines={1} style={{ fontSize: 14, flexShrink: 1, fontFamily: "SpaceGrotesk_500Medium" }}>{h.title}</T>
                    <T v="small" muted style={{ fontSize: 12 }}>line {h.line}</T>
                  </View>
                  <T v="small" numberOfLines={3}>{plainSnippet(h.text)}</T>
                </Row>
              ))}
            </View>
          </View>
        ) : (
          <View>
            <Section title={`Today · ${today.label}`} />
            <View style={st.padH}>
              <Card pad={0} onPress={() => openNote({ path: today.path, day: today.ymd })}>
                <View style={st.today} accessibilityLabel={`Open today's note, ${bullets ?? 0} bullets`}>
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <T v="heading" numberOfLines={1}>{bullets ? `${bullets} bullet${bullets === 1 ? "" : "s"} today` : "Nothing filed yet today"}</T>
                    <T v="small" numberOfLines={1}>{capture.queued ? `${capture.queued} dictation${capture.queued === 1 ? "" : "s"} queued until you are online` : capture.filing ? "The Notes agent is filing…" : today.monthTitle}</T>
                  </View>
                  <Icon name="chevron-right" size={18} tone={color.textMuted} />
                </View>
              </Card>
              {capture.last ? (
                <Pressable onPress={() => router.navigate(`/chats/${capture.last!.threadId}` as any)} accessibilityRole="link" accessibilityLabel="Open the last capture" style={st.lastCapture}>
                  <Icon name="check-circle" size={13} tone={color.textDim} />
                  <T v="small" numberOfLines={1} style={{ flex: 1 }}>Last capture: {capture.last.card.files.map((f) => captureFileLabel(f.path)).join(", ")}{capture.last.card.flags.length ? ` · ${capture.last.card.flags.length} flag${capture.last.card.flags.length === 1 ? "" : "s"}` : ""}</T>
                  <T v="small" muted style={{ fontSize: 12 }}>{ago(capture.last.createdAt, now)}</T>
                </Pressable>
              ) : null}
              {!hasMic || wide ? (
                <View style={st.typed}>
                  <TextInput value={typed} onChangeText={setTyped} placeholder="Add to today…" placeholderTextColor={color.textMuted} style={st.typedInput} multiline accessibilityLabel="Add to today's note"
                    testID="add-to-today" onSubmitEditing={addTyped} blurOnSubmit />
                  <Btn small kind={typed.trim() ? "primary" : "secondary"} icon="plus" label="Add" onPress={addTyped} disabled={!typed.trim()} />
                </View>
              ) : null}
            </View>

            <Section title="Recent" />
            <View style={st.list}>
              {recent.map((f) => <NoteRow key={f.id} file={f} selected={f.path === selectedPath} now={now} />)}
            </View>

            <Section title="Browse" />
            <View style={st.list}>
              {tree.folders.map((f) => <Folder key={f.path} node={f} depth={0} open={open} toggle={toggle} selectedPath={selectedPath} now={now} />)}
              {tree.files.map((f) => <NoteRow key={f.id} file={f} selected={f.path === selectedPath} now={now} />)}
            </View>
            {!online ? <T v="small" muted style={[st.hint, st.padH]}>Offline. You can browse, and read notes you have opened before on this device.</T> : null}
          </View>
        )}
      </ScrollView>

      {hasMic && !wide ? (
        <View style={[st.dock, { paddingBottom: Math.max(insets.bottom, space.md) }]}>
          {d.listening || heard ? (
            <T v="small" tone={color.text} numberOfLines={3} style={st.live} accessibilityLiveRegion="polite">{heard || "Listening…"}</T>
          ) : null}
          <View style={st.dockRow}>
            <View style={{ flex: 1, alignItems: "flex-start" }}>
              <Btn small kind="ghost" icon="edit-3" label="Type or ask" onPress={() => askNotes(agent, "", "text")} />
            </View>
            <MicButton listening={d.listening} level={d.level} onStart={d.start} onStop={stop} size={76} disabled={d.availability === "unavailable"} label="Hold to dictate today's note" />
            <View style={{ flex: 1 }} />
          </View>
          <T v="small" muted style={{ textAlign: "center" }}>
            {d.availability === "unavailable" ? "Speech recognition is unavailable on this device. Use Type or ask." : d.errorText ?? (d.listening ? "Release when you are done" : "Hold to dictate today's note")}
          </T>
        </View>
      ) : null}

      <MicSheet text={sheet} onChange={setSheet} onDiscard={closeSheet}
        onAdd={() => { addToToday(agent, sheet ?? "", "voice"); closeSheet(); }}
        onAsk={() => { const t = sheet ?? ""; closeSheet(); askNotes(agent, t, "voice"); }} />
    </View>
  );
}

const st = StyleSheet.create({
  pane: { flex: 1, backgroundColor: color.bg },
  padH: { paddingHorizontal: space.lg },
  h: { flexDirection: "row", alignItems: "center", gap: space.sm },
  search: {
    flexDirection: "row", alignItems: "center", gap: space.sm, backgroundColor: color.surface, borderRadius: radius.md, borderWidth: 1, borderColor: color.border,
    paddingHorizontal: space.md, height: 46,
  },
  searchInput: { flex: 1, color: color.text, fontSize: 15, height: 44, outlineStyle: "none" } as any,
  section: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.lg, paddingTop: space.xl, paddingBottom: space.sm },
  list: { paddingHorizontal: space.sm },
  noteRow: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 46, paddingVertical: 8, paddingRight: space.md },
  hit: { gap: 3, paddingVertical: 10 },
  hint: { paddingHorizontal: space.md, paddingVertical: space.sm },
  today: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.lg, minHeight: 68 },
  lastCapture: { flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: space.xs, paddingTop: space.md, minHeight: 36 },
  typed: { flexDirection: "row", alignItems: "flex-end", gap: space.sm, marginTop: space.md },
  typedInput: {
    flex: 1, minHeight: 44, maxHeight: 140, color: color.text, fontSize: 15, lineHeight: 21, backgroundColor: color.surface, borderRadius: radius.md, borderWidth: 1, borderColor: color.border,
    paddingHorizontal: space.md, paddingVertical: 11, outlineStyle: "none",
  } as any,
  statusLine: { flexDirection: "row", gap: space.sm, paddingVertical: 3 },
  dock: { borderTopWidth: 1, borderTopColor: color.border, backgroundColor: color.surface, paddingTop: space.md, paddingHorizontal: space.lg, gap: space.sm },
  dockRow: { flexDirection: "row", alignItems: "center" },
  live: { textAlign: "center", paddingHorizontal: space.md },
  scrim: { flex: 1, backgroundColor: color.overlay, justifyContent: "flex-end" },
  sheet: {
    backgroundColor: color.surface, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, borderWidth: 1, borderColor: color.borderStrong, padding: space.lg, gap: space.md,
    width: "100%", maxWidth: 620, alignSelf: "center",
  },
  grabber: { width: 40, height: 4, borderRadius: 2, backgroundColor: color.borderStrong, alignSelf: "center", marginBottom: 2 },
  sheetInput: {
    minHeight: 120, maxHeight: 280, color: color.text, fontSize: 16, lineHeight: 23, backgroundColor: color.bg, borderRadius: radius.md, borderWidth: 1, borderColor: color.border,
    padding: space.md, outlineStyle: "none",
  } as any,
});
