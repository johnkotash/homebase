import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";
import {
  ACCESS_BLURB, ACCESS_LABEL, ACCESS_TAG, APPROVE_NOTE, PRIMARY_BLURB, approvedFolder, canBrowseFolders, folderLabel, folderName, foldersChipText, moveOptions,
  offersFolders, pathTail, resolveRunCwd, resolveRunFolders, sameFolder, startFolders, tidyFolders,
  type Agent, type ApprovedFolder, type FolderAccess, type FolderCheck, type FolderListing, type FolderRef, type Project, type ResolvedFolder, type Thread,
} from "@homebase/protocol";
import { folderRequest, mutate } from "../sync/session";
import { color, radius, space } from "../theme";
import { ConfirmDialog } from "./bits";
import { Field, Input, Sheet } from "./Sheet";
import { Btn, Chip, Icon, Row, T, Tag, type IconName } from "./ui";

/**
 * Folders, the same on the phone and the desktop: which folders on the connector's machine an agent
 * has at its disposal. One picker (approved folders, a browser of that machine, or a typed path) is used
 * everywhere: on a project, in the New session sheet, in a session and on an agent's page.
 *
 * What is shown here is the owner's choice. The connector's own allowlist is what is enforced: a folder
 * is approved there by an explicit step in the picker, and nothing that is not approved there is used.
 */

export interface PickedFolder {
  path: string;
  label: string;
  access: FolderAccess;
}
/** primary: a folder to work in (read & write). extra: a folder next to it, read-only or read & write. approve: only put it on the list. */
type Purpose = "primary" | "extra" | "approve";

const ACCESS_ICON: Record<FolderAccess, IconName> = { read: "eye", write: "edit-2" };
const ACCESS_SHORT: Record<FolderAccess, string> = {
  read: "The agent can read and search. Its file tools cannot change anything here.",
  write: "The agent can read and change files here.",
};

export function AccessTag({ access }: { access: FolderAccess }) {
  return <Tag label={ACCESS_TAG[access]} icon={ACCESS_ICON[access]} tone={access === "write" ? color.text : color.textDim} />;
}

const errorText = (e: unknown) => (e as Error)?.message || "That did not work.";

// ---------------------------------------------------------------- the picker

/**
 * Pick a folder on the agent's machine. Three ways in: a folder that is already approved there, the
 * browser (folder names only, limited to the roots the connector allows), or a typed path. A folder that
 * is not approved yet goes through one more step, which says what approving means.
 */
