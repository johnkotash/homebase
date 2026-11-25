import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { TERM_MAX_OUTPUT } from "@homebase/protocol";
import { runsAsRoot } from "./files";

/**
 * Shells on this machine for the owner (issue #3): a real PTY (node-pty, prebuilt, no compiler needed) as the
 * user the connector runs as, driven from xterm.js in the app through the hub.
 *
 * Off when HB_TERMINAL=0, and always off when the connector runs as root. Keystrokes and output pass through and
 * are never logged. When the device drops off (app in the background, a network blip) the shell keeps running for
 * HB_TERMINAL_GRACE_MIN minutes (default 15) and the last output is kept, so the app can take it up again.
 */

const OFF = /^(0|off|false|no)$/i;
/** HB_TERMINAL: the terminal. Default on. */
export const terminalEnabled = (env: NodeJS.ProcessEnv = process.env) => !OFF.test((env.HB_TERMINAL ?? "").trim());
/** HB_TERMINAL_GRACE_MIN: how long a shell nobody is attached to stays alive. Default 15 minutes, 0 to 1440. */
export function terminalGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.HB_TERMINAL_GRACE_MIN);
  return (env.HB_TERMINAL_GRACE_MIN?.trim() && Number.isFinite(n) && n >= 0 ? Math.min(n, 1440) : 15) * 60_000;
}

/** The shell to start: $SHELL (else bash or sh) on Unix; PowerShell, else cmd, on Windows. HB_TERMINAL_SHELL overrides. */
export function defaultShell(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  if (env.HB_TERMINAL_SHELL?.trim()) return { file: env.HB_TERMINAL_SHELL.trim(), args: [] };
  if (platform === "win32") return { file: "powershell.exe", args: ["-NoLogo"] };
  return { file: env.SHELL || "/bin/bash", args: ["-l"] };
}

