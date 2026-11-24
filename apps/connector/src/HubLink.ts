import WebSocket from "ws";
import {
  isAttachmentId, newId, type AgentRegistration, type ApprovalRequest, type CmdFrame, type ConnectorToHubFrame, type RunEventFrame, type RunStatusFrame,
  type FolderOp, type FoldersRequestFrame, type VaultIndexFrame, type VaultOp, type VaultRequestFrame,
} from "@homebase/protocol";
import type { AgentAdapter, ApprovalDecision, RunContext, RunHandle, RunSpec } from "./adapters/types";

export interface AgentDef extends AgentRegistration {
  adapter: AgentAdapter;
}

export interface HubLinkOptions {
  hubUrl: string; // http://host:port
  token: string;
  name: string;
  agents: AgentDef[];
  log?: (...args: unknown[]) => void;
  /** Called when the hub rejects the token (revoked or the hub database was reset). */
  onUnauthorized?: () => void;
  /** Called each time the link is registered with the hub (first connect and every reconnect). */
  onReady?: () => void;
  /** Answers a vault request relayed from a device. The result goes back to that device only. */
  onVaultRequest?: (op: VaultOp, args: Record<string, unknown>) => Promise<unknown>;
  /** Answers a folder-browser request relayed from a device (list, check, approve, forget). The result goes back to that device only. */
  onFoldersRequest?: (agentKey: string, op: FolderOp, args: Record<string, unknown>, meta: { deviceId: string; canApprove: boolean }) => Promise<unknown>;
  /** A frame for the browser on this connector: the owner's hands, a button in the app, or how many devices are watching. */
  onBrowser?: (frame: { t: string } & Record<string, unknown>) => void;
  reconnect?: boolean;
  heartbeatMs?: number;
}

interface LiveRun {
  spec: RunSpec;
  handle: RunHandle;
  abort: AbortController;
  nextIdx: number;
  /** Persisted events kept for replay after a reconnect (bounded, in memory in the prototype). */
  buffer: RunEventFrame[];
  lastStatus: RunStatusFrame | null;
  approvals: Map<string, { request: ApprovalRequest; resolve: (d: ApprovalDecision) => void }>;
  finished: boolean;
  /** True once the terminal status went out on an open socket. */
  flushed: boolean;
}

const MAX_BUFFER = 2000;

/** Outbound-only link from a machine that hosts agents to the hub. */
export class HubLink {
  private ws: WebSocket | null = null;
  private ready = false;
  private stopped = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private beat: ReturnType<typeof setInterval> | null = null;
  private seenCmds: string[] = [];
  private runs = new Map<string, LiveRun>();
  private log: (...args: unknown[]) => void;
  connectorId: string | null = null;
  private readyWaiters: Array<() => void> = [];

  constructor(private opts: HubLinkOptions) {
    this.log = opts.log ?? ((...a) => console.log("[connector]", ...a));
  }

