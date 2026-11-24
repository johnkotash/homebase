// Takes the demo content that `seed(hub, { demo: true })` creates back out of an existing database
// (`npm run remove-demo`). Synced rows are removed through the hub's change log, so every paired device drops
// them on its next sync; rows that are not synced (run events, audit rows, notifications) are deleted directly.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { EntityName } from "@homebase/protocol";
import type { SqlStore, SqlValue } from "./hub/SqlStore";
import type { WorkspaceHub } from "./hub/WorkspaceHub";

/** Rows created this long after the workspace (or backdated before it) belong to the first-start seed. */
export const SEED_WINDOW_MS = 60_000;
/** The scripted demo agents. A real connector registers claude, comms and notes; those are never touched. */
export const DEMO_AGENT_KEYS = ["dev", "ops"] as const;

export interface PlanRow {
  entity: string;
  id: string;
  label: string;
  /** Created after the seed window: removed only because it belongs to a demo agent or a demo row. */
  late: boolean;
}

export interface DemoPlan {
  workspaceId: string;
  workspaceCreatedAt: number;
  /** Rows at or before this time (workspace creation + SEED_WINDOW_MS) are seed rows. */
  cutoff: number;
  /** Synced rows removed through the change log, in removal order. */
  remove: Array<PlanRow & { entity: EntityName }>;
  /** Kept synced rows that pointed at a removed row: the reference is cleared through the change log. */
  detach: Array<PlanRow & { entity: EntityName; fields: Record<string, null> }>;
  /** Rows of tables that are not synced, deleted directly. */
  direct: PlanRow[];
  /** Pictures attached to removed messages: unlinked, so the hub's weekly sweep deletes them. */
  attachments: string[];
  /** The demo priority senders (every `.example` entry) leave triage.rules. Null: nothing to change. */
  vip: { before: string[]; after: string[] } | null;
}

/** Tables whose row counts the tool reports before and after. */
export const COUNTED_TABLES = [
  "workspaces", "users", "memberships", "devices", "connectors", "agents", "threads", "messages", "runs", "run_events", "approvals",
  "inbox_items", "notes", "note_revisions", "integrations", "projects", "sla_policies", "settings", "vault_files", "attachments",
  "notifications", "audit_log", "changes",
] as const;

const snip = (s: unknown, n = 70) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};
const inList = (ids: string[]) => ids.map(() => "?").join(", ");

function hasTable(store: SqlStore, table: string): boolean {
  return !!store.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", table);
}

/** Row counts of every reported table that exists in this database. */
export function tableCounts(store: SqlStore): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of COUNTED_TABLES) if (hasTable(store, t)) out[t] = Number(store.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)!.n);
  return out;
}