export function FolderPicker({ agent, purpose, exclude = [], onPick, onCancel }: {
  agent: Agent; purpose: Purpose; exclude?: string[]; onPick: (f: PickedFolder) => void; onCancel: () => void;
}) {
  const [view, setView] = useState<"home" | "browse">("home");
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [candidate, setCandidate] = useState<FolderCheck | null>(null);
  const [access, setAccess] = useState<FolderAccess>(purpose === "primary" ? "write" : "read");
  const facts = agent.folders ?? null;
  const online = agent.status === "online";
  const host = facts?.host ?? "the agent's machine";
  const used = (path: string) => exclude.some((x) => sameFolder(x, path));
  const approved = useMemo(
    () => (facts?.approved ?? []).filter((f) => !f.missing && !used(f.path) && (purpose !== "primary" || f.access === "write")),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [facts, purpose, exclude.join("|")],
  );

  const call = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(errorText(e));
      return null;
    } finally {
      setBusy(false);
    }
  };
  const browse = async (path?: string) => {
    const l = await call(() => folderRequest<FolderListing>(agent.id, "list", path ? { path } : {}));
    if (!l) return;
    setListing(l);
    setView("browse");
  };
  /** A folder was chosen: use it if it is approved for this, else show the approval step. */
  const choose = (c: FolderCheck) => {
    setError(null);
    if (!c.ok) return setError(c.reason ?? "This folder cannot be added.");
    if (used(c.path)) return setError("That folder is already in the list.");
    if (purpose === "primary" && c.approved === "write") return onPick({ path: c.path, label: c.label, access: "write" });
    if (purpose === "primary" && c.maxAccess !== "write") return setError(c.warnings[0] ?? `${c.label} can be added read-only at most, so an agent cannot work in it.`);
    setAccess(purpose === "primary" ? "write" : c.approved ?? "read");
    setCandidate(c);
  };
  const check = async (path: string) => {
    const c = await call(() => folderRequest<FolderCheck>(agent.id, "check", { path }));
    if (c) choose(c);
  };
  const confirm = async () => {
    if (!candidate) return;
    const needs = !candidate.approved || (access === "write" && candidate.approved !== "write") || (purpose === "approve" && candidate.approved !== access);
    if (!needs) return onPick({ path: candidate.path, label: candidate.label, access });
    const done = await call(() => folderRequest<ApprovedFolder>(agent.id, "approve", { path: candidate.path, access }));
    if (done) onPick({ path: done.path, label: done.label, access });
  };

  if (!offersFolders(agent)) {
    return (
      <>
        <Note icon="info">{agent.name}'s connector does not report folders. A scripted agent has none; for a Claude agent, update and restart its connector and the picker appears here.</Note>
        <Btn label="Back" onPress={onCancel} />
      </>
    );
  }

  // ---- the approval step
  if (candidate) {
    const needs = !candidate.approved || (access === "write" && candidate.approved !== "write") || (purpose === "approve" && candidate.approved !== access);
    const option = (a: FolderAccess, disabled: boolean) => (
      <Pressable key={a} onPress={disabled ? undefined : () => setAccess(a)} disabled={disabled} accessibilityRole="radio" accessibilityState={{ selected: access === a, disabled }}
        accessibilityLabel={`${ACCESS_LABEL[a]}. ${ACCESS_SHORT[a]}`} testID={`folder-access-${a}`}
        style={({ pressed, hovered }: any) => [st.option, access === a && st.optionOn, hovered && access !== a && !disabled && { backgroundColor: color.surface2 }, pressed && { opacity: 0.8 }, disabled && { opacity: 0.4 }]}>
        <Icon name={ACCESS_ICON[a]} size={16} tone={access === a ? color.text : color.textDim} />
        <View style={{ flex: 1, gap: 1 }}>
          <T v="heading" style={{ fontSize: 15 }}>{ACCESS_LABEL[a]}</T>
          <T v="small">{ACCESS_SHORT[a]}</T>
        </View>
        <View style={[st.radio, access === a && { borderColor: color.accent }]}>{access === a ? <View style={st.radioDot} /> : null}</View>
      </Pressable>
    );
    return (
      <>
        <View style={st.box} testID="folder-confirm">
          <View style={st.rowC}>
            <Icon name="folder" size={18} tone={color.text} />
            <T v="heading" style={{ flex: 1 }} numberOfLines={1}>{candidate.label}</T>
            {candidate.git ? <Tag label="GIT" /> : null}
            {candidate.approved ? <Tag label="APPROVED" icon="check" /> : <Tag label="NOT APPROVED YET" tone={color.p1} />}
          </View>
          <T v="mono" selectable tone={color.textDim} style={st.path}>{candidate.path}</T>
          <T v="small" muted style={{ fontSize: 12 }}>On {host}</T>
        </View>
        {candidate.warnings.map((w) => <Note key={w} icon="alert-triangle" tone={color.warn}>{w}</Note>)}
        {purpose === "primary" ? (
          <Note icon="edit-2">{PRIMARY_BLURB}</Note>
        ) : (
          <Field label="What the agent may do there">
            <View style={{ gap: 6 }} accessibilityRole="radiogroup">
              {option("read", false)}
              {option("write", candidate.maxAccess !== "write")}
            </View>
          </Field>
        )}
        {purpose !== "primary" ? <Note icon="shield">{ACCESS_BLURB[access]}</Note> : null}
        {needs ? <Note icon="lock">{APPROVE_NOTE}</Note> : null}
        {error ? <Note icon="alert-triangle" tone={color.danger}>{error}</Note> : null}
        <Btn kind="primary" icon="check" busy={busy} testID="folder-approve"
          label={needs ? (purpose === "approve" ? `Approve ${ACCESS_LABEL[access].toLowerCase()}` : `Approve and use, ${ACCESS_LABEL[access].toLowerCase()}`) : purpose === "primary" ? "Use this folder" : `Add ${ACCESS_LABEL[access].toLowerCase()}`}
          onPress={() => void confirm()} />
        <Btn kind="ghost" icon="arrow-left" label="Back, pick another" onPress={() => { setCandidate(null); setError(null); }} />
      </>
    );
  }

  // ---- the browser
  if (view === "browse" && listing) {
    const self = listing.self;
    return (
      <>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, alignItems: "center" }} testID="folder-crumbs">
          {listing.crumbs.map((c, i) => (
            <React.Fragment key={c.path}>
              {i ? <Icon name="chevron-right" size={13} tone={color.textMuted} /> : null}
              <Chip label={c.label} icon={i === 0 ? "hard-drive" : undefined} selected={i === listing.crumbs.length - 1} onPress={() => void browse(c.path)} />
            </React.Fragment>
          ))}
        </ScrollView>
        <View style={st.box}>
          <View style={st.rowC}>
            <Icon name="folder" size={18} tone={color.text} />
            <T v="heading" style={{ flex: 1 }} numberOfLines={1}>{self.label}</T>
            {self.git ? <Tag label="GIT" /> : null}
            {self.approved ? <AccessTag access={self.approved} /> : null}
          </View>
          <T v="mono" selectable tone={color.textDim} style={st.path}>{self.path}</T>
          {self.ok ? <Btn small kind="primary" icon="check" label={`Choose ${self.label}`} onPress={() => choose(self)} testID="folder-choose-here" style={{ alignSelf: "flex-start" }} />
            : <T v="small" tone={color.textDim}>{self.reason}</T>}
        </View>
        {error ? <Note icon="alert-triangle" tone={color.danger}>{error}</Note> : null}
        <View testID="folder-entries">
          {busy ? <ActivityIndicator color={color.textDim} style={{ margin: space.md }} /> : null}
          {listing.entries.length === 0 && !busy ? <T v="small" muted style={{ padding: space.sm }}>No folders in here.</T> : null}
          {listing.entries.map((e) => (
            <Row key={e.path} onPress={() => void browse(e.path)} style={st.entry} accessibilityLabel={`Open folder ${e.name}`} testID={`folder-entry-${e.name}`}>
              <View style={st.rowC}>
                <Icon name="folder" size={17} tone={e.blocked ? color.textMuted : color.text} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={[st.rowC, { gap: 6 }]}>
                    <T v="heading" numberOfLines={1} style={[{ fontSize: 14, flexShrink: 1 }, e.blocked ? { color: color.textDim } : null]}>{e.name}</T>
                    {e.git ? <Tag label="GIT" /> : null}
                    {e.approved ? <AccessTag access={e.approved} /> : null}
                  </View>
                  {e.blocked ? <T v="small" muted numberOfLines={2} style={{ fontSize: 12 }}>{e.blocked}</T> : null}
                </View>
                {!e.blocked && !used(e.path) ? <Btn small label="Choose" onPress={() => void check(e.path)} testID={`folder-pick-${e.name}`} /> : null}
                <Icon name="chevron-right" size={16} tone={color.textMuted} />
              </View>
            </Row>
          ))}
        </View>
        <T v="small" muted style={{ fontSize: 12 }}>
          Folders on {host}. Only folder names are listed, never files.
          {listing.hidden ? ` ${listing.hidden} hidden or protected folder${listing.hidden === 1 ? " is" : "s are"} not shown.` : ""}
          {listing.truncated ? " The list is cut short: type the path to go further." : ""}
        </T>
        <View style={st.rowC}>
          {listing.parent ? <Btn small grow icon="corner-left-up" label="Up" onPress={() => void browse(listing.parent!)} /> : null}
          <Btn small grow kind="ghost" icon="arrow-left" label="Approved folders" onPress={() => { setView("home"); setError(null); }} />
        </View>
      </>
    );
  }

  // ---- approved folders, and the two ways to add one
  return (
    <>
      {approved.length ? (
        <Field label={`Approved on ${host}`}>
          <View testID="folder-approved">
            {approved.map((f) => (
              <Row key={f.path} style={st.entry} accessibilityLabel={`Folder ${f.label}, ${ACCESS_LABEL[f.access]}`} testID={`folder-approved-${f.label}`}
                onPress={() => choose({ path: f.path, label: f.label, ok: true, reason: null, approved: f.access, source: f.source, maxAccess: f.source === "app" ? "write" : f.access, warnings: [], git: false })}>
                <View style={st.rowC}>
                  <Icon name={f.source === "sandbox" ? "box" : "folder"} size={17} tone={color.text} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <T v="heading" numberOfLines={1} style={{ fontSize: 14 }}>{f.label}</T>
                    <T v="mono" numberOfLines={1} tone={color.textMuted} style={{ fontSize: 11.5 }}>{pathTail(f.path, 44)}</T>
                  </View>
                  <AccessTag access={f.access} />
                </View>
              </Row>
            ))}
          </View>
        </Field>
      ) : (
        <T v="small" muted>{purpose === "primary" ? "No other folder is approved for working in yet." : "No other folder is approved yet."}</T>
      )}
      {canBrowseFolders(agent) ? (
        <Field label="Add another folder" hint={online ? `Browse ${host}, or type a full path. A new folder is approved in the next step.` : `${agent.name} is offline. Folders are on its machine, so a new one can be added when it is back.`}>
          <Btn icon="hard-drive" label={`Browse ${host}`} onPress={() => void browse()} disabled={!online} busy={busy && !typed} testID="folder-browse" />
          <View style={st.rowC}>
            <Input value={typed} onChangeText={setTyped} placeholder={facts?.sep === "\\" ? "C:\\Users\\you\\git\\project" : "~/git/project"} autoCapitalize="none" autoCorrect={false}
              style={{ flex: 1, fontSize: 13.5 }} accessibilityLabel="Folder path" testID="folder-path" onSubmitEditing={() => typed.trim() && void check(typed.trim())} returnKeyType="go" />
            <Btn small label="Check" onPress={() => void check(typed.trim())} disabled={!typed.trim() || !online} busy={busy && !!typed} testID="folder-check" />
          </View>
        </Field>
      ) : (
        <Note icon="lock">This connector does not take folders from the app. Folders are added in its config file on {host}.</Note>
      )}
      {error ? <Note icon="alert-triangle" tone={color.danger}>{error}</Note> : null}
      <Btn kind="ghost" label="Cancel" onPress={onCancel} />
    </>
  );
}

