import { useLocalSearchParams } from "expo-router";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Placeholder } from "../../src/components/lists";
import { NoteMarkdown } from "../../src/components/NoteMarkdown";
import { NotesHome } from "../../src/components/NotesHome";
import { Btn, Icon, IconBtn, Row, T, Tag } from "../../src/components/ui";
import { ago } from "../../src/format";
import { Header, Split } from "../../src/layout/Shell";
import { useNow, useSync } from "../../src/sync/hooks";
import { color, space } from "../../src/theme";
import { findTarget, parseNote, plainSnippet } from "../../src/vault/noteMarkdown";
import { askNotes, fileName, openNote, useBacklinks, useNote, useNotesAgent } from "../../src/vault/vault";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

/** A note from the vault, rendered. Read-only: editing comes with the app editor; for now changes are made in Obsidian. */
function Note({ path, day, heading, line }: { path: string; day?: string; heading?: string; line?: number }) {
  const insets = useSafeAreaInsets();
  const agent = useNotesAgent();
  const now = useNow(30_000);
  const online = useSync((s) => s.status === "online");
  const [reload, setReload] = useState(0);
  const state = useNote(path, reload);
  const backlinks = useBacklinks(path);
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const bodyY = useRef(0);
  const note = state.note;
  const target = useMemo(() => (note ? findTarget(parseNote(note.text).blocks, { day, heading, line }) : -1), [note, day, heading, line]);
  const jumped = useRef<string | null>(null);
  useEffect(() => {
    jumped.current = null;
  }, [path, day, heading, line]);

  const raw = path.startsWith("Daily Notes/RAW/");
  const transcript = path.startsWith("Daily Notes/RAW/AI Transcriptions/");
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "Vault root";
  const freshness = !note ? "" : state.cached && (state.status !== "ready" || !online) ? `cached ${ago(note.at, now)}`.replace("cached now", "cached just now") : `changed ${ago(note.mtime, now)}`.replace("changed now", "changed just now");

  return (
    <View style={st.pane}>
      <View style={st.head}>
        <Header title={note?.title ?? fileName(path)} subtitle={[folder, freshness].filter(Boolean).join(" · ")} back="/notes"
          right={<IconBtn icon="refresh-cw" label="Reload note" size={17} onPress={() => setReload((n) => n + 1)} />} />
      </View>
      {!note ? (
        state.status === "error"
          ? <Placeholder icon={online ? "alert-circle" : "wifi-off"} title={online ? "This note could not be opened" : "Not available offline"} body={state.error} />
          : <Placeholder icon="file-text" title="Opening…" />
      ) : (
        <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={st.content}>
          {transcript || raw || path.startsWith("_Archive/") || (state.cached && !online) ? (
            <View style={st.badges}>
              {transcript ? <Tag label="TRANSCRIPT · WORD FOR WORD" icon="mic" /> : raw ? <Tag label="YOURS ONLY · THE AGENT NEVER WRITES HERE" icon="lock" /> : null}
              {path.startsWith("_Archive/") ? <Tag label="OLD VERSION" icon="archive" /> : null}
              {state.cached && !online ? <Tag label="OFFLINE COPY" icon="wifi-off" /> : null}
            </View>
          ) : null}
          <View onLayout={(e) => { bodyY.current = e.nativeEvent.layout.y; }}>
            <NoteMarkdown text={note.text} from={path} selectable target={target}
              onTargetLayout={(y) => {
                const key = `${path}|${day}|${heading}|${line}`;
                if (jumped.current === key) return;
                jumped.current = key;
                setTimeout(() => scroll.current?.scrollTo({ y: Math.max(0, bodyY.current + y - 16), animated: false }), 60);
              }} />
          </View>
          {note.truncated ? <T v="small" tone={color.warn} style={{ marginTop: space.md }}>This note is very long; only its first part is shown.</T> : null}

          <View style={st.linked}>
            <T v="micro">Linked from{backlinks ? ` · ${backlinks.length}` : ""}</T>
            {!online ? <T v="small" muted>Backlinks need a connection.</T> : backlinks === null ? <T v="small" muted>Looking…</T> : backlinks.length === 0 ? <T v="small" muted>No other note links here.</T> : null}
            <View style={{ marginHorizontal: -space.md }}>
              {(backlinks ?? []).map((b) => (
                <Row key={`${b.path}:${b.line}`} onPress={() => openNote({ path: b.path, line: b.line })} accessibilityLabel={`Linked from ${b.title}`} style={{ gap: 3, paddingVertical: 10 }}>
                  <View style={st.h}><Icon name="corner-down-right" size={13} tone={color.textMuted} /><T numberOfLines={1} style={{ fontSize: 14, fontFamily: "SpaceGrotesk_500Medium", flexShrink: 1 }}>{b.title}</T></View>
                  <T v="small" muted numberOfLines={2} style={{ fontSize: 12.5 }}>{plainSnippet(b.context)}</T>
                </Row>
              ))}
            </View>
          </View>
        </ScrollView>
      )}
      <View style={[st.foot, { paddingBottom: Math.max(insets.bottom, space.sm) }]}>
        <T v="small" muted numberOfLines={1} style={{ flex: 1, fontSize: 12 }}>{path}</T>
        <Btn small icon="message-circle" label="Ask the Notes agent" onPress={() => askNotes(agent, "", "text")} />
      </View>
    </View>
  );
}

export default function NoteScreen() {
  const p = useLocalSearchParams<{ path?: string; day?: string; heading?: string; line?: string }>();
  const path = one(p.path);
  const line = Number(one(p.line));
  return (
    <Split show="detail" list={<NotesHome selectedPath={path} />}
      detail={path ? <Note key={path} path={path} day={one(p.day)} heading={one(p.heading)} line={Number.isFinite(line) && line > 0 ? line : undefined} /> : <Placeholder icon="file-text" title="No note chosen" />} />
  );
}

const st = StyleSheet.create({
  pane: { flex: 1, backgroundColor: color.bg },
  head: { paddingHorizontal: space.lg, borderBottomWidth: 1, borderBottomColor: color.border },
  content: { paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.xxl, width: "100%", maxWidth: 820, alignSelf: "center" },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginBottom: space.md },
  linked: { marginTop: space.xxl, paddingTop: space.lg, borderTopWidth: 1, borderTopColor: color.border, gap: space.sm },
  h: { flexDirection: "row", alignItems: "center", gap: 6 },
  foot: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingTop: space.sm, borderTopWidth: 1, borderTopColor: color.border, backgroundColor: color.surface },
});
