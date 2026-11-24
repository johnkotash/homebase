// Keeps the desktop app connected to its hub: runs the SSH tunnel (or checks a direct address), tells the
// window where the hub is, and reconnects with a growing pause when the link drops. No Electron in here, so
// it is tested with a fake ssh (apps/desktop/test/tunnel.test.ts); main.mjs hands in the real spawn and fetch.
//
// States (state.phase):
//   idle        nothing started yet
//   connecting  starting ssh / waiting for the hub to answer through it (or at the direct address)
//   connected   the hub answers at state.url
//   retrying    it failed or dropped; the next try is at state.retryAt (state.error says why)
//   error       stopped: trying again cannot help until the user changes something (state.error)
//   stopped     the app is closing
import { classifySshFailure, describeTarget, sshArgs } from "./connection.mjs";

export const BACKOFF_MS = [1000, 2000, 5000, 10000, 20000, 30000];

/**
 * @typedef {{ code: string, message: string, detail?: string, retry?: boolean }} ConnError
 * @typedef {{ phase: "idle"|"connecting"|"connected"|"retrying"|"error"|"stopped", mode?: string, target?: string,
 *   url?: string, localPort?: number, error?: ConnError, attempt: number, retryAt?: number, since: number }} ConnState
 */

export class ConnectionManager {
  /**
   * @param {{
   *   spawn: (cmd: string, args: string[]) => any,   // child_process.spawn-like: .pid, .stderr (on "data"), on("error"|"exit"), kill()
   *   probe: (url: string) => Promise<boolean>,        // true when GET <url>/v1/health answers ok
   *   findPort: (preferred: number) => Promise<number>,
   *   sshPath?: string,
   *   onPid?: (pid: number | null) => void,            // the running ssh (for the stale-tunnel sweep at the next start)
   *   log?: (...a: any[]) => void,
   *   now?: () => number,
   *   timers?: { setTimeout: Function, clearTimeout: Function },
   *   backoff?: number[],
   *   readyTimeoutMs?: number, probeIntervalMs?: number, slowProbeMs?: number, healthIntervalMs?: number, healthFailures?: number,
   * }} deps
   */
  constructor(deps) {
    this.d = {
      sshPath: "ssh", onPid: () => {}, log: () => {}, now: () => Date.now(), timers: { setTimeout, clearTimeout },
      backoff: BACKOFF_MS, readyTimeoutMs: 20_000, probeIntervalMs: 500, slowProbeMs: 5000, healthIntervalMs: 15_000, healthFailures: 3,
      ...deps,
    };
    this.config = null;
    this.gen = 0;
    this.child = null;
    this.timer = null;
    this.failures = 0; // since the last good connection; picks the pause before the next try
    this.listeners = new Set();
    /** @type {ConnState} */
    this.state = { phase: "idle", attempt: 0, since: this.d.now() };
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getState() {
    return this.state;
  }

  /** (Re)starts with this setting. Any running tunnel is stopped first. */
  start(config) {
    this.config = config;
    this.failures = 0;
    this._teardown();
    void this._connect();
  }

  /** Try again now (the Retry button; also after a fatal error). */
  retry() {
    if (!this.config || this.state.phase === "stopped") return;
    this.failures = 0;
    this._teardown();
    void this._connect();
  }

  /** Stops for good (the app is quitting). Resolves when ssh has exited, or after a short wait. */
  stop() {
    const child = this.child;
    this._teardown();
    this._set({ phase: "stopped", url: undefined, error: undefined, retryAt: undefined });
    if (!child || child.exitCode != null) return Promise.resolve();
    return new Promise((resolve) => {
      const t = this.d.timers.setTimeout(resolve, 2000);
      child.once?.("exit", () => {
        this.d.timers.clearTimeout(t);
        resolve();
      });
    });
  }

  // ---------------------------------------------------------------- internals

  _set(patch) {
    const phaseChanged = patch.phase && patch.phase !== this.state.phase;
    this.state = { ...this.state, ...patch, ...(phaseChanged ? { since: this.d.now() } : {}) };
    for (const fn of this.listeners) {
      try {
        fn(this.state);
      } catch (err) {
        this.d.log("[connection] listener failed", err);
      }
    }
  }

  /** Forgets the running attempt: its ssh is killed and its timers and callbacks no longer count. */
  _teardown() {
    this.gen++;
    if (this.timer) this.d.timers.clearTimeout(this.timer);
    this.timer = null;
    const child = this.child;
    this.child = null;
    if (child && child.exitCode == null) {
      try {
        child.kill();
      } catch {}
    }
    if (child) this.d.onPid(null);
  }

  _later(ms, fn) {
    const gen = this.gen;
    if (this.timer) this.d.timers.clearTimeout(this.timer);
    this.timer = this.d.timers.setTimeout(() => {
      this.timer = null;
      if (gen === this.gen) fn();
    }, ms);
  }

  async _connect() {
    const cfg = this.config;
    const gen = this.gen;
    const attempt = this.state.attempt + 1;
    this._set({ phase: "connecting", mode: cfg.mode, target: describeTarget(cfg), url: undefined, retryAt: undefined, attempt, error: this.state.phase === "error" ? undefined : this.state.error });
    if (cfg.mode === "direct") return this._waitForHub(gen, cfg.directUrl, null);

    let port;
    try {
      port = await this.d.findPort(cfg.localPort);
    } catch (err) {
      if (gen !== this.gen) return;
      return this._fail({ code: "port_in_use", retry: true, message: `No free local port for the tunnel: ${err.message}` });
    }
    if (gen !== this.gen) return;

    let child;
    let stderr = "";
    try {
      child = this.d.spawn(this.d.sshPath, sshArgs(cfg, port));
    } catch (err) {
      return this._fail(classifySshFailure({ spawnError: err, host: cfg.sshHost }));
    }
    this.child = child;
    if (child.pid) this.d.onPid(child.pid);
    this.d.log(`[connection] ssh ${cfg.sshHost}: 127.0.0.1:${port} -> 127.0.0.1:${cfg.remotePort} (pid ${child.pid ?? "?"})`);
    child.stderr?.on("data", (d) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    let spawnError = null;
    child.on("error", (err) => {
      spawnError = err;
      // Node reports a missing binary with "error" and then (sometimes) "exit"; handle it once.
      if (gen === this.gen && this.child === child) {
        this.child = null;
        this.d.onPid(null);
        this._fail(classifySshFailure({ spawnError: err, host: cfg.sshHost }));
      }
    });
    child.on("exit", (code) => {
      if (gen !== this.gen || this.child !== child) return; // a tunnel we already let go of
      this.child = null;
      this.d.onPid(null);
      this.d.log(`[connection] ssh exited (${code}): ${stderr.trim().split(/\r?\n/).slice(-2).join(" | ")}`);
      this._fail(classifySshFailure({ stderr, exitCode: code, spawnError, host: cfg.sshHost }));
    });
    this._waitForHub(gen, `http://127.0.0.1:${port}`, port);
  }

  /** Polls the hub until it answers, then watches it. */
  _waitForHub(gen, url, port) {
    const started = this.d.now();
    let slow = false;
    const check = async () => {
      let ok = false;
      try {
        ok = await this.d.probe(url);
      } catch {}
      if (gen !== this.gen) return;
      if (ok) {
        this.failures = 0;
        this._set({ phase: "connected", url, localPort: port ?? undefined, error: undefined, retryAt: undefined });
        return this._watch(gen, url, port);
      }
      if (this.config.mode === "direct") {
        return this._fail({
          code: "unreachable", retry: true,
          message: `Can't reach the hub at ${url}. Check that this PC is on Tailscale (or the network the hub is on) and that the hub is running.`,
        });
      }
      // ssh is up (or still starting) but the hub does not answer through it.
      if (!slow && this.d.now() - started >= this.d.readyTimeoutMs) {
        slow = true;
        this._set({
          phase: "connecting",
          error: {
            code: "hub_unreachable", retry: true,
            message: `SSH to ${this.config.sshHost} is up, but the hub is not answering on its port ${this.config.remotePort}. Check it with: ssh ${this.config.sshHost} systemctl --user status homebase-hub`,
          },
        });
      }
      this._later(slow ? this.d.slowProbeMs : this.d.probeIntervalMs, check);
    };
    void check();
  }

  /** While connected: a health check now and then. A hub that stops answering is reported; a stuck tunnel is restarted. */
  _watch(gen, url, port) {
    let misses = 0;
    const tick = async () => {
      let ok = false;
      try {
        ok = await this.d.probe(url);
      } catch {}
      if (gen !== this.gen) return;
      if (ok) {
        misses = 0;
        if (this.state.phase !== "connected") this._set({ phase: "connected", url, localPort: port ?? undefined, error: undefined });
      } else if (++misses >= this.d.healthFailures) {
        const message = this.config.mode === "direct"
          ? `The hub at ${url} stopped answering.`
          : `The hub stopped answering through the SSH tunnel to ${this.config.sshHost}; reconnecting.`;
        this._teardown();
        return this._fail({ code: "hub_unreachable", retry: true, message });
      }
      this._later(this.d.healthIntervalMs, tick);
    };
    this._later(this.d.healthIntervalMs, tick);
  }

  /** One attempt failed: try again after a pause, or stop when only the user can fix it. */
  _fail(error) {
    if (this.state.phase === "stopped") return;
    // Whatever is left of this attempt goes (an ssh that is still up while its hub never answered, say).
    this._teardown();
    if (error.retry === false) {
      this._set({ phase: "error", url: undefined, error, retryAt: undefined });
      return;
    }
    const pause = this.d.backoff[Math.min(this.failures, this.d.backoff.length - 1)];
    this.failures++;
    this._set({ phase: "retrying", url: undefined, error, retryAt: this.d.now() + pause });
    this._later(pause, () => void this._connect());
  }
}

/**
 * At start: an ssh left over from a run that crashed (its pid is in the file) is ended, so no tunnel is ever
 * orphaned for long. Only a process that is still ssh is touched.
 * @param {{ readPid: () => number | null, isSsh: (pid: number) => boolean, kill: (pid: number) => void, clear: () => void }} io
 * @returns {boolean} true when one was ended
 */
export function killStaleTunnel(io) {
  let pid = null;
  try {
    pid = io.readPid();
  } catch {}
  if (!pid) return false;
  let killed = false;
  try {
    if (io.isSsh(pid)) {
      io.kill(pid);
      killed = true;
    }
  } catch {}
  try {
    io.clear();
  } catch {}
  return killed;
}