/** The picker in its own sheet, for screens that are not already inside one. */
export function FolderPickerSheet({ visible, agent, purpose, title, exclude, onPick, onClose }: {
  visible: boolean; agent: Agent | undefined; purpose: Purpose; title: string; exclude?: string[]; onPick: (f: PickedFolder) => void; onClose: () => void;
}) {
  return (
    <Sheet visible={visible && !!agent} title={title} subtitle={agent ? `On ${agent.folders?.host ?? "the agent's machine"} · ${agent.name}` : undefined} onClose={onClose} testID="folder-sheet">
      {agent && visible ? <FolderPicker agent={agent} purpose={purpose} exclude={exclude} onPick={onPick} onCancel={onClose} /> : null}
    </Sheet>
  );
}

function Note({ icon, tone = color.textMuted, children }: { icon: IconName; tone?: string; children: React.ReactNode }) {
  return (
    <View style={st.note}>
      <Icon name={icon} size={13} tone={tone} style={{ marginTop: 2 }} />
      <T v="small" tone={tone === color.textMuted ? undefined : tone} muted={tone === color.textMuted} style={{ flex: 1 }}>{children}</T>
    </View>
  );
}

// ---------------------------------------------------------------- lists of folders

/** One folder in a list: its name, where it is, what the agent may do there, and where the setting comes from. */
function FolderLine({ icon = "folder", label, path, access, tag, note, onAccess, onRemove, dim, testID }: {
  icon?: IconName; label: string; path: string; access?: FolderAccess; tag?: string; note?: string; onAccess?: () => void; onRemove?: () => void; dim?: boolean; testID?: string;
}) {
  return (
    <View style={[st.line, dim && { opacity: 0.55 }]} testID={testID}>
      <Icon name={icon} size={17} tone={color.text} style={{ marginTop: 2 }} />
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View style={[st.rowC, { gap: 6, flexWrap: "wrap" }]}>
          <T v="heading" numberOfLines={1} style={{ fontSize: 14, flexShrink: 1 }}>{label}</T>
          {access ? (onAccess ? <Pressable onPress={onAccess} hitSlop={8} accessibilityRole="button" accessibilityLabel={`${ACCESS_LABEL[access]}. Tap to change.`}><AccessTag access={access} /></Pressable> : <AccessTag access={access} />) : null}
          {tag ? <Tag label={tag} /> : null}
        </View>
        <T v="mono" selectable numberOfLines={2} tone={color.textMuted} style={{ fontSize: 11.5, lineHeight: 16 }}>{path}</T>
        {note ? <T v="small" muted style={{ fontSize: 12 }}>{note}</T> : null}
      </View>
      {onRemove ? <Pressable onPress={onRemove} hitSlop={10} accessibilityRole="button" accessibilityLabel={`Remove ${label}`} style={st.x}><Icon name="x" size={16} /></Pressable> : null}
    </View>
  );
}

