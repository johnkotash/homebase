import { FILES_CAPABILITY, FILE_WRITE_OPS, TERMINAL_CAPABILITY, newId, type Agent, type InboundFrame } from "@homebase/protocol";
import { readEntity } from "./tables";
import type { Peer, WorkspaceHub } from "./WorkspaceHub";

/**
 * Files, the editor and the terminal on a connector's machine (protocol files.ts, issue #3).
 *
 * The hub only relays and checks who asks: every frame comes from a device that may approve (the owner's
 * devices), goes to the connector of the agent the device names, and the answer goes back to the socket
 * that asked. File contents and keystrokes pass through and are never stored or logged. Writes, renames,
 * deletes, and terminals opened and closed are written to the audit log with the path and the device.
 */

type FilesReq = Extract<InboundFrame, { t: "files.req" }>;
type FilesResponse = Extract<InboundFrame, { t: "files.response" }>;
type TermOpen = Extract<InboundFrame, { t: "term.open" }>;
type TermAttach = Extract<InboundFrame, { t: "term.attach" }>;
type TermInput = Extract<InboundFrame, { t: "term.input" }>;
type TermResize = Extract<InboundFrame, { t: "term.resize" }>;
type TermClose = Extract<InboundFrame, { t: "term.close" }>;
type PtyOpened = Extract<InboundFrame, { t: "pty.opened" }>;
type PtyOutput = Extract<InboundFrame, { t: "pty.output" }>;
type PtyExit = Extract<InboundFrame, { t: "pty.exit" }>;

const TIMEOUT_MS = 30_000;
/** Terminals one device may have open at once. */
export const MAX_TERMINALS_PER_DEVICE = 8;

type Target = { agent: Agent; connector: Peer } | { error: { code: string; message: string } };

/** The agent's connector, when the device may use it for `capability`. */
function target(hub: WorkspaceHub, peer: Peer, agentId: string, capability: string, what: string): Target {
  if (!peer.canApprove) return { error: { code: "forbidden", message: `Only a device that may approve can use the ${what}. Allow it in Settings → Devices.` } };
  const agent = readEntity<Agent>(hub.store, "agents", agentId);
  if (!agent) return { error: { code: "not_found", message: "Agent not found" } };
  if (!agent.capabilities?.includes(capability)) {
    return { error: { code: "unsupported", message: `${agent.name}'s connector does not offer the ${what}: it is turned off there, or the connector is older. Update and restart the connector.` } };
  }
  const connector = agent.connectorId ? hub.connectorPeer(agent.connectorId) : undefined;
  if (!connector) return { error: { code: "offline", message: `${agent.name}'s connector is offline.` } };
  return { agent, connector };
}

const str = (v: unknown, max = 1000) => (typeof v === "string" ? v.slice(0, max) : null);

export class FileRelay {
  private pending = new Map<string, { peer: Peer; clientId: string; connectorId: string; agentId: string; op: FilesReq["op"]; timer: ReturnType<typeof setTimeout> }>();
  private seq = 0;

  constructor(private hub: WorkspaceHub) {}

  request(peer: Peer, frame: FilesReq) {
    const t = target(this.hub, peer, frame.agentId, FILES_CAPABILITY, "file browser");
    if ("error" in t) return peer.send({ t: "files.res", id: frame.id, ok: false, error: t.error });
    const id = `fl_${Date.now().toString(36)}_${++this.seq}`;
    const timer = setTimeout(() => this.settle(id, { ok: false, error: { code: "timeout", message: "The connector did not answer in time." } }), TIMEOUT_MS);
    (timer as any).unref?.();
    this.pending.set(id, { peer, clientId: frame.id, connectorId: t.connector.id, agentId: t.agent.id, op: frame.op, timer });
    t.connector.send({ t: "files.request", id, op: frame.op, args: frame.args ?? {}, deviceId: peer.id });
  }

