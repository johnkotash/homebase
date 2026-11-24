import {
  ENTITY_NAMES, FOLDER_OPS, PROTOCOL_VERSION, SCHEMA_VERSION, VAULT_OPS, newId,
  type Change, type EntityName, type FolderOp, type HubToDeviceFrame, type MutationArgs, type MutationName, type Notification, type RunEvent, type VaultOp,
} from "@homebase/protocol";
import { browserTopic, type BrowserControl, type BrowserInput, type BrowserToDevice } from "@homebase/protocol";
import { applyOptimistic } from "./optimistic";
import type { KeyValueStore } from "./storage";
import { createSyncStore, emptyMaps, type EntityMaps, type OutboxEntry, type SyncStore } from "./store";

export interface MutationResult {
  ok: boolean;
  seq?: number;
  error?: { code: string; message: string };
}

export interface SyncClientOptions {
  /** Hub base URL, e.g. http://10.0.2.2:8787 */
  url: string;
  token: string;
  storage: KeyValueStore;
  client: { platform: string; app: string; name: string };
  store?: SyncStore;
  storagePrefix?: string;
  WebSocketImpl?: typeof WebSocket;
  pingMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  onNotify?: (n: Notification) => void;
  onUnauthorized?: () => void;
  onMutationError?: (e: { id: string; name: string; code: string; message: string }) => void;
  /** A frame the hub refused outright (`error`), e.g. a browser input that did not parse. */
  onServerError?: (e: { code: string; message: string }) => void;
}

type Waiter = (r: MutationResult) => void;

/**
 * What a stored sync cursor covers: the schema version plus the entity types this build can apply.
 * Changes for entity types the app does not know are dropped while the cursor still moves past them,
 * so a cursor saved by an older build is only trusted by a build with the same key. Any other key
 * (including none, from builds before this marker existed) means a full resync from 0 on start.
 */
export const SYNC_CURSOR_KEY = `${SCHEMA_VERSION}:${[...ENTITY_NAMES].sort().join(",")}`;

/**
 * Device-side sync engine: one WebSocket, a full local copy of the synced entities, optimistic
 * mutations with a persisted outbox, and reconnect with backoff.
 */
export class SyncClient {
  readonly store: SyncStore;
  private ws: WebSocket | null = null;
  private stopped = true;
  private attempt = 0;
  private everOnline = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastFrameAt = 0;
  private waiters = new Map<string, Waiter>();
  private vaultWaiters = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private vaultSeq = 0;
  private inFlight = new Set<string>();
  private topics = new Map<string, number>();
  private browserWatchers = new Map<string, Set<(m: BrowserToDevice) => void>>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private prefix: string;
  private WS: typeof WebSocket;
  private starting: Promise<void> | null = null;

  constructor(private opts: SyncClientOptions) {
    this.store = opts.store ?? createSyncStore();
    this.prefix = opts.storagePrefix ?? "homebase";
    this.WS = opts.WebSocketImpl ?? (globalThis as any).WebSocket;
  }

