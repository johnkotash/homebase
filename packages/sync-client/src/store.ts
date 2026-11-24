import { createStore, type StoreApi } from "zustand/vanilla";
import { ENTITY_NAMES, type EntityName, type EntityTypes, type MutationName, type RunEvent } from "@homebase/protocol";

export type EntityMaps = { [E in EntityName]: Record<string, EntityTypes[E]> };

export type ConnectionStatus = "idle" | "connecting" | "online" | "reconnecting" | "offline" | "unauthorized";

export interface OutboxEntry {
  id: string;
  name: MutationName;
  args: unknown;
  at: number;
}

export interface SyncState {
  status: ConnectionStatus;
  /** Cache has been read from storage; safe to render lists. */
  hydrated: boolean;
  /** At least one snapshot or delta has been applied in this or an earlier session. */
  synced: boolean;
  lastSeq: number;
  deviceId: string | null;
  workspaceId: string | null;
  /** hub clock minus local clock, ms */
  clockOffset: number;
  /** Hub-confirmed rows. */
  server: EntityMaps;
  /** What the UI reads: server rows with queued local mutations applied on top. */
  entities: EntityMaps;
  outbox: OutboxEntry[];
  /** Streaming assistant text per run, built from text_delta events. */
  streams: Record<string, string>;
  /** Persisted-kind run events seen live on a subscribed run topic. */
  runEvents: Record<string, RunEvent[]>;
  lastError: { id: string; name: string; code: string; message: string; at: number } | null;
}

export const emptyMaps = (): EntityMaps => {
  const m = {} as Record<string, Record<string, unknown>>;
  for (const e of ENTITY_NAMES) m[e] = {};
  return m as EntityMaps;
};

export type SyncStore = StoreApi<SyncState>;

export function createSyncStore(): SyncStore {
  const maps = emptyMaps();
  return createStore<SyncState>(() => ({
    status: "idle", hydrated: false, synced: false, lastSeq: 0, deviceId: null, workspaceId: null, clockOffset: 0,
    server: maps, entities: maps, outbox: [], streams: {}, runEvents: {}, lastError: null,
  }));
}