  response(connector: Peer, frame: FilesResponse) {
    const p = this.pending.get(frame.id);
    if (!p || p.connectorId !== connector.id) return; // only the connector that was asked may answer
    if (frame.ok && FILE_WRITE_OPS.includes(p.op)) {
      // What changed and where; never the contents.
      const r = (frame.result ?? {}) as { path?: unknown; from?: unknown; to?: unknown; kind?: unknown; size?: unknown };
      this.hub.commit(p.peer.id, null, (tx) => tx.audit(`files.${p.op}`, "agent", p.agentId, {
        connectorId: p.connectorId, path: str(r.path), ...(p.op === "rename" ? { from: str(r.from), to: str(r.to) } : {}),
        ...(p.op === "create" ? { kind: str(r.kind, 10) } : {}), ...(p.op === "write" && typeof r.size === "number" ? { size: r.size } : {}),
      }));
    }
    this.settle(frame.id, frame.ok ? { ok: true, result: frame.result } : { ok: false, error: { code: frame.code ?? "file_error", message: frame.error ?? "The connector could not do that." } });
  }

  private settle(id: string, out: { ok: boolean; result?: unknown; error?: { code: string; message: string } }) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.peer.send({ t: "files.res", id: p.clientId, ...out });
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

interface Term {
  termId: string;
  deviceId: string;
  agentId: string;
  connectorId: string;
  /** The socket the output goes to; null while the device is away (the shell is kept for a while on the connector). */
  peer: Peer | null;
  cwd: string | null;
  open: boolean;
  /** The device's request id waiting for `term.opened`. */
  waiting: { clientId: string; peer: Peer; timer: ReturnType<typeof setTimeout> } | null;
}

export class TerminalRelay {
  private terms = new Map<string, Term>();

  constructor(private hub: WorkspaceHub) {}

  /** For tests and the status page: how many terminals are live. */
  get size() {
    return this.terms.size;
  }

  open(peer: Peer, frame: TermOpen) {
    const fail = (code: string, message: string) => peer.send({ t: "term.opened", id: frame.id, ok: false, error: { code, message } });
    const t = target(this.hub, peer, frame.agentId, TERMINAL_CAPABILITY, "terminal");
    if ("error" in t) return fail(t.error.code, t.error.message);
    if ([...this.terms.values()].filter((x) => x.deviceId === peer.id).length >= MAX_TERMINALS_PER_DEVICE) {
      return fail("too_many", `At most ${MAX_TERMINALS_PER_DEVICE} terminals at once. Close one first.`);
    }
    const termId = newId("term");
    const term: Term = { termId, deviceId: peer.id, agentId: t.agent.id, connectorId: t.connector.id, peer, cwd: frame.cwd ?? null, open: false, waiting: null };
    this.terms.set(termId, term);
    this.wait(term, peer, frame.id);
    t.connector.send({ t: "pty.open", termId, cwd: frame.cwd ?? null, cols: frame.cols, rows: frame.rows, deviceId: peer.id });
  }

  attach(peer: Peer, frame: TermAttach) {
    const term = this.terms.get(frame.termId);
    if (!peer.canApprove || !term || term.deviceId !== peer.id) {
      return peer.send({ t: "term.opened", id: frame.id, ok: false, termId: frame.termId, error: { code: "not_found", message: "That terminal has ended." } });
    }
    const connector = this.hub.connectorPeer(term.connectorId);
    if (!connector) return peer.send({ t: "term.opened", id: frame.id, ok: false, termId: frame.termId, error: { code: "offline", message: "The connector is offline." } });
    term.peer = peer;
    this.wait(term, peer, frame.id);
    connector.send({ t: "pty.attach", termId: term.termId, cols: frame.cols, rows: frame.rows });
  }

  private wait(term: Term, peer: Peer, clientId: string) {
    if (term.waiting) clearTimeout(term.waiting.timer);
    const timer = setTimeout(() => this.onOpened(null, { t: "pty.opened", termId: term.termId, ok: false, error: "The connector did not answer in time.", code: "timeout" }), TIMEOUT_MS);
    (timer as any).unref?.();
    term.waiting = { clientId, peer, timer };
  }

