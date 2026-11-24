import type { Agent, InboundFrame, VaultFile } from "@homebase/protocol";
import { readEntity } from "./tables";
import type { Peer, WorkspaceHub } from "./WorkspaceHub";

type VaultReq = Extract<InboundFrame, { t: "vault.req" }>;
type VaultIndex = Extract<InboundFrame, { t: "vault.index" }>;
type VaultResponse = Extract<InboundFrame, { t: "vault.response" }>;

const TIMEOUT_MS = 20_000;
/** One request per device at a time per op (NOTES-PLAN.md 7.2). A newer one replaces the older. */
const key = (deviceId: string, op: string) => `${deviceId}:${op}`;

/** The online agent that keeps a vault, if any. */
export function vaultAgent(hub: WorkspaceHub): Agent | undefined {
  return hub.store
    .all<{ id: string }>("SELECT id FROM agents WHERE vault IS NOT NULL AND status = 'online' AND connector_id IS NOT NULL")
    .map((r) => readEntity<Agent>(hub.store, "agents", r.id))
    .find((a): a is Agent => !!a?.vault);
}

/**
 * Relays vault requests from a device to the connector that holds the vault, and the answer back to
 * the socket that asked. Note text passes through here and is never written to the database or the log.
 */
export class VaultRelay {
  private pending = new Map<string, { peer: Peer; clientId: string; slot: string; timer: ReturnType<typeof setTimeout> }>();
  private slots = new Map<string, string>();
  private seq = 0;

  constructor(private hub: WorkspaceHub) {}

  request(peer: Peer, frame: VaultReq) {
    const fail = (code: string, message: string) => peer.send({ t: "vault.res", id: frame.id, ok: false, error: { code, message } });
    const agent = vaultAgent(this.hub);
    const connector = agent?.connectorId ? this.hub.connectorPeer(agent.connectorId) : undefined;
    if (!agent || !connector) return fail("offline", "The vault is not reachable right now. The connector that holds it is offline.");
    const slot = key(peer.id, frame.op);
    const older = this.slots.get(slot);
    if (older) this.settle(older, { ok: false, error: { code: "superseded", message: "Replaced by a newer request" } });
    const id = `vq_${Date.now().toString(36)}_${++this.seq}`;
    const timer = setTimeout(() => this.settle(id, { ok: false, error: { code: "timeout", message: "The vault did not answer in time." } }), TIMEOUT_MS);
    (timer as any).unref?.();
    this.pending.set(id, { peer, clientId: frame.id, slot, timer });
    this.slots.set(slot, id);
    connector.send({ t: "vault.request", id, op: frame.op, args: frame.args ?? {}, deviceId: peer.id });
  }

  response(_connector: Peer, frame: VaultResponse) {
    this.settle(frame.id, frame.ok ? { ok: true, result: frame.result } : { ok: false, error: { code: "vault_error", message: frame.error ?? "The vault could not do that." } });
  }

  private settle(id: string, out: { ok: boolean; result?: unknown; error?: { code: string; message: string } }) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (this.slots.get(p.slot) === id) this.slots.delete(p.slot);
    p.peer.send({ t: "vault.res", id: p.clientId, ...out });
  }

  peerGone(peer: Peer) {
    for (const [id, p] of this.pending) {
      if (p.peer === peer) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        if (this.slots.get(p.slot) === id) this.slots.delete(p.slot);
      } else if (peer.role === "connector") {
        this.settle(id, { ok: false, error: { code: "offline", message: "The connector that holds the vault went offline." } });
      }
    }
  }
}

/** Applies note metadata from the connector's index to `vault_files`. Rows that did not change are left alone. */
export function onVaultIndex(hub: WorkspaceHub, peer: Peer, frame: VaultIndex) {
  hub.commit(peer.id, null, (tx) => {
    const same = (a: VaultFile, b: VaultFile) => JSON.stringify(a) === JSON.stringify({ ...a, ...b });
    const seen = new Set<string>();
    for (const f of frame.upserts) {
      seen.add(f.id);
      const cur = tx.get("vault_files", f.id);
      if (!cur || !same(cur, f)) tx.upsert("vault_files", f);
    }
    for (const id of frame.deletes) if (tx.get("vault_files", id)) tx.remove("vault_files", id);
    if (frame.full) for (const row of tx.query("vault_files")) if (!seen.has(row.id)) tx.remove("vault_files", row.id);
  });
}

/**
 * A dictation meant for the daily note reaches the Notes agent wrapped as data, with when and where it
 * was spoken (NOTES-PLAN.md 4.1). Any other message, and any other agent, gets the text as typed.
 */
export function dictationPrompt(
  agent: Pick<Agent, "vault"> | undefined,
  a: { text: string; messageId: string; capturedAt?: number; tz?: string },
  device: { id: string; name?: string },
): string {
  if (!agent?.vault || !a.capturedAt) return a.text;
  const attr = (v: string) => v.replace(/[^\w ./+:-]/g, "").slice(0, 80);
  const tz = a.tz && /^[A-Za-z0-9_+\-/]{1,60}$/.test(a.tz) ? ` tz="${a.tz}"` : "";
  return `<dictation message="${attr(a.messageId)}" captured_at="${Math.round(a.capturedAt)}"${tz} device="${attr(device.name ?? device.id)}">\n${a.text}\n</dictation>`;
}
