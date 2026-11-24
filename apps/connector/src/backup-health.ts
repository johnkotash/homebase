import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { InboxIngestFrame } from "@homebase/protocol";
import { dataDirOf, expandHome } from "./config";

/**
 * Backup alerts (docs/CONFIGURATION.md, "Backup alerts"). `scripts/server/backup.sh run` writes a status file
 * ({ at, result: "ok" | "failed", message, lastOkAt }); this reads it every few minutes and raises, updates and
 * resolves P1 inbox items through the connector's `inbox.ingest` frame. Nothing happens on a machine without the file.
 */

export type MonitorItem = Extract<InboxIngestFrame["item"], { source: "monitor" }>;
export type BackupAlertsMode = "auto" | "on" | "off";
export type BackupCondition = "failed" | "overdue";
export const BACKUP_CONDITIONS: BackupCondition[] = ["failed", "overdue"];

export interface BackupHealthConfig {
  /** auto: only when the status file exists. on: a missing file counts as overdue. off: never. */
  mode: BackupAlertsMode;
  statusFile: string;
  checkMs: number;
  staleMs: number;
}

const HOUR = 3_600_000;

function num(v: string | undefined, def: number, min: number, max: number): number {
  const n = Number(v?.trim());
  return v?.trim() && Number.isFinite(n) && n >= min && n <= max ? n : def;
}

export function backupHealthConfig(env: NodeJS.ProcessEnv = process.env): BackupHealthConfig {
  const raw = (env.HB_BACKUP_ALERTS ?? "").trim().toLowerCase();
  const mode: BackupAlertsMode = /^(0|off|false|no)$/.test(raw) ? "off" : /^(1|on|true|yes)$/.test(raw) ? "on" : "auto";
  const file = env.HB_BACKUP_STATUS_FILE?.trim();
  return {
    mode,
    statusFile: resolve(file ? expandHome(file) : join(dataDirOf(env), ".backup-status.json")),
    checkMs: num(env.HB_BACKUP_CHECK_MINUTES, 10, 1, 1440) * 60_000,
    staleMs: num(env.HB_BACKUP_STALE_HOURS, 3, 0.25, 24 * 30) * HOUR,
  };
}

export interface BackupStatus {
  at: number | null;
  result: "ok" | "failed" | null;
  message: string;
  /** The last successful run (falls back to `at` for a success recorded by an older backup.sh). */
  lastOkAt: number | null;
}

const time = (v: unknown): number | null => {
  const t = typeof v === "string" || typeof v === "number" ? new Date(v).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
};

/** The status file, "missing", or "unreadable" (half-written or not JSON: the next check tries again). */
export function readBackupStatus(file: string): BackupStatus | "missing" | "unreadable" {
  if (!existsSync(file)) return "missing";
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    if (!j || typeof j !== "object") return "unreadable";
    const result = j.result === "ok" || j.result === "failed" ? j.result : null;
    const at = time(j.at);
    return { at, result, message: typeof j.message === "string" ? j.message : "", lastOkAt: time(j.lastOkAt) ?? (result === "ok" ? at : null) };
  } catch {
    return "unreadable";
  }
}

const clean = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
export const fmtUtc = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const hours = (ms: number) => `${Math.round((ms / HOUR) * 100) / 100} h`;

/**
 * What should be open now: an alert item per condition, or null when that condition is healthy.
 * Null overall means "no opinion" (alerts off, no file in auto mode, unreadable file): nothing is raised or resolved.
 * An alert's id names its episode, the last success before it, so a later failure is a new item.
 */
