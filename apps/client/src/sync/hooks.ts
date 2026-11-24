import { useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import { isLiveRun, runTopic, type Approval, type EntityName, type EntityTypes, type InboxItem, type RunEvent } from "@homebase/protocol";
import type { SyncState } from "@homebase/sync-client";
import { api, subscribeTopic, syncStore } from "./session";

export function useSync<T>(selector: (s: SyncState) => T): T {
  return useStore(syncStore, selector);
}

export function useMap<E extends EntityName>(entity: E): Record<string, EntityTypes[E]> {
  return useSync((s) => s.entities[entity]);
}

export function useList<E extends EntityName>(entity: E, compare?: (a: EntityTypes[E], b: EntityTypes[E]) => number): EntityTypes[E][] {
  const map = useMap(entity);
  return useMemo(() => {
    const list = Object.values(map) as EntityTypes[E][];
    return compare ? list.sort(compare) : list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);
}

export function useOne<E extends EntityName>(entity: E, id: string | undefined): EntityTypes[E] | undefined {
  return useSync((s) => (id ? s.entities[entity][id] : undefined));
}

export function useSetting<T>(key: string, fallback: T): T {
  const row = useSync((s) => s.entities.settings[key]);
  return (row?.value as T) ?? fallback;
}

/** Re-renders on an interval so countdowns stay honest. Uses the hub's clock. */
export function useNow(intervalMs = 20_000): number {
  const offset = useSync((s) => s.clockOffset);
  const [now, setNow] = useState(() => Date.now() + offset);
  useEffect(() => {
    setNow(Date.now() + offset);
    const t = setInterval(() => setNow(Date.now() + offset), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs, offset]);
  return now;
}

const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 } as const;
export const isOpen = (i: InboxItem) => i.status !== "done" && i.status !== "responded" && i.status !== "snoozed";

/** The queue order used everywhere: priority first, then the nearest deadline. */
export function byUrgency(a: InboxItem, b: InboxItem) {
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (a.slaDueAt ?? Infinity) - (b.slaDueAt ?? Infinity) || b.receivedAt - a.receivedAt;
}

export function usePendingApprovals(): Approval[] {
  const map = useMap("approvals");
  return useMemo(() => Object.values(map).filter((a) => a.status === "pending").sort((a, b) => a.requestedAt - b.requestedAt), [map]);
}

/** Subscribes to live events for a run while mounted; returns streaming text for it. */
export function useRunStream(runId: string | undefined, live: boolean): string {
  useEffect(() => {
    if (!runId || !live) return;
    return subscribeTopic(runTopic(runId));
  }, [runId, live]);
  return useSync((s) => (runId ? s.streams[runId] ?? "" : ""));
}

/** Persisted events over REST, merged with events that arrive live on the run topic. */
export function useRunEvents(runId: string | undefined, status: string | undefined): { events: RunEvent[]; loading: boolean } {
  const live = useSync((s) => (runId ? s.runEvents[runId] : undefined));
  const lastIdx = useSync((s) => (runId ? s.entities.runs[runId]?.lastEventIdx : undefined));
  const [fetched, setFetched] = useState<RunEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const isLive = status ? isLiveRun(status as any) : false;
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    api<{ events: RunEvent[] }>(`/v1/runs/${runId}/events?limit=1000`)
      .then((r) => !cancelled && setFetched(r.events))
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // Refetch when the run settles so nothing that streamed past is missing.
  }, [runId, status, lastIdx]);
  useEffect(() => {
    if (!runId || !isLive) return;
    return subscribeTopic(runTopic(runId));
  }, [runId, isLive]);
  const events = useMemo(() => {
    const byIdx = new Map<number, RunEvent>();
    for (const e of fetched) byIdx.set(e.idx, e);
    for (const e of live ?? []) byIdx.set(e.idx, e);
    return [...byIdx.values()].sort((a, b) => a.idx - b.idx);
  }, [fetched, live]);
  return { events, loading };
}
