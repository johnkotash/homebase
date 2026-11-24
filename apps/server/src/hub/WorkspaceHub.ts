import {
  ENTITY_NAMES, MUTATIONS, SCHEMA_VERSION, isMutationName, newId, runTopic,
  type Change, type CmdFrame, type EntityName, type EntityTypes, type InboundFrame, type InboxItem, type Notification,
  type RunEvent, type SlaPolicy, type Workspace,
} from "@homebase/protocol";
import type { SqlStore, SqlValue } from "./SqlStore";
import { TABLES, deleteEntity, queryEntities, readEntity, rowToEntity, writeEntity } from "./tables";
import { MUTATION_HANDLERS } from "./mutations";
import { onApprovalRequest } from "./approvals";
import { onConnectorGone, onRegister, onRunEvent, onRunStatus, resumeList } from "./runs";
import { backfillSessions, onRunWritten } from "./sessions";
import { onMessageWritten } from "./readState";
import { VaultRelay, onVaultIndex } from "./vault";
import { BrowserRelay } from "./browser";
import { FolderRelay, backfillFolders } from "./folders";
import { deliverable } from "./notify";
import { computeSla, pickPolicy, slaStateAt } from "./sla";
import { DEFAULT_TRIAGE, triage, type InboxItemDraft } from "../ingest/triage";

export interface Peer {
  id: string;
  role: "device" | "connector";
  name: string;
  canApprove: boolean;
  topics: Set<string>;
  send(frame: object): void;
  close(code?: number, reason?: string): void;
}

export class MutationError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;
export type CmdDraft = DistributiveOmit<CmdFrame, "t" | "id">;

/** A unit of work: entity writes go to the tables and the change log in one transaction. */
export class Tx {
  changes: Change[] = [];
  notifications: Array<Notification & { subjectType?: string; subjectId?: string }> = [];
  commands: Array<{ connectorId: string; cmd: CmdDraft }> = [];
  after: Array<() => void> = [];

  constructor(public hub: WorkspaceHub, public actorId: string | null, public mutationId: string | null, public now: number) {}

  get<E extends EntityName>(entity: E, id: string): EntityTypes[E] | undefined {
    return readEntity(this.hub.store, entity, id);
  }

  query<E extends EntityName>(entity: E, where = "", ...params: SqlValue[]): EntityTypes[E][] {
    return queryEntities(this.hub.store, entity, where, ...params);
  }

  upsert<E extends EntityName>(entity: E, obj: EntityTypes[E]): EntityTypes[E] {
    writeEntity(this.hub.store, entity, obj as any);
    const stored = readEntity<EntityTypes[E]>(this.hub.store, entity, obj.id)!;
    this.log(entity, obj.id, "upsert", stored as any);
    // A session always knows the status of its newest run, whoever wrote the run.
    if (entity === "runs") onRunWritten(this, stored as EntityTypes["runs"]);
    // And whether the agent has said something the owner has not seen yet.
    if (entity === "messages") onMessageWritten(this, stored as EntityTypes["messages"]);
    return stored;
  }

  patch<E extends EntityName>(entity: E, id: string, partial: Partial<EntityTypes[E]>): EntityTypes[E] {
    const cur = this.get(entity, id);
    if (!cur) throw new MutationError("not_found", `${entity} ${id} not found`);
    return this.upsert(entity, { ...cur, ...partial });
  }

  remove(entity: EntityName, id: string): void {
    deleteEntity(this.hub.store, entity, id);
    this.log(entity, id, "delete");
  }

  private log(entity: EntityName, id: string, op: "upsert" | "delete", data?: Record<string, unknown>) {
    const r = this.hub.store.run(
      "INSERT INTO changes (entity, entity_id, op, data, at, mutation_id, actor_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      entity, id, op, data ? JSON.stringify(data) : null, this.now, this.mutationId, this.actorId,
    );
    const change: Change = { seq: r.lastInsertRowid, entity, id, op, at: this.now };
    if (data) change.data = data;
    this.changes.push(change);
  }