/** The part of node-pty this service uses. Swappable in tests. */
export interface Pty {
  onData(cb: (d: string) => void): unknown;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown;
  write(d: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
export type SpawnPty = (file: string, args: string[], opts: { cols: number; rows: number; cwd: string; env: Record<string, string> }) => Pty;

let loaded: SpawnPty | null | undefined;
/** node-pty, loaded on first use. Null when it is not installed for this platform. */
export function loadPty(): SpawnPty | null {
  if (loaded !== undefined) return loaded;
  try {
    const mod = createRequire(import.meta.url)("@lydell/node-pty") as { spawn: (f: string, a: string[], o: object) => Pty };
    loaded = (file, args, opts) => mod.spawn(file, args, { name: "xterm-256color", ...opts });
  } catch {
    loaded = null;
  }
  return loaded;
}

type Send = (frame: object) => boolean;
const SCROLLBACK = 200 * 1024;
const MAX_TERMINALS = 16;

interface Shell {
  pty: Pty;
  deviceId: string;
  attached: boolean;
  /** The last output, for a device that comes back. */
  back: string;
  out: string;
  flush: ReturnType<typeof setTimeout> | null;
  grace: ReturnType<typeof setTimeout> | null;
  closing: boolean;
}

export interface TerminalServiceOptions {
  enabled?: boolean;
  home?: string;
  graceMs?: number;
  spawn?: SpawnPty | null;
  root?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  log?: (...a: unknown[]) => void;
}

export class TerminalService {
  private shells = new Map<string, Shell>();
  private send: Send = () => false;
  private home: string;

  constructor(private o: TerminalServiceOptions = {}) {
    this.home = resolve(o.home ?? homedir());
  }

  attach(send: Send) {
    this.send = send;
  }

  private get spawner(): SpawnPty | null {
    return this.o.spawn !== undefined ? this.o.spawn : loadPty();
  }

  /** True when the owner can open a terminal here. */
  get available(): boolean {
    return (this.o.enabled ?? terminalEnabled(this.o.env)) && !(this.o.root ?? runsAsRoot()) && !!this.spawner;
  }

  get count() {
    return this.shells.size;
  }

  private why(): string {
    if (!(this.o.enabled ?? terminalEnabled(this.o.env))) return "The terminal is turned off on this connector (HB_TERMINAL=0).";
    if (this.o.root ?? runsAsRoot()) return "The connector runs as root, so the terminal is off. Run the connector as a normal user.";
    return "The terminal needs @lydell/node-pty, which is not installed for this platform. Run npm ci on the connector's machine.";
  }

  /** A frame from the hub. */
  onFrame(f: { t: string; termId?: unknown; [k: string]: unknown }) {
    const termId = typeof f.termId === "string" ? f.termId : "";
    if (!termId) return;
    const cols = clamp(f.cols, 2, 1000, 80);
    const rows = clamp(f.rows, 1, 500, 24);
    switch (f.t) {
      case "pty.open": return this.open(termId, typeof f.cwd === "string" ? f.cwd : null, cols, rows, String(f.deviceId ?? ""));
      case "pty.attach": return this.reattach(termId, cols, rows);
      case "pty.input": return void (typeof f.data === "string" && this.shells.get(termId)?.pty.write(f.data));
      case "pty.resize": return this.resize(termId, cols, rows);
      case "pty.close": return this.close(termId);
      case "pty.detach": return this.detach(termId);
    }
  }

  private fail(termId: string, code: string, error: string) {
    this.send({ t: "pty.opened", termId, ok: false, code, error });
  }

  open(termId: string, cwdIn: string | null, cols: number, rows: number, deviceId: string) {
    if (this.shells.has(termId)) return;
    if (!this.available) return this.fail(termId, "disabled", this.why());
    if (this.shells.size >= MAX_TERMINALS) return this.fail(termId, "too_many", "Too many terminals are open on this connector.");
    let cwd = this.home;
    if (cwdIn) {
      const want = cwdIn.startsWith("~") ? resolve(this.home, cwdIn.slice(1).replace(/^[\\/]/, "")) : cwdIn;
      try {
        if (!isAbsolute(want) || !statSync(want).isDirectory()) throw new Error();
        cwd = resolve(want);
      } catch {
        return this.fail(termId, "not_found", `There is no folder ${cwdIn} on this machine.`);
      }
    }
    const env = cleanEnv(this.o.env ?? process.env);
    const { file, args } = defaultShell(this.o.env ?? process.env, this.o.platform);
    let pty: Pty;
    try {
      pty = this.spawner!(file, args, { cols, rows, cwd, env });
    } catch (e) {
      return this.fail(termId, "spawn_failed", `${file} could not start: ${(e as Error).message}`);
    }
    const sh: Shell = { pty, deviceId, attached: true, back: "", out: "", flush: null, grace: null, closing: false };
    this.shells.set(termId, sh);
    pty.onData((d) => this.output(termId, sh, d));
    pty.onExit(({ exitCode }) => {
      if (this.shells.get(termId) !== sh) return;
      this.drain(termId, sh);
      this.shells.delete(termId);
      if (sh.grace) clearTimeout(sh.grace);
      this.send({ t: "pty.exit", termId, code: Number.isInteger(exitCode) ? exitCode : null, reason: sh.closing ? "closed" : "exit" });
      this.o.log?.(`terminal ${termId} ended (${sh.closing ? "closed" : `exit ${exitCode}`})`);
    });
    this.send({ t: "pty.opened", termId, ok: true, shell: file, cwd });
    this.o.log?.(`terminal ${termId} opened: ${file} in ${cwd}`);
  }

  private output(termId: string, sh: Shell, d: string) {
    sh.back = (sh.back + d).slice(-SCROLLBACK);
    if (!sh.attached) return;
    sh.out += d;
    if (sh.out.length >= 32 * 1024) return this.drain(termId, sh);
    // A few milliseconds of output go out as one frame.
    if (!sh.flush) sh.flush = setTimeout(() => this.drain(termId, sh), 8);
  }

  private drain(termId: string, sh: Shell) {
    if (sh.flush) clearTimeout(sh.flush);
    sh.flush = null;
    const data = sh.out;
    sh.out = "";
    if (!data || !sh.attached) return;
    for (let i = 0; i < data.length; i += TERM_MAX_OUTPUT) this.send({ t: "pty.output", termId, data: data.slice(i, i + TERM_MAX_OUTPUT) });
  }

  private reattach(termId: string, cols: number, rows: number) {
    const sh = this.shells.get(termId);
    if (!sh) return this.fail(termId, "not_found", "That terminal has ended.");
    if (sh.grace) clearTimeout(sh.grace);
    sh.grace = null;
    sh.attached = true;
    sh.out = "";
    this.send({ t: "pty.opened", termId, ok: true, reattached: true });
    // What the app missed, from the kept output: the app clears its screen first.
    if (sh.back) for (let i = 0; i < sh.back.length; i += TERM_MAX_OUTPUT) this.send({ t: "pty.output", termId, data: sh.back.slice(i, i + TERM_MAX_OUTPUT) });
    this.resize(termId, cols, rows);
  }

  private resize(termId: string, cols: number, rows: number) {
    try {
      this.shells.get(termId)?.pty.resize(cols, rows);
    } catch {
      // the shell is on its way out
    }
  }

  detach(termId: string) {
    const sh = this.shells.get(termId);
    if (!sh) return;
    sh.attached = false;
    sh.out = "";
    if (sh.grace) clearTimeout(sh.grace);
    const ms = this.o.graceMs ?? terminalGraceMs(this.o.env);
    sh.grace = setTimeout(() => this.close(termId), ms);
    (sh.grace as any).unref?.();
  }

  close(termId: string) {
    const sh = this.shells.get(termId);
    if (!sh) return;
    sh.closing = true;
    try {
      sh.pty.kill();
    } catch {
      // already gone
    }
  }

  /** Every shell ends with the connector, or when the hub link is lost for good. */
  closeAll() {
    for (const id of [...this.shells.keys()]) this.close(id);
  }
}

const clamp = (v: unknown, min: number, max: number, dflt: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : dflt);

/** The shell's environment: the connector's own, without HomeBase's pairing code and with a colour terminal. */
export function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string" && k !== "HB_PAIR_CODE") out[k] = v;
  out.TERM = "xterm-256color";
  out.COLORTERM = "truecolor";
  out.HOMEBASE_TERMINAL = "1";
  return out;
}