  get activeRuns() {
    return [...this.runs.values()].filter((r) => !r.finished).length;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  /** Resolves when the link is registered with the hub. */
  whenReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((r) => this.readyWaiters.push(r));
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.beat) clearInterval(this.beat);
    for (const run of this.runs.values()) run.abort.abort();
    this.ws?.close();
    this.ws = null;
    this.ready = false;
  }

  private register() {
    this.send({
      t: "register", host: { name: this.opts.name, os: process.platform },
      agents: this.opts.agents.map(({ adapter: _a, ...reg }) => reg),
      activeRunIds: [...this.runs.keys()],
    });
  }

  /** Changes an agent's registration (for example its readiness note) and tells the hub right away. */
  updateAgent(key: string, patch: Partial<AgentRegistration>) {
    const i = this.opts.agents.findIndex((a) => a.key === key);
    if (i < 0) return;
    this.opts.agents[i] = { ...this.opts.agents[i], ...patch };
    this.register();
  }

  /** Hands the hub an inbox item found by a watcher on this machine. False when the link is down. */
  ingestInbox(item: Extract<ConnectorToHubFrame, { t: "inbox.ingest" }>["item"]): boolean {
    return this.send({ t: "inbox.ingest", item });
  }

  /** Sends note metadata from the vault index. False when the link is down. */
  sendVaultIndex(frame: Omit<VaultIndexFrame, "t">): boolean {
    return this.send({ t: "vault.index", ...frame });
  }

  private onVaultRequest(frame: VaultRequestFrame) {
    const answer = (ok: boolean, result?: unknown, error?: string) => {
      let payload = JSON.stringify({ t: "vault.response", id: frame.id, ok, ...(ok ? { result } : { error: (error ?? "failed").slice(0, 480) }) });
      // The hub accepts frames up to 1 MB; a note larger than that is read in parts.
      if (payload.length > 950_000) payload = JSON.stringify({ t: "vault.response", id: frame.id, ok: false, error: "That is too large to send in one piece." });
      if (this.ready && this.ws?.readyState === WebSocket.OPEN) this.ws.send(payload);
    };
    if (!this.opts.onVaultRequest) return answer(false, undefined, "This connector has no vault.");
    this.opts.onVaultRequest(frame.op, frame.args ?? {}).then((r) => answer(true, r), (e) => answer(false, undefined, (e as Error).message));
  }

  private onFoldersRequest(frame: FoldersRequestFrame) {
    const answer = (ok: boolean, result?: unknown, error?: { message: string; code?: string }) => {
      let payload = JSON.stringify({ t: "folders.response", id: frame.id, ok, ...(ok ? { result } : { error: (error?.message ?? "failed").slice(0, 480), code: (error?.code ?? "folder_error").slice(0, 40) }) });
      if (payload.length > 950_000) payload = JSON.stringify({ t: "folders.response", id: frame.id, ok: false, error: "That folder has too much in it to list.", code: "too_large" });
      if (this.ready && this.ws?.readyState === WebSocket.OPEN) this.ws.send(payload);
    };
    if (!this.opts.onFoldersRequest) return answer(false, undefined, { message: "This connector does not take folders from the app.", code: "unsupported" });
    this.opts.onFoldersRequest(frame.agentKey, frame.op, frame.args ?? {}, { deviceId: frame.deviceId, canApprove: frame.canApprove === true })
      .then((r) => answer(true, r), (e) => answer(false, undefined, { message: (e as Error).message, code: (e as { code?: string }).code }));
  }

  /** Sends a browser frame (state, a picture, a notice). Not queued: a frame that misses the hub is simply gone. */
  sendBrowser(frame: object): boolean {
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  /**
   * The bytes of a picture the owner attached, from the hub, with this connector's token in the header (never in
   * the address). Held in memory for the run only; nothing is written to disk here.
   */
  async fetchAttachment(id: string): Promise<Uint8Array> {
    if (!isAttachmentId(id)) throw new Error("not an attachment id");
    const res = await fetch(`${this.opts.hubUrl.replace(/\/+$/, "")}/v1/attachments/${id}`, { headers: { Authorization: `Bearer ${this.opts.token}` } });
    if (!res.ok) throw new Error(`the hub answered ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Test hook: drop the socket without stopping runs, as a network blip would. */
  dropConnection() {
    this.ws?.terminate();
  }

  private connect() {
    if (this.stopped) return;
    const url = this.opts.hubUrl.replace(/^http/, "ws").replace(/\/+$/, "") + "/v1/ws";
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on("open", () => {
      // The token travels in the hello frame, never in the URL.
      ws.send(JSON.stringify({
        t: "hello", v: 1, token: this.opts.token, role: "connector",
        client: { platform: process.platform, app: "0.1.0", name: this.opts.name },
      }));
    });
    ws.on("message", (raw) => {
      let frame: any;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.onFrame(frame);
    });
    ws.on("close", (code) => {
      if (this.ws !== ws) return;
      this.ready = false;
      this.ws = null;
      if (this.beat) clearInterval(this.beat);
      if (code === 4003) {
        this.log("the hub rejected this connector's token");
        this.opts.onUnauthorized?.();
        return;
      }
      if (this.stopped || this.opts.reconnect === false) return;
      // exponential backoff with jitter, 1 s to 30 s
      const delay = Math.min(30_000, 1000 * 2 ** this.attempt++) * (0.5 + Math.random() * 0.5);
      this.log(`disconnected (code ${code}); retrying in ${Math.round(delay / 100) / 10}s`);
      this.timer = setTimeout(() => this.connect(), delay);
    });
    ws.on("error", () => {});
  }

  private send(frame: ConnectorToHubFrame): boolean {
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  private onFrame(frame: any) {
    switch (frame.t) {
      case "welcome": {
        this.attempt = 0;
        this.connectorId = frame.connectorId ?? null;
        this.ready = true;
        this.register();
        this.replay(frame.resume ?? []);
        this.beat = setInterval(() => this.send({ t: "heartbeat", activeRuns: this.activeRuns, at: Date.now() }), this.opts.heartbeatMs ?? 25_000);
        this.log(`online as ${this.connectorId}; registered ${this.opts.agents.map((a) => a.key).join(", ")}`);
        for (const w of this.readyWaiters.splice(0)) w();
        this.opts.onReady?.();
        return;
      }
      case "vault.request":
        return this.onVaultRequest(frame as VaultRequestFrame);
      case "folders.request":
        return this.onFoldersRequest(frame as FoldersRequestFrame);
      case "browser.input":
      case "browser.control":
      case "browser.viewers":
      case "browser.ack":
        return this.opts.onBrowser?.(frame);
      case "cmd":
        return this.onCmd(frame as CmdFrame);
      case "error":
        this.log(`hub error: ${frame.code}: ${frame.message}`);
        return;
    }
  }

  /** After a reconnect: resend what the hub has not seen, per run. */
  private replay(resume: Array<{ runId: string; lastIdx: number }>) {
    const lastSeen = new Map(resume.map((r) => [r.runId, r.lastIdx]));
    for (const [runId, run] of this.runs) {
      const from = lastSeen.get(runId) ?? -1;
      for (const ev of run.buffer) if (ev.idx > from) this.send(ev);
      if (run.lastStatus && !(run.approvals.size && !run.finished)) this.send(run.lastStatus);
      for (const a of run.approvals.values()) this.send({ t: "approval.request", approval: a.request });
      if (run.finished) {
        run.flushed = true;
        this.runs.delete(runId);
      }
    }
  }

  private onCmd(cmd: CmdFrame) {
    // Commands are de-duplicated by ID: the hub re-sends anything it did not see acknowledged.
    if (this.seenCmds.includes(cmd.id)) return void this.send({ t: "cmd.ack", id: cmd.id, ok: true });
    this.seenCmds.push(cmd.id);
    if (this.seenCmds.length > 500) this.seenCmds.shift();
    try {
      switch (cmd.name) {
        case "run.start":
          this.startRun(cmd.run);
          break;
        case "run.input":
          this.runs.get(cmd.runId)?.handle.input(cmd.text, cmd.attachments?.length ? cmd.attachments : undefined);
          break;
        case "run.cancel": {
          const run = this.runs.get(cmd.runId);
          if (run) {
            run.abort.abort();
            run.handle.cancel();
          } else {
            this.send({ t: "run.status", runId: cmd.runId, status: "cancelled", at: Date.now() });
          }
          break;
        }
        case "approval.decision": {
          const pending = this.runs.get(cmd.runId)?.approvals.get(cmd.approvalId);
          if (pending) {
            this.runs.get(cmd.runId)!.approvals.delete(cmd.approvalId);
            pending.resolve({ decision: cmd.decision, message: cmd.message, answers: cmd.answers, remember: cmd.remember, mode: cmd.mode ?? null });
          }
          break;
        }
        case "run.mode":
          this.runs.get(cmd.runId)?.handle.setMode?.(cmd.mode);
          break;
      }
      this.send({ t: "cmd.ack", id: cmd.id, ok: true });
    } catch (err) {
      this.send({ t: "cmd.ack", id: cmd.id, ok: false, error: (err as Error).message });
    }
  }

  private startRun(spec: RunSpec) {
    if (this.runs.has(spec.id)) return;
    const def = this.opts.agents.find((a) => a.key === spec.agentKey);
    if (!def) {
      this.send({ t: "run.status", runId: spec.id, status: "failed", error: `No agent "${spec.agentKey}" on this connector`, at: Date.now() });
      return;
    }
    const abort = new AbortController();
    const run: LiveRun = {
      spec, abort, nextIdx: 0, buffer: [], lastStatus: null, approvals: new Map(), finished: false, flushed: false,
      handle: undefined as unknown as RunHandle,
    };
    this.runs.set(spec.id, run);
    this.log(`run ${spec.id.slice(-8)} started on ${spec.agentKey}: ${spec.prompt.slice(0, 80)}`);

    const ctx: RunContext = {
      run: spec,
      signal: abort.signal,
      emit: (kind, data, o) => {
        const frame: RunEventFrame = { t: "run.event", runId: spec.id, idx: run.nextIdx++, at: Date.now(), kind, data };
        if (o?.persist === false) frame.persist = false;
        else {
          frame.persist = true;
          run.buffer.push(frame);
          if (run.buffer.length > MAX_BUFFER) run.buffer.shift();
        }
        this.send(frame);
      },
      status: (status, extra) => {
        const frame: RunStatusFrame = { t: "run.status", runId: spec.id, status, at: Date.now(), ...(extra ?? {}) };
        run.lastStatus = frame;
        const sent = this.send(frame);
        if (status === "succeeded" || status === "failed" || status === "cancelled") {
          run.finished = true;
          run.flushed = sent;
          for (const a of run.approvals.values()) a.resolve({ decision: "deny", message: "Run ended", answers: null, remember: false });
          run.approvals.clear();
          this.log(`run ${spec.id.slice(-8)} ${status}`);
          if (sent) this.runs.delete(spec.id); // otherwise kept until the next reconnect replays it
        }
      },
      requestApproval: (draft) =>
        new Promise<ApprovalDecision>((resolve, reject) => {
          const request: ApprovalRequest = { ...draft, id: newId("apr"), runId: spec.id, requestedAt: Date.now() };
          run.approvals.set(request.id, { request, resolve });
          const onAbort = () => {
            run.approvals.delete(request.id);
            reject(new Error("cancelled"));
          };
          abort.signal.addEventListener("abort", onAbort, { once: true });
          this.send({ t: "approval.request", approval: request });
          this.log(`run ${spec.id.slice(-8)} waiting for approval: ${request.title} (${request.risk})`);
        }).then((d) => {
          // The run continues; say so before the adapter emits anything else.
          if (!run.finished) ctx.status("running");
          return d;
        }),
      loadAttachment: (a) => this.fetchAttachment(a.id),
    };
    this.send({ t: "run.status", runId: spec.id, status: "starting", at: Date.now() });
    run.handle = def.adapter.start(ctx);
  }
}
