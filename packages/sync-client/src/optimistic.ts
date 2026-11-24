import {
  EFFORTS, RECAP_REQUEST, approvedFolder, isDefaultTitle, sameModel, startFolders, sameFolder, tidyFolders, titleFromMessage, type Effort, type FolderRef, type EntityName, type EntityTypes, type MutationArgs, type MutationName,
} from "@homebase/protocol";
import { readUpTo } from "@homebase/protocol";
import type { EntityMaps, OutboxEntry } from "./store";

interface Ctx {
  at: number;
  deviceId: string | null;
}

/** Copy-on-write helper: only the touched entity map is cloned. */
class Draft {
  private cloned = new Set<EntityName>();
  constructor(public maps: EntityMaps) {
    this.maps = { ...maps };
  }
  get<E extends EntityName>(e: E, id: string): EntityTypes[E] | undefined {
    return this.maps[e][id];
  }
  private own<E extends EntityName>(e: E): Record<string, EntityTypes[E]> {
    if (!this.cloned.has(e)) {
      (this.maps as any)[e] = { ...this.maps[e] };
      this.cloned.add(e);
    }
    return this.maps[e];
  }
  set<E extends EntityName>(e: E, row: EntityTypes[E]) {
    this.own(e)[row.id] = row;
  }
  patch<E extends EntityName>(e: E, id: string, partial: Partial<EntityTypes[E]>) {
    const cur = this.maps[e][id];
    if (cur) this.own(e)[id] = { ...cur, ...partial };
  }
  del(e: EntityName, id: string) {
    if (this.maps[e][id]) delete this.own(e)[id];
  }
}

type Reducer<N extends MutationName> = (d: Draft, a: MutationArgs<N>, ctx: Ctx) => void;