/** Works out what is demo content. Reads only. */
export function planDemoRemoval(store: SqlStore): DemoPlan {
  const ws = store.get<{ id: string; created_at: number }>("SELECT id, created_at FROM workspaces ORDER BY created_at LIMIT 1");
  if (!ws) throw new Error("This database has no workspace.");
  const created = Number(ws.created_at);
  const cutoff = created + SEED_WINDOW_MS;
  const seedEra = (at: unknown) => at != null && Number(at) <= cutoff;
  const has = (t: string) => hasTable(store, t);
  const rows = <T = Record<string, SqlValue>>(sql: string, ...p: SqlValue[]) => store.all<T>(sql, ...p);

  const remove: DemoPlan["remove"] = [];
  const detach: DemoPlan["detach"] = [];
  const direct: PlanRow[] = [];

  // ---- agents: the scripted Dev and Site ops agents ----
  const agents = rows<{ id: string; key: string; name: string }>(
    `SELECT id, key, name FROM agents WHERE kind = 'mock' AND key IN (${inList([...DEMO_AGENT_KEYS])})`, ...DEMO_AGENT_KEYS,
  );
  const agentIds = new Set(agents.map((a) => a.id));
  const isDemoAgent = (id: unknown) => typeof id === "string" && agentIds.has(id);

  // ---- projects created by the seed (backdated, so before the cutoff) ----
  const projects = has("projects") ? rows<any>("SELECT id, name, created_at, default_agent_id FROM projects") : [];
  const projectIds = new Set(projects.filter((p) => seedEra(p.created_at)).map((p) => p.id as string));

  // ---- threads: seed-era, or a session with a demo agent ----
  const threads = rows<any>("SELECT id, title, agent_id, project_id, recap_run_id, created_at FROM threads ORDER BY created_at");
  const threadIds = new Set(threads.filter((t) => seedEra(t.created_at) || isDemoAgent(t.agent_id)).map((t) => t.id as string));

  // ---- runs: seed-era, by a demo agent, or in a removed thread ----
  const runs = rows<any>("SELECT id, agent_id, thread_id, status, prompt, created_at FROM runs ORDER BY created_at");
  const runIds = new Set(runs.filter((r) => seedEra(r.created_at) || isDemoAgent(r.agent_id) || threadIds.has(r.thread_id)).map((r) => r.id as string));

  // ---- messages: in a removed thread, or written by a removed run ----
  const messages = rows<any>("SELECT id, thread_id, run_id, role, text, created_at FROM messages ORDER BY created_at");
  const removedMessages = messages.filter((m) => threadIds.has(m.thread_id) || (m.run_id && runIds.has(m.run_id)));

  // ---- approvals: seed-era, a demo agent's, or a removed run's ----
  const approvals = rows<any>("SELECT id, run_id, agent_id, title, requested_at FROM approvals ORDER BY requested_at");
  const removedApprovals = approvals.filter((a) => seedEra(a.requested_at) || isDemoAgent(a.agent_id) || runIds.has(a.run_id));

  // ---- inbox, notes, integrations ----
  const inbox = rows<any>("SELECT id, source, title, created_at, linked_thread_id, linked_run_id, assigned_agent_id FROM inbox_items ORDER BY created_at");
  const notes = rows<any>("SELECT id, title, created_at FROM notes ORDER BY created_at");
  const integrations = rows<any>("SELECT id, kind, name, status FROM integrations");

  for (const a of removedApprovals) remove.push({ entity: "approvals", id: a.id, label: snip(a.title), late: !seedEra(a.requested_at) });
  for (const m of removedMessages) remove.push({ entity: "messages", id: m.id, label: `${m.role}: ${snip(m.text, 60)}`, late: !seedEra(m.created_at) });
  for (const r of runs.filter((r) => runIds.has(r.id))) remove.push({ entity: "runs", id: r.id, label: `${r.status}: ${snip(r.prompt, 60)}`, late: !seedEra(r.created_at) });
  for (const t of threads.filter((t) => threadIds.has(t.id))) remove.push({ entity: "threads", id: t.id, label: snip(t.title), late: !seedEra(t.created_at) });
  for (const i of inbox.filter((i) => seedEra(i.created_at))) remove.push({ entity: "inbox_items", id: i.id, label: `${i.source}: ${snip(i.title, 60)}`, late: false });
  for (const n of notes.filter((n) => seedEra(n.created_at))) remove.push({ entity: "notes", id: n.id, label: snip(n.title), late: false });
  for (const p of projects.filter((p) => projectIds.has(p.id))) remove.push({ entity: "projects", id: p.id, label: snip(p.name), late: false });
  for (const i of integrations.filter((i) => i.status === "simulated")) remove.push({ entity: "integrations", id: i.id, label: `${i.kind}: ${snip(i.name)}`, late: false });
  for (const a of agents) remove.push({ entity: "agents", id: a.id, label: `${a.name} (${a.key})`, late: false });

  // ---- kept rows that point at removed ones: the pointer is cleared, the row stays ----
  for (const t of threads.filter((t) => !threadIds.has(t.id))) {
    const fields: Record<string, null> = {};
    if (t.project_id && projectIds.has(t.project_id)) fields.projectId = null;
    if (t.recap_run_id && runIds.has(t.recap_run_id)) fields.recapRunId = null;
    if (Object.keys(fields).length) detach.push({ entity: "threads", id: t.id, label: snip(t.title), late: !seedEra(t.created_at), fields });
  }
  for (const i of inbox.filter((i) => !seedEra(i.created_at))) {
    const fields: Record<string, null> = {};
    if (i.linked_thread_id && threadIds.has(i.linked_thread_id)) fields.linkedThreadId = null;
    if (i.linked_run_id && runIds.has(i.linked_run_id)) fields.linkedRunId = null;
    if (isDemoAgent(i.assigned_agent_id)) fields.assignedAgentId = null;
    if (Object.keys(fields).length) detach.push({ entity: "inbox_items", id: i.id, label: `${i.source}: ${snip(i.title, 60)}`, late: true, fields });
  }
  for (const p of projects.filter((p) => !projectIds.has(p.id) && isDemoAgent(p.default_agent_id))) {
    detach.push({ entity: "projects", id: p.id, label: snip(p.name), late: true, fields: { defaultAgentId: null, defaultCwd: null } });
  }

  // ---- tables that are not synced ----
  const removedIds = new Set(remove.map((r) => r.id));
  const runList = [...runIds];
  if (runList.length) {
    for (const r of rows<{ run_id: string; n: number }>(`SELECT run_id, COUNT(*) AS n FROM run_events WHERE run_id IN (${inList(runList)}) GROUP BY run_id`, ...runList)) {
      direct.push({ entity: "run_events", id: r.run_id, label: `${r.n} event(s) of run ${r.run_id}`, late: false });
    }
  }
  const noteList = remove.filter((r) => r.entity === "notes").map((r) => r.id);
  if (noteList.length) {
    for (const r of rows<{ note_id: string; n: number }>(`SELECT note_id, COUNT(*) AS n FROM note_revisions WHERE note_id IN (${inList(noteList)}) GROUP BY note_id`, ...noteList)) {
      direct.push({ entity: "note_revisions", id: r.note_id, label: `${r.n} revision(s) of note ${r.note_id}`, late: false });
    }
  }
  // Audit rows and notifications go with the row they are about, never by date alone: a connector or device paired
  // in the first minute is real. The seed marks its own audit rows `"seeded": true`.
  const seededAudit = (detail: unknown) => {
    try {
      return JSON.parse(String(detail ?? "null"))?.seeded === true;
    } catch {
      return false;
    }
  };
  for (const a of rows<any>("SELECT id, at, action, subject_type, subject_id, detail FROM audit_log ORDER BY at")) {
    if (removedIds.has(a.subject_id) || seededAudit(a.detail)) direct.push({ entity: "audit_log", id: a.id, label: `${a.action} ${a.subject_type ?? ""} ${a.subject_id ?? ""}`.trim(), late: !seedEra(a.at) });
  }
  if (has("notifications")) {
    for (const n of rows<any>("SELECT id, title, subject_id, created_at FROM notifications ORDER BY created_at")) {
      if (removedIds.has(n.subject_id)) direct.push({ entity: "notifications", id: n.id, label: snip(n.title), late: !seedEra(n.created_at) });
    }
  }
  const msgList = removedMessages.map((m) => m.id as string);
  const attachments = has("attachments") && msgList.length
    ? rows<{ id: string }>(`SELECT id FROM attachments WHERE message_id IN (${inList(msgList)})`, ...msgList).map((a) => a.id)
    : [];

  // ---- the demo priority senders ----
  let vip: DemoPlan["vip"] = null;
  const rules = store.get<{ value: string | null }>("SELECT value FROM settings WHERE id = 'triage.rules'");
  if (rules?.value) {
    try {
      const v = JSON.parse(rules.value);
      const before: string[] = Array.isArray(v?.vipSenders) ? v.vipSenders.map(String) : [];
      const after = before.filter((s) => !s.trim().toLowerCase().endsWith(".example"));
      if (after.length !== before.length) vip = { before, after };
    } catch {
      // An unreadable setting is left alone.
    }
  }

  return { workspaceId: ws.id, workspaceCreatedAt: created, cutoff, remove, detach, direct, attachments, vip };
}