const SKIP_WHY: Record<string, string> = {
  not_approved: "Not approved on this agent's connector, so the agent is not given it.",
  missing: "Approved, but not on disk right now, so the agent is not given it.",
  primary: "This is the primary folder already.",
};

/** The extra folders one level owns, each with its access (tap the tag to switch) and a remove button. */
function ExtraList({ agent, value, onChange, testID }: { agent: Agent | undefined; value: FolderRef[]; onChange: (next: FolderRef[]) => void; testID?: string }) {
  return (
    <View testID={testID}>
      {value.map((f) => {
        const ok = agent ? approvedFolder(agent, f.path) : undefined;
        const canWrite = ok?.access === "write";
        const flip = () => onChange(value.map((x) => (x === f ? { ...x, access: x.access === "write" ? "read" : "write" } : x)));
        return (
          <FolderLine key={f.path} label={ok?.label ?? folderName(f.path)} path={f.path} access={ok?.access === "read" ? "read" : f.access}
            onAccess={canWrite ? flip : undefined} onRemove={() => onChange(value.filter((x) => x !== f))}
            note={!agent ? undefined : !ok ? SKIP_WHY.not_approved : ok.missing ? SKIP_WHY.missing : undefined} dim={!!agent && (!ok || !!ok.missing)} />
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------- a project's folders

/**
 * The Folders card on a project page: the primary folder (where its sessions start) and the extra
 * folders every session in it gets. Folders live on the default agent's machine.
 */
export function ProjectFolders({ project, agent, onNeedAgent }: { project: Project; agent: Agent | undefined; onNeedAgent: () => void }) {
  const [picking, setPicking] = useState<Purpose | null>(null);
  const set = (patch: { cwd?: string | null; folders?: FolderRef[] }) => void mutate("folders.set", { scope: "project", id: project.id, ...patch });
  const extras = project.folders ?? [];
  if (!agent) {
    return (
      <View style={{ gap: space.md }} testID="project-folders">
        <T v="small">Give this project a folder and every session started in it has that folder's code and files at the agent's disposal.</T>
        <Note icon="info">Folders are on an agent's machine. Choose the project's default agent first.</Note>
        <Btn small icon="cpu" label="Choose a default agent" onPress={onNeedAgent} style={{ alignSelf: "flex-start" }} />
        {extras.length ? <ExtraList agent={undefined} value={extras} onChange={(folders) => set({ folders })} /> : null}
      </View>
    );
  }
  if (!offersFolders(agent)) {
    return (
      <View style={{ gap: space.md }} testID="project-folders">
        {project.defaultCwd ? <FolderLine label={folderLabel(agent, project.defaultCwd)} path={project.defaultCwd} tag="PRIMARY" /> : null}
        <Note icon="info">{agent.kind === "claude"
          ? `${agent.name}'s connector is older than the folder picker. Update and restart it, and folders can be added here.`
          : `${agent.name} is a scripted agent and takes no folders. Choose a Claude agent as the project's default agent to give it folders.`}</Note>
      </View>
    );
  }
  const primary = project.defaultCwd;
  const fallback = resolveRunCwd({ agent, project: { defaultCwd: null } });
  return (
    <View style={{ gap: space.md }} testID="project-folders">
      <View style={{ gap: 6 }}>
        <T v="micro">Primary folder · where sessions start</T>
        {primary ? (
          <FolderLine label={folderLabel(agent, primary)} path={primary} access="write" onRemove={() => set({ cwd: null })} testID="project-primary"
            note={approvedFolder(agent, primary)?.access === "write" ? undefined : `Not approved for working in on ${agent.folders?.host}. A session would be refused there; pick the folder again to approve it.`} />
        ) : (
          <FolderLine icon="box" label={`${folderLabel(agent, fallback.cwd)} (not set)`} path={fallback.cwd ?? ""} testID="project-primary"
            note={`No project folder yet, so a new session starts in ${fallback.from === "agent" ? `${agent.name}'s default folder` : `${agent.name}'s sandbox`}.`} />
        )}
        <Btn small icon="folder" label={primary ? "Change the primary folder" : "Choose the project's folder"} onPress={() => setPicking("primary")} style={{ alignSelf: "flex-start" }} testID="project-pick-primary" />
      </View>
      <View style={{ gap: 6 }}>
        <T v="micro">Extra folders · next to it, in every session</T>
        {extras.length ? <ExtraList agent={agent} value={extras} onChange={(folders) => set({ folders })} testID="project-extras" />
          : <T v="small" muted>None. Add a docs folder, a shared library or another repository the agent should see.</T>}
        <Btn small icon="plus" label="Add a folder" onPress={() => setPicking("extra")} style={{ alignSelf: "flex-start" }} testID="project-add-folder" />
      </View>
      <Note icon="info">
        New sessions in this project start in the primary folder and get the extra folders. A session that has already started stays in the folder it started in; extra folders reach it at its next message.
        {primary ? ` Images made here are saved in ${folderName(primary)}/assets/generated, and brand assets live in ${folderName(primary)}/brand.` : ""}
      </Note>
      <FolderPickerSheet visible={!!picking} agent={agent} purpose={picking ?? "extra"} title={picking === "primary" ? "The project's folder" : "Add a folder to the project"}
        exclude={picking === "extra" ? [...extras.map((f) => f.path), ...(primary ? [primary] : [])] : primary ? [primary] : []}
        onClose={() => setPicking(null)}
        onPick={(f) => {
          if (picking === "primary") set({ cwd: f.path, folders: tidyFolders(extras, f.path) });
          else set({ folders: [...extras, { path: f.path, access: f.access }] });
          setPicking(null);
        }} />
    </View>
  );
}

// ---------------------------------------------------------------- a session's folders

const FROM: Record<ResolvedFolder["from"], string> = { agent: "AGENT DEFAULT", project: "PROJECT", session: "THIS SESSION" };

/** What a session works with right now: its primary folder and every extra folder, with where each comes from. */
export function sessionFolders(thread: Thread, agent: Agent, project: Project | undefined) {
  const primary = thread.cwd ? { cwd: thread.cwd, from: "session" as const } : resolveRunCwd({ agent, project: project ?? null, thread });
  const { folders, skipped } = resolveRunFolders({ agent, project: project ?? null, thread, cwd: primary.cwd });
  return { primary, folders, skipped };
}

/**
 * The folder chip above the message box and the sheet behind it. Extra folders can be added at any time
 * and reach the agent at the next message. The primary folder is fixed once the session has a
 * conversation, because that is where the conversation is stored: changing it means a fresh agent
 * session, and the owner is told so before anything happens.
 */
export function FoldersSwitch({ thread, agent, project, live, hasHistory }: {
  thread: Thread; agent: Agent; project: Project | undefined;
  /** A run is in flight in this session. */
  live: boolean;
  /** The agent has already run here, so there is a conversation that lives in the primary folder. */
  hasHistory: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState<Purpose | null>(null);
  const [move, setMove] = useState<PickedFolder | null>(null);
  useEffect(() => {
    if (open) return;
    setPicking(null);
    setMove(null);
  }, [open]);
  if (!offersFolders(agent)) return null;
  const { primary, folders, skipped } = sessionFolders(thread, agent, project);
  const own = thread.folders ?? [];
  const inherited = folders.filter((f) => f.from !== "session");
  const primaryLabel = folderLabel(agent, primary.cwd) || "No folder";
  const set = (patch: { cwd?: string | null; folders?: FolderRef[]; fresh?: boolean }) => void mutate("folders.set", { scope: "thread", id: thread.id, ...patch });
  const where = thread.cwd
    ? hasHistory ? "Where this session started. Its conversation is stored with this folder."
      : project?.defaultCwd && sameFolder(project.defaultCwd, thread.cwd) ? `The folder of ${project.name}.` : "Chosen for this session."
    : primary.from === "project" ? `From ${project?.name ?? "the project"}. It becomes this session's folder at the first message.`
    : primary.from === "agent" ? `${agent.name}'s default folder. It becomes this session's folder at the first message.`
    : `${agent.name}'s sandbox. It becomes this session's folder at the first message.`;
  const options = move ? moveOptions(primaryLabel, move.label) : null;
  const canWrite = move ? approvedFolder(agent, move.path)?.access === "write" : false;
  const addExtra = (f: PickedFolder) => set({ folders: [...own.filter((x) => !sameFolder(x.path, f.path)), { path: f.path, access: f.access }] });

  return (
    <>
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button" testID="folders-switch" hitSlop={8}
        accessibilityLabel={`Folders: ${primaryLabel}${folders.length ? ` and ${folders.length} more` : ""}. Tap to change.`}
        style={({ pressed, hovered }: any) => [st.pill, hovered && { backgroundColor: color.surface3 }, pressed && { opacity: 0.75 }]}>
        <Icon name="folder" size={13} tone={color.text} />
        <T v="small" tone={color.text} numberOfLines={1} style={st.pillText}>{foldersChipText(primaryLabel, folders.length)}</T>
        <Icon name="chevron-up" size={13} tone={color.textMuted} />
      </Pressable>
      <Sheet visible={open} onClose={() => setOpen(false)} testID="folders-sheet"
        title={move ? `Move this session to ${move.label}?` : picking === "primary" ? "A folder to work in" : picking === "extra" ? "Add a folder" : "Folders"}
        subtitle={move ? `Now in ${primaryLabel}` : `${agent.name} · this session`}>
        {move && options ? (
          <>
            <Note icon="info">{options.why}</Note>
            {live ? <Note icon="zap" tone={color.p1}>The agent is working right now. Starting fresh is available when it has finished its current turn.</Note> : null}
            <Pressable onPress={live ? undefined : () => { set({ cwd: move.path, fresh: true }); setOpen(false); }} disabled={live} accessibilityRole="button" accessibilityState={{ disabled: live }} testID="folder-move-fresh"
              style={({ pressed, hovered }: any) => [st.choice, st.choicePrimary, hovered && !live && { opacity: 0.94 }, pressed && { opacity: 0.8 }, live && { opacity: 0.45 }]}>
              <View style={st.rowC}><Icon name="refresh-cw" size={16} tone={color.accentInk} /><T v="heading" tone={color.accentInk} style={{ flex: 1 }}>{options.fresh.title}</T></View>
              <T v="small" tone={color.accentInk}>{options.fresh.body}</T>
            </Pressable>
            <View style={st.choice} testID="folder-move-extra">
              <View style={st.rowC}><Icon name="folder-plus" size={16} tone={color.text} /><T v="heading" style={{ flex: 1 }}>{options.extra.title}</T></View>
              <T v="small">{options.extra.body}</T>
              <View style={[st.rowC, { flexWrap: "wrap" }]}>
                <Btn small icon="eye" label="Add read-only" onPress={() => { addExtra({ ...move, access: "read" }); setOpen(false); }} testID="folder-move-read" />
                {canWrite ? <Btn small icon="edit-2" label="Add read & write" onPress={() => { addExtra({ ...move, access: "write" }); setOpen(false); }} testID="folder-move-write" /> : null}
              </View>
            </View>
            <Btn kind="ghost" icon="arrow-left" label="Back, change nothing" onPress={() => setMove(null)} testID="folder-move-back" />
          </>
        ) : picking ? (
          <FolderPicker agent={agent} purpose={picking} exclude={picking === "extra" ? [...own.map((f) => f.path), ...(primary.cwd ? [primary.cwd] : [])] : primary.cwd ? [primary.cwd] : []}
            onCancel={() => setPicking(null)}
            onPick={(f) => {
              setPicking(null);
              if (picking === "extra") return addExtra(f);
              // Before the first message the folder simply applies. After it, the owner chooses how.
              if (hasHistory) setMove(f);
              else set({ cwd: f.path });
            }} />
        ) : (
          <>
            <Field label="Primary folder · where the agent works">
              <FolderLine icon={primary.from === "connector" ? "box" : "folder"} label={primaryLabel} path={primary.cwd ?? ""} access="write" note={where} testID="session-primary" />
              <Btn small icon="folder" label={hasHistory ? "Move to another folder" : "Choose another folder"} onPress={() => setPicking("primary")} style={{ alignSelf: "flex-start" }} testID="session-pick-primary" />
            </Field>
            <Field label="Extra folders" hint={live ? "The agent is working right now. A change applies to your next message after it has finished." : hasHistory ? "A change applies from your next message. The conversation is kept." : undefined}>
              {inherited.map((f) => <FolderLine key={f.path} label={folderLabel(agent, f.path)} path={f.path} access={f.access} tag={FROM[f.from]} />)}
              <ExtraList agent={agent} value={own} onChange={(next) => set({ folders: next })} testID="session-extras" />
              {skipped.filter((s) => s.from !== "session" && s.why !== "primary").map((s) => <FolderLine key={s.path} label={folderName(s.path)} path={s.path} tag={FROM[s.from]} note={SKIP_WHY[s.why]} dim />)}
              {inherited.length + own.length === 0 ? <T v="small" muted>None. The agent works in the primary folder only.</T> : null}
              <Btn small icon="plus" label="Add a folder" onPress={() => setPicking("extra")} style={{ alignSelf: "flex-start" }} testID="session-add-folder" />
            </Field>
            <Note icon="shield">Read-only: {ACCESS_BLURB.read}</Note>
            <Btn label="Done" onPress={() => setOpen(false)} testID="folders-done" />
          </>
        )}
      </Sheet>
    </>
  );
}

// ---------------------------------------------------------------- an agent's folders

const SOURCE: Record<ApprovedFolder["source"], string> = { sandbox: "SANDBOX", config: "CONFIG FILE", app: "APPROVED IN THE APP" };

/** On an agent's page: its default folders, and everything its connector has approved, with a way to add and to forget. */
export function AgentFolders({ agent }: { agent: Agent }) {
  const [picking, setPicking] = useState<Purpose | null>(null);
  const [forget, setForget] = useState<ApprovedFolder | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!offersFolders(agent)) {
    return <Note icon="info">{agent.kind === "claude" && !agent.gmail && !agent.vault
      ? `${agent.name}'s connector does not report folders yet. Update and restart it, and its folders can be managed here.`
      : `${agent.name} works in its own fixed place and takes no folders.`}</Note>;
  }
  const facts = agent.folders!;
  const set = (patch: { cwd?: string | null; folders?: FolderRef[] }) => void mutate("folders.set", { scope: "agent", id: agent.id, ...patch });
  const starts = startFolders(agent);
  const extras = agent.defaultFolders ?? [];
  const sandbox = facts.approved.find((f) => f.source === "sandbox");
  const reapprove = (f: ApprovedFolder, access: FolderAccess) => {
    setError(null);
    folderRequest(agent.id, "approve", { path: f.path, access }).catch((e) => setError(errorText(e)));
  };
  return (
    <View style={{ gap: space.lg }} testID="agent-folders">
      <Field label="Where its sessions start" hint="Used when neither the session nor its project names a folder.">
        <View style={st.wrap} accessibilityRole="radiogroup">
          <Chip label={`Sandbox${sandbox ? "" : " (connector default)"}`} icon="box" selected={!agent.defaultCwd || sameFolder(agent.defaultCwd, sandbox?.path)} onPress={() => set({ cwd: null })} />
          {starts.filter((f) => !sameFolder(f.path, sandbox?.path)).map((f) => <Chip key={f.path} label={f.label} icon="folder" selected={sameFolder(agent.defaultCwd, f.path)} onPress={() => set({ cwd: f.path })} />)}
        </View>
      </Field>
      <Field label="Extra folders in every session" hint="Each session with this agent gets these next to its primary folder, whatever project it is in.">
        {extras.length ? <ExtraList agent={agent} value={extras} onChange={(folders) => set({ folders })} testID="agent-extras" /> : <T v="small" muted>None.</T>}
        <Btn small icon="plus" label="Add a default folder" onPress={() => setPicking("extra")} style={{ alignSelf: "flex-start" }} testID="agent-add-default" />
      </Field>
      <Field label={`Approved on ${facts.host}`} hint="The connector on that machine uses these folders and no others, whatever a project or a session asks for.">
        <View testID="agent-approved">
          {facts.approved.map((f) => (
            <FolderLine key={f.path} icon={f.source === "sandbox" ? "box" : "folder"} label={f.label} path={f.path} access={f.access} tag={SOURCE[f.source]} dim={!!f.missing}
              note={f.missing ? "Not on disk right now." : undefined}
              onAccess={f.source === "app" && !f.missing ? () => reapprove(f, f.access === "write" ? "read" : "write") : undefined}
              onRemove={f.source === "app" ? () => setForget(f) : undefined} />
          ))}
        </View>
        {error ? <Note icon="alert-triangle" tone={color.danger}>{error}</Note> : null}
        {facts.browse ? <Btn small icon="hard-drive" label="Approve another folder" onPress={() => setPicking("approve")} style={{ alignSelf: "flex-start" }} disabled={agent.status !== "online"} testID="agent-approve-folder" />
          : <Note icon="lock">This connector does not take folders from the app. They are added in its config file on {facts.host}.</Note>}
      </Field>
      <Note icon="shield">
        {facts.browse ? `The app can browse ${facts.roots.map((r) => r.path).join(", ") || "nothing"} on ${facts.host} (browseRoots in the connector's config file). ` : ""}
        The home folder itself, drives, credential and settings folders, system folders and HomeBase's own data can never be added. Read-only means: {ACCESS_BLURB.read}
      </Note>
      <FolderPickerSheet visible={!!picking} agent={agent} purpose={picking ?? "approve"} title={picking === "approve" ? "Approve a folder" : "Add a default folder"}
        exclude={picking === "extra" ? extras.map((f) => f.path) : picking === "approve" ? facts.approved.map((f) => f.path) : []} onClose={() => setPicking(null)}
        onPick={(f) => {
          if (picking === "extra") set({ folders: [...extras, { path: f.path, access: f.access }] });
          setPicking(null);
        }} />
      <ConfirmDialog visible={!!forget} title={`Forget ${forget?.label ?? "this folder"}?`} confirmLabel="Forget folder" detail={forget?.path}
        body="It is taken off this connector's approved list. Projects and sessions that use it keep the setting, but the agent is no longer given the folder, and a session that works in it is refused until it is approved again. Nothing on disk is touched."
        onCancel={() => setForget(null)}
        onConfirm={() => {
          const f = forget;
          setForget(null);
          if (f) folderRequest(agent.id, "forget", { path: f.path }).catch((e) => setError(errorText(e)));
        }} />
    </View>
  );
}

// ---------------------------------------------------------------- the New session sheet

/** What a new session with this agent would start in, in a few words: "notetaker · project folder". */
export function startsIn(agent: Agent, project: Project | undefined, chosen: string | null): { label: string; why: string } {
  if (chosen) return { label: folderLabel(agent, chosen), why: "your choice" };
  const r = resolveRunCwd({ agent, project: project ?? null });
  return { label: folderLabel(agent, r.cwd) || "its own folder", why: r.from === "project" ? "the project's folder" : r.from === "agent" ? "its default folder" : "the default" };
}

const st = StyleSheet.create({
  rowC: { flexDirection: "row", alignItems: "center", gap: space.sm },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  box: { gap: 6, padding: space.md, borderRadius: radius.lg, borderWidth: 1, borderColor: color.borderStrong, backgroundColor: color.bg },
  path: { fontSize: 12, lineHeight: 17 },
  entry: { minHeight: 50, paddingHorizontal: space.sm, paddingVertical: 8 },
  note: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  line: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, paddingVertical: 8 },
  x: { width: 32, height: 32, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, marginRight: -6 },
  option: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.md, paddingVertical: 10, borderRadius: radius.md, borderWidth: 1, borderColor: color.border, backgroundColor: color.bg },
  optionOn: { borderColor: color.accent, backgroundColor: color.accentDim },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: color.borderStrong, alignItems: "center", justifyContent: "center" },
  radioDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: color.accent },
  pill: {
    height: 30, paddingHorizontal: 11, borderRadius: radius.pill, borderWidth: 1, borderColor: color.borderStrong, backgroundColor: color.surface2,
    flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", flexShrink: 1, maxWidth: 220,
  },
  pillText: { fontFamily: "SpaceGrotesk_600SemiBold", fontSize: 13, lineHeight: 16, flexShrink: 1 },
  choice: { gap: 6, padding: space.md, borderRadius: radius.lg, borderWidth: 1, borderColor: color.borderStrong, backgroundColor: color.bg },
  choicePrimary: { backgroundColor: color.accent, borderColor: color.accent },
});