  /** A frame from the device that owns the terminal. Anything else is ignored. */
  private mine(peer: Peer, termId: string): { term: Term; connector: Peer } | null {
    const term = this.terms.get(termId);
    if (!term || !peer.canApprove || term.deviceId !== peer.id) return null;
    const connector = this.hub.connectorPeer(term.connectorId);
    if (!connector) return null;
    // A second socket of the same device that types into the terminal takes its output from now on.
    term.peer = peer;
    return { term, connector };
  }

  input(peer: Peer, frame: TermInput) {
    const m = this.mine(peer, frame.termId);
    if (m?.term.open) m.connector.send({ t: "pty.input", termId: frame.termId, data: frame.data });
  }

  resize(peer: Peer, frame: TermResize) {
    const m = this.mine(peer, frame.termId);
    if (m?.term.open) m.connector.send({ t: "pty.resize", termId: frame.termId, cols: frame.cols, rows: frame.rows });
  }

  close(peer: Peer, frame: TermClose) {
    const m = this.mine(peer, frame.termId);
    if (m) m.connector.send({ t: "pty.close", termId: frame.termId });
  }

  onOpened(connector: Peer | null, frame: PtyOpened) {
    const term = this.terms.get(frame.termId);
    if (!term || (connector && connector.id !== term.connectorId)) return;
    const w = term.waiting;
    if (w) clearTimeout(w.timer);
    term.waiting = null;
    if (!frame.ok) {
      w?.peer.send({ t: "term.opened", id: w.clientId, ok: false, termId: term.termId, error: { code: frame.code ?? "terminal_error", message: frame.error ?? "The terminal could not start." } });
      this.end(term, null, frame.code ?? "failed", term.open);
      return;
    }
    const first = !term.open;
    term.open = true;
    if (frame.cwd) term.cwd = frame.cwd;
    w?.peer.send({ t: "term.opened", id: w.clientId, ok: true, termId: term.termId, reattached: !!frame.reattached, shell: frame.shell, cwd: frame.cwd });
    if (first) {
      this.hub.commit(term.deviceId, null, (tx) => tx.audit("terminal.open", "agent", term.agentId, { connectorId: term.connectorId, termId: term.termId, cwd: str(term.cwd), shell: str(frame.shell, 300) }));
    }
  }

  onOutput(connector: Peer, frame: PtyOutput) {
    const term = this.terms.get(frame.termId);
    if (!term || term.connectorId !== connector.id) return;
    term.peer?.send({ t: "term.output", termId: term.termId, data: frame.data });
  }

  onExit(connector: Peer, frame: PtyExit) {
    const term = this.terms.get(frame.termId);
    if (!term || term.connectorId !== connector.id) return;
    this.end(term, frame.code, frame.reason ?? "exit", true);
  }

  private end(term: Term, code: number | null, reason: string, audit: boolean) {
    if (!this.terms.delete(term.termId)) return;
    if (term.waiting) clearTimeout(term.waiting.timer);
    if (term.open) term.peer?.send({ t: "term.exit", termId: term.termId, code, reason });
    if (audit) this.hub.commit(term.deviceId, null, (tx) => tx.audit("terminal.close", "agent", term.agentId, { connectorId: term.connectorId, termId: term.termId, code, reason }));
  }

  peerGone(peer: Peer) {
    for (const term of [...this.terms.values()]) {
      if (peer.role === "connector" && term.connectorId === peer.id) {
        if (term.waiting) term.waiting.peer.send({ t: "term.opened", id: term.waiting.clientId, ok: false, termId: term.termId, error: { code: "offline", message: "The connector went offline." } });
        this.end(term, null, "offline", term.open);
      } else if (term.peer === peer) {
        // The device went away (app in the background, a network blip). The connector keeps the shell for a while.
        term.peer = null;
        if (term.waiting?.peer === peer) {
          clearTimeout(term.waiting.timer);
          term.waiting = null;
        }
        this.hub.connectorPeer(term.connectorId)?.send({ t: "pty.detach", termId: term.termId });
      }
    }
  }
}