export function planIsEmpty(plan: DemoPlan): boolean {
  return !plan.remove.length && !plan.detach.length && !plan.direct.length && !plan.attachments.length && !plan.vip;
}

/** Carries out a plan in one transaction. The hub must not be running against this database. */
export function applyDemoRemoval(hub: WorkspaceHub, plan: DemoPlan): void {
  const prev = hub.suppressNotifications;
  hub.suppressNotifications = true;
  try {
    hub.commit(null, null, (tx) => {
      for (const d of plan.detach) {
        const cur = tx.get(d.entity, d.id);
        if (cur) tx.upsert(d.entity, { ...cur, ...d.fields } as any);
      }
      for (const r of plan.remove) if (tx.get(r.entity, r.id)) tx.remove(r.entity, r.id);
      const del = (table: string, col: string, ids: string[]) => {
        for (let i = 0; i < ids.length; i += 200) {
          const chunk = ids.slice(i, i + 200);
          hub.store.run(`DELETE FROM ${table} WHERE ${col} IN (${inList(chunk)})`, ...chunk);
        }
      };
      const ids = (entity: string) => plan.direct.filter((d) => d.entity === entity).map((d) => d.id);
      del("run_events", "run_id", ids("run_events"));
      del("note_revisions", "note_id", ids("note_revisions"));
      del("audit_log", "id", ids("audit_log"));
      del("notifications", "id", ids("notifications"));
      // Unlinked pictures are uploads no message took; the hub's sweep deletes them and their files.
      for (let i = 0; i < plan.attachments.length; i += 200) {
        const chunk = plan.attachments.slice(i, i + 200);
        hub.store.run(`UPDATE attachments SET message_id = NULL WHERE id IN (${inList(chunk)})`, ...chunk);
      }
      if (plan.vip) {
        const cur = tx.get("settings", "triage.rules");
        if (cur) tx.upsert("settings", { ...cur, value: { ...(cur.value as object), vipSenders: plan.vip.after }, updatedAt: tx.now });
      }
      const counts: Record<string, number> = {};
      for (const r of [...plan.remove, ...plan.direct]) counts[r.entity] = (counts[r.entity] ?? 0) + 1;
      tx.audit("demo.remove", "workspace", plan.workspaceId, { removed: counts, detached: plan.detach.length, vipSendersRemoved: plan.vip ? plan.vip.before.length - plan.vip.after.length : 0 });
    });
  } finally {
    hub.suppressNotifications = prev;
  }
}

