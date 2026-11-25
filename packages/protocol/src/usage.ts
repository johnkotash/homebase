import { z } from "zod";

/**
 * Claude plan usage (issue #4), read only from what the Claude Code CLI prints: every run's `rate_limit_event`
 * carries `unifiedWindows.five_hour` and `seven_day` (utilization 0–1, reset time, status). The connector forwards
 * the latest numbers; the hub keeps them in the synced setting below and raises inbox alerts at the thresholds.
 */
export const USAGE_SETTING = "usage.claude";
/** Alert thresholds in percent (a synced setting; default below). */
export const USAGE_THRESHOLDS_SETTING = "usage.alertThresholds";
export const DEFAULT_USAGE_THRESHOLDS = [80, 95];

export const UsageWindowKey = z.enum(["five_hour", "seven_day"]);
export type UsageWindowKey = z.infer<typeof UsageWindowKey>;
export const USAGE_WINDOW_LABEL: Record<UsageWindowKey, string> = { five_hour: "5-hour", seven_day: "Week" };

export const UsageWindow = z.object({
  /** 0–100, one decimal. */
  pct: z.number().min(0).max(1000),
  /** Epoch milliseconds, or null when the CLI did not say. */
  resetsAt: z.number().int().nullable(),
  status: z.enum(["allowed", "allowed_warning", "warning", "rejected"]).or(z.string().max(40)),
});
export type UsageWindow = z.infer<typeof UsageWindow>;

export const UsageSnapshot = z.object({
  at: z.number().int(),
  windows: z.object({ five_hour: UsageWindow.optional(), seven_day: UsageWindow.optional() }),
  /** Which agent's run reported it, and its model (all agents on one connector share the same login). */
  agentKey: z.string().max(100).nullable().optional(),
  model: z.string().max(100).nullable().optional(),
});
export type UsageSnapshot = z.infer<typeof UsageSnapshot>;

/** Reads a CLI `rate_limit_info` object into a snapshot; null when it has no usable window. */
export function usageFromRateLimit(info: unknown, at: number): UsageSnapshot | null {
  const u = (info as { unifiedWindows?: Record<string, unknown> } | null)?.unifiedWindows;
  if (!u || typeof u !== "object") return null;
  const windows: UsageSnapshot["windows"] = {};
  for (const key of UsageWindowKey.options) {
    const w = u[key] as { utilization?: unknown; resetsAt?: unknown; status?: unknown } | undefined;
    if (!w || typeof w.utilization !== "number" || !Number.isFinite(w.utilization)) continue;
    windows[key] = {
      pct: Math.round(Math.max(0, w.utilization) * 1000) / 10,
      resetsAt: typeof w.resetsAt === "number" && Number.isFinite(w.resetsAt) ? Math.round(w.resetsAt < 1e11 ? w.resetsAt * 1000 : w.resetsAt) : null,
      status: typeof w.status === "string" ? w.status.slice(0, 40) : "allowed",
    };
  }
  return windows.five_hour || windows.seven_day ? { at, windows } : null;
}
