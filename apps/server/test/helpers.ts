import { ENTITY_SCHEMAS, newId, type EntityName } from "@homebase/protocol";
import { openStore } from "../src/app";
import { Directory } from "../src/directory";
import { WorkspaceHub, type HubOptions, type Peer } from "../src/hub/WorkspaceHub";
import { seed } from "../src/seed";

export interface TestPeer extends Peer {
  frames: any[];
  closed: { code?: number; reason?: string } | null;
  of(t: string): any[];
}

export function makeHub(opts: HubOptions & { demo?: boolean; clock?: { now: number } } = {}) {
  const clock = opts.clock ?? { now: Date.UTC(2026, 10, 18, 15, 0, 0) }; // Wed 2026-11-18 10:00 in New York
  const store = openStore(":memory:");
  const hub = new WorkspaceHub(store, { quiet: true, now: () => clock.now, ...opts });
  seed(hub, { demo: opts.demo ?? false });
  const directory = new Directory(store, hub.now);
  return { hub, store, directory, clock };
}

export function pairDevice(directory: Directory, kind: "device" | "connector" = "device", name = "Test device") {
  const { code } = directory.createPairingCode(kind, null);
  const r = directory.pair({ code, kind, name, platform: "test" });
  if (!r.ok) throw new Error(r.message);
  return r;
}

export function peer(id: string, role: "device" | "connector" = "device", canApprove = true): TestPeer {
  const p: TestPeer = {
    id, role, name: id, canApprove, topics: new Set(), frames: [], closed: null,
    send: (f) => void p.frames.push(JSON.parse(JSON.stringify(f))),
    close: (code, reason) => void (p.closed = { code, reason }),
    of: (t) => p.frames.filter((f) => f.t === t),
  };
  return p;
}

/** Attaches a device peer and returns it; frames collected so far include welcome + snapshot/changes. */
export function connectDevice(hub: WorkspaceHub, directory: Directory, hello: { lastSeq?: number; schema?: number } = {}) {
  const d = pairDevice(directory);
  const p = peer(d.deviceId);
  hub.attachDevice(p, hello);
  return p;
}

export function connectConnector(hub: WorkspaceHub, directory: Directory, agents = [{ key: "dev", name: "Dev agent", kind: "mock" as const }]) {
  const c = pairDevice(directory, "connector", "test-connector");
  const p = peer(c.deviceId, "connector", false);
  hub.attachConnector(p);
  hub.onFrame(p, { t: "register", host: { name: "test-connector", os: "test" }, agents: agents.map((a) => ({ description: "", capabilities: [], workspaces: [], ...a })) });
  return p;
}

export const mid = () => newId("mut");

/** Every row a hub sends must satisfy the shared schema. */
export function assertValid(entity: EntityName, row: unknown) {
  const r = ENTITY_SCHEMAS[entity].safeParse(row);
  if (!r.success) throw new Error(`${entity} row failed schema: ${JSON.stringify(r.error.issues)} ${JSON.stringify(row)}`);
}