/** Human-readable plan, one line per row. */
export function formatPlan(plan: DemoPlan): string[] {
  const out: string[] = [];
  const iso = (t: number) => new Date(t).toISOString();
  out.push(`Workspace created ${iso(plan.workspaceCreatedAt)}; seed rows are those dated up to ${iso(plan.cutoff)}.`);
  if (planIsEmpty(plan)) {
    out.push("No demo content found. Nothing to do.");
    return out;
  }
  const group = (title: string, list: PlanRow[]) => {
    if (!list.length) return;
    out.push("", title);
    for (const r of list) out.push(`  ${r.entity.padEnd(14)} ${r.id.padEnd(41)} ${r.label}${r.late ? "   [created after the seed]" : ""}`);
  };
  group("Remove (through the change log; paired devices drop these on their next sync):", plan.remove);
  group("Keep, but clear references to removed rows:", plan.detach.map((d) => ({ ...d, label: `${d.label}  (clear ${Object.keys(d.fields).join(", ")})` })));
  group("Delete directly (not synced):", plan.direct);
  if (plan.attachments.length) out.push("", `Unlink ${plan.attachments.length} picture(s) attached to removed messages (the hub's weekly sweep deletes them).`);
  if (plan.vip) out.push("", `triage.rules vipSenders: ${JSON.stringify(plan.vip.before)} -> ${JSON.stringify(plan.vip.after)}`);
  return out;
}

/**
 * True when another connection has the database open, which is what a running hub does: the probe asks SQLite
 * for an exclusive lock without waiting. A database nobody has open gives the lock (released at once).
 */
export function databaseInUse(path: string): boolean {
  if (!existsSync(path)) return false;
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;");
    db.exec("ROLLBACK");
    return false;
  } catch (err) {
    if (/locked|busy/i.test((err as Error).message)) return true;
    throw err;
  } finally {
    db.close();
  }
}

/** A read-only SqlStore for the dry run: it never writes, so it is safe next to a running hub. */
export class ReadOnlyStore implements SqlStore {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path, { readOnly: true });
  }
  exec(): void {
    throw new Error("read-only");
  }
  run(): never {
    throw new Error("read-only");
  }
  all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.db.prepare(sql).all(...(params as any[])) as T[];
  }
  get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.db.prepare(sql).get(...(params as any[])) as T | undefined;
  }
  transaction<T>(fn: () => T): T {
    return fn();
  }
  close(): void {
    this.db.close();
  }
}