/** Local predictions of what the hub will do. The hub's rows replace them when the change arrives. */
const REDUCERS: { [N in MutationName]?: Reducer<N> } = {
  "thread.create": (d, a, { at, deviceId }) => {
    if (d.get("threads", a.threadId)) return;
    d.set("threads", {
      id: a.threadId, title: a.title, agentId: a.agentId ?? null, lastMessageAt: null, pinned: false, archived: false,
      createdBy: deviceId, createdAt: at, updatedAt: at, mode: null,
      // A project this device does not know yet (or any more) would be refused by the hub: show Unsorted meanwhile.
      projectId: a.projectId && d.get("projects", a.projectId) ? a.projectId : null,
      cwd: a.cwd ?? null, folders: a.folders?.length ? a.folders : null,
    });
  },
  "thread.update": (d, a, { at }) => {
    const patch: Record<string, unknown> = { updatedAt: at };
    if (a.title !== undefined) patch.title = a.title;
    if (a.archived !== undefined) patch.archived = a.archived;
    if (a.pinned !== undefined) patch.pinned = a.pinned;
    if (a.projectId !== undefined && (a.projectId === null || d.get("projects", a.projectId))) patch.projectId = a.projectId;
    if (a.note !== undefined) patch.note = a.note?.trim() || null;
    d.patch("threads", a.threadId, patch);
  },
  "thread.recap": (d, a, { at, deviceId }) => {
    const th = d.get("threads", a.threadId);
    if (!th?.agentId || d.get("messages", a.messageId)) return;
    d.set("messages", {
      id: a.messageId, threadId: a.threadId, role: "user", text: RECAP_REQUEST, source: "text", runId: null, authorDeviceId: deviceId, createdAt: at,
    });
    d.patch("threads", a.threadId, { lastMessageAt: at, updatedAt: at });
  },
  "thread.read": (d, a) => {
    // The badge and the dot clear at once on this device; the hub settles the same value for the others.
    const th = d.get("threads", a.threadId);
    const upTo = th ? readUpTo(th, a.at) : null;
    if (upTo != null) d.patch("threads", a.threadId, { readAt: upTo });
  },
  "project.create": (d, a, { at }) => {
    if (d.get("projects", a.projectId)) return;
    d.set("projects", {
      id: a.projectId, name: a.name.trim(), description: a.description?.trim() || null, defaultAgentId: a.defaultAgentId ?? null,
      defaultCwd: a.defaultCwd || null, pinned: false, archived: false, createdAt: at, updatedAt: at,
    });
  },
  "project.update": (d, a, { at }) => {
    const p = d.get("projects", a.projectId);
    if (!p) return;
    const agentId = a.defaultAgentId !== undefined ? a.defaultAgentId : p.defaultAgentId;
    d.set("projects", {
      ...p, name: a.name?.trim() || p.name, description: a.description !== undefined ? a.description?.trim() || null : p.description,
      defaultAgentId: agentId, defaultCwd: a.defaultCwd !== undefined ? a.defaultCwd || null : agentId === p.defaultAgentId ? p.defaultCwd : null,
      pinned: a.pinned ?? p.pinned, archived: a.archived ?? p.archived, updatedAt: at,
    });
  },
  "project.delete": (d, a, { at }) => {
    if (!d.get("projects", a.projectId)) return;
    // Its sessions go back to Unsorted; none is deleted.
    for (const th of Object.values(d.maps.threads)) if (th.projectId === a.projectId) d.patch("threads", th.id, { projectId: null, updatedAt: at });
    d.del("projects", a.projectId);
  },
  "message.send": (d, a, { at, deviceId }) => {
    if (d.get("messages", a.messageId)) return;
    d.set("messages", {
      id: a.messageId, threadId: a.threadId, role: "user", text: a.text, source: a.source, runId: null, authorDeviceId: deviceId, createdAt: at,
      ...(a.attachments?.length ? { attachments: a.attachments } : {}),
    });
    const th = d.get("threads", a.threadId);
    // The hub names a session that still has its placeholder title after the first thing said in it (pictures alone do not name it).
    d.patch("threads", a.threadId, { lastMessageAt: at, updatedAt: at, ...(th && isDefaultTitle(th.title) && a.text.trim() ? { title: titleFromMessage(a.text) } : {}) });
  },
  "run.start": (d, a, { at, deviceId }) => {
    if (d.get("runs", a.runId)) return;
    d.set("runs", {
      id: a.runId, agentId: a.agentId, threadId: a.threadId ?? null, prompt: a.prompt, status: "queued", sessionRef: null, summary: null,
      error: null, costUsd: null, numTurns: null, durationMs: null, lastEventIdx: -1, startedBy: deviceId, cwd: a.options?.cwd ?? null,
      createdAt: at, startedAt: null, endedAt: null, updatedAt: at, mode: a.options?.mode ?? null,
    });
  },
  "approval.decide": (d, a, { at, deviceId }) => {
    const cur = d.get("approvals", a.approvalId);
    if (!cur || cur.status !== "pending") return;
    // Approving a plan moves the run and its chat to the chosen mode.
    const planMode = cur.kind === "plan" && a.decision === "approve" ? a.mode ?? "manual" : null;
    d.patch("approvals", a.approvalId, {
      status: a.decision === "approve" ? "approved" : "denied", decisionMessage: a.message ?? null, answers: a.answers ?? null,
      decidedBy: deviceId, decidedAt: at, ...(planMode ? { mode: planMode } : {}),
    });
    if (planMode) {
      const run = d.get("runs", cur.runId);
      d.patch("runs", cur.runId, { mode: planMode });
      if (run?.threadId) d.patch("threads", run.threadId, { mode: planMode });
    }
  },
  "mode.set": (d, a, { at }) => {
    if (a.scope === "agent") {
      const agent = d.get("agents", a.id);
      if (agent && a.mode && agent.modes?.includes(a.mode)) d.patch("agents", a.id, { defaultMode: a.mode, updatedAt: at });
      return;
    }
    const th = d.get("threads", a.id);
    const agent = th?.agentId ? d.get("agents", th.agentId) : undefined;
    if (th && agent?.modes?.length && (!a.mode || agent.modes.includes(a.mode))) d.patch("threads", a.id, { mode: a.mode, updatedAt: at });
  },
  "model.set": (d, a, { at }) => {
    const th = a.scope === "thread" ? d.get("threads", a.id) : undefined;
    const agent = a.scope === "agent" ? d.get("agents", a.id) : th?.agentId ? d.get("agents", th.agentId) : undefined;
    // The hub refuses anything the agent does not offer; nothing is shown that it would not accept.
    if (!agent?.models?.length) return;
    const model = a.model == null ? a.model : agent.models.find((m) => sameModel(m, a.model));
    if (a.model != null && model === undefined) return;
    if (a.effort != null && !(agent.efforts ?? EFFORTS).includes(a.effort)) return;
    const patch: { model?: string | null; effort?: Effort | null } = {};
    if (model !== undefined) patch.model = model;
    if (a.effort !== undefined) patch.effort = a.effort;
    if (a.scope === "agent") {
      d.patch("agents", a.id, { ...(patch.model !== undefined ? { defaultModel: patch.model } : {}), ...(patch.effort !== undefined ? { defaultEffort: patch.effort } : {}), updatedAt: at });
    } else if (th) {
      d.patch("threads", a.id, { ...patch, ...(a.fresh ? { sessionResetAt: at } : {}), updatedAt: at });
    }
  },
  "folders.set": (d, a, { at }) => {
    // Shown at once only when the hub would take it: folders the agent's connector has approved. The hub settles the rest.
    const th = a.scope === "thread" ? d.get("threads", a.id) : undefined;
    const p = a.scope === "project" ? d.get("projects", a.id) : undefined;
    const agentId = a.scope === "agent" ? a.id : th?.agentId ?? p?.defaultAgentId ?? null;
    const agent = agentId ? d.get("agents", agentId) : undefined;
    const cwdOk = a.cwd == null || (!!agent && startFolders(agent).some((f) => sameFolder(f.path, a.cwd)));
    const extrasOk = !a.folders || a.folders.every((f) => {
      const ok = agent ? approvedFolder(agent, f.path) : Object.values(d.maps.agents).map((x) => approvedFolder(x, f.path)).find(Boolean);
      return !!ok && (f.access === "read" || ok.access === "write");
    });
    if (!cwdOk || !extrasOk) return;
    const extras = (cwd: string | null | undefined): { folders?: FolderRef[] | null } => {
      if (!a.folders) return {};
      const list = tidyFolders(a.folders, a.scope === "project" ? cwd : null);
      return { folders: list.length ? list : null };
    };
    if (a.scope === "agent") {
      const list = extras(null);
      if (agent) d.patch("agents", a.id, { ...(a.cwd !== undefined ? { defaultCwd: a.cwd } : {}), ...(list.folders !== undefined ? { defaultFolders: list.folders } : {}), updatedAt: at });
    } else if (p) {
      if (a.cwd != null && !agent) return;
      const cwd = a.cwd !== undefined ? a.cwd : p.defaultCwd;
      d.patch("projects", a.id, { defaultCwd: cwd, ...extras(cwd), updatedAt: at });
    } else if (th) {
      // A new folder for a session that has talked needs a fresh agent session; without that flag the hub refuses, so nothing is shown.
      const moving = a.cwd !== undefined && !((!a.cwd && !th.cwd) || sameFolder(a.cwd, th.cwd));
      const talked = th.lastRunStatus != null;
      if (moving && talked && !a.fresh) return;
      d.patch("threads", a.id, { ...(moving ? { cwd: a.cwd, ...(talked ? { sessionResetAt: at } : {}) } : {}), ...extras(null), updatedAt: at });
    }
  },
  "images.set": (d, a, { at }) => {
    if (a.scope === "project") d.patch("projects", a.id, { imageRoute: a.route, updatedAt: at });
    else d.patch("threads", a.id, { imageRoute: a.route, updatedAt: at });
  },
  "inbox.update": (d, a, { at }) => {
    const cur = d.get("inbox_items", a.itemId);
    if (!cur) return;
    const next = { ...cur, updatedAt: at };
    if (a.priority) next.priority = a.priority;
    if (a.assignedAgentId !== undefined) next.assignedAgentId = a.assignedAgentId;
    if (a.linkedThreadId !== undefined) next.linkedThreadId = a.linkedThreadId;
    if (a.status) {
      next.status = a.status;
      if (a.status === "responded" || a.status === "done") {
        next.respondedAt = cur.respondedAt ?? at;
        if (cur.slaState === "running" || cur.slaState === "warning") next.slaState = cur.slaDueAt != null && at > cur.slaDueAt ? "breached" : "met";
        next.snoozeUntil = null;
      } else if (a.status !== "snoozed") next.snoozeUntil = null;
    }
    if (a.snoozeUntil !== undefined && next.status === "snoozed") next.snoozeUntil = a.snoozeUntil;
    d.set("inbox_items", next);
  },
  "inbox.capture": (d, a, { at }) => {
    if (d.get("inbox_items", a.itemId)) return;
    d.set("inbox_items", {
      id: a.itemId, source: "manual", externalId: null, externalUrl: null, title: a.title, snippet: a.body?.slice(0, 140) ?? null,
      body: a.body ?? null, sender: "You", clientLabel: null, priority: a.priority ?? "P2", status: "new", triageReason: "Captured by you",
      assignedAgentId: null, linkedThreadId: null, linkedRunId: null, slaPolicyId: null, slaDueAt: null, slaWarnAt: null, slaState: "none",
      respondedAt: null, snoozeUntil: null, receivedAt: at, createdAt: at, updatedAt: at,
    });
  },
  "note.upsert": (d, a, { at }) => {
    const cur = d.get("notes", a.noteId);
    if (cur) d.set("notes", { ...cur, title: a.title, body: a.body, tags: a.tags ?? cur.tags, rev: cur.rev + 1, updatedAt: at });
    else {
      d.set("notes", {
        id: a.noteId, title: a.title, body: a.body, tags: a.tags ?? [], rev: 1, source: a.source ?? "text", vaultPath: null, createdAt: at, updatedAt: at,
      });
    }
  },
  "note.delete": (d, a) => d.del("notes", a.noteId),
  "device.update": (d, a) => {
    if (a.name) d.patch("devices", a.deviceId, { name: a.name });
  },
  "settings.update": (d, a, { at }) => {
    if (a.key === "sla.default") return; // the hub recomputes deadlines; wait for it
    d.set("settings", { id: a.key, value: a.value, updatedAt: at });
  },
};

export function applyOptimistic(server: EntityMaps, outbox: OutboxEntry[], deviceId: string | null): EntityMaps {
  if (outbox.length === 0) return server;
  const draft = new Draft(server);
  for (const m of outbox) {
    const reducer = REDUCERS[m.name] as Reducer<any> | undefined;
    try {
      reducer?.(draft, m.args as any, { at: m.at, deviceId });
    } catch {
      // A prediction must never break rendering; the hub result will settle it.
    }
  }
  return draft.maps;
}
