import { router } from "expo-router";
import React, { useDeferredValue, useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import {
  SESSION_FILTERS, SESSION_SORTS, UNSORTED, buildSessionRows, describeChoice, digestText, effectiveModelChoice, filterSessions, newId, offersFolders, offersModels, recapIsStale,
  searchSessions, sortProjects, sortSessions,
  type Agent, type Project, type SessionHit, type SessionRow, type SessionScope, type SessionStatus, type Thread,
} from "@homebase/protocol";
import { inScope } from "@homebase/protocol";
import { ago, dayTime } from "../format";
import { Header } from "../layout/Shell";
import { setSessionView, useSessionView } from "../sessionView";
import { useMap, useNow, useSync } from "../sync/hooks";
import { mutate } from "../sync/session";
import { color, radius, space, tint } from "../theme";
import { AgentAvatar } from "./bits";
import { FolderPicker, startsIn } from "./Folders";
import { AnswerMarkdown } from "./NoteMarkdown";
import { Field, Input, Sheet } from "./Sheet";
import { Btn, Chip, Dot, Empty, Icon, IconBtn, Row, T, Tag, type IconName } from "./ui";

/**
 * Sessions: every chat with an agent, findable again. A session is filed in one project or sits in
 * Unsorted; the list can be narrowed to a project, filtered by what needs the owner, sorted and searched
 * by more than its title (the owner's note, the agent's recap, the last reply, project, agent, messages).
 * The same components serve the phone and the desktop window.
 */

const pane = { flex: 1, backgroundColor: color.bg } as const;

/** One row per session from what this device holds. Rebuilt only when a source map changes. */
export function useSessionRows(): SessionRow[] {
  const threads = useMap("threads");
  const projects = useMap("projects");
  const agents = useMap("agents");
  const messages = useMap("messages");
  const runs = useMap("runs");
  const approvals = useMap("approvals");
  return useMemo(
    () => buildSessionRows({
      threads: Object.values(threads), projects, agents, messages: Object.values(messages), runs: Object.values(runs), approvals: Object.values(approvals),
    }),
    [threads, projects, agents, messages, runs, approvals],
  );
}

const STATUS: Record<Exclude<SessionStatus, "idle">, { label: string; tone: string; icon: IconName }> = {
  waiting: { label: "WAITING FOR YOU", tone: color.p1, icon: "pause-circle" },
  failed: { label: "FAILED", tone: color.danger, icon: "x-circle" },
  offline: { label: "CONNECTOR OFFLINE", tone: color.textMuted, icon: "wifi-off" },
  running: { label: "RUNNING", tone: color.accent, icon: "zap" },
};

export function SessionStatusTag({ status }: { status: SessionStatus }) {
  if (status === "idle") return null;
  const m = STATUS[status];
  return <Tag label={m.label} tone={m.tone} icon={m.icon} />;
}

const LEFT_ICON: Record<"note" | "recap" | "summary", IconName> = { note: "edit-3", recap: "list", summary: "corner-down-right" };
const HIT_LABEL: Record<string, string> = { note: "Your note", recap: "Recap", summary: "Last reply", project: "Project", agent: "Agent" };

/** The line under a session's title: the search hit, what it waits on, where it was left, or its last message. */
function leftLine(h: SessionHit): { icon: IconName; text: string; tone?: string; label?: string } {
  const r = h.row;
  if (h.hit && h.hit.field !== "project" && h.hit.field !== "agent") {
    const label = h.hit.field === "message" ? (h.hit.role === "user" ? "You said" : "Agent said") : HIT_LABEL[h.hit.field];
    return { icon: "search", text: h.hit.snippet, label, tone: color.text };
  }
  if (r.waitingOn) return { icon: "pause-circle", text: `Waiting for you: ${r.waitingOn}`, tone: color.p1 };
  if (r.left.source !== "none") return { icon: LEFT_ICON[r.left.source], text: r.left.text };
  if (r.last) return { icon: "corner-down-right", text: `${r.last.role === "user" ? "You: " : ""}${digestText(r.last.text, 160)}` };
  return { icon: "minus", text: "Nothing said yet" };
}

export function SessionRowView({ hit, now, selected, showProject = true, onOpen, onMore }: {
  hit: SessionHit; now: number; selected?: boolean; showProject?: boolean; onOpen?: (row: SessionRow) => void; onMore?: (threadId: string) => void;
}) {
  const row = hit.row;
  const t = row.thread;
  // Unread: the agent said something here that the owner has not had on screen, on any device (kept by the hub).
  const unread = row.unread;
  const line = leftLine(hit);
  return (
    <Row selected={selected} accessibilityLabel={`Session ${t.title}${unread ? ", unread" : ""}`} testID={`session-${t.id}`}
      onPress={() => { onOpen?.(row); router.navigate(`/chats/${t.id}` as any); }} onLongPress={onMore ? () => onMore(t.id) : undefined}>
      <View style={st.rowH}>
        {row.agent ? <AgentAvatar name={row.agent.name} online={row.agent.status === "online"} /> : <View style={st.scratch}><Icon name="edit-3" size={17} /></View>}
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <View style={[st.rowH, { gap: 6, alignItems: "center" }]}>
            {unread ? <Dot tone={color.accent} size={8} /> : null}
            {t.pinned ? <Icon name="bookmark" size={12} tone={color.accent} /> : null}
            <T v="heading" numberOfLines={1} style={[{ fontSize: 15, flexShrink: 1 }, unread && st.unreadTitle, t.archived && { color: color.textDim }]}>{t.title}</T>
          </View>
          <View style={[st.rowH, { gap: 6 }]}>
            <Icon name={line.icon} size={12} tone={line.tone ?? color.textMuted} style={{ marginTop: 3 }} />
            <T v="small" numberOfLines={2} tone={line.tone ?? (unread ? color.text : undefined)} style={{ flex: 1 }}>
              {line.label ? <T v="small" muted>{line.label}: </T> : null}{line.text}
            </T>
          </View>
          <View style={[st.rowH, { gap: 6, marginTop: 2, alignItems: "center", flexWrap: "wrap" }]}>
            {showProject && row.project ? <Tag label={row.project.name} icon="folder" /> : null}
            <SessionStatusTag status={row.status} />
            {t.archived ? <Tag label="ARCHIVED" tone={color.textMuted} /> : null}
            <T v="small" muted style={{ fontSize: 12 }} numberOfLines={1}>{row.agent?.name ?? "No agent"} · {ago(row.lastAt, now) || "now"}</T>
          </View>
        </View>
        {onMore ? <IconBtn icon="more-horizontal" label={`File or change ${t.title}`} size={18} onPress={() => onMore(t.id)} style={st.more} /> : null}
      </View>
    </Row>
  );
}

// ---------------------------------------------------------------- one session: file, rename, note, pin, archive

/** Everything that organises one session, in one sheet: its project, its name, where it was left, pin and archive. */
export function SessionSheet({ threadId, onClose }: { threadId: string | null; onClose: () => void }) {
  const thread = useSync((s) => (threadId ? s.entities.threads[threadId] : undefined));
  const projectMap = useMap("projects");
  const projects = useMemo(() => sortProjects(Object.values(projectMap), () => null), [projectMap]);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [adding, setAdding] = useState<string | null>(null);
  useEffect(() => {
    setTitle(thread?.title ?? "");
    setNote(thread?.note ?? "");
    setAdding(null);
    // Only when another session is opened: typing must not be reset by a sync of the same session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);
  if (!thread) return <Sheet visible={false} title="Session" onClose={onClose}>{null}</Sheet>;
  const update = (patch: Omit<Parameters<typeof mutate<"thread.update">>[1], "threadId">) => void mutate("thread.update", { threadId: thread.id, ...patch });
  const current = thread.projectId && projectMap[thread.projectId] ? thread.projectId : null;
  const dirty = title.trim() !== thread.title || note.trim() !== (thread.note ?? "");
  const save = () => {
    const patch: { title?: string; note?: string | null } = {};
    if (title.trim() && title.trim() !== thread.title) patch.title = title.trim().slice(0, 200);
    if (note.trim() !== (thread.note ?? "")) patch.note = note.trim() || null;
    if (Object.keys(patch).length) update(patch);
    onClose();
  };
  const createAndMove = () => {
    const name = (adding ?? "").trim();
    if (!name) return;
    const projectId = newId("prj");
    void mutate("project.create", { projectId, name: name.slice(0, 80) });
    update({ projectId });
    setAdding(null);
  };
  return (
    <Sheet visible title="Session" subtitle={thread.title} onClose={onClose} testID="session-sheet">
      <Field label="Project" hint="A session is in one project, or in Unsorted. Moving it never changes the agent's working directory.">
        <View style={st.wrap}>
          <Chip label="Unsorted" icon="layers" selected={current === null} onPress={() => update({ projectId: null })} />
          {projects.map((p) => <Chip key={p.id} label={p.name} icon="folder" selected={current === p.id} onPress={() => update({ projectId: p.id })} />)}
          {adding === null ? <Chip label="New project" icon="plus" onPress={() => setAdding("")} /> : null}
        </View>
        {adding !== null ? (
          <View style={[st.rowH, { alignItems: "center", gap: space.sm }]}>
            <Input value={adding} onChangeText={setAdding} autoFocus placeholder="Project name" style={{ flex: 1 }} accessibilityLabel="New project name"
              onSubmitEditing={createAndMove} returnKeyType="done" maxLength={80} />
            <Btn small kind="primary" label="Create & move" onPress={createAndMove} disabled={!adding.trim()} />
          </View>
        ) : null}
      </Field>
      <Field label="Where you left off" hint="Your own note. It shows under the session in every list and at the top when you come back to it.">
        <Input value={note} onChangeText={setNote} multiline placeholder="e.g. Waiting on the client's API key. Next: rerun the import." maxLength={4000}
          accessibilityLabel="Where you left off" testID="session-note" />
      </Field>
      <Field label="Name">
        <Input value={title} onChangeText={setTitle} maxLength={200} accessibilityLabel="Session name" />
      </Field>
      <View style={[st.rowH, { gap: space.sm }]}>
        <Btn grow icon="bookmark" label={thread.pinned ? "Unpin" : "Pin"} onPress={() => update({ pinned: !thread.pinned })} />
        <Btn grow icon="archive" label={thread.archived ? "Unarchive" : "Archive"} onPress={() => { update({ archived: !thread.archived }); onClose(); }} />
      </View>
      <Btn kind="primary" icon="check" label={dirty ? "Save" : "Done"} onPress={save} testID="session-save" />
    </Sheet>
  );
}

// ---------------------------------------------------------------- a new session

export function createSession(agent: Agent | null, projectId: string | null, folder?: { cwd?: string | null }): string {
  const threadId = newId("thr");
  // A placeholder title: the hub renames the session after the first thing said in it.
  // A folder picked in the New session sheet goes with it; with none, the project's or the agent's applies at the first message.
  void mutate("thread.create", {
    threadId, title: agent ? `New session with ${agent.name}` : "New scratch thread", agentId: agent?.id ?? null, projectId,
    ...(agent && folder?.cwd ? { cwd: folder.cwd } : {}),
  });
  router.navigate(`/chats/${threadId}` as any);
  return threadId;
}

/** Pick the agent (and the project) for a new session. */
export function NewSessionSheet({ visible, onClose, projectId }: { visible: boolean; onClose: () => void; projectId: string | null }) {
  const agents = useMap("agents");
  const projectMap = useMap("projects");
  const projects = useMemo(() => sortProjects(Object.values(projectMap), () => null), [projectMap]);
  const [target, setTarget] = useState<string | null>(projectId);
  // The folder picked for each agent in this sheet (agent id -> path), and the agent whose folder is being picked.
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [picking, setPicking] = useState<string | null>(null);
  useEffect(() => {
    if (!visible) return;
    setTarget(projectId && projectMap[projectId] ? projectId : null);
    setChosen({});
    setPicking(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, projectId]);
  const def = target ? projectMap[target]?.defaultAgentId : null;
  const list = useMemo(
    () => Object.values(agents).sort((a, b) => Number(b.id === def) - Number(a.id === def) || a.name.localeCompare(b.name)),
    [agents, def],
  );
  const start = (agent: Agent | null) => {
    onClose();
    createSession(agent, target, agent && chosen[agent.id] ? { cwd: chosen[agent.id] } : undefined);
  };
  const pickFor = picking ? agents[picking] : undefined;
  if (pickFor) {
    return (
      <Sheet visible={visible} title="A folder for this session" subtitle={`${pickFor.name} works in it`} onClose={onClose} testID="new-session-sheet">
        <FolderPicker agent={pickFor} purpose="primary" onCancel={() => setPicking(null)}
          onPick={(f) => { setChosen({ ...chosen, [pickFor.id]: f.path }); setPicking(null); }} />
      </Sheet>
    );
  }
  return (
    <Sheet visible={visible} title="New session" subtitle={target ? `In ${projectMap[target]?.name}` : "In Unsorted"} onClose={onClose} testID="new-session-sheet">
      <Field label="File it in">
        <View style={st.wrap}>
          <Chip label="Unsorted" icon="layers" selected={target === null} onPress={() => setTarget(null)} />
          {projects.map((p) => <Chip key={p.id} label={p.name} icon="folder" selected={target === p.id} onPress={() => setTarget(p.id)} />)}
        </View>
      </Field>
      <Field label="Start it with">
        <View>
          {list.map((a) => (
            <Row key={a.id} onPress={() => start(a)} style={{ minHeight: 56, paddingHorizontal: space.sm }} accessibilityLabel={`New session with ${a.name}`}>
              <View style={[st.rowH, { alignItems: "center" }]}>
                <AgentAvatar name={a.name} online={a.status === "online"} size={34} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={[st.rowH, { gap: 6, alignItems: "center" }]}>
                    <T v="heading" style={{ fontSize: 14 }}>{a.name}</T>
                    {a.id === def ? <Tag label="PROJECT DEFAULT" /> : null}
                  </View>
                  <T v="small" numberOfLines={1}>{a.description}</T>
                  {/* What a new session with this agent starts on. It can be changed in the session before the first message. */}
                  <T v="small" muted numberOfLines={1} style={{ fontSize: 12 }}>
                    {offersModels(a) ? `Starts on ${describeChoice(effectiveModelChoice(a).model, effectiveModelChoice(a).effort)}` : "Scripted agent · no model"}
                  </T>
                  {/* The folder a new session with this agent works in, next to its model. Tap the line to pick another one. */}
                  {offersFolders(a) ? (() => {
                    const s = startsIn(a, target ? projectMap[target] : undefined, chosen[a.id] ?? null);
                    return (
                      <Pressable onPress={() => setPicking(a.id)} hitSlop={6} accessibilityRole="button" testID={`new-session-folder-${a.key}`}
                        accessibilityLabel={`Folder for a session with ${a.name}: ${s.label}, ${s.why}. Tap to choose another.`} style={st.folderLine}>
                        <Icon name="folder" size={12} tone={color.text} />
                        <T v="small" tone={color.text} numberOfLines={1} style={{ fontSize: 12, flexShrink: 1 }}>Works in {s.label}</T>
                        <T v="small" muted numberOfLines={1} style={{ fontSize: 12, flexShrink: 4, minWidth: 48 }}>· {s.why} · change</T>
                      </Pressable>
                    );
                  })() : null}
                  {a.statusNote ? <T v="small" tone={color.warn} numberOfLines={2}>{a.statusNote}</T> : null}
                </View>
                <Icon name="chevron-right" tone={color.textMuted} />
              </View>
            </Row>
          ))}
          <Row onPress={() => start(null)} style={{ minHeight: 48, paddingHorizontal: space.sm }}>
            <View style={[st.rowH, { alignItems: "center" }]}><Icon name="edit-3" /><T v="heading" style={{ fontSize: 14 }}>No agent, just a scratch thread</T></View>
          </Row>
        </View>
      </Field>
    </Sheet>
  );
}

// ---------------------------------------------------------------- the list

export function SearchBox({ value, onChange, placeholder, right, testID }: { value: string; onChange: (v: string) => void; placeholder: string; right?: React.ReactNode; testID?: string }) {
  return (
    <View style={st.search}>
      <Icon name="search" size={16} tone={color.textMuted} />
      <TextInput value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={color.textMuted} style={st.searchInput}
        accessibilityLabel={placeholder} autoCapitalize="none" autoCorrect={false} returnKeyType="search" testID={testID} />
      {value ? <IconBtn icon="x" label="Clear search" size={16} onPress={() => onChange("")} style={st.inBox} /> : null}
      {right}
    </View>
  );
}

const scopeName = (scope: SessionScope, projects: Record<string, Project>) =>
  scope === "all" ? "all projects" : scope === UNSORTED ? "Unsorted" : projects[scope]?.name ?? "all projects";

/** The Sessions tab: every session, narrowed by project, filter and search. Also the list beside an open session. */
export function SessionList({ selectedId }: { selectedId?: string }) {
  const rows = useSessionRows();
  const messages = useMap("messages");
  const projects = useMap("projects");
  const view = useSessionView();
  const now = useNow();
  const [creating, setCreating] = useState(false);
  const [tools, setTools] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const query = useDeferredValue(view.query).trim();
  // A project removed on another device leaves no dangling scope.
  const scope = view.scope === "all" || view.scope === UNSORTED || projects[view.scope] ? view.scope : "all";

  const inFilter = useMemo(() => {
    const list = filterSessions(rows, { filter: view.filter });
    // Under "Unread", the session being read stays in the list until the owner leaves it.
    if (view.filter === "unread" && selectedId && !list.some((r) => r.thread.id === selectedId)) {
      const open = rows.find((r) => r.thread.id === selectedId && !r.thread.archived);
      if (open) list.push(open);
    }
    return list;
  }, [rows, view.filter, selectedId]);
  const unreadTotal = useMemo(() => rows.filter((r) => r.unread && !r.thread.archived).length, [rows]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: inFilter.length, [UNSORTED]: 0 };
    for (const r of inFilter) {
      const k = r.project?.id ?? UNSORTED;
      c[k] = (c[k] ?? 0) + 1;
    }
    return c;
  }, [inFilter]);
  const lastAt = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of rows) if (r.project && !r.thread.archived) m[r.project.id] = Math.max(m[r.project.id] ?? 0, r.lastAt);
    return m;
  }, [rows]);
  const projectList = useMemo(() => sortProjects(Object.values(projects), (p) => lastAt[p.id] ?? null), [projects, lastAt]);

  const { hits, elsewhere } = useMemo(() => {
    const scoped = inFilter.filter((r) => inScope(r, scope));
    if (!query) return { hits: sortSessions(scoped, view.sort).map((row): SessionHit => ({ row, score: 0, hit: null })), elsewhere: 0 };
    const all = searchSessions(inFilter, query, Object.values(messages));
    const here = scope === "all" ? all : all.filter((h) => scoped.includes(h.row));
    return { hits: here, elsewhere: all.length - here.length };
  }, [inFilter, scope, view.filter, view.sort, query, messages]);

  // "Unread" has its own chip in front of the projects, so it does not open the filter panel.
  const custom = (view.filter !== "open" && view.filter !== "unread") || view.sort !== "recent";
  const filterLabel = SESSION_FILTERS.find((f) => f.value === view.filter)?.label.toLowerCase() ?? "open";
  // Under "Unread" the session being read is still listed, but it no longer counts.
  const shownCount = view.filter === "unread" ? inFilter.filter((r) => r.unread && inScope(r, scope)).length : counts[scope === "all" ? "all" : scope] ?? 0;
  // "3 open", "1 needs you", "2 need you".
  const countLabel = view.filter === "attention" ? `${shownCount} need${shownCount === 1 ? "s" : ""} you` : `${shownCount} ${filterLabel}`;
  return (
    <View style={pane}>
      <View style={st.padH}>
        <Header title="Sessions" large
          subtitle={query ? `${hits.length} match${hits.length === 1 ? "" : "es"} · ${scopeName(scope, projects)}` : `${countLabel} · ${scopeName(scope, projects)}`}
          right={<Btn small kind="primary" icon="plus" label="New" onPress={() => setCreating(true)} testID="new-session" />} />
        <SearchBox value={view.query} onChange={(q) => setSessionView({ query: q })} placeholder="Search sessions, notes and messages" testID="session-search"
          right={<IconBtn icon="sliders" label="Filter and sort" size={17} active={tools || custom} onPress={() => setTools(!tools)} style={st.inBox} />} />
      </View>
      <View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.chips}>
          {unreadTotal > 0 || view.filter === "unread" ? (
            <>
              <Chip label="Unread" count={unreadTotal} selected={view.filter === "unread"}
                onPress={() => setSessionView({ filter: view.filter === "unread" ? "open" : "unread" })} />
              <View style={st.chipSep} />
            </>
          ) : null}
          <Chip label="All" count={counts.all} selected={scope === "all"} onPress={() => setSessionView({ scope: "all" })} />
          <Chip label="Unsorted" icon="layers" count={counts[UNSORTED]} selected={scope === UNSORTED} onPress={() => setSessionView({ scope: UNSORTED })} />
          {projectList.map((p) => (
            <Chip key={p.id} label={p.name} icon="folder" count={counts[p.id] ?? 0} selected={scope === p.id} onPress={() => setSessionView({ scope: p.id })} />
          ))}
        </ScrollView>
      </View>
      {tools || custom ? (
        <View style={st.tools}>
          <View style={st.toolRow}>
            <T v="micro" style={st.toolLabel}>Show</T>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
              {SESSION_FILTERS.map((f) => <Chip key={f.value} label={f.label} selected={view.filter === f.value} onPress={() => setSessionView({ filter: f.value })} />)}
            </ScrollView>
          </View>
          <View style={st.toolRow}>
            <T v="micro" style={st.toolLabel}>Sort</T>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
              {SESSION_SORTS.map((s) => <Chip key={s.value} label={s.label} selected={!query && view.sort === s.value} onPress={() => setSessionView({ sort: s.value })} />)}
            </ScrollView>
          </View>
          {query ? <T v="small" muted style={{ fontSize: 12 }}>While you search, the best match comes first.</T> : null}
        </View>
      ) : null}
      <FlatList
        data={hits}
        keyExtractor={(h) => h.row.thread.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: space.sm, paddingBottom: space.xxl, flexGrow: 1 }}
        renderItem={({ item }) => <SessionRowView hit={item} now={now} selected={item.row.thread.id === selectedId} showProject={scope === "all"} onMore={setMenu} />}
        ListEmptyComponent={
          query ? <Empty icon="search" title={`Nothing matches “${query}”`} body={`Searched titles, your notes, recaps, last replies and messages in ${scopeName(scope, projects)}.`} />
          : view.filter === "unread" ? <Empty icon="check" title="Nothing unread" body="You have seen everything your agents said. Tap Unread again to show every session." />
          : scope === UNSORTED ? <Empty icon="layers" title="Nothing unsorted" body="New sessions land here until you file them in a project." />
          : view.filter !== "open" ? <Empty icon="filter" title={view.filter === "attention" ? "Nothing needs you" : `No ${filterLabel} sessions`} body="Change the filter to see the rest." />
          : <Empty icon="message-square" title="No sessions yet" body="Start one with an agent and talk to it by text or voice." />
        }
        ListFooterComponent={query && elsewhere > 0 ? (
          <Pressable onPress={() => setSessionView({ scope: "all" })} style={st.elsewhere} accessibilityRole="button">
            <Icon name="search" size={14} />
            <T v="small" tone={color.text}>{elsewhere} more match{elsewhere === 1 ? "" : "es"} in other projects. Search everywhere</T>
          </Pressable>
        ) : undefined}
      />
      <NewSessionSheet visible={creating} onClose={() => setCreating(false)} projectId={scope !== "all" && scope !== UNSORTED ? scope : null} />
      <SessionSheet threadId={menu} onClose={() => setMenu(null)} />
    </View>
  );
}