  audit(action: string, subjectType: string, subjectId: string, detail: Record<string, unknown> = {}) {
    this.hub.store.run(
      "INSERT INTO audit_log (id, at, actor_id, action, subject_type, subject_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
      newId("aud"), this.now, this.actorId, action, subjectType, subjectId, JSON.stringify(detail),
    );
  }

  notify(n: Omit<Notification, "id"> & { subjectType?: string; subjectId?: string }) {
    const id = newId("ntf");
    this.hub.store.run(
      `INSERT INTO notifications (id, priority, channel, title, body, link, collapse_key, subject_type, subject_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, n.priority, n.channel, n.title, n.body, n.link ?? null, n.collapseKey ?? null, n.subjectType ?? null, n.subjectId ?? null, this.now,
    );
    this.notifications.push({ ...n, id });
  }

  command(connectorId: string, cmd: CmdDraft) {
    this.commands.push({ connectorId, cmd });
  }
}

export interface HubOptions {
  now?: () => number;
  devMode?: boolean;
  /** How many change-log rows to keep. Clients further behind than this get a snapshot. */
  retainChanges?: number;
  quiet?: boolean;
}

/**
 * One instance per workspace. Owns the database, the change log, every socket, approvals, SLA timers
 * and connector routing. Written against SqlStore only, so it ports to a Durable Object.
 */
export class WorkspaceHub {
  peers = new Set<Peer>();
  now: () => number;
  devMode: boolean;
  retainChanges: number;
  suppressNotifications = false;
  private pendingCmds = new Map<string, Map<string, CmdFrame>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private quiet: boolean;
  /** Vault requests in flight between a device and the connector. Nothing in it is stored or logged. */
  vault = new VaultRelay(this);
  /** A connector's browser, relayed live to the devices watching it. Nothing in it is stored. */
  browser = new BrowserRelay(this);
  /** Folder-browser requests in flight between a device and an agent's connector. Folder names pass through; nothing is stored. */
  folders = new FolderRelay(this);

  constructor(public store: SqlStore, opts: HubOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.devMode = opts.devMode ?? true;
    this.retainChanges = opts.retainChanges ?? 5000;
    this.quiet = opts.quiet ?? false;
  }

  log(...args: unknown[]) {
    if (!this.quiet) console.log("[hub]", ...args);
  }

  // ---------- lifecycle ----------
  start(tickMs = 30_000) {
    // Nothing is connected at boot, whatever the last process left behind.
    this.commit(null, null, (tx) => {
      for (const d of tx.query("devices", "WHERE online = 1")) tx.upsert("devices", { ...d, online: false });
      for (const c of tx.query("connectors", "WHERE status = 'online'")) tx.upsert("connectors", { ...c, status: "offline" });
      for (const a of tx.query("agents", "WHERE status = 'online'")) tx.upsert("agents", { ...a, status: "offline", updatedAt: tx.now });
    });
    // Sessions from before session organisation get their status, digest and a real title. Idempotent.
    backfillSessions(this);
    // Sessions from before folders were kept on the session get the folder they already work in written down. Idempotent.
    backfillFolders(this);
    this.pruneChanges();
    this.store.run("DELETE FROM mutations WHERE at < ?", this.now() - 7 * 86_400_000);
    this.tick();
    this.timer = setInterval(() => this.tick(), tickMs);
    (this.timer as any).unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const p of [...this.peers]) p.close(1001, "hub stopping");
    this.peers.clear();
  }

  pruneChanges() {
    const max = this.currentSeq();
    this.store.run("DELETE FROM changes WHERE seq <= ?", max - this.retainChanges);
  }

  // ---------- transactions ----------
  commit<T>(actorId: string | null, mutationId: string | null, fn: (tx: Tx) => T): T {
    const tx = new Tx(this, actorId, mutationId, this.now());
    const out = this.store.transaction(() => fn(tx));
    this.afterCommit(tx);
    return out;
  }

  private afterCommit(tx: Tx) {
    if (tx.changes.length) {
      const frame = { t: "changes", from: tx.changes[0].seq, to: tx.changes[tx.changes.length - 1].seq, changes: tx.changes };
      for (const p of this.peers) if (p.role === "device") p.send(frame);
    }
    if (!this.suppressNotifications) {
      for (const n of tx.notifications) {
        if (!deliverable(this, n)) continue;
        const { subjectType: _s, subjectId: _i, ...notification } = n;
        let sent = 0;
        for (const p of this.peers) {
          if (p.role !== "device") continue;
          p.send({ t: "notify", notification });
          sent++;
        }
        if (sent) this.store.run("UPDATE notifications SET delivered_at = ? WHERE id = ?", this.now(), n.id);
      }
    }
    for (const c of tx.commands) this.sendCommand(c.connectorId, c.cmd);
    for (const f of tx.after) f();
  }

  currentSeq(): number {
    const r = this.store.get<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'changes'");
    return r ? Number(r.seq) : 0;
  }

  workspace(): Workspace {
    return rowToEntity<Workspace>("workspace", this.store.get("SELECT * FROM workspaces LIMIT 1"))!;
  }

  setting<T>(key: string, fallback: T): T {
    const row = this.store.get<{ value: string | null }>("SELECT value FROM settings WHERE id = ?", key);
    if (!row || row.value == null) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return fallback;
    }
  }

  // ---------- sync ----------
  snapshot(): { seq: number; entities: Record<string, unknown[]> } {
    return this.store.transaction(() => {
      const now = this.now();
      const entities: Record<string, unknown[]> = {};
      for (const e of ENTITY_NAMES) {
        const t = TABLES[e].table;
        if (e === "messages") {
          entities[e] = this.store
            .all<Record<string, SqlValue>>(
              `SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY created_at DESC, id DESC) AS rn FROM messages) WHERE rn <= 200 ORDER BY created_at, id`,
            )
            .map((r) => rowToEntity(e, r));
        } else if (e === "inbox_items") {
          entities[e] = queryEntities(this.store, e, "WHERE status NOT IN ('done','responded') OR updated_at > ?", now - 30 * 86_400_000);
        } else if (e === "runs") {
          entities[e] = queryEntities(this.store, e, "ORDER BY created_at DESC LIMIT 100");
        } else if (e === "devices") {
          entities[e] = queryEntities(this.store, e, "WHERE kind = 'device'");
        } else {
          entities[e] = this.store.all<Record<string, SqlValue>>(`SELECT * FROM ${t}`).map((r) => rowToEntity(e, r));
        }
      }
      return { seq: this.currentSeq(), entities };
    });
  }

  changesAfter(seq: number): Change[] {
    return this.store
      .all<{ seq: number; entity: EntityName; entity_id: string; op: "upsert" | "delete"; data: string | null; at: number }>(
        "SELECT seq, entity, entity_id, op, data, at FROM changes WHERE seq > ? ORDER BY seq", seq,
      )
      .map((r) => {
        const c: Change = { seq: Number(r.seq), entity: r.entity, id: r.entity_id, op: r.op, at: Number(r.at) };
        if (r.data) c.data = JSON.parse(r.data);
        return c;
      });
  }

  /** True when a client at `lastSeq` can be caught up from the retained change log. */
  canDelta(lastSeq: number | undefined, schema: number | undefined): boolean {
    if (!lastSeq || lastSeq <= 0) return false;
    if (schema !== undefined && schema !== SCHEMA_VERSION) return false;
    const cur = this.currentSeq();
    if (lastSeq > cur) return false;
    if (lastSeq === cur) return true;
    const min = this.store.get<{ m: number | null }>("SELECT MIN(seq) AS m FROM changes")?.m;
    return min != null && Number(min) <= lastSeq + 1;
  }

  attachDevice(peer: Peer, hello: { lastSeq?: number; schema?: number }) {
    const delta = this.canDelta(hello.lastSeq, hello.schema);
    // Presence is written before the peer is attached so its own catch-up includes it.
    this.commit(peer.id, null, (tx) => {
      const d = tx.get("devices", peer.id);
      if (d) tx.upsert("devices", { ...d, online: true, lastSeenAt: tx.now });
    });
    const seq = this.currentSeq();
    peer.send({
      t: "welcome", v: 1, workspaceId: this.workspace().id, deviceId: peer.id, serverTime: this.now(), seq,
      mode: delta ? "delta" : "snapshot",
    });
    if (delta) {
      const changes = this.changesAfter(hello.lastSeq!);
      if (changes.length) peer.send({ t: "changes", from: changes[0].seq, to: changes[changes.length - 1].seq, changes });
    } else {
      peer.send({ t: "snapshot", ...this.snapshot() });
    }
    this.peers.add(peer);
    this.log(`device connected: ${peer.name} (${delta ? "delta from " + hello.lastSeq : "snapshot"})`);
  }

  attachConnector(peer: Peer) {
    for (const p of [...this.peers]) if (p.role === "connector" && p.id === peer.id) p.close(4000, "replaced by a newer connection");
    this.peers.add(peer);
    peer.send({
      t: "welcome", v: 1, workspaceId: this.workspace().id, connectorId: peer.id, serverTime: this.now(), resume: resumeList(this, peer.id),
    });
    this.log(`connector connected: ${peer.name}`);
  }

  detach(peer: Peer) {
    if (!this.peers.delete(peer)) return;
    this.vault.peerGone(peer);
    this.browser.peerGone(peer);
    this.folders.peerGone(peer);
    if (peer.role === "device") {
      const stillThere = [...this.peers].some((p) => p.role === "device" && p.id === peer.id);
      if (!stillThere) {
        this.commit(peer.id, null, (tx) => {
          const d = tx.get("devices", peer.id);
          if (d) tx.upsert("devices", { ...d, online: false, lastSeenAt: tx.now });
        });
      }
      this.log(`device disconnected: ${peer.name}`);
    } else {
      const replaced = [...this.peers].some((p) => p.role === "connector" && p.id === peer.id);
      if (!replaced) onConnectorGone(this, peer.id);
      this.log(`connector disconnected: ${peer.name}`);
    }
  }

  /** Closes every socket of a device (revocation). */
  kick(deviceId: string, reason: string) {
    for (const p of [...this.peers]) if (p.id === deviceId) p.close(4003, reason);
  }

  // ---------- frames ----------
  onFrame(peer: Peer, frame: InboundFrame) {
    if (frame.t === "ping") return peer.send({ t: "pong" });
    if (peer.role === "device") {
      switch (frame.t) {
        case "mutate":
          return peer.send(this.mutate(peer, frame.id, frame.name, frame.args));
        case "sub":
          peer.topics.add(frame.topic);
          this.browser.onSub(peer, frame.topic);
          return;
        case "unsub":
          peer.topics.delete(frame.topic);
          this.browser.onUnsub(peer, frame.topic);
          return;
        case "browser.input":
          return this.browser.input(peer, frame);
        case "browser.control":
          return this.browser.control(peer, frame);
        case "browser.ack":
          return this.browser.ack(peer, frame);
        case "vault.req":
          return this.vault.request(peer, frame);
        case "folders.req":
          return this.folders.request(peer, frame);
        default:
          return peer.send({ t: "error", code: "bad_frame", message: `Unexpected frame ${frame.t} from a device` });
      }
    }
    switch (frame.t) {
      case "register":
        onRegister(this, peer, frame);
        return this.flushCommands(peer.id);
      case "cmd.ack":
        this.pendingCmds.get(peer.id)?.delete(frame.id);
        return;
      case "run.status":
        return onRunStatus(this, peer, frame);
      case "run.event":
        return onRunEvent(this, peer, frame);
      case "approval.request":
        return onApprovalRequest(this, peer, frame.approval);
      case "inbox.ingest":
        return this.ingestFromConnector(peer, frame.item);
      case "vault.index":
        return onVaultIndex(this, peer, frame);
      case "browser.state":
        return this.browser.onState(peer, frame);
      case "browser.frame":
        return this.browser.onPicture(peer, frame);
      case "browser.notice":
        return this.browser.onNotice(peer, frame);
      case "vault.response":
        return this.vault.response(peer, frame);
      case "folders.response":
        return this.folders.response(peer, frame);
      case "heartbeat":
        this.store.run("UPDATE connectors SET last_seen_at = ? WHERE id = ?", this.now(), peer.id);
        return;
      default:
        return peer.send({ t: "error", code: "bad_frame", message: `Unexpected frame ${frame.t} from a connector` });
    }
  }

  // ---------- mutations ----------
  mutate(device: { id: string; canApprove: boolean }, id: string, name: string, args: unknown) {
    const prior = this.store.get<{ result: string }>("SELECT result FROM mutations WHERE id = ?", id);
    if (prior) return { t: "ack" as const, id, ...JSON.parse(prior.result) };
    const fail = (code: string, message: string) => {
      const result = { ok: false, error: { code, message } };
      this.store.run("INSERT OR IGNORE INTO mutations (id, actor_id, name, result, at) VALUES (?, ?, ?, ?, ?)", id, device.id, name, JSON.stringify(result), this.now());
      return { t: "ack" as const, id, ...result };
    };
    if (!isMutationName(name)) return fail("unknown_mutation", `Unknown mutation "${name}"`);
    const parsed = MUTATIONS[name].safeParse(args);
    if (!parsed.success) return fail("invalid_args", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    try {
      const result = this.commit(device.id, id, (tx) => {
        (MUTATION_HANDLERS[name] as any)(tx, parsed.data, device);
        const seq = tx.changes.length ? tx.changes[tx.changes.length - 1].seq : this.currentSeq();
        const r = { ok: true, seq };
        this.store.run("INSERT INTO mutations (id, actor_id, name, result, at) VALUES (?, ?, ?, ?, ?)", id, device.id, name, JSON.stringify(r), tx.now);
        return r;
      });
      return { t: "ack" as const, id, ...result };
    } catch (err) {
      if (err instanceof MutationError) return fail(err.code, err.message);
      console.error("[hub] mutation failed", name, err);
      return fail("internal", (err as Error).message);
    }
  }

  // ---------- connector routing ----------
  connectorPeer(connectorId: string): Peer | undefined {
    for (const p of this.peers) if (p.role === "connector" && p.id === connectorId) return p;
    return undefined;
  }

  /** Commands are kept until acknowledged and re-sent when the connector (re)registers. */
  sendCommand(connectorId: string, draft: CmdDraft) {
    const cmd = { t: "cmd", id: newId("cmd"), ...draft } as CmdFrame;
    let q = this.pendingCmds.get(connectorId);
    if (!q) this.pendingCmds.set(connectorId, (q = new Map()));
    q.set(cmd.id, cmd);
    this.connectorPeer(connectorId)?.send(cmd);
  }

  flushCommands(connectorId: string) {
    const peer = this.connectorPeer(connectorId);
    const q = this.pendingCmds.get(connectorId);
    if (!peer || !q) return;
    for (const cmd of q.values()) peer.send(cmd);
  }

  dropCommandsForRun(connectorId: string, runId: string) {
    const q = this.pendingCmds.get(connectorId);
    if (!q) return;
    for (const [id, cmd] of q) {
      const rid = cmd.name === "run.start" ? cmd.run.id : cmd.runId;
      if (rid === runId) q.delete(id);
    }
  }

  publish(topic: string, event: RunEvent) {
    const frame = { t: "ephemeral", topic, event };
    for (const p of this.peers) if (p.role === "device" && p.topics.has(topic)) p.send(frame);
  }

  publishRunEvent(event: RunEvent) {
    this.publish(runTopic(event.runId), event);
  }

  // ---------- ingestion ----------
  /** normalize → dedupe on (source, external_id) → triage → SLA policy → upsert → notification policy */
  ingest(draft: InboxItemDraft, actorId: string | null = null): InboxItem {
    return this.commit(actorId, null, (tx) => this.ingestTx(tx, draft));
  }

  /**
   * Mail metadata or a mail security flag from a connector's Gmail watcher. The frame has no body field
   * and none is stored: bodies stay in Gmail and are read on demand by the agent. An item that already
   * exists is left alone, so a watcher that reports the same message twice changes nothing.
   */
  ingestFromConnector(peer: Peer, item: Extract<InboundFrame, { t: "inbox.ingest" }>["item"]): InboxItem | null {
    if (item.source === "monitor") return this.monitorFromConnector(peer, item);
    return this.commit(peer.id, null, (tx) => {
      if (tx.query("inbox_items", "WHERE source = ? AND external_id = ?", item.source, item.externalId)[0]) return null;
      const flag = item.kind === "flag";
      const created = this.ingestTx(tx, {
        source: item.source, externalId: item.externalId, title: item.title, snippet: item.snippet ?? null, body: null,
        sender: item.sender ?? null, externalUrl: item.externalUrl ?? null, receivedAt: item.receivedAt,
        ...(flag ? { priority: "P1" as const, reason: "Security flag from the Gmail connector: this email looks like it is trying to instruct an AI agent" } : {}),
      });
      if (flag) tx.audit("gmail.injection_flag", "inbox_item", created.id, { externalId: item.externalId, sender: item.sender ?? null, title: item.title });
      return created;
    });
  }

  /**
   * A health check on a connector's machine (backups). An alert is one P1 item per `externalId`: the first report
   * creates it and notifies, later reports only refresh its text, and an item you closed stays closed. A resolve
   * closes the open alerts of that condition (`externalId` itself or `<externalId>:<episode>`) by itself.
   */
  monitorFromConnector(peer: Peer, item: Extract<Extract<InboundFrame, { t: "inbox.ingest" }>["item"], { source: "monitor" }>): InboxItem | null {
    return this.commit(peer.id, null, (tx) => {
      if (item.kind === "alert") {
        const existing = tx.query("inbox_items", "WHERE source = 'monitor' AND external_id = ?", item.externalId)[0];
        if (existing && existing.title === item.title && existing.snippet === (item.snippet ?? null)) return existing;
        const created = this.ingestTx(tx, {
          source: "monitor", externalId: item.externalId, title: item.title, snippet: item.snippet ?? null, body: null,
          sender: item.sender ?? null, receivedAt: item.receivedAt, priority: "P1", reason: `Health check on ${peer.name || "a connector"}`,
        });
        if (!existing) tx.audit("monitor.alert", "inbox_item", created.id, { externalId: item.externalId, title: item.title });
        return created;
      }
      const open = tx.query(
        "inbox_items",
        "WHERE source = 'monitor' AND (external_id = ? OR substr(external_id, 1, ?) = ?) AND status NOT IN ('responded','done')",
        item.externalId, item.externalId.length + 1, `${item.externalId}:`,
      );
      let last: InboxItem | null = null;
      for (const it of open) {
        const slaState = it.slaState === "running" || it.slaState === "warning" ? (it.slaDueAt != null && tx.now > it.slaDueAt ? "breached" : "met") : it.slaState;
        last = tx.upsert("inbox_items", {
          ...it, status: "done", respondedAt: it.respondedAt ?? tx.now, snoozeUntil: null, slaState, updatedAt: tx.now,
          snippet: `Resolved: ${item.title}${item.snippet ? ` (${item.snippet})` : ""}. ${it.snippet ?? ""}`.trim().slice(0, 500),
        });
        tx.audit("monitor.resolve", "inbox_item", it.id, { externalId: it.externalId });
      }
      return last;
    });
  }

  ingestTx(tx: Tx, draft: InboxItemDraft, id: string = newId("inb")): InboxItem {
    const now = tx.now;
    if (draft.externalId) {
      const existing = tx.query("inbox_items", "WHERE source = ? AND external_id = ?", draft.source, draft.externalId)[0];
      if (existing) {
        return tx.upsert("inbox_items", {
          ...existing, title: draft.title, snippet: draft.snippet ?? existing.snippet, body: draft.body ?? existing.body, updatedAt: now,
        });
      }
    }
    const result = draft.priority
      ? { priority: draft.priority, reason: draft.reason ?? (draft.source === "manual" ? "Captured by you" : "Priority set by the source") }
      : triage(draft, this.setting("triage.rules", DEFAULT_TRIAGE));
    const receivedAt = draft.receivedAt ?? now;
    const base = { source: draft.source, priority: result.priority, clientLabel: draft.clientLabel ?? null };
    const policy = pickPolicy(tx.query("sla_policies") as SlaPolicy[], base);
    const sla = policy ? computeSla(policy, receivedAt) : { slaDueAt: null, slaWarnAt: null };
    const item = tx.upsert("inbox_items", {
      id, source: draft.source, externalId: draft.externalId ?? null, externalUrl: draft.externalUrl ?? null, title: draft.title,
      snippet: draft.snippet ?? null, body: draft.body ?? null, sender: draft.sender ?? null, clientLabel: draft.clientLabel ?? null,
      priority: result.priority, status: "new", triageReason: result.reason, assignedAgentId: null, linkedThreadId: null,
      linkedRunId: null, slaPolicyId: policy?.id ?? null, slaDueAt: sla.slaDueAt, slaWarnAt: sla.slaWarnAt,
      slaState: slaStateAt(now, sla.slaDueAt, sla.slaWarnAt), respondedAt: null, snoozeUntil: null, receivedAt, createdAt: now, updatedAt: now,
    });
    if (item.priority === "P0" || item.priority === "P1") {
      tx.notify({
        priority: item.priority, channel: item.priority === "P0" ? "p0_urgent" : "p1_today",
        title: item.priority === "P0" ? `Urgent: ${item.title}` : item.title,
        body: [item.clientLabel, item.snippet].filter(Boolean).join(" — ") || item.title,
        link: `/inbox/${item.id}`, actions: ["open"], collapseKey: item.id, subjectType: "inbox_item", subjectId: item.id,
      });
    }
    return item;
  }

  // ---------- timers ----------
  /** Moves SLA clocks running → warning → breached and wakes snoozed items. A DO alarm in production. */
  tick() {
    const now = this.now();
    this.commit(null, null, (tx) => {
      const open = tx.query("inbox_items", "WHERE sla_state IN ('running','warning') AND status NOT IN ('responded','done')");
      for (const item of open) {
        const next = slaStateAt(now, item.slaDueAt, item.slaWarnAt);
        if (next === item.slaState || next === "none") continue;
        if (item.slaState === "warning" && next === "running") continue;
        tx.upsert("inbox_items", { ...item, slaState: next, updatedAt: now });
        tx.notify(next === "breached"
          ? {
              priority: "P0", channel: "p0_urgent", title: `SLA breached: ${item.title}`,
              body: `${item.clientLabel ?? item.sender ?? item.source} has waited past the response deadline.`,
              link: `/inbox/${item.id}`, actions: ["open"], collapseKey: item.id, subjectType: "inbox_item", subjectId: item.id,
            }
          : {
              priority: "P1", channel: "p1_today", title: `SLA at risk: ${item.title}`,
              body: `Response due ${new Date(item.slaDueAt!).toLocaleString("en-US", { timeZone: this.workspace().timezone, weekday: "short", hour: "numeric", minute: "2-digit" })}.`,
              link: `/inbox/${item.id}`, actions: ["open"], collapseKey: item.id, subjectType: "inbox_item", subjectId: item.id,
            });
      }
      for (const item of tx.query("inbox_items", "WHERE status = 'snoozed' AND snooze_until IS NOT NULL AND snooze_until <= ?", now)) {
        tx.upsert("inbox_items", { ...item, status: "triaged", snoozeUntil: null, updatedAt: now });
      }
    });
  }
}
