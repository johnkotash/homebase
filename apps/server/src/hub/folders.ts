import {
  FOLDER_WRITE_OPS, approvedFolder, folderChanges, folderLabel, foldersMarkerText, isLiveRun, newId, offersFolders, resolveRunCwd, resolveRunFolders, sameFolder, startFolders, tidyFolders,
  type Agent, type FolderRef, type InboundFrame, type MutationArgs, type Project, type Run, type Thread,
} from "@homebase/protocol";
import { readEntity } from "./tables";
import { MutationError, type Peer, type Tx, type WorkspaceHub } from "./WorkspaceHub";

/**
 * Folders on the hub (ARCHITECTURE.md 6.6). The hub holds the owner's choice at three levels (an agent's
 * defaults, a project, a session) and works out what each run is asked to use. It never decides what is
 * allowed: a path is accepted here only when the agent's connector reported it as approved, and the
 * connector checks again, against its own list, before a process starts.
 */

type FoldersReq = Extract<InboundFrame, { t: "folders.req" }>;
type FoldersResponse = Extract<InboundFrame, { t: "folders.response" }>;
type Device = { id: string; canApprove: boolean };

const TIMEOUT_MS = 20_000;

/**
 * Relays the folder browser: a device asks an agent's connector to list folders on its machine, to check
 * one, or to approve or forget one, and the answer goes back to the socket that asked. Folder names pass
 * through and are not stored. Approving and forgetting change that machine's allowlist, so they are taken
 * only from a device that may approve, and each one that succeeds is written to the audit log.
 */
export class FolderRelay {
  private pending = new Map<string, { peer: Peer; clientId: string; connectorId: string; agentId: string; op: FoldersReq["op"]; timer: ReturnType<typeof setTimeout> }>();
  private seq = 0;

  constructor(private hub: WorkspaceHub) {}

  request(peer: Peer, frame: FoldersReq) {
    const fail = (code: string, message: string) => peer.send({ t: "folders.res", id: frame.id, ok: false, error: { code, message } });
    const agent = readEntity<Agent>(this.hub.store, "agents", frame.agentId);
    if (!agent) return fail("not_found", "Agent not found");
    if (!offersFolders(agent)) return fail("unsupported", `${agent.name} does not take folders, or its connector is older than the folder picker. Update and restart the connector.`);
    if (FOLDER_WRITE_OPS.includes(frame.op) && !peer.canApprove) return fail("forbidden", "This device cannot change which folders agents may use");
    const connector = agent.connectorId ? this.hub.connectorPeer(agent.connectorId) : undefined;
    if (!connector) return fail("offline", `${agent.name}'s connector is offline. Folders are on its machine, so they can be picked when it is back.`);
    const id = `fq_${Date.now().toString(36)}_${++this.seq}`;
    const timer = setTimeout(() => this.settle(id, { ok: false, error: { code: "timeout", message: "The connector did not answer in time." } }), TIMEOUT_MS);
    (timer as any).unref?.();
    this.pending.set(id, { peer, clientId: frame.id, connectorId: connector.id, agentId: agent.id, op: frame.op, timer });
    connector.send({ t: "folders.request", id, agentKey: agent.key, op: frame.op, args: frame.args ?? {}, deviceId: peer.id, canApprove: peer.canApprove });
  }

