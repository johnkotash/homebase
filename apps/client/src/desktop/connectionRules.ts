/**
 * The desktop app's hub connection, as the page sees it (the shell runs it: apps/desktop/tunnel.mjs).
 * Pure rules only, so they are tested without React Native (test/desktop-connection.test.ts).
 */

export type ConnMode = "ssh" | "direct";

export interface ConnConfig {
  mode: ConnMode;
  sshHost: string;
  remotePort: number;
  localPort: number;
  directUrl: string;
}

export interface ConnError { code: string; message: string; detail?: string; retry?: boolean }

export interface ConnState {
  phase: "idle" | "connecting" | "connected" | "retrying" | "error" | "stopped";
  mode?: ConnMode;
  target?: string;
  url?: string;
  localPort?: number;
  error?: ConnError;
  attempt: number;
  retryAt?: number;
  since: number;
}

export interface ConnSnapshot { config: ConnConfig; configured: boolean; state: ConnState }

export type Tone = "ok" | "warn" | "danger" | "muted";

/** The hub address the page should use now, or null while there is none. */
export function connectedHubUrl(state: ConnState | null | undefined): string | null {
  return state?.phase === "connected" && state.url ? state.url : null;
}

/** "homebase-server over SSH" / "http://my-server:8787". */
export function targetLabel(config: ConnConfig): string {
  return config.mode === "direct" ? config.directUrl || "no address" : `${config.sshHost} over SSH`;
}

/**
 * One line for where the connection stands, and a second with what to do about it.
 * `now` is for the "next try in Ns" countdown.
 */
export function connectionHeadline(snap: ConnSnapshot, now: number): { title: string; body?: string; tone: Tone; busy: boolean } {
  const { state, config } = snap;
  const where = targetLabel(config);
  switch (state.phase) {
    case "connected":
      return {
        tone: "ok", busy: false,
        title: config.mode === "ssh" ? `Connected to ${config.sshHost} over SSH` : `Connected to ${config.directUrl}`,
        body: config.mode === "ssh" && state.localPort ? `Tunnel on this PC: 127.0.0.1:${state.localPort} → ${config.sshHost}:${config.remotePort}` : undefined,
      };
    case "connecting":
      if (state.error?.code === "hub_unreachable") return { tone: "warn", busy: true, title: "The hub is not answering", body: state.error.message };
      return { tone: "muted", busy: true, title: config.mode === "ssh" ? `Opening the SSH tunnel to ${config.sshHost}…` : `Connecting to ${config.directUrl}…`, body: state.error?.message };
    case "retrying": {
      const secs = state.retryAt ? Math.max(0, Math.ceil((state.retryAt - now) / 1000)) : 0;
      return { tone: "warn", busy: false, title: secs ? `Can't connect · trying again in ${secs}s` : "Can't connect · trying again", body: state.error?.message };
    }
    case "error":
      return { tone: "danger", busy: false, title: errorTitle(state.error?.code), body: state.error?.message };
    case "stopped":
      return { tone: "muted", busy: false, title: "Disconnected" };
    default:
      return { tone: "muted", busy: false, title: snap.configured ? `Connecting to ${where}…` : "Not set up yet" };
  }
}

function errorTitle(code: string | undefined): string {
  switch (code) {
    case "ssh_missing": return "SSH is not installed on this PC";
    case "auth": return "SSH key not accepted";
    case "host_key": return "Host key not trusted yet";
    default: return "Can't connect";
  }
}

/** Checks the form before it goes to the shell (which checks again). Field → message. */
export function formErrors(form: { mode: ConnMode; sshHost: string; directUrl: string; remotePort: string }): Record<string, string> {
  const e: Record<string, string> = {};
  if (form.mode === "ssh") {
    const h = form.sshHost.trim();
    if (!h) e.sshHost = "Enter an SSH host from your ~/.ssh/config (like homebase-server) or user@host.";
    else if (!/^(?:[A-Za-z0-9._][A-Za-z0-9._-]*@)?[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(h)) e.sshHost = "Use a host alias, a host name or user@host: letters, digits, dots, dashes, no spaces.";
    const p = Number(form.remotePort);
    if (!Number.isInteger(p) || p < 1 || p > 65535) e.remotePort = "A port number from 1 to 65535.";
  } else {
    const u = form.directUrl.trim();
    if (!/^https?:\/\/[^\s/]+\/?$/i.test(u)) e.directUrl = "The hub's address with http:// or https:// and no path, like http://my-server:8787.";
  }
  return e;
}

/**
 * The hub address a browser page starts with on the pair screen. A production web build that the hub itself
 * serves (http://my-server:8787/) pairs with the address it was opened from; the dev server and the
 * phone use the address baked in at build time.
 */
export function defaultHubUrl(o: { platform: string; production: boolean; location?: { protocol: string; origin: string } | null; envUrl?: string | null }): string {
  if (o.platform === "web" && o.production && o.location && /^https?:$/.test(o.location.protocol)) return o.location.origin;
  const env = o.envUrl?.trim();
  if (env) return env;
  return o.platform === "android" ? "http://10.0.2.2:8787" : "http://localhost:8787";
}
