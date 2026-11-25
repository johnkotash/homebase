import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { jobEnv } from "../src/adapters/claude-code";
import { JobWatcher, logTail, type JobInfo, type UnitProbe } from "../src/jobs";

const NOW = 1_800_000_000_000;

function setup(probe: UnitProbe = async () => ({ state: "running", exitCode: null })) {
  const dir = mkdtempSync(join(tmpdir(), "hb-jobs-"));
  const sent: JobInfo[] = [];
  let up = true;
  const w = new JobWatcher({ dir, probe, now: () => NOW, emit: (j) => (up ? (sent.push(j), true) : false) });
  const job = (id: string, over: Record<string, unknown> = {}) => {
    const log = join(dir, `${id}.log`);
    writeFileSync(log, "step 1\nstep 2\n\u001b[32mall done\u001b[0m\n");
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, name: id.split("-")[0], unit: `hbjob-${id}.service`, log, cwd: "/w", command: "bash x.sh", threadId: "thr_1", agentKey: "claude", startedAt: NOW / 1000 - 600, ...over }));
  };
  const done = (id: string, exitCode: number) => writeFileSync(join(dir, `${id}.done`), JSON.stringify({ exitCode, endedAt: NOW / 1000 - 5 }));
  return { dir, w, sent, job, done, setUp: (v: boolean) => (up = v) };
}

describe("background job watcher", () => {
  it("reports a finished job once, with its session, exit code and the end of its log", async () => {
    const s = setup();
    s.job("fix1-a");
    expect(await s.w.check()).toHaveLength(0); // still running
    s.done("fix1-a", 0);
    const [r] = await s.w.check();
    expect(r).toMatchObject({ id: "fix1-a", name: "fix1", threadId: "thr_1", exitCode: 0, startedAt: NOW - 600_000, endedAt: NOW - 5000 });
    expect(r.tail).toBe("step 1\nstep 2\nall done");
    expect(existsSync(join(s.dir, "fix1-a.reported"))).toBe(true);
    expect(await s.w.check()).toHaveLength(0);
    expect(s.sent).toHaveLength(1);
  });

  it("a service that stopped without a done file (adopted, killed) is reported from systemd's state", async () => {
    const s = setup(async () => ({ state: "ended", exitCode: 2 }));
    s.job("adopt-a");
    const [r] = await s.w.check();
    expect(r).toMatchObject({ exitCode: 2, endedAt: NOW });
  });

  it("does not judge a job that just started, and retries when the hub link is down", async () => {
    const s = setup(async () => ({ state: "ended", exitCode: null }));
    s.job("new-a", { startedAt: NOW / 1000 - 5 });
    expect(await s.w.check()).toHaveLength(0);
    s.job("old-a");
    s.setUp(false);
    expect(await s.w.check()).toHaveLength(0);
    expect(existsSync(join(s.dir, "old-a.reported"))).toBe(false);
    s.setUp(true);
    expect((await s.w.check()).map((j) => j.id)).toEqual(["old-a"]);
  });

  it("ignores records it cannot trust", async () => {
    const s = setup(async () => ({ state: "ended", exitCode: 0 }));
    writeFileSync(join(s.dir, "bad.json"), JSON.stringify({ id: "../../etc", name: "x" }));
    writeFileSync(join(s.dir, "half.json"), "{\"id\": ");
    expect(await s.w.check()).toHaveLength(0);
  });

  it("log tails are bounded", () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-tail-"));
    const f = join(dir, "l.log");
    writeFileSync(f, Array.from({ length: 500 }, (_, i) => `line ${i} ${"x".repeat(100)}`).join("\n"));
    expect(logTail(f).length).toBeLessThanOrEqual(4000);
    expect(logTail(f)).toContain("line 499");
    expect(logTail(null)).toBe("");
  });

  it("agent runs get the session id for hbjob and no CLI background tasks", () => {
    const env = jobEnv({ HOMEBASE_DATA_DIR: "/data" }, { id: "run_1", threadId: "thr_9", agentKey: "claude" });
    expect(env).toMatchObject({ HOMEBASE_THREAD_ID: "thr_9", HOMEBASE_RUN_ID: "run_1", HOMEBASE_AGENT_KEY: "claude", CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" });
    expect(env.HOMEBASE_JOBS_DIR.split("\\").join("/")).toMatch(/\/data\/jobs$/);
  });
});