  response(connector: Peer, frame: FoldersResponse) {
    const p = this.pending.get(frame.id);
    // Only the connector that was asked may answer.
    if (!p || p.connectorId !== connector.id) return;
    if (frame.ok && FOLDER_WRITE_OPS.includes(p.op)) {
      const r = (frame.result ?? {}) as { path?: unknown; access?: unknown; label?: unknown };
      const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : null);
      this.hub.commit(p.peer.id, null, (tx) => tx.audit(p.op === "approve" ? "folder.approve" : "folder.forget", "agent", p.agentId, {
        agentId: p.agentId, connectorId: p.connectorId, path: str(r.path, 1000), access: str(r.access, 10), label: str(r.label, 80),
      }));
    }
    this.settle(frame.id, frame.ok ? { ok: true, result: frame.result } : { ok: false, error: { code: frame.code ?? "folder_error", message: frame.error ?? "The connector could not do that." } });
  }

  private settle(id: string, out: { ok: boolean; result?: unknown; error?: { code: string; message: string } }) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.peer.send({ t: "folders.res", id: p.clientId, ...out });
  }

  peerGone(peer: Peer) {
    for (const [id, p] of this.pending) {
      if (p.peer === peer) {
        clearTimeout(p.timer);
        this.pending.delete(id);
      } else if (peer.role === "connector" && p.connectorId === peer.id) {
        this.settle(id, { ok: false, error: { code: "offline", message: "The connector went offline." } });
      }
    }
  }
}

// ---------------------------------------------------------------- the owner's choice: folders.set

/** A primary folder for this agent, in the connector's own spelling. Refused when its connector has not approved it for working in. */
export function checkedCwd(agent: Agent, cwd: string): string {
  const hit = startFolders(agent).find((f) => sameFolder(f.path, cwd))?.path ?? agent.workspaces.find((w) => sameFolder(w.cwd, cwd))?.cwd;
  if (hit) return hit;
  const ro = approvedFolder(agent, cwd);
  if (ro?.access === "read") throw new MutationError("invalid_args", `${ro.label} is approved read-only on ${agent.name}'s connector, so an agent cannot work in it. Approve it for read & write first.`);
  throw new MutationError("invalid_args", `${agent.name}'s connector has not approved ${cwd}. Approve the folder first.`);
}

/** Extra folders, each approved by one of `agents` and never asked for more than it is approved for. */
export function checkedExtras(agents: Agent[], list: FolderRef[], cwd: string | null): FolderRef[] {
  const out: FolderRef[] = [];
  for (const f of tidyFolders(list, cwd)) {
    const hits = agents.map((a) => approvedFolder(a, f.path)).filter((x) => !!x);
    if (!hits.length) throw new MutationError("invalid_args", `No connector has approved ${f.path}. Approve the folder first.`);
    if (f.access === "write" && !hits.some((h) => h!.access === "write")) {
      throw new MutationError("invalid_args", `${hits[0]!.label} is approved read-only. Approve it for read & write first, or add it read-only.`);
    }
    out.push({ path: hits[0]!.path, access: f.access });
  }
  return out;
}

/** True when the session has an agent conversation that its next run would resume. */
export function hasConversation(tx: Tx, th: Pick<Thread, "id" | "sessionResetAt">): boolean {
  const prev = tx.query("runs", "WHERE thread_id = ? AND session_ref IS NOT NULL ORDER BY created_at DESC LIMIT 1", th.id)[0];
  return !!prev && prev.createdAt > (th.sessionResetAt ?? 0);
}

const sameList = (a: FolderRef[] | null | undefined, b: FolderRef[] | null | undefined) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

/**
 * `folders.set`. Giving an agent reach into a folder is an approval-grade decision, like its permission
 * mode: only a device that may approve can make it, and it is audited. Nothing is sent to a live run;
 * the folders are read when the next run starts.
 */
