import {
  RECAP_PROMPT, RECAP_REQUEST, acceptsAttachments, attachmentRefusal, attachmentsProblem, isDefaultTitle, isLiveRun, newId, titleFromMessage,
  type Agent, type MessageAttachment, type MutationArgs, type MutationName, type SlaPolicy,
} from "@homebase/protocol";
import { attachmentRow, toMessageAttachment } from "../attachments";
import { MutationError, type Tx } from "./WorkspaceHub";
import { decideApproval } from "./approvals";
import { newSessionFolders, setFolders } from "./folders";
import { markRead } from "./readState";
import { cancelRun, resolveMode, startRun } from "./runs";
import { setModelChoice } from "./sessions";
import { computeSla, slaStateAt } from "./sla";
import { dictationPrompt } from "./vault";

type Device = { id: string; canApprove: boolean; name?: string };
type Handler<N extends MutationName> = (tx: Tx, args: MutationArgs<N>, device: Device) => void;

const OPEN_STATUSES = ["new", "triaged", "in_progress", "snoozed"];

/** A project's default agent and working directory, checked: the directory must be one that agent offers. */
function projectDefaults(tx: Tx, agentId: string | null, cwd: string | null): { defaultAgentId: string | null; defaultCwd: string | null } {
  let agent: Agent | undefined;
  if (agentId) {
    agent = tx.get("agents", agentId);
    if (!agent) throw new MutationError("not_found", "Agent not found");
  }
  if (cwd && !agent) throw new MutationError("invalid_args", "A working directory needs a default agent");
  if (cwd && agent && !agent.workspaces.some((w) => w.cwd === cwd)) throw new MutationError("invalid_args", `${agent.name} has no working directory ${cwd}`);
  return { defaultAgentId: agent?.id ?? null, defaultCwd: cwd || null };
}

/**
 * The pictures on a message, as the hub stored them: every id must be an upload this hub holds, the set must fit the
 * limits, and the session's agent must be one that can look at pictures. Nothing is dropped quietly: a problem is an error.
 */
function messageAttachments(tx: Tx, a: MutationArgs<"message.send">, agent: Agent | undefined): MessageAttachment[] {
  if (!a.attachments?.length) return [];
  const seen = new Set<string>();
  const out: MessageAttachment[] = [];
  for (const ref of a.attachments) {
    if (seen.has(ref.id)) continue;
    seen.add(ref.id);
    const row = attachmentRow(tx.hub.store, ref.id);
    if (!row) throw new MutationError("not_found", "An attached image has not reached the hub. Attach it again and resend.");
    out.push(toMessageAttachment(row));
  }
  const problem = attachmentsProblem(out);
  if (problem) throw new MutationError("invalid_args", problem);
  if (agent && !acceptsAttachments(agent)) throw new MutationError("invalid_args", attachmentRefusal(agent));
  return out;
}