// ---------------------------------------------------------------- inside a session: where it was left

const HOUR = 3_600_000;

/**
 * The strip under a session's header. One line when the session is fresh; opened by itself when the
 * owner comes back after half a day or more, showing their note, the agent's recap and the last reply.
 */
export function LeftOffBar({ thread, agent, live, now, onEdit }: { thread: Thread; agent: Agent | undefined; live: boolean; now: number; onEdit: () => void }) {
  const quietFor = now - (thread.lastMessageAt ?? thread.createdAt);
  const [open, setOpen] = useState(() => quietFor > 12 * HOUR && !!(thread.note || thread.recap || thread.summary));
  const writing = !!thread.recapRunId;
  const stale = !!thread.recap && recapIsStale(thread);
  const head = thread.note?.trim() || (thread.recap && !stale ? digestText(thread.recap, 200) : "") || thread.summary || (thread.recap ? digestText(thread.recap, 200) : "");
  if (!head && !agent) return null;
  const recap = () => void mutate("thread.recap", { threadId: thread.id, messageId: newId("msg") });
  return (
    <View style={st.left} testID="left-off">
      <Pressable onPress={() => setOpen(!open)} style={st.leftHead} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel="Where you left off">
        <Icon name="flag" size={13} tone={color.textDim} />
        <T v="micro" tone={color.textDim}>Left off</T>
        <T v="small" numberOfLines={1} style={{ flex: 1 }} tone={open ? color.textMuted : color.text}>
          {open ? (quietFor > HOUR ? `Last activity ${dayTime(thread.lastMessageAt ?? thread.createdAt)}` : "") : head || "Nothing yet. Add a note or ask for a recap."}
        </T>
        <Icon name={open ? "chevron-up" : "chevron-down"} size={16} />
      </Pressable>
      {open ? (
        <ScrollView style={{ maxHeight: 300 }} contentContainerStyle={st.leftBody}>
          <View style={st.leftPart}>
            <T v="micro">Your note</T>
            {thread.note ? <T selectable style={{ fontSize: 14.5, lineHeight: 21 }}>{thread.note}</T> : <T v="small" muted>No note yet.</T>}
          </View>
          {thread.recap || writing ? (
            <View style={st.leftPart}>
              <View style={[st.rowH, { gap: 6, alignItems: "center" }]}>
                <T v="micro">Recap from {agent?.name ?? "the agent"}</T>
                {thread.recapAt ? <T v="small" muted style={{ fontSize: 11 }}>{dayTime(thread.recapAt)}</T> : null}
                {stale && !writing ? <Tag label="BEFORE THE LATEST MESSAGES" tone={color.p1} /> : null}
              </View>
              {writing ? <T v="small" tone={color.accent}>Writing a recap…</T> : null}
              {thread.recap ? <AnswerMarkdown text={thread.recap} /> : null}
            </View>
          ) : null}
          {thread.summary && !(thread.recap && !stale) ? (
            <View style={st.leftPart}>
              <T v="micro">Last reply</T>
              <T v="small" selectable>{thread.summary}</T>
            </View>
          ) : null}
          <View style={[st.rowH, { gap: space.sm, flexWrap: "wrap" }]}>
            <Btn small icon="edit-3" label={thread.note ? "Edit note" : "Add a note"} onPress={onEdit} />
            {agent ? (
              <Btn small icon="list" label={writing ? "Writing a recap…" : thread.recap ? "Ask for a fresh recap" : "Ask for a recap"} onPress={recap}
                disabled={live || writing || !agent.connectorId} testID="ask-recap" />
            ) : null}
          </View>
          {agent ? <T v="small" muted style={{ fontSize: 12 }}>A recap is one more turn in this same agent session: it continues where you stopped and is kept here.</T> : null}
        </ScrollView>
      ) : null}
    </View>
  );
}

