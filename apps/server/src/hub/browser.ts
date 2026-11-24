import { browserTopic, type BrowserFrame, type BrowserState, type InboundFrame } from "@homebase/protocol";
import type { Peer, WorkspaceHub } from "./WorkspaceHub";

type StateFrame = Extract<InboundFrame, { t: "browser.state" }>;
type PictureFrame = Extract<InboundFrame, { t: "browser.frame" }>;
type NoticeFrame = Extract<InboundFrame, { t: "browser.notice" }>;
type InputFrame = Extract<InboundFrame, { t: "browser.input" }>;
type ControlFrame = Extract<InboundFrame, { t: "browser.control" }>;
type AckFrame = Extract<InboundFrame, { t: "browser.ack" }>;

const TOPIC = /^browser:(.+)$/;

/** Temporary diagnostics (HB_BROWSER_DEBUG=1): which inputs passed through. Never what was typed. */
export const browserDebug = () => process.env.HB_BROWSER_DEBUG === "1";
export function inputWords(i: InputFrame["input"]): string {
  switch (i.kind) {
    case "tap": return `tap ${i.x.toFixed(3)},${i.y.toFixed(3)}`;
    case "mouse": return `mouse ${i.type} ${i.x.toFixed(3)},${i.y.toFixed(3)}`;
    case "wheel": return `wheel dy ${Math.round(i.dy)}`;
    case "key": return `key ${i.type} ${i.key.length === 1 ? "(a character)" : i.key}${i.repeat ? ` x${i.repeat}` : ""}`;
    case "text": return "text";
  }
}
/** Buttons that change who drives or what agents may do. They are written to the audit log; where the owner went and what they typed is not. */
const AUDITED = new Set(["take", "release", "signin", "done", "pause", "resume", "stop", "settings", "allow_site", "disallow_site", "forget"]);

/**
 * Carries a connector's browser to the devices watching it, and a person's hands back
 * (docs/BROWSER-AGENT-PLAN.md 4.6). A device watches by subscribing to `browser:<connectorId>`.
 *
 * Nothing here touches the database except the audit rows for seat and settings changes. The last state
 * and the last picture are held in memory for a device that opens the view, and dropped with the connector.
 * Pictures taken while the owner signs in privately are passed on and never held.
 */
export class BrowserRelay {
  private last = new Map<string, { state: BrowserState | null; frame: BrowserFrame | null }>();
  private told = new WeakMap<Peer, number>();

  constructor(private hub: WorkspaceHub) {}

  private watchers(connectorId: string): Peer[] {
    const topic = browserTopic(connectorId);
    return [...this.hub.peers].filter((p) => p.role === "device" && p.topics.has(topic));
  }

  /** Tells the connector how many devices are watching, when that number is news to it. The browser draws pictures only for an audience. */
  private countFor(connectorId: string) {
    const connector = this.hub.connectorPeer(connectorId);
    if (!connector) return;
    const count = this.watchers(connectorId).length;
    if (this.told.get(connector) === count) return;
    this.told.set(connector, count);
    connector.send({ t: "browser.viewers", count });
  }

  // ---- from the connector

  onState(connector: Peer, frame: StateFrame) {
    const entry = this.last.get(connector.id) ?? { state: null, frame: null };
    entry.state = frame.state;
    if (frame.state.seat === "signin" || !frame.state.running) entry.frame = null;
    this.last.set(connector.id, entry);
    for (const p of this.watchers(connector.id)) p.send({ t: "browser.state", connectorId: connector.id, state: frame.state });
    this.countFor(connector.id);
  }

  onPicture(connector: Peer, frame: PictureFrame) {
    const entry = this.last.get(connector.id) ?? { state: null, frame: null };
    entry.frame = entry.state?.seat === "signin" ? null : frame.frame;
    this.last.set(connector.id, entry);
    const to = this.watchers(connector.id);
    for (const p of to) p.send({ t: "browser.frame", connectorId: connector.id, frame: frame.frame });
    if (browserDebug()) {
      const s = this.frameStats;
      s.n++;
      s.bytes += frame.frame.data.length;
      if (Date.now() - s.since >= 5000) {
        console.log(`[hub] browser debug: ${s.n} pictures in ${((Date.now() - s.since) / 1000).toFixed(1)}s, avg ${Math.round((s.bytes * 0.75) / s.n / 1024)} KB, ${frame.frame.width}x${frame.frame.height}, to ${to.length} watcher(s)`);
        this.frameStats = { n: 0, bytes: 0, since: Date.now() };
      }
    }
  }
  private frameStats = { n: 0, bytes: 0, since: Date.now() };

