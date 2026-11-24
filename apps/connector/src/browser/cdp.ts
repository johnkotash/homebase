import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { Readable, Writable } from "node:stream";

/**
 * Chrome, started by HomeBase and spoken to over the DevTools protocol on a pipe (docs/BROWSER-AGENT-PLAN.md).
 *
 * The pipe matters: `--remote-debugging-pipe` opens no TCP port at all, so nothing else on this machine
 * can attach to the browser and read its cookies. The profile is a folder of its own; the owner's own
 * Chrome profile is never used.
 */

export type CdpListener = (method: string, params: any, sessionId: string | undefined) => void;

/** One DevTools connection: numbered requests, and events for whoever listens. */
export class Cdp {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; method: string }>();
  private listeners = new Set<CdpListener>();
  closed = false;

  constructor(private write: (text: string) => void) {}

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error("The browser is not running."));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      try {
        this.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (err) {
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  on(fn: CdpListener): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** Resolves with the first event the test accepts, or rejects after `ms`. */
  waitFor(test: (method: string, params: any, sessionId: string | undefined) => boolean, ms: number): Promise<{ method: string; params: any }> {
    return new Promise((resolve, reject) => {
      const off = this.on((method, params, sessionId) => {
        if (!test(method, params, sessionId)) return;
        done();
        resolve({ method, params });
      });
      const timer = setTimeout(() => {
        done();
        reject(new Error("timeout"));
      }, ms);
      const done = () => {
        clearTimeout(timer);
        off();
      };
    });
  }

  /** One message from the browser, as text. */
  feed(text: string) {
    let m: any;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof m.id === "number") {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message ?? "failed"}`));
      else p.resolve(m.result);
      return;
    }
    if (typeof m.method === "string") for (const l of [...this.listeners]) l(m.method, m.params ?? {}, m.sessionId);
  }

  close(reason = "The browser closed.") {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error(reason));
    this.pending.clear();
  }
}

// ---------------------------------------------------------------- finding Chrome

const numeric = (name: string) => Number(/(\d+)$/.exec(name)?.[1] ?? 0);

/** The newest Chromium that Playwright has downloaded on this machine, if any. */
function playwrightChromium(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  const roots = [
    env.PLAYWRIGHT_BROWSERS_PATH,
    platform === "win32" ? join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "ms-playwright")
      : platform === "darwin" ? join(homedir(), "Library", "Caches", "ms-playwright")
      : join(env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "ms-playwright"),
  ].filter((r): r is string => !!r);
  const inside = platform === "win32" ? [["chrome-win64", "chrome.exe"], ["chrome-win", "chrome.exe"]]
    : platform === "darwin" ? [
        ["chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
        ["chrome-mac", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
        ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
      ]
    : [["chrome-linux64", "chrome"], ["chrome-linux", "chrome"]];
  for (const root of roots) {
    let dirs: string[] = [];
    try {
      dirs = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => numeric(b) - numeric(a));
    } catch {
      continue;
    }
    for (const d of dirs) for (const parts of inside) {
      const exe = join(root, d, ...parts);
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}

function onPath(names: string[], env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? "").split(delimiter)) for (const n of names) {
    if (dir && existsSync(join(dir, n))) return join(dir, n);
  }
  return null;
}

/**
 * The browser HomeBase drives. `HB_BROWSER_EXE` wins. On Linux an installed Google Chrome is preferred
 * (the plan for a server node); otherwise the Chromium in Playwright's cache. On Windows and macOS only
 * the Playwright cache is searched, so the owner's everyday Chrome is never started by HomeBase.
 */
export function findChrome(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const explicit = env.HB_BROWSER_EXE?.trim();
  if (explicit) return existsSync(explicit) ? explicit : null;
  if (platform === "linux") {
    const installed = onPath(["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"], env);
    if (installed) return installed;
  }
  return playwrightChromium(env, platform);
}

// ---------------------------------------------------------------- starting it

export interface LaunchOptions {
  exe: string;
  profileDir: string;
  headless?: boolean;
  width?: number;
  height?: number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /**
   * Device pixels per CSS pixel for a window nobody looks at on this machine (on Xvfb, or headless): Chrome's
   * `--force-device-scale-factor`. Chrome's live picture is taken at the window's own pixels whatever the
   * page's emulated pixel ratio, so this is what makes the picture sharp on a phone's dense screen (measured:
   * a 411 × 830 page at ratio 2.625 comes as 1079 × 2179 with 3, as 411 × 830 with 1). A window on a real
   * screen is left at the screen's own scale. 1 (the default) changes nothing.
   */
  scale?: number;
  /** Test seam. */
  spawnFn?: typeof spawn;
}

export interface ChromeProcess {
  cdp: Cdp;
  /** "Chrome/159.0.0.0" */
  version: string;
  /** The browser's own user agent, as it sends it with no override. */
  userAgent: string;
  /** The window's device pixels per CSS pixel (see LaunchOptions.scale): the sharpest a live picture can be. */
  scale: number;
  headless: boolean;
  /** Why the browser is not windowed although a window was asked for (a server without a display). */
  note: string | null;
  exited: Promise<void>;
  close(): Promise<void>;
}

/** The switches every HomeBase browser is started with. No stealth, no sandbox changes, no remote port. */
export function chromeArgs(o: { profileDir: string; headless: boolean; width: number; height: number; scale?: number }): string[] {
  const scale = chromeScale(o.scale);
  return [
    `--user-data-dir=${o.profileDir}`,
    "--remote-debugging-pipe",
    "--no-first-run", "--no-default-browser-check",
    `--window-size=${o.width},${o.height + 90}`,
    ...(scale > 1 ? [`--force-device-scale-factor=${scale}`] : []),
    // The window is watched from the app, not on this machine's screen: keep drawing when it is covered.
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
    "--disable-features=CalculateNativeWinOcclusion,Translate",
    // Passwords are typed by the owner and never kept: no password bubble, no OS keyring prompt.
    "--password-store=basic",
    ...(o.headless ? ["--headless=new"] : []),
    "about:blank",
  ];
}

/** The window's device pixel ratio: 1 to 3, in quarter steps. Anything else is 1. */
export function chromeScale(scale: number | undefined): number {
  if (!scale || !Number.isFinite(scale)) return 1;
  return Math.max(1, Math.min(3, Math.round(scale * 4) / 4));
}

/** First start of a profile: tell Chrome not to offer to save passwords or payment cards in it. */
function seedProfile(profileDir: string) {
  const dir = join(profileDir, "Default");
  const prefs = join(dir, "Preferences");
  if (existsSync(prefs)) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(prefs, JSON.stringify({
    credentials_enable_service: false,
    profile: { password_manager_enabled: false },
    autofill: { credit_card_enabled: false, profile_enabled: false },
  }));
}

/** On a Linux server without a display: a virtual one for a windowed Chrome. Null when Xvfb is not installed. */
async function startXvfb(env: NodeJS.ProcessEnv, width: number, height: number, spawnFn: typeof spawn, scale = 1): Promise<{ display: string; proc: ChildProcess } | null> {
  const xvfb = onPath(["Xvfb"], env);
  if (!xvfb) return null;
  for (let n = 90; n < 110; n++) {
    if (existsSync(`/tmp/.X11-unix/X${n}`)) continue;
    // The screen holds the whole window at its device pixels, with room for the window's frame.
    const proc = spawnFn(xvfb, [`:${n}`, "-screen", "0", `${Math.ceil((width + 40) * scale)}x${Math.ceil((height + 200) * scale)}x24`, "-nolisten", "tcp"], { stdio: "ignore" });
    // Give it a moment to create its socket; a display that is taken makes Xvfb exit at once.
    const until = Date.now() + 3000;
    while (Date.now() < until && proc.exitCode == null && !existsSync(`/tmp/.X11-unix/X${n}`)) await new Promise((r) => setTimeout(r, 60));
    if (proc.exitCode == null && existsSync(`/tmp/.X11-unix/X${n}`)) return { display: `:${n}`, proc };
    proc.kill();
  }
  return null;
}

export async function launchChrome(o: LaunchOptions): Promise<ChromeProcess> {
  const env = { ...(o.env ?? process.env) };
  const platform = o.platform ?? process.platform;
  const spawnFn = o.spawnFn ?? spawn;
  const width = o.width ?? 1280;
  const height = o.height ?? 800;
  let scale = 1;
  let headless = !!o.headless;
  let note: string | null = null;
  let xvfb: ChildProcess | null = null;
  if (!headless && platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    const x = await startXvfb(env, width, height, spawnFn, chromeScale(o.scale));
    if (x) {
      env.DISPLAY = x.display;
      xvfb = x.proc;
      scale = chromeScale(o.scale);
    } else {
      headless = true;
      note = "This machine has no display and Xvfb is not installed, so the browser runs headless. Install Xvfb for a normal windowed browser.";
    }
  }
  if (headless) scale = chromeScale(o.scale);
  mkdirSync(o.profileDir, { recursive: true });
  seedProfile(o.profileDir);

  const proc = spawnFn(o.exe, chromeArgs({ profileDir: o.profileDir, headless, width, height, scale }), {
    env, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], windowsHide: false, detached: false,
  });
  const toChrome = proc.stdio[3] as Writable;
  const fromChrome = proc.stdio[4] as Readable;
  const cdp = new Cdp((text) => void toChrome.write(text + "\0"));
  let buf = "";
  fromChrome.setEncoding("utf8");
  fromChrome.on("data", (chunk: string) => {
    buf += chunk;
    for (let i = buf.indexOf("\0"); i >= 0; i = buf.indexOf("\0")) {
      const msg = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (msg) cdp.feed(msg);
    }
  });
  toChrome.on("error", () => {});
  fromChrome.on("error", () => {});
  const exited = new Promise<void>((resolve) => {
    const gone = () => {
      cdp.close();
      xvfb?.kill();
      resolve();
    };
    proc.once("exit", gone);
    proc.once("error", gone);
  });

  let version = "";
  let userAgent = "";
  try {
    const v = await Promise.race([
      cdp.send<{ product: string; userAgent?: string }>("Browser.getVersion"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Chrome did not answer within 20 seconds.")), 20_000)),
      exited.then(() => Promise.reject(new Error("Chrome exited as it started. Is another browser already using this profile?"))),
    ]);
    version = v.product;
    userAgent = v.userAgent ?? "";
  } catch (err) {
    proc.kill();
    xvfb?.kill();
    throw err;
  }

  return {
    cdp, version, userAgent, scale, headless, note, exited,
    close: async () => {
      if (!cdp.closed) await cdp.send("Browser.close").catch(() => {});
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      if (proc.exitCode == null) proc.kill();
      xvfb?.kill();
      cdp.close();
    },
  };
}
