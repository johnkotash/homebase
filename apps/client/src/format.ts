import type { InboxItem, InboxSource, RunStatus } from "@homebase/protocol";
import type { IconName } from "./components/ui";
import { color } from "./theme";

export function ago(ts: number | null | undefined, now: number): string {
  if (!ts) return "";
  const d = Math.max(0, now - ts);
  if (d < 45_000) return "now";
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h`;
  if (d < 7 * 86_400_000) return `${Math.round(d / 86_400_000)}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function duration(ms: number): string {
  const m = Math.floor(Math.abs(ms) / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function dayTime(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  return same ? clock(ts) : `${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}, ${clock(ts)}`;
}

export const SOURCE: Record<InboxSource, { icon: IconName; label: string; tone: string }> = {
  // Monochrome: sources are told apart by icon, not hue.
  gmail: { icon: "mail", label: "Gmail", tone: color.textDim },
  clickup: { icon: "check-square", label: "ClickUp", tone: color.textDim },
  monitor: { icon: "activity", label: "Monitor", tone: color.textDim },
  resend: { icon: "send", label: "Resend", tone: color.textDim },
  calendar: { icon: "calendar", label: "Calendar", tone: color.textDim },
  crm: { icon: "users", label: "CRM", tone: color.textDim },
  social: { icon: "message-circle", label: "Social", tone: color.textDim },
  agent: { icon: "cpu", label: "Agent", tone: color.text },
  manual: { icon: "edit-3", label: "Captured", tone: color.text },
};

export const RUN_STATUS: Record<RunStatus, { label: string; tone: string; icon: IconName }> = {
  queued: { label: "Queued", tone: color.textDim, icon: "clock" },
  starting: { label: "Starting", tone: color.p2, icon: "loader" },
  running: { label: "Running", tone: color.accent, icon: "zap" },
  waiting_approval: { label: "Waiting for you", tone: color.p1, icon: "pause-circle" },
  succeeded: { label: "Succeeded", tone: color.ok, icon: "check-circle" },
  failed: { label: "Failed", tone: color.danger, icon: "x-circle" },
  cancelled: { label: "Cancelled", tone: color.textMuted, icon: "slash" },
  offline: { label: "Connector offline", tone: color.textMuted, icon: "wifi-off" },
};

export interface SlaView { label: string; tone: string; state: InboxItem["slaState"]; short: string }

/** Green while there is room, amber past the warning point, red once the deadline is gone. */
export function slaView(item: InboxItem, now: number): SlaView | null {
  if (item.slaState === "none" || item.slaDueAt == null) return null;
  if (item.slaState === "met") return { label: "Responded in time", short: "Met", tone: color.ok, state: "met" };
  const left = item.slaDueAt - now;
  const done = item.status === "responded" || item.status === "done";
  if (item.slaState === "breached" || left <= 0) {
    return done
      ? { label: "Responded late", short: "Late", tone: color.danger, state: "breached" }
      : { label: `Overdue by ${duration(left)}`, short: `-${duration(left)}`, tone: color.danger, state: "breached" };
  }
  const warn = item.slaState === "warning" || (item.slaWarnAt != null && now >= item.slaWarnAt);
  return { label: `${duration(left)} left to respond`, short: duration(left), tone: warn ? color.warn : color.ok, state: warn ? "warning" : "running" };
}

export const senderName = (s: string | null | undefined) => (s ?? "").replace(/\s*<.*>$/, "");