  onNotice(connector: Peer, frame: NoticeFrame) {
    for (const p of this.watchers(connector.id)) {
      if (!frame.deviceId || p.id === frame.deviceId) p.send({ t: "browser.notice", connectorId: connector.id, message: frame.message });
    }
  }

  // ---- from a device

  onSub(peer: Peer, topic: string) {
    const m = TOPIC.exec(topic);
    if (!m) return;
    const entry = this.last.get(m[1]);
    const online = !!this.hub.connectorPeer(m[1]);
    peer.send({ t: "browser.state", connectorId: m[1], state: online ? entry?.state ?? null : null });
    if (online && entry?.frame) peer.send({ t: "browser.frame", connectorId: m[1], frame: entry.frame });
    this.countFor(m[1]);
  }

  onUnsub(_peer: Peer, topic: string) {
    const m = TOPIC.exec(topic);
    if (m) this.countFor(m[1]);
  }

  private route(peer: Peer, connectorId: string): Peer | null {
    if (!peer.canApprove) {
      peer.send({ t: "browser.notice", connectorId, message: "This device may watch the browser but not drive it." });
      return null;
    }
    const connector = this.hub.connectorPeer(connectorId);
    if (!connector) peer.send({ t: "browser.notice", connectorId, message: "The machine that runs this browser is offline." });
    return connector ?? null;
  }

  /** A tap, a scroll, a key. Passed on and forgotten: no row, no log line (only where it went, with HB_BROWSER_DEBUG=1). */
  input(peer: Peer, frame: InputFrame) {
    const connector = this.route(peer, frame.connectorId);
    if (browserDebug()) console.log(`[hub] browser debug: input ${inputWords(frame.input)} from ${peer.id.slice(0, 12)} -> ${connector ? "relayed" : "dropped (no route)"}`);
    connector?.send({ t: "browser.input", input: frame.input, deviceId: peer.id });
  }

  /** "Picture n arrived", from any watching device: passed on so the node can pace its pictures. Silent when it cannot go. */
  ack(peer: Peer, frame: AckFrame) {
    if (!peer.topics.has(browserTopic(frame.connectorId))) return;
    this.hub.connectorPeer(frame.connectorId)?.send({ t: "browser.ack", seq: frame.seq, deviceId: peer.id });
  }

  control(peer: Peer, frame: ControlFrame) {
    const connector = this.route(peer, frame.connectorId);
    if (browserDebug()) console.log(`[hub] browser debug: control ${frame.control.action}${frame.control.layout ? ` ${frame.control.layout}` : ""}${frame.control.size ? ` ${frame.control.size.width}x${frame.control.size.height}@${frame.control.size.scale}` : ""} from ${peer.id.slice(0, 12)} -> ${connector ? "relayed" : "dropped"}`);
    if (!connector) return;
    const c = frame.control;
    if (AUDITED.has(c.action)) {
      this.hub.commit(peer.id, null, (tx) => tx.audit(`browser.${c.action}`, "connector", frame.connectorId, {
        ...(c.site ? { site: c.site } : {}), ...(c.settings ? { settings: c.settings } : {}),
      }));
    }
    connector.send({ t: "browser.control", control: c, deviceId: peer.id });
  }

  // ---- sockets going away

  peerGone(peer: Peer) {
    if (peer.role === "connector") {
      // A newer socket of the same connector may already be here; only a real departure clears the view.
      if (this.hub.connectorPeer(peer.id)) return;
      this.last.delete(peer.id);
      for (const p of this.watchers(peer.id)) p.send({ t: "browser.state", connectorId: peer.id, state: null });
      return;
    }
    for (const topic of peer.topics) {
      const m = TOPIC.exec(topic);
      if (m) this.countFor(m[1]);
    }
  }
}