export const MUTATION_HANDLERS: { [N in MutationName]: Handler<N> } = {
  "thread.create": (tx, a, device) => {
    if (tx.get("threads", a.threadId)) throw new MutationError("conflict", "Thread already exists");
    if (a.agentId && !tx.get("agents", a.agentId)) throw new MutationError("not_found", "Agent not found");
    if (a.projectId && !tx.get("projects", a.projectId)) throw new MutationError("not_found", "Project not found");
    tx.upsert("threads", {
      id: a.threadId, title: a.title, agentId: a.agentId ?? null, lastMessageAt: null, pinned: false, archived: false,
      createdBy: device.id, createdAt: tx.now, updatedAt: tx.now, mode: null, projectId: a.projectId ?? null,
      // A folder picked in the New session sheet. Left out: the project's or the agent's, decided when the first run starts.
      ...newSessionFolders(tx, a, device),
    });
  },

  "thread.update": (tx, a) => {
    const th = tx.get("threads", a.threadId);
    if (!th) throw new MutationError("not_found", "Thread not found");
    if (a.projectId && !tx.get("projects", a.projectId)) throw new MutationError("not_found", "Project not found");
    tx.upsert("threads", {
      ...th, title: a.title ?? th.title, archived: a.archived ?? th.archived, pinned: a.pinned ?? th.pinned,
      // Moving a session never changes where its agent works: a session resumes in the directory it started in.
      projectId: a.projectId !== undefined ? a.projectId : th.projectId ?? null,
      note: a.note !== undefined ? a.note?.trim() || null : th.note ?? null,
      updatedAt: tx.now,
    });
  },

  "thread.read": (tx, a) => markRead(tx, a),

  "thread.recap": (tx, a, device) => {
    const th = tx.get("threads", a.threadId);
    if (!th) throw new MutationError("not_found", "Thread not found");
    const agent = th.agentId ? tx.get("agents", th.agentId) : undefined;
    if (!agent) throw new MutationError("invalid_args", "This session has no agent to write a recap");
    if (!agent.connectorId) throw new MutationError("conflict", `${agent.name} has no connector yet. Start the connector and try again.`);
    if (tx.get("messages", a.messageId)) throw new MutationError("conflict", "Message already exists");
    if (tx.query("runs", "WHERE thread_id = ? ORDER BY created_at DESC LIMIT 5", th.id).some((r) => isLiveRun(r.status))) {
      throw new MutationError("conflict", "The agent is still working in this session. Ask for a recap when it has finished.");
    }
    // The recap is one more turn of the same agent session (resumed), in Manual so nothing runs unasked.
    const run = startRun(tx, { runId: newId("run"), agentId: agent.id, threadId: th.id, prompt: RECAP_PROMPT, options: { mode: "manual" } });
    tx.upsert("messages", {
      id: a.messageId, threadId: th.id, role: "user", text: RECAP_REQUEST, source: "text", runId: run.id, authorDeviceId: device.id, createdAt: tx.now,
    });
    tx.patch("threads", th.id, { recapRunId: run.id, lastMessageAt: tx.now, updatedAt: tx.now });
  },

  "project.create": (tx, a) => {
    if (tx.get("projects", a.projectId)) throw new MutationError("conflict", "Project already exists");
    tx.upsert("projects", {
      id: a.projectId, name: a.name, description: a.description?.trim() || null, ...projectDefaults(tx, a.defaultAgentId ?? null, a.defaultCwd ?? null),
      pinned: false, archived: false, createdAt: tx.now, updatedAt: tx.now,
    });
  },

  "project.update": (tx, a) => {
    const p = tx.get("projects", a.projectId);
    if (!p) throw new MutationError("not_found", "Project not found");
    const agentId = a.defaultAgentId !== undefined ? a.defaultAgentId : p.defaultAgentId;
    // A new default agent drops a directory that belonged to the old one, unless a new directory came with it.
    const cwd = a.defaultCwd !== undefined ? a.defaultCwd : agentId === p.defaultAgentId ? p.defaultCwd : null;
    const touched = a.defaultAgentId !== undefined || a.defaultCwd !== undefined;
    tx.upsert("projects", {
      ...p, name: a.name ?? p.name, description: a.description !== undefined ? a.description?.trim() || null : p.description,
      ...(touched ? projectDefaults(tx, agentId, cwd) : {}),
      pinned: a.pinned ?? p.pinned, archived: a.archived ?? p.archived, updatedAt: tx.now,
    });
  },

  "project.delete": (tx, a) => {
    const p = tx.get("projects", a.projectId);
    if (!p) return; // already gone: deleting twice is fine
    // Sessions are never deleted with their project. They go back to Unsorted.
    const moved = tx.query("threads", "WHERE project_id = ?", p.id);
    for (const th of moved) tx.upsert("threads", { ...th, projectId: null, updatedAt: tx.now });
    tx.remove("projects", p.id);
    tx.audit("project.delete", "project", p.id, { name: p.name, sessionsMovedToUnsorted: moved.length });
  },

  "message.send": (tx, a, device) => {
    const th = tx.get("threads", a.threadId);
    if (!th) throw new MutationError("not_found", "Thread not found");
    if (tx.get("messages", a.messageId)) throw new MutationError("conflict", "Message already exists");
    const attachments = messageAttachments(tx, a, th.agentId ? tx.get("agents", th.agentId) : undefined);
    if (!a.text.trim() && !attachments.length) throw new MutationError("invalid_args", "A message needs text or an image");
    const pics = attachments.length ? { attachments } : {};
    const live = th.agentId ? tx.query("runs", "WHERE thread_id = ? ORDER BY created_at DESC LIMIT 5", th.id).find((r) => isLiveRun(r.status)) : undefined;
    let runId: string | null = live?.id ?? null;
    if (th.agentId) {
      const agent = tx.get("agents", th.agentId);
      if (live && agent?.connectorId) {
        tx.command(agent.connectorId, { name: "run.input", runId: live.id, text: dictationPrompt(agent, a, device), ...pics });
      } else if (agent?.connectorId) {
        runId = startRun(tx, { runId: newId("run"), agentId: th.agentId, threadId: th.id, prompt: dictationPrompt(agent, a, device), ...pics }).id;
      }
    }
    tx.upsert("messages", {
      id: a.messageId, threadId: th.id, role: "user", text: a.text, source: a.source, runId, authorDeviceId: device.id, createdAt: tx.now, ...pics,
    });
    for (const p of attachments) tx.hub.store.run("UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL", a.messageId, p.id);
    // Patched, not written from `th`: starting the run has already put its status on the session.
    // A session that still has its placeholder title is named after the first thing said in it (pictures alone do not name it).
    tx.patch("threads", th.id, { lastMessageAt: tx.now, updatedAt: tx.now, ...(isDefaultTitle(th.title) && a.text.trim() ? { title: titleFromMessage(a.text) } : {}) });
  },

  "run.start": (tx, a) => {
    if (a.threadId && !tx.get("threads", a.threadId)) throw new MutationError("not_found", "Thread not found");
    startRun(tx, { runId: a.runId, agentId: a.agentId, threadId: a.threadId ?? null, prompt: a.prompt, cwd: a.options?.cwd ?? null, options: a.options });
  },

  "run.input": (tx, a) => {
    const run = tx.get("runs", a.runId);
    if (!run) throw new MutationError("not_found", "Run not found");
    if (!isLiveRun(run.status)) throw new MutationError("conflict", `Run is ${run.status}; it cannot take input`);
    const agent = tx.get("agents", run.agentId);
    if (!agent?.connectorId) throw new MutationError("conflict", "Agent has no connector");
    if (run.threadId) {
      tx.upsert("messages", {
        id: newId("msg"), threadId: run.threadId, role: "user", text: a.text, source: "text", runId: run.id, authorDeviceId: tx.actorId, createdAt: tx.now,
      });
    }
    tx.command(agent.connectorId, { name: "run.input", runId: run.id, text: a.text });
  },

  "run.cancel": (tx, a) => cancelRun(tx, a.runId),

  "approval.decide": (tx, a, device) => decideApproval(tx, a, device),

  "inbox.update": (tx, a) => {
    const item = tx.get("inbox_items", a.itemId);
    if (!item) throw new MutationError("not_found", "Inbox item not found");
    const next = { ...item, updatedAt: tx.now };
    if (a.priority && a.priority !== item.priority) {
      next.priority = a.priority;
      next.triageReason = `You changed this from ${item.priority} to ${a.priority}`;
      tx.audit("inbox.reprioritize", "inbox_item", item.id, { from: item.priority, to: a.priority, source: item.source, sender: item.sender });
    }
    if (a.assignedAgentId !== undefined) next.assignedAgentId = a.assignedAgentId;
    if (a.linkedThreadId !== undefined) next.linkedThreadId = a.linkedThreadId;
    if (a.status && a.status !== item.status) {
      next.status = a.status;
      if (a.status === "responded" || a.status === "done") {
        // Responding stops the clock. A deadline that already passed stays breached.
        next.respondedAt = item.respondedAt ?? tx.now;
        if (item.slaState === "running" || item.slaState === "warning") {
          next.slaState = item.slaDueAt != null && tx.now > item.slaDueAt ? "breached" : "met";
        }
        next.snoozeUntil = null;
      } else if (a.status === "snoozed") {
        if (a.snoozeUntil == null) throw new MutationError("invalid_args", "snoozeUntil is required to snooze");
      } else if (OPEN_STATUSES.includes(a.status)) {
        next.snoozeUntil = null;
        if (item.status === "responded" || item.status === "done") {
          // Re-opened: the clock picks up where the calendar says it should be.
          next.respondedAt = null;
          const st = slaStateAt(tx.now, item.slaDueAt, item.slaWarnAt);
          next.slaState = st;
        }
      }
    }
    // Snoozing never pauses the SLA clock.
    if (a.snoozeUntil !== undefined && next.status === "snoozed") next.snoozeUntil = a.snoozeUntil;
    tx.upsert("inbox_items", next);
  },

  "inbox.capture": (tx, a) => {
    if (tx.get("inbox_items", a.itemId)) throw new MutationError("conflict", "Item already exists");
    tx.hub.ingestTx(tx, { source: "manual", title: a.title, body: a.body ?? null, snippet: a.body?.slice(0, 140) ?? null, sender: "You", priority: a.priority ?? "P2" }, a.itemId);
  },

  "note.upsert": (tx, a) => {
    const cur = tx.get("notes", a.noteId);
    if (!cur) {
      tx.upsert("notes", {
        id: a.noteId, title: a.title, body: a.body, tags: a.tags ?? [], rev: 1, source: a.source ?? "text", vaultPath: null,
        createdAt: tx.now, updatedAt: tx.now,
      });
      return;
    }
    if (a.baseRev !== undefined && a.baseRev !== cur.rev && cur.body !== a.body) {
      // Stale write: last writer still wins, but the overwritten body is kept so nothing is lost.
      tx.hub.store.run("INSERT OR REPLACE INTO note_revisions (note_id, rev, body, at) VALUES (?, ?, ?, ?)", cur.id, cur.rev, cur.body, tx.now);
    }
    tx.upsert("notes", { ...cur, title: a.title, body: a.body, tags: a.tags ?? cur.tags, rev: cur.rev + 1, updatedAt: tx.now });
  },

  "note.delete": (tx, a) => {
    const cur = tx.get("notes", a.noteId);
    if (!cur) return; // already gone: deleting twice is fine
    tx.hub.store.run("INSERT OR REPLACE INTO note_revisions (note_id, rev, body, at) VALUES (?, ?, ?, ?)", cur.id, cur.rev, cur.body, tx.now);
    tx.remove("notes", a.noteId);
  },

  "device.update": (tx, a, device) => {
    const d = tx.get("devices", a.deviceId);
    if (!d) throw new MutationError("not_found", "Device not found");
    const next = { ...d };
    if (a.name) next.name = a.name;
    if (a.revoked === true && d.revokedAt == null) {
      if (!device.canApprove) throw new MutationError("forbidden", "This device cannot revoke devices");
      next.revokedAt = tx.now;
      next.online = false;
      tx.audit("device.revoke", "device", d.id, { name: d.name });
      tx.after.push(() => tx.hub.kick(d.id, "revoked"));
    }
    tx.upsert("devices", next);
  },

  "mode.set": (tx, a, device) => {
    // Loosening what an agent may do alone is an approval-grade decision.
    if (!device.canApprove) throw new MutationError("forbidden", "This device cannot change agent permission modes");
    if (a.scope === "agent") {
      const agent = tx.get("agents", a.id);
      if (!agent) throw new MutationError("not_found", "Agent not found");
      if (!a.mode) throw new MutationError("invalid_args", "An agent's default mode cannot be empty");
      if (!agent.modes?.includes(a.mode)) throw new MutationError("invalid_args", `${agent.name} does not offer ${a.mode} mode`);
      if (agent.defaultMode === a.mode) return;
      tx.upsert("agents", { ...agent, defaultMode: a.mode, updatedAt: tx.now });
      tx.audit("mode.set", "agent", agent.id, { scope: "agent", from: agent.defaultMode ?? null, to: a.mode });
      return;
    }
    const th = tx.get("threads", a.id);
    if (!th) throw new MutationError("not_found", "Thread not found");
    const agent = th.agentId ? tx.get("agents", th.agentId) : undefined;
    if (!agent?.modes?.length) throw new MutationError("invalid_args", "This chat's agent has no permission modes");
    if (a.mode && !agent.modes.includes(a.mode)) throw new MutationError("invalid_args", `${agent.name} does not offer ${a.mode} mode`);
    if ((th.mode ?? null) !== a.mode) {
      tx.upsert("threads", { ...th, mode: a.mode, updatedAt: tx.now });
      tx.audit("mode.set", "thread", th.id, { scope: "thread", agentId: agent.id, from: th.mode ?? null, to: a.mode });
    }
    // A live run takes the change for the approvals it has not asked for yet. Plan is a property of how the
    // agent process was started, so a switch to or from plan waits for the next run.
    const next = resolveMode(agent, { mode: a.mode });
    const live = tx.query("runs", "WHERE thread_id = ? ORDER BY created_at DESC LIMIT 5", th.id).find((r) => isLiveRun(r.status));
    if (live && agent.connectorId && next && next !== "plan" && live.mode && live.mode !== "plan" && live.mode !== next) {
      tx.upsert("runs", { ...live, mode: next, updatedAt: tx.now });
      tx.audit("mode.set", "run", live.id, { scope: "run", from: live.mode, to: next });
      tx.command(agent.connectorId, { name: "run.mode", runId: live.id, mode: next });
    }
  },

  "model.set": (tx, a) => setModelChoice(tx, a),

  "folders.set": (tx, a, device) => setFolders(tx, a, device),

  "images.set": (tx, a) => {
    // Who makes images: a session's own choice, or a project's default for its sessions. Read when the next run starts.
    if (a.scope === "project") {
      const p = tx.get("projects", a.id);
      if (!p) throw new MutationError("not_found", "Project not found");
      if ((p.imageRoute ?? null) === a.route) return;
      tx.upsert("projects", { ...p, imageRoute: a.route, updatedAt: tx.now });
      tx.audit("images.set", "project", p.id, { scope: "project", from: p.imageRoute ?? null, to: a.route });
      return;
    }
    const th = tx.get("threads", a.id);
    if (!th) throw new MutationError("not_found", "Thread not found");
    if ((th.imageRoute ?? null) === a.route) return;
    tx.upsert("threads", { ...th, imageRoute: a.route, updatedAt: tx.now });
    tx.audit("images.set", "thread", th.id, { scope: "thread", from: th.imageRoute ?? null, to: a.route });
  },

  "settings.update": (tx, a) => {
    if (a.key === "sla.default") {
      // The Settings screen edits the default policy through this key.
      const p = tx.query("sla_policies", "WHERE is_default = 1")[0] as SlaPolicy | undefined;
      if (!p) throw new MutationError("not_found", "No default SLA policy");
      const v = (a.value ?? {}) as Partial<Pick<SlaPolicy, "respondWithinMinutes" | "warnAtPct" | "calendar" | "name">>;
      const mins = Number(v.respondWithinMinutes ?? p.respondWithinMinutes);
      const pct = Number(v.warnAtPct ?? p.warnAtPct);
      if (!Number.isFinite(mins) || mins < 1 || mins > 100_000) throw new MutationError("invalid_args", "respondWithinMinutes must be 1 to 100000");
      if (!Number.isFinite(pct) || pct < 1 || pct > 100) throw new MutationError("invalid_args", "warnAtPct must be 1 to 100");
      const next = tx.upsert("sla_policies", {
        ...p, name: v.name ?? p.name, respondWithinMinutes: Math.round(mins), warnAtPct: pct,
        calendar: { ...p.calendar, ...(v.calendar ?? {}) }, updatedAt: tx.now,
      });
      // Open items on this policy get their deadlines recomputed.
      for (const item of tx.query("inbox_items", "WHERE sla_policy_id = ? AND status NOT IN ('responded','done')", p.id)) {
        const sla = computeSla(next, item.receivedAt);
        tx.upsert("inbox_items", { ...item, ...sla, slaState: slaStateAt(tx.now, sla.slaDueAt, sla.slaWarnAt), updatedAt: tx.now });
      }
      tx.audit("sla.update", "sla_policy", p.id, { respondWithinMinutes: mins, warnAtPct: pct });
      return;
    }
    tx.upsert("settings", { id: a.key, value: a.value ?? null, updatedAt: tx.now });
  },
};
