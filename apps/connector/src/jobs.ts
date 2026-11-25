import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { JobDoneFrame } from "@homebase/protocol";
import { dataDirOf, expandHome } from "./config";

/**
 * Background jobs (docs/AGENTS.md, "Background jobs"). An agent run ends when its reply does, so long work that must
 * outlive it (another `claude -p`, a long build or migration) is started with `hbjob start` (scripts/server/hbjob),
 * which runs it as its own systemd user service and writes `<jobs dir>/<id>.json`, then `<id>.done` when it ends.
 * This watcher notices the end (the done file, or the service no longer running) and tells the hub once
 * (`job.done`), which wakes the session the job came from so the agent reports the outcome on its own.
 */

export type JobInfo = JobDoneFrame["job"];

export interface JobRecord {
  id: string;
  name: string;
  threadId: string | null;
  agentKey: string | null;
  command: string;
  cwd: string | null;
  unit: string | null;
  log: string | null;
  startedAt: number | null;
}

export const jobsDirOf = (env: NodeJS.ProcessEnv = process.env) =>
  resolve(env.HOMEBASE_JOBS_DIR?.trim() ? expandHome(env.HOMEBASE_JOBS_DIR.trim()) : join(dataDirOf(env), "jobs"));

const ID = /^[\w.:-]{1,100}$/;
const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.slice(0, max) : null);
const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : typeof v === "string" && /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : null);
/** hbjob writes seconds (date +%s); accept milliseconds too. */
const ms = (v: unknown) => {
  const n = int(v);
  return n == null ? null : n < 1e11 ? n * 1000 : n;
};

export function readJob(file: string): JobRecord | null {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    const id = str(j?.id, 100);
    if (!id || !ID.test(id)) return null;
    return {
      id, name: str(j.name, 100) ?? id, threadId: str(j.threadId, 100), agentKey: str(j.agentKey, 100), command: str(j.command, 2000) ?? "",
      cwd: str(j.cwd, 1000), unit: str(j.unit, 200), log: str(j.log, 1000), startedAt: ms(j.startedAt),
    };
  } catch {
    return null; // half-written: the next check reads it again
  }
}

export function readDone(file: string): { exitCode: number | null; endedAt: number | null } | null {
  if (!existsSync(file)) return null;
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    return { exitCode: int(j?.exitCode), endedAt: ms(j?.endedAt) };
  } catch {
    return { exitCode: null, endedAt: null };
  }
}

/** The last lines of a log, without control characters, kept under `max` characters. */
export function logTail(file: string | null, lines = 40, max = 4000): string {
  if (!file || !existsSync(file)) return "";
  try {
    const size = statSync(file).size;
    const buf = readFileSync(file);
    const text = buf.subarray(Math.max(0, size - 64_000)).toString("utf8");
    const tail = text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").split("\n").slice(-lines).join("\n").trim();
    return tail.length > max ? tail.slice(tail.length - max) : tail;
  } catch {
    return "";
  }
}

export type UnitState = "running" | "ended" | "unknown";
export type UnitProbe = (unit: string) => Promise<{ state: UnitState; exitCode: number | null }>;

/** Asks systemd whether a job's service is still running. */
export const systemdProbe: UnitProbe = (unit) =>
  new Promise((done) => {
    execFile("systemctl", ["--user", "show", unit, "-p", "LoadState", "-p", "ActiveState", "-p", "ExecMainStatus"], { timeout: 10_000 }, (err, stdout) => {
      if (err) return done({ state: "unknown", exitCode: null });
      const kv = Object.fromEntries(String(stdout).split("\n").map((l) => l.split("=")).filter((p) => p.length >= 2).map(([k, ...v]) => [k, v.join("=").trim()]));
      if (kv.LoadState === "not-found") return done({ state: "ended", exitCode: null });
      if (["active", "activating", "reloading", "deactivating"].includes(kv.ActiveState)) return done({ state: "running", exitCode: null });
      if (kv.ActiveState === "inactive" || kv.ActiveState === "failed") return done({ state: "ended", exitCode: int(kv.ExecMainStatus) });
      return done({ state: "unknown", exitCode: null });
    });
  });

export interface JobWatcherOptions {
  emit: (job: JobInfo) => boolean;
  log?: (...a: unknown[]) => void;
  dir?: string;
  checkMs?: number;
  probe?: UnitProbe;
  now?: () => number;
}

/** A job is not judged by its service until this long after it started (systemd may not show it yet). */
const GRACE_MS = 30_000;
/** Reported jobs' files are removed after this long. */
const KEEP_MS = 14 * 24 * 3_600_000;

export class JobWatcher {
  readonly dir: string;
  readonly checkMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private readonly probe: UnitProbe;
  private readonly now: () => number;

  constructor(private readonly opts: JobWatcherOptions) {
    this.dir = opts.dir ?? jobsDirOf();
    this.checkMs = opts.checkMs ?? 20_000;
    this.probe = opts.probe ?? systemdProbe;
    this.now = opts.now ?? Date.now;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check(), this.checkMs);
    this.timer.unref?.();
    void this.check();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass: every job that has ended and was not reported yet is sent to the hub; returns what was sent. */
  async check(): Promise<JobInfo[]> {
    if (this.busy || !existsSync(this.dir)) return [];
    this.busy = true;
    const sent: JobInfo[] = [];
    try {
      const now = this.now();
      for (const f of readdirSync(this.dir)) {
        if (!f.endsWith(".json")) continue;
        const base = join(this.dir, f.slice(0, -5));
        if (existsSync(`${base}.reported`)) {
          try {
            if (now - statSync(`${base}.reported`).mtimeMs > KEEP_MS) for (const ext of [".json", ".done", ".reported"]) if (existsSync(base + ext)) unlinkSync(base + ext);
          } catch {
            // best effort
          }
          continue;
        }
        const job = readJob(`${base}.json`);
        if (!job) continue;
        let done = readDone(`${base}.done`);
        if (!done) {
          if (!job.unit || (job.startedAt != null && now - job.startedAt < GRACE_MS)) continue;
          const p = await this.probe(job.unit);
          if (p.state !== "ended") continue;
          // The done file may have landed while systemd was asked.
          done = readDone(`${base}.done`) ?? { exitCode: p.exitCode, endedAt: now };
        }
        const info: JobInfo = {
          id: job.id, name: job.name, threadId: job.threadId, agentKey: job.agentKey, command: job.command.slice(0, 2000), cwd: job.cwd,
          exitCode: done.exitCode, startedAt: job.startedAt, endedAt: done.endedAt ?? now, log: job.log, tail: logTail(job.log),
        };
        if (!this.opts.emit(info)) break; // link down: try again on the next pass
        writeFileSync(`${base}.reported`, String(now));
        this.opts.log?.(`job ${job.name} (${job.id}) ended with exit code ${done.exitCode ?? "?"}; reported to the hub`);
        sent.push(info);
      }
    } catch (err) {
      this.opts.log?.("jobs:", (err as Error).message);
    } finally {
      this.busy = false;
    }
    return sent;
  }
}
