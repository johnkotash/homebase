import type { Notification } from "@homebase/protocol";
import type { WorkspaceHub } from "./WorkspaceHub";
import { wallTime } from "./sla";

export interface FocusWindow { enabled: boolean; days: number[]; start: string; end: string }
export const DEFAULT_FOCUS: FocusWindow = { enabled: false, days: [1, 2, 3, 4, 5], start: "08:00", end: "16:30" };

const hm = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};

export function inFocusWindow(fw: FocusWindow, now: number, tz: string): boolean {
  if (!fw.enabled) return false;
  const w = wallTime(now, tz);
  const mins = w.h * 60 + w.mi;
  return fw.days.includes(w.dow) && mins >= hm(fw.start) && mins < hm(fw.end);
}

/**
 * Notification policy (ARCHITECTURE.md 11.2). During the focus window (the day-job hours) only
 * high-risk approvals and P0 items interrupt; everything else waits for a digest.
 */
export function deliverable(hub: WorkspaceHub, n: Notification): boolean {
  const fw = hub.setting<FocusWindow>("notifications.focusWindow", DEFAULT_FOCUS);
  if (!inFocusWindow(fw, hub.now(), hub.workspace().timezone)) return true;
  if (n.channel === "p0_urgent") return true;
  if (n.channel === "approvals" && n.priority === "P0") return true;
  return false;
}