const st = StyleSheet.create({
  padH: { paddingHorizontal: space.lg },
  rowH: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  folderLine: {
    flexDirection: "row", alignItems: "center", gap: 5, alignSelf: "flex-start", maxWidth: "100%", marginTop: 4, paddingHorizontal: 8, height: 26, borderRadius: radius.pill,
    borderWidth: 1, borderColor: color.borderStrong, backgroundColor: color.surface2,
  },
  scratch: { width: 40, height: 40, borderRadius: 13, backgroundColor: color.surface2, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: color.border },
  more: { width: 36, height: 36, marginRight: -8, marginTop: -4 },
  chips: { paddingHorizontal: space.lg, gap: space.sm, paddingBottom: space.md, paddingTop: space.md },
  chipSep: { width: 1, alignSelf: "stretch", marginVertical: 6, backgroundColor: color.border },
  unreadTitle: { fontFamily: "SpaceGrotesk_700Bold" },
  search: {
    flexDirection: "row", alignItems: "center", gap: space.sm, backgroundColor: color.surface, borderRadius: radius.md, borderWidth: 1, borderColor: color.border,
    paddingLeft: space.md, paddingRight: 6, height: 46,
  },
  searchInput: { flex: 1, minWidth: 0, color: color.text, fontSize: 15, height: 44, outlineStyle: "none" } as any,
  inBox: { width: 34, height: 34 },
  tools: { paddingHorizontal: space.lg, paddingBottom: space.md, gap: space.sm },
  toolRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  toolLabel: { width: 38 },
  elsewhere: {
    flexDirection: "row", alignItems: "center", gap: space.sm, margin: space.md, padding: space.md, borderRadius: radius.md, borderWidth: 1,
    borderColor: color.border, backgroundColor: color.surface,
  },
  left: { borderTopWidth: 1, borderTopColor: color.border, marginHorizontal: -space.lg, paddingHorizontal: space.lg, backgroundColor: color.surface },
  leftHead: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 40 },
  leftBody: { gap: space.md, paddingBottom: space.md, maxWidth: 860 },
  leftPart: { gap: 4, borderLeftWidth: 2, borderLeftColor: tint(color.accent, 0.25), paddingLeft: space.md },
});
