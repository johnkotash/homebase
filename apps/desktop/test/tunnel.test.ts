import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-ignore plain ESM, shared with the Electron main process
import { DEFAULT_CONFIG } from "../connection.mjs";
// @ts-ignore plain ESM, shared with the Electron main process
import { BACKOFF_MS, ConnectionManager, killStaleTunnel } from "../tunnel.mjs";

/** A stand-in for ssh.exe: it "forwards" its port while alive, and exits when told (or killed). */
class FakeSsh extends EventEmitter {
  static nextPid = 1000;
  pid = FakeSsh.nextPid++;
  exitCode: number | null = null;
  killed = false;
  stderr = new EventEmitter();
  constructor(public cmd: string, public args: string[]) {
    super();
  }
  get port() {
    const l = this.args[this.args.indexOf("-L") + 1];
    return Number(l.split(":")[1]);
  }
  kill() {
    this.killed = true;
    this.die(null);
  }
  /** ssh prints something and exits. */
  fail(stderr: string, code = 255) {
    this.stderr.emit("data", Buffer.from(stderr));
    this.die(code);
  }
  private die(code: number | null) {
    if (this.exitCode != null) return;
    this.exitCode = code ?? 1;
    queueMicrotask(() => this.emit("exit", code));
  }
}

function harness(opts: { port?: number; hubUp?: boolean; spawnThrows?: boolean; missing?: boolean } = {}) {
  const spawned: FakeSsh[] = [];
  const env = { hubUp: opts.hubUp ?? true, directUp: false };
  const pids: Array<number | null> = [];
  const states: string[] = [];
  const live = () => spawned.filter((c) => c.exitCode == null);
  const m = new ConnectionManager({
    sshPath: "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
    spawn: (cmd: string, args: string[]) => {
      const c = new FakeSsh(cmd, args);
      spawned.push(c);
      if (opts.missing) queueMicrotask(() => c.emit("error", Object.assign(new Error("spawn ssh ENOENT"), { code: "ENOENT" })));
      return c;
    },
    // The hub answers through a live tunnel's port (or at the direct address when it is up).
    probe: async (url: string) => {
      if (url.startsWith("http://100.")) return env.directUp;
      const port = Number(new URL(url).port);
      return env.hubUp && live().some((c) => c.port === port);
    },
    findPort: async (preferred: number) => opts.port ?? preferred,
    onPid: (pid: number | null) => pids.push(pid),
    readyTimeoutMs: 5000, probeIntervalMs: 200, slowProbeMs: 1000, healthIntervalMs: 10_000, healthFailures: 3,
  });
  m.onChange((s: any) => states.push(s.phase));
  return { m, spawned, env, pids, states, live };
}

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe("SSH tunnel manager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-24T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("starts ssh with the tunnel command and reports the hub address once /v1/health answers", async () => {
    const h = harness();
    h.m.start({ ...DEFAULT_CONFIG });
    await tick(0);
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0].cmd).toMatch(/ssh\.exe$/);
    expect(h.spawned[0].args).toContain("127.0.0.1:18787:127.0.0.1:8787");
    expect(h.spawned[0].args).toContain("BatchMode=yes");
    expect(h.spawned[0].args.at(-1)).toBe("homebase-server");
    expect(h.m.getState()).toMatchObject({ phase: "connected", url: "http://127.0.0.1:18787", localPort: 18787, mode: "ssh" });
    expect(h.pids).toEqual([h.spawned[0].pid]);
    expect(h.states.slice(0, 2)).toEqual(["connecting", "connected"]);
  });

  it("uses another local port when the preferred one is taken", async () => {
    const h = harness({ port: 40123 });
    h.m.start({ ...DEFAULT_CONFIG });
    await tick(0);
    expect(h.m.getState()).toMatchObject({ phase: "connected", url: "http://127.0.0.1:40123" });
  });

  it("a refused key stops: no retry loop, no password prompt; Retry tries again", async () => {
    const h = harness({ hubUp: false });
    h.m.start({ ...DEFAULT_CONFIG });
    await tick(0);
    h.spawned[0].fail("user@192.168.1.20: Permission denied (publickey).");
    await tick(0);
    expect(h.m.getState()).toMatchObject({ phase: "error", error: { code: "auth", retry: false } });
    await tick(120_000);
    expect(h.spawned).toHaveLength(1);
    h.env.hubUp = true;
    h.m.retry();
    await tick(0);
    expect(h.spawned).toHaveLength(2);
    expect(h.m.getState().phase).toBe("connected");
  });

  it("no ssh on the PC: an error that says so, and nothing left running", async () => {
    const h = harness({ missing: true });
    h.m.start({ ...DEFAULT_CONFIG });
    await tick(0);
    expect(h.m.getState()).toMatchObject({ phase: "error", error: { code: "ssh_missing" } });
    await tick(60_000);
    expect(h.spawned).toHaveLength(1);
  });

  it("an unreachable host is retried with a growing pause", async () => {
    const h = harness();
    const failNext = () => h.live().forEach((c) => c.fail("ssh: connect to host 192.168.1.20 port 22: Connection timed out"));
    h.env.hubUp = false; // nothing answers
    h.m.start({ ...DEFAULT_CONFIG });
    await tick(0);
    failNext();
    await tick(0);
    expect(h.m.getState()).toMatchObject({ phase: "retrying", error: { code: "unreachable" } });
    expect(h.m.getState().retryAt - Date.now()).toBe(BACKOFF_MS[0]);
    const at: number[] = [];
    for (let i = 0; i < 4; i++) {
      const before = h.spawned.length;
      const t0 = Date.now();
      while (h.spawned.length === before) await tick(100);
      at.push(Date.now() - t0);
      failNext();
      await tick(0);
    }
    // 1 s, 2 s, 5 s, 10 s (to the nearest tick)
    expect(at.map((ms) => Math.round(ms / 1000))).toEqual([1, 2, 5, 10]);
  });

  it("reconnects after a drop, and the pause starts small again after a good connection", async () => {
    const h = harness();
    h.m.start({ ...DEFAULT_CONFIG });
    await tick(0);
    expect(h.m.getState().phase).toBe("connected");
    h.spawned[0].fail("Timeout, server 192.168.1.20 not responding.");
    await tick(0);
    expect(h.m.getState()).toMatchObject({ phase: "retrying", error: { code: "unreachable" } });
    await tick(BACKOFF_MS[0]);
    expect(h.spawned).toHaveLength(2);
    expect(h.m.getState().phase).toBe("connected");
    h.spawned[1].fail("Connection reset");
    await tick(0);
    expect(h.m.getState().retryAt - Date.now()).toBe(BACKOFF_MS[0]);
  });

  it("ssh up but the hub silent: says so, keeps the tunnel, connects when the hub comes back", async () => {
    const h = harness({ hubUp: false });
    h.m.start({ ...DEFAULT_CONFIG });
    await tick(0);
    expect(h.m.getState().phase).toBe("connecting");
    await tick(5200);
    expect(h.m.getState()).toMatchObject({ phase: "connecting", error: { code: "hub_unreachable" } });
    expect(h.m.getState().error.message).toMatch(/systemctl --user status homebase-hub/);
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0].killed).toBe(false);
    h.env.hubUp = true;
    await tick(1000);
    expect(h.m.getState()).toMatchObject({ phase: "connected", error: undefined });
  });

  it("while connected, a hub that stops answering gets a fresh tunnel", async () => {
    const h = harness();
    h.m.start({ ...DEFAULT_CONFIG });
    await tick(0);
    h.env.hubUp = false;
    await tick(30_000); // three missed checks
    expect(h.spawned[0].killed).toBe(true);
    expect(h.m.getState()).toMatchObject({ phase: "retrying", error: { code: "hub_unreachable" } });
    h.env.hubUp = true;
    await tick(BACKOFF_MS[0]);
    expect(h.spawned).toHaveLength(2);
    expect(h.m.getState().phase).toBe("connected");
  });

  it("stop() kills ssh, clears the pid and never reconnects (no orphaned ssh.exe)", async () => {
    const h = harness();
    h.m.start({ ...DEFAULT_CONFIG });
    await tick(0);
    const done = h.m.stop();
    await tick(0);
    await done;
    expect(h.spawned[0].killed).toBe(true);
    expect(h.live()).toHaveLength(0);
    expect(h.pids.at(-1)).toBeNull();
    expect(h.m.getState().phase).toBe("stopped");
    await tick(120_000);
    expect(h.spawned).toHaveLength(1);
  });

  it("a new setting replaces the running tunnel; the old ssh's exit is ignored", async () => {
    const h = harness();
    h.m.start({ ...DEFAULT_CONFIG });
    await tick(0);
    h.m.start({ ...DEFAULT_CONFIG, sshHost: "user@192.168.1.20" });
    await tick(0);
    expect(h.spawned[0].killed).toBe(true);
    expect(h.spawned[1].args.at(-1)).toBe("user@192.168.1.20");
    expect(h.live()).toHaveLength(1);
    expect(h.m.getState().phase).toBe("connected");
  });

  it("direct mode: no ssh; retries until the address answers", async () => {
    const h = harness();
    h.m.start({ ...DEFAULT_CONFIG, mode: "direct", directUrl: "http://100.101.102.103:8787" });
    await tick(0);
    expect(h.spawned).toHaveLength(0);
    expect(h.m.getState()).toMatchObject({ phase: "retrying", error: { code: "unreachable" } });
    expect(h.m.getState().error.message).toMatch(/Tailscale/);
    h.env.directUp = true;
    await tick(BACKOFF_MS[0]);
    expect(h.m.getState()).toMatchObject({ phase: "connected", url: "http://100.101.102.103:8787", mode: "direct" });
  });
});

describe("stale tunnel sweep", () => {
  it("ends a leftover ssh from a crashed run, and only an ssh", () => {
    const killed: number[] = [];
    let cleared = 0;
    const io = (pid: number | null, ssh: boolean) => ({ readPid: () => pid, isSsh: () => ssh, kill: (p: number) => killed.push(p), clear: () => cleared++ });
    expect(killStaleTunnel(io(4242, true))).toBe(true);
    expect(killStaleTunnel(io(4343, false))).toBe(false); // the pid was reused by something else
    expect(killStaleTunnel(io(null, true))).toBe(false);
    expect(killed).toEqual([4242]);
    expect(cleared).toBe(2);
  });
});
