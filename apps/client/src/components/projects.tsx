import { router } from "expo-router";
import React, { useDeferredValue, useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import {
  DEFAULT_IMAGE_ROUTE, IMAGE_ROUTES, ROUTE_BLURB, ROUTE_LABEL, UNSORTED, filterSessions, folderLabel, newId, projectAgents, projectStats, searchSessions, sortProjects, sortSessions,
  type Project, type ProjectStats, type SessionHit, type SessionRow,
} from "@homebase/protocol";
import { ago } from "../format";
import { Header, Screen } from "../layout/Shell";
import { setSessionView } from "../sessionView";
import { useMap, useNow } from "../sync/hooks";
import { mutate } from "../sync/session";
import { color, radius, space } from "../theme";
import { AgentAvatar, ConfirmDialog } from "./bits";
import { ProjectFolders } from "./Folders";
import { ProjectAssets } from "./ImageCards";
import { Placeholder, RunRow } from "./lists";
import { NewSessionSheet, SearchBox, SessionRowView, SessionSheet, SessionStatusTag, createSession, useSessionRows } from "./sessions";
import { Field, Input, Sheet } from "./Sheet";
import { Btn, Card, Chip, Empty, Icon, IconBtn, Row, SectionTitle, T, Tag } from "./ui";

/**
 * Projects: one tap to everything about a piece of work. A project is the folder its sessions are
 * filed in, plus the agents that work in it and what happened lately. The same screens serve the phone
 * (a bottom tab) and the desktop window (a rail item, list and detail side by side).
 */

const pane = { flex: 1, backgroundColor: color.bg } as const;

export function ProjectAvatar({ name, size = 40 }: { name: string; size?: number }) {
  const initials = name.split(/[\s&/_-]+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?";
  return (
    <View style={[st.avatar, { width: size, height: size, borderRadius: size * 0.22 }]}>
      <T v="heading" style={{ fontSize: size * 0.36 }}>{initials}</T>
    </View>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function StatTags({ s }: { s: ProjectStats }) {
  return (
    <>
      {s.attention ? <Tag label={`${s.attention} NEED${s.attention === 1 ? "S" : ""} YOU`} tone={color.p1} icon="pause-circle" /> : null}
      {s.running ? <Tag label={`${s.running} RUNNING`} tone={color.accent} icon="zap" /> : null}
    </>
  );
}

/** Per-project numbers for the rows a device holds, plus the same for Unsorted. */
export function useProjectStats(rows: SessionRow[], projects: Record<string, Project>) {
  return useMemo(() => {
    const m: Record<string, ProjectStats> = { [UNSORTED]: projectStats(rows, UNSORTED) };
    for (const id of Object.keys(projects)) m[id] = projectStats(rows, id);
    return m;
  }, [rows, projects]);
}

// ---------------------------------------------------------------- add or edit a project

export function ProjectSheet({ visible, project, onClose, onCreated }: { visible: boolean; project?: Project; onClose: () => void; onCreated?: (id: string) => void }) {
  const agents = useMap("agents");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [agentId, setAgentId] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  useEffect(() => {
    if (!visible) return;
    setName(project?.name ?? "");
    setDescription(project?.description ?? "");
    setAgentId(project?.defaultAgentId ?? null);
    setCwd(project?.defaultCwd ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, project?.id]);
  const list = useMemo(() => Object.values(agents).sort((a, b) => a.name.localeCompare(b.name)), [agents]);
  const agent = agentId ? agents[agentId] : undefined;
  const dirs = agent?.workspaces ?? [];
  const save = () => {
    const n = name.trim().slice(0, 80);
    if (!n) return;
    const body = { name: n, description: description.trim() || null, defaultAgentId: agent?.id ?? null, defaultCwd: agent && cwd && dirs.some((w) => w.cwd === cwd) ? cwd : null };
    if (project) void mutate("project.update", { projectId: project.id, ...body });
    else {
      const projectId = newId("prj");
      void mutate("project.create", { projectId, ...body });
      onCreated?.(projectId);
    }
    onClose();
  };
  return (
    <Sheet visible={visible} title={project ? "Edit project" : "New project"} subtitle={project?.name} onClose={onClose} testID="project-sheet">
      <Field label="Name">
        <Input value={name} onChangeText={setName} autoFocus={!project} placeholder="e.g. Notetaker" maxLength={80} accessibilityLabel="Project name" testID="project-name"
          onSubmitEditing={save} returnKeyType="done" />
      </Field>
      <Field label="What it is" hint="Optional. Shown under the name.">
        <Input value={description} onChangeText={setDescription} multiline placeholder="A line about the app, the client or the goal" maxLength={2000}
          accessibilityLabel="Project description" style={{ minHeight: 68 }} />
      </Field>
      <Field label="Default agent" hint="New sessions in this project start with this agent. You can still pick another.">
        <View style={st.wrap}>
          <Chip label="Ask each time" selected={!agent} onPress={() => { setAgentId(null); setCwd(null); }} />
          {list.map((a) => <Chip key={a.id} label={a.name} icon="cpu" selected={agent?.id === a.id} onPress={() => { setAgentId(a.id); if (a.id !== agentId) setCwd(null); }} />)}
        </View>
      </Field>
      {agent && dirs.length ? (
        <Field label="Primary folder" hint="Where a new session's agent starts. These are the folders approved on the agent's machine; to add another, save and use Folders on the project page. A session keeps the folder it started in, so it can always be resumed.">
          <View style={st.wrap}>
            <Chip label="Agent default" selected={!cwd} onPress={() => setCwd(null)} />
            {dirs.map((w) => <Chip key={w.cwd} label={w.label} icon="folder" selected={cwd === w.cwd} onPress={() => setCwd(w.cwd)} />)}
          </View>
          {cwd ? <T v="mono" tone={color.textDim} style={{ fontSize: 12 }}>{cwd}</T> : null}
        </Field>
      ) : null}
      <Btn kind="primary" icon="check" label={project ? "Save" : "Create project"} onPress={save} disabled={!name.trim()} testID="project-save" />
    </Sheet>
  );
}

// ---------------------------------------------------------------- the list

export function ProjectList({ selectedId }: { selectedId?: string }) {
  const rows = useSessionRows();
  const projects = useMap("projects");
  const stats = useProjectStats(rows, projects);
  const now = useNow();
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const all = Object.values(projects);
  const archived = all.filter((p) => p.archived).length;
  const list = useMemo(() => sortProjects(Object.values(projects), (p) => stats[p.id]?.lastAt ?? null, showArchived), [projects, stats, showArchived]);
  const un = stats[UNSORTED];
  const openUnsorted = () => {
    setSessionView({ scope: UNSORTED, filter: "open", query: "" });
    router.navigate("/chats" as any);
  };
  return (
    <ScrollView style={pane} contentContainerStyle={{ paddingBottom: space.xxl, flexGrow: 1 }} keyboardShouldPersistTaps="handled">
      <View style={st.padH}>
        <Header title="Projects" subtitle={`${plural(all.length - archived, "project")} · ${un.sessions} unsorted`} large
          right={<Btn small kind="primary" icon="plus" label="New" onPress={() => setCreating(true)} testID="new-project" />} />
      </View>
      <View style={{ paddingHorizontal: space.sm }}>
        {list.map((p) => {
          const s = stats[p.id];
          return (
            <Row key={p.id} selected={p.id === selectedId} onPress={() => router.navigate(`/projects/${p.id}` as any)} accessibilityLabel={`Project ${p.name}`} testID={`project-${p.id}`}>
              <View style={st.rowH}>
                <ProjectAvatar name={p.name} />
                <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                  <View style={[st.rowH, { gap: 6, alignItems: "center" }]}>
                    {p.pinned ? <Icon name="bookmark" size={12} tone={color.accent} /> : null}
                    <T v="heading" numberOfLines={1} style={[{ fontSize: 15, flexShrink: 1 }, p.archived && { color: color.textDim }]}>{p.name}</T>
                  </View>
                  {p.description ? <T v="small" numberOfLines={1}>{p.description}</T> : null}
                  <View style={[st.rowH, { gap: 6, marginTop: 2, alignItems: "center", flexWrap: "wrap" }]}>
                    <StatTags s={s} />
                    {p.archived ? <Tag label="ARCHIVED" tone={color.textMuted} /> : null}
                    <T v="small" muted style={{ fontSize: 12 }}>{plural(s.sessions, "session")}{s.lastAt ? ` · ${ago(s.lastAt, now) || "now"}` : ""}</T>
                  </View>
                </View>
                <Icon name="chevron-right" tone={color.textMuted} />
              </View>
            </Row>
          );
        })}
        {list.length === 0 ? (
          <Empty icon="folder" title="No projects yet" body="A project keeps the sessions, agents and recent activity of one piece of work together. Add one, then file sessions into it.">
            <Btn kind="primary" icon="plus" label="New project" onPress={() => setCreating(true)} style={{ marginTop: space.md }} />
          </Empty>
        ) : null}
        <View style={st.rule} />
        <Row onPress={openUnsorted} accessibilityLabel={`Unsorted, ${un.sessions} sessions`} testID="project-unsorted">
          <View style={st.rowH}>
            <View style={[st.avatar, { width: 40, height: 40, borderRadius: 9, borderStyle: "dashed" }]}><Icon name="layers" size={17} /></View>
            <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
              <T v="heading" style={{ fontSize: 15 }}>Unsorted</T>
              <T v="small" numberOfLines={1}>Sessions that are not in a project yet. New ones land here.</T>
              <View style={[st.rowH, { gap: 6, marginTop: 2, alignItems: "center", flexWrap: "wrap" }]}>
                <StatTags s={un} />
                <T v="small" muted style={{ fontSize: 12 }}>{plural(un.sessions, "session")}{un.lastAt ? ` · ${ago(un.lastAt, now) || "now"}` : ""}</T>
              </View>
            </View>
            <Icon name="chevron-right" tone={color.textMuted} />
          </View>
        </Row>
        {archived ? (
          <Btn small kind="ghost" icon={showArchived ? "eye-off" : "archive"} label={showArchived ? "Hide archived projects" : `Show ${plural(archived, "archived project")}`}
            onPress={() => setShowArchived(!showArchived)} style={{ alignSelf: "flex-start", margin: space.md }} />
        ) : null}
      </View>
      <ProjectSheet visible={creating} onClose={() => setCreating(false)} onCreated={(id) => router.navigate(`/projects/${id}` as any)} />
    </ScrollView>
  );
}

// ---------------------------------------------------------------- one project

const SHOWN = 30;

export function ProjectDetail({ id }: { id: string }) {
  const projects = useMap("projects");
  const project = projects[id];
  const rows = useSessionRows();
  const agents = useMap("agents");
  const runs = useMap("runs");
  const messages = useMap("messages");
  const now = useNow();
  const [q, setQ] = useState("");
  const query = useDeferredValue(q).trim();
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);

  const mine = useMemo(() => rows.filter((r) => r.project?.id === id), [rows, id]);
  const stats = useMemo(() => projectStats(rows, id), [rows, id]);
  const hits = useMemo<SessionHit[]>(() => {
    const scoped = filterSessions(mine, { filter: showArchived ? "archived" : "open" });
    if (query) return searchSessions(scoped, query, Object.values(messages));
    return sortSessions(scoped, "attention").map((row) => ({ row, score: 0, hit: null }));
  }, [mine, showArchived, query, messages]);
  const team = useMemo(() => (project ? projectAgents(rows, project, agents) : []), [rows, project, agents]);
  const activity = useMemo(() => {
    const ids = new Set(mine.map((r) => r.thread.id));
    return Object.values(runs).filter((r) => r.threadId && ids.has(r.threadId)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 8);
  }, [runs, mine]);

  if (!project) return <Placeholder icon="folder" title="Project not found" body="It may have been removed on another device. Its sessions are in Unsorted." />;

  const def = project.defaultAgentId ? agents[project.defaultAgentId] : undefined;
  const dir = def && project.defaultCwd ? { label: folderLabel(def, project.defaultCwd) } : undefined;
  const open = () => setSessionView({ scope: id, filter: "open", query: "" });
  const start = () => (def ? (open(), createSession(def, id)) : setCreating(true));
  const latest = stats.latest;
  const update = (patch: Omit<Parameters<typeof mutate<"project.update">>[1], "projectId">) => void mutate("project.update", { projectId: id, ...patch });

  return (
    <Screen>
      <Header title={project.name} subtitle={project.description ?? "Project"} back="/projects"
        right={
          <>
            <IconBtn icon="bookmark" label={project.pinned ? "Unpin project" : "Pin project"} active={project.pinned} onPress={() => update({ pinned: !project.pinned })} />
            <IconBtn icon="edit-2" label="Edit project" onPress={() => setEditing(true)} />
          </>
        } />

      <View style={st.summary}>
        <ProjectAvatar name={project.name} size={48} />
        <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
          <View style={st.wrap}>
            <StatTags s={stats} />
            {project.archived ? <Tag label="ARCHIVED" tone={color.textMuted} /> : null}
            <Tag label={plural(stats.sessions, "session").toUpperCase()} />
            {dir ? <Tag label={`${dir.label}${project.folders?.length ? ` +${project.folders.length}` : ""}`} icon="folder" tone={color.text} /> : null}
          </View>
          <T v="small" muted numberOfLines={2}>
            {def ? `New sessions start with ${def.name}${dir ? ` in ${dir.label}` : ""}.` : "New sessions ask which agent to use."}
            {stats.lastAt ? ` Last active ${ago(stats.lastAt, now) || "now"}.` : ""}
          </T>
        </View>
      </View>
      <Btn kind="primary" icon="plus" label={def ? `New session with ${def.name}` : "New session"} onPress={start} testID="project-new-session" />

      {latest ? (
        <>
          <SectionTitle title="Pick up where you left off" />
          <Card pad={space.md} style={{ gap: space.sm }} onPress={() => { open(); router.navigate(`/chats/${latest.thread.id}` as any); }}>
            <View style={[st.rowH, { alignItems: "center" }]}>
              <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                <T v="heading" numberOfLines={1}>{latest.thread.title}</T>
                <T v="small" muted style={{ fontSize: 12 }}>{latest.agent?.name ?? "No agent"} · {ago(latest.lastAt, now) || "now"}</T>
              </View>
              <SessionStatusTag status={latest.status} />
            </View>
            <T v="small" numberOfLines={4} tone={latest.waitingOn ? color.p1 : color.textDim}>
              {latest.waitingOn ? `Waiting for you: ${latest.waitingOn}` : latest.left.text || "Nothing said yet."}
            </T>
            <View style={[st.rowH, { alignItems: "center", gap: 6 }]}>
              <T v="small" tone={color.text} style={{ fontFamily: "SpaceGrotesk_600SemiBold" }}>Continue this session</T>
              <Icon name="arrow-right" size={14} tone={color.text} />
            </View>
          </Card>
        </>
      ) : null}

      <SectionTitle title={showArchived ? "Archived sessions" : "Sessions"} count={hits.length} />
      {mine.length > 4 ? <View style={{ marginBottom: space.sm }}><SearchBox value={q} onChange={setQ} placeholder={`Search in ${project.name}`} testID="project-search" /></View> : null}
      <Card pad={4}>
        {hits.length === 0 ? (
          <T v="small" muted style={{ padding: space.md }}>
            {query ? `Nothing in this project matches “${query}”.` : showArchived ? "No archived sessions." : "No sessions yet. Start one above, or file one here from its ⋯ menu."}
          </T>
        ) : null}
        {hits.slice(0, SHOWN).map((h) => <SessionRowView key={h.row.thread.id} hit={h} now={now} showProject={false} onOpen={open} onMore={setMenu} />)}
      </Card>
      <View style={[st.wrap, { marginTop: space.sm }]}>
        {hits.length > SHOWN ? <Btn small kind="ghost" icon="list" label={`All ${hits.length} in Sessions`} onPress={() => { open(); router.navigate("/chats" as any); }} /> : null}
        {stats.archived || showArchived ? (
          <Btn small kind="ghost" icon={showArchived ? "eye-off" : "archive"} label={showArchived ? "Back to open sessions" : `${stats.archived} archived`} onPress={() => setShowArchived(!showArchived)} />
        ) : null}
      </View>

      {/* The project's folders on the default agent's machine: where its sessions start and what else they can see. */}
      <SectionTitle title="Folders" count={(project.defaultCwd ? 1 : 0) + (project.folders?.length ?? 0)} />
      <Card pad={space.md}><ProjectFolders project={project} agent={def} onNeedAgent={() => setEditing(true)} /></Card>

      <SectionTitle title="Images" />
      <Card pad={space.md} style={{ gap: space.md }}>
        <ProjectAssets projectId={id} />
        <View style={{ gap: 6 }}>
          <T v="micro">Who makes images in this project</T>
          <View style={st.wrap} accessibilityRole="radiogroup">
            {IMAGE_ROUTES.map((r) => (
              <Chip key={r} label={ROUTE_LABEL[r]} selected={(project.imageRoute ?? DEFAULT_IMAGE_ROUTE) === r}
                onPress={() => void mutate("images.set", { scope: "project", id, route: r === DEFAULT_IMAGE_ROUTE ? null : r })} />
            ))}
          </View>
          <T v="small" muted style={{ fontSize: 12 }}>{ROUTE_BLURB[project.imageRoute ?? DEFAULT_IMAGE_ROUTE]} A session can choose its own from its message box.</T>
        </View>
      </Card>

      <SectionTitle title="Agents" count={team.length} />
      <Card pad={4}>
        {team.length === 0 ? <T v="small" muted style={{ padding: space.md }}>No agent has worked here yet. Set a default agent, or start a session.</T> : null}
        {team.map((a) => (
          <Row key={a.agent.id} onPress={() => router.navigate(`/agents/${a.agent.id}` as any)} style={{ paddingHorizontal: space.md }} accessibilityLabel={`Agent ${a.agent.name}`}>
            <View style={[st.rowH, { alignItems: "center" }]}>
              <AgentAvatar name={a.agent.name} online={a.agent.status === "online"} size={36} />
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <View style={[st.rowH, { gap: 6, alignItems: "center" }]}>
                  <T v="heading" style={{ fontSize: 14 }} numberOfLines={1}>{a.agent.name}</T>
                  {a.isDefault ? <Tag label="DEFAULT" /> : null}
                </View>
                <T v="small" muted style={{ fontSize: 12 }}>{plural(a.sessions, "session")} here{a.lastAt ? ` · ${ago(a.lastAt, now) || "now"}` : ""}</T>
              </View>
              <Btn small icon="plus" label="Session" onPress={() => { open(); createSession(a.agent, id); }} />
            </View>
          </Row>
        ))}
      </Card>

      <SectionTitle title="Recent activity" count={activity.length} />
      <Card pad={4}>
        {activity.length === 0 ? <T v="small" muted style={{ padding: space.md }}>No runs on this device for this project yet.</T> : null}
        {activity.map((r) => <RunRow key={r.id} run={r} now={now} agentName={agents[r.agentId]?.name} />)}
      </Card>

      <View style={[st.wrap, { marginTop: space.xl }]}>
        <Btn small kind="ghost" icon="archive" label={project.archived ? "Unarchive project" : "Archive project"} onPress={() => update({ archived: !project.archived })} />
        <Btn small kind="ghost" icon="trash-2" label="Delete project" onPress={() => setDeleting(true)} />
      </View>

      <ProjectSheet visible={editing} project={project} onClose={() => setEditing(false)} />
      <NewSessionSheet visible={creating} onClose={() => setCreating(false)} projectId={id} />
      <SessionSheet threadId={menu} onClose={() => setMenu(null)} />
      <ConfirmDialog visible={deleting} title={`Delete ${project.name}?`} confirmLabel="Delete project"
        body={`The project is removed. Its ${plural(stats.sessions + stats.archived, "session")} ${stats.sessions + stats.archived === 1 ? "is" : "are"} kept and go back to Unsorted.`}
        onCancel={() => setDeleting(false)}
        onConfirm={() => { setDeleting(false); void mutate("project.delete", { projectId: id }); router.navigate("/projects" as any); }} />
    </Screen>
  );
}

// ---------------------------------------------------------------- Home: one tap into a project

/** A row of projects for the Home screen. Nothing is drawn until there is a project or something unsorted. */
export function ProjectStrip() {
  const rows = useSessionRows();
  const projects = useMap("projects");
  const stats = useProjectStats(rows, projects);
  const list = useMemo(() => sortProjects(Object.values(projects), (p) => stats[p.id]?.lastAt ?? null), [projects, stats]);
  const un = stats[UNSORTED];
  if (list.length === 0 && un.sessions === 0) return null;
  const tile = (key: string, name: string, s: ProjectStats, onPress: () => void, unsorted = false) => (
    <Card key={key} pad={space.md} onPress={onPress} style={st.tile}>
      <View style={[st.rowH, { gap: space.sm, alignItems: "center" }]}>
        {unsorted ? <Icon name="layers" size={15} /> : <Icon name="folder" size={15} tone={color.text} />}
        <T v="heading" numberOfLines={1} style={{ fontSize: 14, flexShrink: 1 }}>{name}</T>
      </View>
      <View style={[st.rowH, { gap: 6, alignItems: "center" }]}>
        {s.attention ? <View style={[st.pip, { backgroundColor: color.p1 }]} /> : s.running ? <View style={[st.pip, { backgroundColor: color.accent }]} /> : null}
        <T v="small" muted style={{ fontSize: 12 }} numberOfLines={1}>
          {s.attention ? `${s.attention} need${s.attention === 1 ? "s" : ""} you` : s.running ? `${s.running} running` : plural(s.sessions, "session")}
        </T>
      </View>
    </Card>
  );
  return (
    <>
      <SectionTitle title="Projects" count={list.length} action="All projects" onAction={() => router.navigate("/projects" as any)} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }} style={{ marginHorizontal: -2 }}>
        {list.map((p) => tile(p.id, p.name, stats[p.id], () => router.navigate(`/projects/${p.id}` as any)))}
        {un.sessions ? tile(UNSORTED, "Unsorted", un, () => { setSessionView({ scope: UNSORTED, filter: "open", query: "" }); router.navigate("/chats" as any); }, true) : null}
      </ScrollView>
    </>
  );
}

const st = StyleSheet.create({
  padH: { paddingHorizontal: space.lg },
  rowH: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, alignItems: "center" },
  avatar: { backgroundColor: color.surface2, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: color.borderStrong },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: color.border, marginHorizontal: space.lg, marginVertical: space.sm },
  summary: { flexDirection: "row", alignItems: "center", gap: space.md, marginTop: space.sm, marginBottom: space.md },
  tile: { width: 168, gap: 6, borderRadius: radius.md },
  pip: { width: 7, height: 7, borderRadius: 4 },
});
