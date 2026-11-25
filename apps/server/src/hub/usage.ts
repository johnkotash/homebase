import {
  DEFAULT_USAGE_THRESHOLDS, USAGE_SETTING, USAGE_THRESHOLDS_SETTING, USAGE_WINDOW_LABEL, UsageWindowKey,
  type InboxItem, type UsageSnapshot,
} from "@homebase/protocol";
import type { Peer, Tx, WorkspaceHub } from "./WorkspaceHub";

/**
 * Claude plan usage (issue #4). The connector sends the latest windows a run printed; the hub keeps them in the
 * synced `usage.claude` setting (the meter on every device) and raises inbox alerts:
 * - one item per window, level and window episode (`usage:<window>:<level>:<resetsAt>`), level = a threshold
 *   (default 80 and 95 %) or "limit" when the CLI says rejected;
 * - a higher level closes the lower ones of the same episode; a new episode (the window reset) closes them all.
 */

type Level = number | "limit";

export function usageLevel(pct: number, status: string, thresholds: number[]): Level | null {
  if (status === "rejected" || pct >= 100) return "limit";
  const hit = thresholds.filter((t) => pct >= t);
  return hit.length ? Math.max(...hit) : null;
}

export function thresholdsOf(hub: WorkspaceHub): number[] {
  const v = hub.setting<unknown>(USAGE_THRESHOLDS_SETTING, DEFAULT_USAGE_THRESHOLDS);
  const list = Array.isArray(v) ? v.filter((n): n is number => typeof n === "number" && n > 0 && n < 100) : [];
  return list.length ? list : DEFAULT_USAGE_THRESHOLDS;
}

const fmtReset = (hub: WorkspaceHub, at: number | null) => {
  if (at == null) return "an unknown time";
  try {
    return new Date(at).toLocaleString("en-US", { timeZone: hub.workspace().timezone, weekday: "short", hour: "numeric", minute: "2-digit" });
  } catch {
    return new Date(at).toISOString();
  }
};

function close(tx: Tx, items: InboxItem[]) {
  for (const it of items) {
    const slaState = it.slaState === "running" || it.slaState === "warning" ? (it.slaDueAt != null && tx.now > it.slaDueAt ? "breached" : "met") : it.slaState;
    tx.upsert("inbox_items", { ...it, status: "done", respondedAt: it.respondedAt ?? tx.now, snoozeUntil: null, slaState, updatedAt: tx.now });
    tx.audit("usage.resolve", "inbox_item", it.id, { externalId: it.externalId });
  }
}

export function onUsageReport(hub: WorkspaceHub, peer: Peer, usage: UsageSnapshot) {
  hub.commit(peer.id, null, (tx) => {
    const prev = tx.get("settings", USAGE_SETTING)?.value as UsageSnapshot | null | undefined;
    // An older report (a slow run finishing late) never replaces a newer one.
    if (prev && typeof prev.at === "number" && prev.at > usage.at) return;
    tx.upsert("settings", { id: USAGE_SETTING, value: usage, updatedAt: tx.now });

    const thresholds = thresholdsOf(hub);
    for (const key of UsageWindowKey.options) {
      const w = usage.windows[key];
      if (!w) continue;
      const episode = w.resetsAt ?? "na";
      const open = tx.query("inbox_items", "WHERE source = 'monitor' AND substr(external_id, 1, ?) = ? AND status NOT IN ('responded','done')", `usage:${key}:`.length, `usage:${key}:`);
      // The window reset: whatever was open for the last episode is over.
      close(tx, open.filter((i) => !String(i.externalId).endsWith(`:${episode}`)));
      const level = usageLevel(w.pct, w.status, thresholds);
      if (level == null) continue;
      const externalId = `usage:${key}:${level}:${episode}`;
      const label = USAGE_WINDOW_LABEL[key];
      const title = level === "limit"
        ? `Claude ${label} limit reached: resets ${fmtReset(hub, w.resetsAt)}`
        : `Claude ${label} usage at ${Math.round(w.pct)}% (resets ${fmtReset(hub, w.resetsAt)})`;
      const existing = tx.query("inbox_items", "WHERE source = 'monitor' AND external_id = ?", externalId)[0];
      if (existing) {
        if (existing.status !== "done" && existing.status !== "responded" && existing.title !== title) tx.upsert("inbox_items", { ...existing, title, updatedAt: tx.now });
        continue;
      }
      // A higher level replaces the lower ones of this episode.
      close(tx, open.filter((i) => String(i.externalId).endsWith(`:${episode}`)));
      const high = level === "limit" || level >= 95;
      const item = hub.ingestTx(tx, {
        source: "monitor", externalId, title, snippet: `As of ${fmtReset(hub, usage.at)}. Shown on the home screen's usage meter.`, body: null,
        sender: peer.name || null, receivedAt: usage.at, priority: high ? "P1" : "P2", reason: "Claude plan usage alert",
      });
      tx.audit("usage.alert", "inbox_item", item.id, { externalId, pct: w.pct, status: w.status });
      // P1 items notify through ingestion; a P2 warning still deserves a heads-up.
      if (!high) {
        tx.notify({
          priority: "P2", channel: "agent_updates", title, body: "Claude usage is getting high.", link: `/inbox/${item.id}`, actions: ["open"],
          collapseKey: externalId, subjectType: "inbox_item", subjectId: item.id,
        });
      }
    }
  });
}