export function setFolders(tx: Tx, a: MutationArgs<"folders.set">, device: Device) {
  if (!device.canApprove) throw new MutationError("forbidden", "This device cannot change which folders agents use");
  if (a.fresh && a.scope !== "thread") throw new MutationError("invalid_args", "Only a session can be given a fresh agent session");

  if (a.scope === "agent") {
    const agent = tx.get("agents", a.id);
    if (!agent) throw new MutationError("not_found", "Agent not found");
    if (!offersFolders(agent)) throw new MutationError("invalid_args", `${agent.name} does not take folders`);
    const cwd = a.cwd === undefined ? agent.defaultCwd ?? null : a.cwd === null ? null : checkedCwd(agent, a.cwd);
    const folders = a.folders === undefined ? agent.defaultFolders ?? null : checkedExtras([agent], a.folders, null);
    if (sameFolderOrNull(cwd, agent.defaultCwd) && sameList(folders, agent.defaultFolders)) return;
    tx.upsert("agents", { ...agent, defaultCwd: cwd, defaultFolders: folders?.length ? folders : null, updatedAt: tx.now });
    tx.audit("folders.set", "agent", agent.id, { scope: "agent", cwd, folders: folders ?? [] });
    return;
  }

  if (a.scope === "project") {
    const p = tx.get("projects", a.id);
    if (!p) throw new MutationError("not_found", "Project not found");
    const def = p.defaultAgentId ? tx.get("agents", p.defaultAgentId) : undefined;
    let cwd = p.defaultCwd;
    if (a.cwd !== undefined) {
      if (a.cwd !== null && !def) throw new MutationError("invalid_args", "A project folder needs a default agent: the folder is on that agent's machine");
      cwd = a.cwd === null ? null : checkedCwd(def!, a.cwd);
    }
    // A project's extra folders must be approved for its default agent; with no default agent, by any agent's connector.
    const folders = a.folders === undefined ? p.folders ?? null : checkedExtras(def ? [def] : tx.query("agents").filter(offersFolders), a.folders, cwd);
    if (sameFolderOrNull(cwd, p.defaultCwd) && sameList(folders, p.folders)) return;
    tx.upsert("projects", { ...p, defaultCwd: cwd, folders: folders?.length ? folders : null, updatedAt: tx.now });
    tx.audit("folders.set", "project", p.id, { scope: "project", agentId: def?.id ?? null, cwd, folders: folders ?? [] });
    return;
  }

  const th = tx.get("threads", a.id);
  if (!th) throw new MutationError("not_found", "Thread not found");
  const agent = th.agentId ? tx.get("agents", th.agentId) : undefined;
  if (!agent) throw new MutationError("invalid_args", "This session has no agent, so it has no folders");
  const live = tx.query("runs", "WHERE thread_id = ? ORDER BY created_at DESC LIMIT 5", th.id).some((r) => isLiveRun(r.status));
  let cwd = th.cwd ?? null;
  let reset = th.sessionResetAt ?? null;
  if (a.cwd !== undefined && !sameFolderOrNull(a.cwd, th.cwd)) {
    const talked = hasConversation(tx, th);
    if (talked && !a.fresh) {
      throw new MutationError("conflict", "This session has a conversation, and a conversation resumes only in the folder it started in. Start a fresh agent session in the new folder, or add the folder as an extra one.");
    }
    if (talked && live) throw new MutationError("conflict", "The agent is still working in this session. Move it when the agent has finished.");
    if (talked && a.cwd === null) throw new MutationError("invalid_args", "Pick the folder the fresh agent session should work in");
    cwd = a.cwd === null ? null : checkedCwd(agent, a.cwd);
    if (talked) reset = tx.now;
  }
  const folders = a.folders === undefined ? th.folders ?? null : checkedExtras([agent], a.folders, null);
  if (sameFolderOrNull(cwd, th.cwd) && sameList(folders, th.folders) && reset === (th.sessionResetAt ?? null)) return;
  tx.upsert("threads", { ...th, cwd, folders: folders?.length ? folders : null, sessionResetAt: reset, updatedAt: tx.now });
  tx.audit("folders.set", "thread", th.id, { scope: "thread", agentId: agent.id, cwd, folders: folders ?? [], fresh: reset !== (th.sessionResetAt ?? null) });
}

const sameFolderOrNull = (a: string | null | undefined, b: string | null | undefined) => (!a && !b) || sameFolder(a, b);