export function assessBackup(
  status: BackupStatus | "missing" | "unreadable", cfg: BackupHealthConfig, now: number, startedAt: number,
): Record<BackupCondition, MonitorItem | null> | null {
  if (cfg.mode === "off" || status === "unreadable") return null;
  const base = { source: "monitor" as const, kind: "alert" as const, sender: "Backup monitor", receivedAt: now };
  if (status === "missing") {
    if (cfg.mode !== "on" || now - startedAt <= cfg.staleMs) return null;
    return {
      failed: null,
      overdue: { ...base, externalId: "backup:overdue:missing", title: "Backup overdue", snippet: clean(`No backup status file at ${cfg.statusFile}: has the backup ever run? Backup alerts are on (HB_BACKUP_ALERTS).`, 500) },
    };
  }
  const lastOk = status.lastOkAt;
  const lastOkText = lastOk != null ? fmtUtc(lastOk) : "none yet";
  const failed: MonitorItem | null = status.result === "failed"
    ? {
        ...base, externalId: `backup:failed:${lastOk ?? "never"}`, title: "Backup failed",
        snippet: clean(`Last run ${status.at != null ? fmtUtc(status.at) : "(time unknown)"}: ${status.message || "no reason given"}. Last successful backup: ${lastOkText}.`, 500),
      }
    : null;
  const overdue: MonitorItem | null = lastOk != null && now - lastOk > cfg.staleMs
    ? {
        ...base, externalId: `backup:overdue:${lastOk}`, title: "Backup overdue",
        snippet: clean(`No successful backup since ${lastOkText}, more than ${hours(cfg.staleMs)} ago. Is the backup timer running?`, 500),
      }
    : null;
  return { failed, overdue };
}

export interface BackupMonitorOptions {
  config?: BackupHealthConfig;
  /** Hands an item to the hub. False when the link is down: the check is repeated on the next pass. */
  emit(item: MonitorItem): boolean;
  log?: (...a: unknown[]) => void;
  now?: () => number;
}

export class BackupMonitor {
  readonly config: BackupHealthConfig;
  private readonly now: () => number;
  private readonly startedAt: number;
  /** What was last delivered per condition, so an unchanged alert is not sent again. */
  private sent = new Map<BackupCondition, string>();
  /** Conditions that may have an open item on the hub. All of them at start: an alert may be left from before a restart. */
  private maybeOpen = new Set<BackupCondition>(BACKUP_CONDITIONS);
  private timer: ReturnType<typeof setInterval> | null = null;
  private warned = false;

  constructor(private o: BackupMonitorOptions) {
    this.config = o.config ?? backupHealthConfig();
    this.now = o.now ?? Date.now;
    this.startedAt = this.now();
  }

  get enabled() {
    return this.config.mode !== "off";
  }

  /** One pass. Returns the items it delivered. */
  check(): MonitorItem[] {
    const out: MonitorItem[] = [];
    if (!this.enabled) return out;
    const status = readBackupStatus(this.config.statusFile);
    if (status === "unreadable" && !this.warned) this.o.log?.(`backup alerts: could not read ${this.config.statusFile}; trying again on the next check`);
    this.warned = status === "unreadable";
    const want = assessBackup(status, this.config, this.now(), this.startedAt);
    if (!want) return out;
    for (const cond of BACKUP_CONDITIONS) {
      const alert = want[cond];
      if (alert) {
        const { receivedAt: _r, ...same } = alert;
        const key = JSON.stringify(same);
        if (this.sent.get(cond) === key) continue;
        if (!this.o.emit(alert)) continue;
        this.sent.set(cond, key);
        this.maybeOpen.add(cond);
        out.push(alert);
        this.o.log?.(`backup alerts: ${alert.title.toLowerCase()} (${alert.externalId})`);
      } else if (this.maybeOpen.has(cond)) {
        const resolveItem: MonitorItem = {
          source: "monitor", kind: "resolve", externalId: `backup:${cond}`, sender: "Backup monitor",
          title: status !== "missing" && status !== "unreadable" && status.lastOkAt != null ? `backup succeeded at ${fmtUtc(status.lastOkAt)}` : "backup healthy again",
        };
        if (!this.o.emit(resolveItem)) continue;
        this.maybeOpen.delete(cond);
        this.sent.delete(cond);
        out.push(resolveItem);
      }
    }
    return out;
  }

  start() {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.check();
      } catch (err) {
        this.o.log?.("backup alerts:", (err as Error).message);
      }
    }, this.config.checkMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