  // ---------- lifecycle ----------
  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.starting = this.hydrate();
    await this.starting;
    if (!this.stopped) this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {}
    this.flushCache();
    this.store.setState({ status: "idle" });
  }

  /** Forget everything on this device (unpair). */
  async wipe() {
    this.stop();
    await this.opts.storage.removeItem(`${this.prefix}:cache`);
    await this.opts.storage.removeItem(`${this.prefix}:outbox`);
    const maps = emptyMaps();
    this.store.setState({ server: maps, entities: maps, outbox: [], lastSeq: 0, synced: false, streams: {}, runEvents: {} });
  }

  private async hydrate() {
    try {
      const [cacheRaw, outboxRaw] = await Promise.all([
        this.opts.storage.getItem(`${this.prefix}:cache`), this.opts.storage.getItem(`${this.prefix}:outbox`),
      ]);
      const outbox: OutboxEntry[] = outboxRaw ? JSON.parse(outboxRaw) : [];
      let server = emptyMaps();
      let lastSeq = 0;
      let deviceId: string | null = null;
      let workspaceId: string | null = null;
      let cached = false;
      if (cacheRaw) {
        const cache = JSON.parse(cacheRaw);
        if (cache.schema === SCHEMA_VERSION && cache.entities) {
          // Rows of known entity types are kept for offline reading either way.
          for (const e of ENTITY_NAMES) if (cache.entities[e]) (server as any)[e] = cache.entities[e];
          cached = true;
          deviceId = cache.deviceId ?? null;
          workspaceId = cache.workspaceId ?? null;
          // The cursor is only trusted if it was built with the same entity set; otherwise start from 0
          // so the hub sends a snapshot and nothing skipped by an older build stays missing.
          lastSeq = cache.cursorKey === SYNC_CURSOR_KEY ? (cache.lastSeq ?? 0) : 0;
        }
      }
      // Mutations made before start() resolved are kept ahead of nothing: merge by id.
      const pending = this.store.getState().outbox.filter((m) => !outbox.some((o) => o.id === m.id));
      const all = [...outbox, ...pending];
      this.store.setState({
        server, entities: applyOptimistic(server, all, deviceId), outbox: all, lastSeq, deviceId, workspaceId, hydrated: true, synced: cached,
      });
    } catch {
      this.store.setState({ hydrated: true });
    }
  }

  // ---------- socket ----------
  private connect() {
    if (this.stopped) return;
    this.store.setState({ status: this.everOnline || this.attempt > 0 ? (this.attempt >= 2 ? "offline" : "reconnecting") : "connecting" });
    const url = this.opts.url.replace(/^http/, "ws").replace(/\/+$/, "") + "/v1/ws";
    let ws: WebSocket;
    try {
      ws = new this.WS(url);
    } catch {
      return this.scheduleReconnect();
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      // The token travels in the hello frame, never in the URL.
      ws.send(JSON.stringify({
        t: "hello", v: PROTOCOL_VERSION, token: this.opts.token, role: "device", lastSeq: this.store.getState().lastSeq,
        schema: SCHEMA_VERSION, client: this.opts.client,
      }));
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws) return;
      this.lastFrameAt = Date.now();
      let frame: HubToDeviceFrame;
      try {
        frame = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return;
      }
      this.onFrame(frame);
    };
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.dropSocket(ws);
      if (ev?.code === 4003) {
        this.stopped = true;
        this.store.setState({ status: "unauthorized" });
        this.opts.onUnauthorized?.();
        return;
      }
      this.scheduleReconnect();
    };
    ws.onerror = () => {};
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    const min = this.opts.minBackoffMs ?? 1000;
    const max = this.opts.maxBackoffMs ?? 30_000;
    const delay = Math.min(max, min * 2 ** this.attempt) * (0.5 + Math.random() * 0.5);
    this.attempt++;
    this.store.setState({ status: this.attempt >= 2 ? "offline" : "reconnecting" });
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /** Skip the backoff wait, e.g. when the app returns to the foreground. */
  reconnectNow() {
    if (this.stopped || this.ws) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.connect();
  }

  /**
   * Manual escape hatch: forget the sync cursor and fetch a full snapshot from the hub.
   * Pairing (the token), the outbox and cached rows are kept; the snapshot replaces the rows.
   */
  resync() {
    const st = this.store.getState();
    this.store.setState({ lastSeq: 0 });
    // Persist the reset so an app kill before the snapshot arrives still resyncs on the next start.
    if (st.hydrated) this.writeCache(0);
    if (this.stopped) return;
    const ws = this.ws;
    if (ws) {
      this.dropSocket(ws);
      try {
        ws.close();
      } catch {}
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.attempt = 0;
    this.connect();
  }

  /** Detaches a socket so its late frames and close event are ignored. */
  private dropSocket(ws: WebSocket) {
    if (this.ws === ws) this.ws = null;
    this.inFlight.clear();
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const [id, w] of this.vaultWaiters) {
      clearTimeout(w.timer);
      this.vaultWaiters.delete(id);
      w.reject(Object.assign(new Error("The connection dropped."), { code: "offline" }));
    }
  }

  private send(frame: object): boolean {
    if (!this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  private onFrame(frame: HubToDeviceFrame) {
    // A connector's browser, live: its state, its picture, a notice. Handed to whoever is watching and kept nowhere.
    const t = (frame as { t?: unknown }).t;
    if (typeof t === "string" && t.startsWith("browser.")) {
      const m = frame as unknown as BrowserToDevice;
      for (const w of [...(this.browserWatchers.get(m.connectorId) ?? [])]) w(m);
      return;
    }
    switch (frame.t) {
      case "welcome": {
        this.attempt = 0;
        this.everOnline = true;
        this.store.setState({
          deviceId: frame.deviceId ?? null, workspaceId: frame.workspaceId, clockOffset: frame.serverTime - Date.now(),
        });
        if (frame.mode === "delta") this.online();
        const pingMs = this.opts.pingMs ?? 25_000;
        this.pingTimer = setInterval(() => {
          // App-level keepalive: a silent socket is treated as dead.
          if (Date.now() - this.lastFrameAt > pingMs * 2 + 5000) {
            try {
              this.ws?.close();
            } catch {}
            return;
          }
          this.send({ t: "ping" });
        }, pingMs);
        return;
      }
      case "snapshot": {
        const server = emptyMaps();
        for (const e of ENTITY_NAMES) {
          const map: Record<string, any> = {};
          for (const row of (frame.entities[e] ?? []) as any[]) map[row.id] = row;
          (server as any)[e] = map;
        }
        this.commitServer(server, frame.seq);
        this.online();
        return;
      }
      case "changes":
        this.applyChanges(frame.changes);
        return;
      case "ack": {
        this.inFlight.delete(frame.id);
        const st = this.store.getState();
        const entry = st.outbox.find((m) => m.id === frame.id);
        if (entry) {
          const outbox = st.outbox.filter((m) => m.id !== frame.id);
          const patch: Partial<ReturnType<SyncStore["getState"]>> = { outbox, entities: applyOptimistic(st.server, outbox, st.deviceId) };
          if (!frame.ok && frame.error) {
            patch.lastError = { id: frame.id, name: entry.name, code: frame.error.code, message: frame.error.message, at: Date.now() };
          }
          this.store.setState(patch);
          this.saveOutbox();
          if (!frame.ok && frame.error) this.opts.onMutationError?.({ id: frame.id, name: entry.name, ...frame.error });
        }
        const w = this.waiters.get(frame.id);
        if (w) {
          this.waiters.delete(frame.id);
          w({ ok: frame.ok, seq: frame.seq, error: frame.error });
        }
        return;
      }
      case "ephemeral":
        this.onEphemeral(frame.event);
        return;
      case "notify":
        this.opts.onNotify?.(frame.notification);
        return;
      case "vault.res": {
        const w = this.vaultWaiters.get(frame.id);
        if (!w) return;
        this.vaultWaiters.delete(frame.id);
        clearTimeout(w.timer);
        if (frame.ok) w.resolve(frame.result);
        else w.reject(Object.assign(new Error(frame.error?.message ?? "The vault could not do that."), { code: frame.error?.code ?? "vault_error" }));
        return;
      }
      case "folders.res": {
        // Same waiters as the vault: one request, one answer, nothing cached.
        const w = this.vaultWaiters.get(frame.id);
        if (!w) return;
        this.vaultWaiters.delete(frame.id);
        clearTimeout(w.timer);
        if (frame.ok) w.resolve(frame.result);
        else w.reject(Object.assign(new Error(frame.error?.message ?? "The connector could not do that."), { code: frame.error?.code ?? "folder_error" }));
        return;
      }
      case "pong":
        return;
      case "error":
        // The hub refused a frame (one that did not parse, say). Nothing to retry; told to whoever asked.
        this.opts.onServerError?.({ code: String((frame as { code?: unknown }).code ?? ""), message: String((frame as { message?: unknown }).message ?? "") });
        return;
    }
  }

  // ---------- vault ----------
  /**
   * Asks the vault for something (a note, a search, backlinks, status). Online only: the answer comes
   * from the machine that holds the vault and is not cached here. Rejects when offline or on a timeout.
   */
  vault<T = unknown>(op: VaultOp, args: Record<string, unknown> = {}, timeoutMs = 25_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = `vr_${Date.now().toString(36)}_${++this.vaultSeq}`;
      const fail = (code: string, message: string) => reject(Object.assign(new Error(message), { code }));
      if (!(VAULT_OPS as readonly string[]).includes(op)) return fail("unsupported", `The vault has no "${op}" operation yet.`);
      if (this.store.getState().status !== "online" || !this.send({ t: "vault.req", id, op, args })) return fail("offline", "Offline. Notes you have not opened before need a connection.");
      const timer = setTimeout(() => {
        this.vaultWaiters.delete(id);
        fail("timeout", "The vault did not answer in time.");
      }, timeoutMs);
      this.vaultWaiters.set(id, { resolve, reject, timer });
    });
  }

  // ---------- folders ----------
  /**
   * Asks an agent's connector about folders on its machine: browse them, check one, approve or forget one.
   * Online only, like the vault: the answer comes from that machine and is not cached. Approving and
   * forgetting are refused by the hub unless this device may approve.
   */
  folders<T = unknown>(agentId: string, op: FolderOp, args: Record<string, unknown> = {}, timeoutMs = 25_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = `fr_${Date.now().toString(36)}_${++this.vaultSeq}`;
      const fail = (code: string, message: string) => reject(Object.assign(new Error(message), { code }));
      if (!(FOLDER_OPS as readonly string[]).includes(op)) return fail("unsupported", `There is no "${op}" folder operation.`);
      if (this.store.getState().status !== "online" || !this.send({ t: "folders.req", id, agentId, op, args })) return fail("offline", "Offline. Folders are on the agent's machine, so picking one needs a connection.");
      const timer = setTimeout(() => {
        this.vaultWaiters.delete(id);
        fail("timeout", "The connector did not answer in time.");
      }, timeoutMs);
      this.vaultWaiters.set(id, { resolve, reject, timer });
    });
  }

  private online() {
    this.store.setState({ status: "online", synced: true });
    for (const topic of this.topics.keys()) this.send({ t: "sub", topic });
    this.flushOutbox();
  }

  private commitServer(server: EntityMaps, lastSeq: number) {
    const st = this.store.getState();
    this.store.setState({ server, lastSeq, entities: applyOptimistic(server, st.outbox, st.deviceId) });
    this.scheduleSave();
  }

  private applyChanges(changes: Change[]) {
    const st = this.store.getState();
    const server = { ...st.server } as Record<EntityName, Record<string, any>>;
    const cloned = new Set<EntityName>();
    let lastSeq = st.lastSeq;
    for (const c of changes) {
      if (c.seq <= lastSeq) continue; // already applied (reconnect overlap)
      if (!server[c.entity]) continue;
      if (!cloned.has(c.entity)) {
        server[c.entity] = { ...server[c.entity] };
        cloned.add(c.entity);
      }
      if (c.op === "delete") delete server[c.entity][c.id];
      else if (c.data) server[c.entity][c.id] = c.data;
      lastSeq = c.seq;
    }
    if (lastSeq !== st.lastSeq) this.commitServer(server as EntityMaps, lastSeq);
  }

  private onEphemeral(ev: RunEvent) {
    const st = this.store.getState();
    if (ev.kind === "text_delta") {
      const text = (st.streams[ev.runId] ?? "") + String((ev.data as any).text ?? "");
      this.store.setState({ streams: { ...st.streams, [ev.runId]: text } });
      return;
    }
    const list = st.runEvents[ev.runId] ?? [];
    const patch: Partial<ReturnType<SyncStore["getState"]>> = {};
    if (!list.some((e) => e.idx === ev.idx)) patch.runEvents = { ...st.runEvents, [ev.runId]: [...list, ev].sort((a, b) => a.idx - b.idx) };
    if (ev.kind === "text" && st.streams[ev.runId]) patch.streams = { ...st.streams, [ev.runId]: "" };
    this.store.setState(patch);
  }

  // ---------- mutations ----------
  /**
   * Applies the mutation locally at once, queues it, and sends it when connected.
   * The promise settles when the hub acknowledges (possibly after a reconnect).
   */
  mutate<N extends MutationName>(name: N, args: MutationArgs<N>): Promise<MutationResult> {
    const entry: OutboxEntry = { id: newId("mut"), name, args, at: Date.now() + this.store.getState().clockOffset };
    const st = this.store.getState();
    const outbox = [...st.outbox, entry];
    this.store.setState({ outbox, entities: applyOptimistic(st.server, outbox, st.deviceId) });
    this.saveOutbox();
    const p = new Promise<MutationResult>((resolve) => this.waiters.set(entry.id, resolve));
    if (this.store.getState().status === "online") this.sendMutation(entry);
    return p;
  }

  private sendMutation(m: OutboxEntry) {
    if (this.inFlight.has(m.id)) return;
    if (this.send({ t: "mutate", id: m.id, name: m.name, args: m.args })) this.inFlight.add(m.id);
  }

  /** Replays every unacknowledged mutation in order. The hub de-duplicates by mutation ID. */
  private flushOutbox() {
    for (const m of this.store.getState().outbox) this.sendMutation(m);
  }

  // ---------- topics ----------
  subscribe(topic: string): () => void {
    const n = this.topics.get(topic) ?? 0;
    this.topics.set(topic, n + 1);
    if (n === 0) this.send({ t: "sub", topic });
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const left = (this.topics.get(topic) ?? 1) - 1;
      if (left <= 0) {
        this.topics.delete(topic);
        this.send({ t: "unsub", topic });
      } else this.topics.set(topic, left);
    };
  }

  // ---------- a connector's browser ----------
  /**
   * Watches the browser on a connector until the returned function is called: its state and its live
   * picture arrive at `on`. Nothing is cached here; after a reconnect the hub is asked again.
   */
  watchBrowser(connectorId: string, on: (m: BrowserToDevice) => void): () => void {
    let set = this.browserWatchers.get(connectorId);
    if (!set) this.browserWatchers.set(connectorId, (set = new Set()));
    const watchers = set;
    watchers.add(on);
    const unsub = this.subscribe(browserTopic(connectorId));
    return () => {
      watchers.delete(on);
      if (!watchers.size && this.browserWatchers.get(connectorId) === watchers) this.browserWatchers.delete(connectorId);
      unsub();
    };
  }

  /** A tap, a scroll or a key for the browser. Sent only while online and never queued: a late keystroke is worse than a lost one. */
  browserInput(connectorId: string, input: BrowserInput): boolean {
    return this.send({ t: "browser.input", connectorId, input });
  }

  /** Asks the hub again for where a watched browser stands (its state and last picture), e.g. when the app comes back to the front. */
  refreshBrowser(connectorId: string): boolean {
    const topic = browserTopic(connectorId);
    return this.topics.has(topic) && this.send({ t: "sub", topic });
  }

  /** "Picture `seq` arrived": the browser node paces its pictures by these and learns how fast this link is. */
  browserAck(connectorId: string, seq: number): boolean {
    return this.send({ t: "browser.ack", connectorId, seq });
  }

  /** A button of the browser view: take over, hand back, sign in, settings. Online only. */
  browserControl(connectorId: string, control: BrowserControl): boolean {
    return this.send({ t: "browser.control", connectorId, control });
  }

  // ---------- persistence ----------
  private saveOutbox() {
    void this.opts.storage.setItem(`${this.prefix}:outbox`, JSON.stringify(this.store.getState().outbox)).catch(() => {});
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flushCache();
    }, 400);
  }

  flushCache() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const st = this.store.getState();
    if (!st.hydrated || st.lastSeq === 0) return;
    this.writeCache(st.lastSeq);
  }

  private writeCache(lastSeq: number) {
    const st = this.store.getState();
    const payload = JSON.stringify({
      schema: SCHEMA_VERSION, cursorKey: SYNC_CURSOR_KEY, lastSeq, deviceId: st.deviceId, workspaceId: st.workspaceId, entities: st.server,
    });
    void this.opts.storage.setItem(`${this.prefix}:cache`, payload).catch(() => {});
  }
}