/** `thread.create` with a folder: the same checks as `folders.set` for a session that has not started. */
export function newSessionFolders(tx: Tx, a: Pick<MutationArgs<"thread.create">, "agentId" | "cwd" | "folders">, device: Device): { cwd: string | null; folders: FolderRef[] | null } {
  if (!a.cwd && !a.folders?.length) return { cwd: null, folders: null };
  if (!device.canApprove) throw new MutationError("forbidden", "This device cannot choose folders for agents");
  const agent = a.agentId ? tx.get("agents", a.agentId) : undefined;
  if (!agent) throw new MutationError("invalid_args", "A folder needs an agent: the folder is on that agent's machine");
  const cwd = a.cwd ? checkedCwd(agent, a.cwd) : null;
  const folders = a.folders?.length ? checkedExtras([agent], a.folders, null) : null;
  return { cwd, folders: folders?.length ? folders : null };
}

// ---------------------------------------------------------------- what a run gets

/**
 * The folders of a run that is about to start: its primary folder (see `resolveRunCwd` for the order) and
 * the extra ones from the agent's defaults, the project and the session. `prev` is the session's last run
 * that had an agent session; `resume` is that run when this one continues it.
 */
export function foldersForRun(i: {
  agent: Agent; thread?: Thread | null; project?: Project | null; asked?: string | null; prev?: Pick<Run, "cwd"> | null; resume?: Pick<Run, "cwd"> | null;
}): { cwd: string | null; folders: FolderRef[] | null } {
  const { cwd } = resolveRunCwd({
    agent: i.agent, thread: i.thread ?? null,
    // A project's folder is where a session starts; once it has run, it stays where it is.
    project: i.prev ? null : i.project ?? null,
    asked: i.asked ?? null, resumeCwd: i.resume?.cwd ?? null, lastCwd: i.prev?.cwd ?? null,
  });
  if (!offersFolders(i.agent)) return { cwd, folders: null };
  const extra = resolveRunFolders({ agent: i.agent, project: i.project ?? null, thread: i.thread ?? null, cwd }).folders.map(({ path, access }) => ({ path, access }));
  return { cwd, folders: extra.length ? extra : null };
}

/**
 * Called when a run starts in a session. If the extra folders differ from those of the session's run
 * before it, a line goes into the conversation at that point, so a folder never appears or goes silently.
 */
export function markFolders(tx: Tx, thread: Pick<Thread, "id">, run: Run, agent?: Agent) {
  const before = tx.query("runs", "WHERE thread_id = ? AND id != ? ORDER BY created_at DESC, id DESC LIMIT 1", thread.id, run.id)[0];
  if (!before) return; // the first run of a session: nothing to compare with
  const text = foldersMarkerText(folderChanges(before.folders, run.folders), (p) => folderLabel(agent, p));
  if (!text) return;
  tx.upsert("messages", {
    id: newId("msg"), threadId: thread.id, role: "system", text, source: "agent", runId: run.id, authorDeviceId: null, createdAt: tx.now,
    card: { type: "session_marker", kind: "folders", model: null, effort: null },
  });
}

/**
 * Sessions from before folders were kept on the session get theirs written down: the folder their agent
 * session lives in (their last run with one), else the folder of their newest run. Nothing changes for
 * them, since a session already resumed there; it is now also visible. Safe at every start.
 */
export function backfillFolders(hub: WorkspaceHub): number {
  const rows = hub.store.all<{ id: string }>(
    "SELECT t.id FROM threads t WHERE t.cwd IS NULL AND EXISTS (SELECT 1 FROM runs r WHERE r.thread_id = t.id AND r.cwd IS NOT NULL)",
  );
  if (!rows.length) return 0;
  let n = 0;
  hub.commit(null, null, (tx) => {
    for (const { id } of rows) {
      const th = tx.get("threads", id);
      if (!th || th.cwd) continue;
      const run =
        hub.store.get<{ cwd: string }>("SELECT cwd FROM runs WHERE thread_id = ? AND cwd IS NOT NULL AND session_ref IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1", id) ??
        hub.store.get<{ cwd: string }>("SELECT cwd FROM runs WHERE thread_id = ? AND cwd IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1", id);
      if (!run?.cwd) continue;
      tx.upsert("threads", { ...th, cwd: run.cwd });
      n++;
    }
  });
  if (n) hub.log(`folder backfill: ${n} session(s) now show the folder they work in`);
  return n;
}
