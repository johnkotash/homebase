// How the desktop app reaches the hub: the parts that need no Electron, so they can be tested
// (apps/desktop/test/connection.test.ts). tunnel.mjs runs the connection, main.mjs wires it to the window.
//
// Two modes:
//   ssh     the PC is not on the tailnet; HomeBase runs the system `ssh` with a local port forward to the
//           hub's loopback address on the server (the user's own ~/.ssh/config and keys, never a password).
//   direct  the PC can reach the hub itself (Tailscale, or a `tailscale serve` https address).

import fs from "node:fs";
import net from "node:net";
import { join } from "node:path";

export const DEFAULT_REMOTE_PORT = 8787;
/** The local end of the tunnel, when it is free. Kept away from the ports the dev setup uses (8081-8089, 8787-8799). */
export const DEFAULT_LOCAL_PORT = 18787;

export const DEFAULT_CONFIG = Object.freeze({
  mode: "ssh",
  sshHost: "homebase-server",
  remotePort: DEFAULT_REMOTE_PORT,
  localPort: DEFAULT_LOCAL_PORT,
  directUrl: "",
});

/** An ssh destination as `ssh` takes it: a ~/.ssh/config alias, a host name or `user@host`. Never starts with "-". */
const SSH_HOST = /^(?:[A-Za-z0-9._][A-Za-z0-9._-]*@)?[A-Za-z0-9_][A-Za-z0-9._-]*$/;

const isPort = (n) => Number.isInteger(n) && n >= 1 && n <= 65535;

/**
 * Turns what the user typed into the hub's base address: http(s), no path, no query, no trailing slash.
 * @returns {{ ok: true, url: string } | { ok: false, message: string }}
 */
export function normalizeHubUrl(raw) {
  const text = String(raw ?? "").trim().replace(/\/+$/, "");
  if (!text) return { ok: false, message: "Enter the hub's address, like http://my-server:8787." };
  if (!/^https?:\/\//i.test(text)) return { ok: false, message: "The address must start with http:// or https://." };
  let u;
  try {
    u = new URL(text);
  } catch {
    return { ok: false, message: "That is not a valid address." };
  }
  if (u.username || u.password) return { ok: false, message: "Leave user names and passwords out of the address." };
  if ((u.pathname && u.pathname !== "/") || u.search || u.hash) return { ok: false, message: "Only the hub's address, without a path (like http://my-server:8787)." };
  return { ok: true, url: `${u.protocol}//${u.host}` };
}

/**
 * Checks a connection setting from the window (or the file) and fills in defaults.
 * @returns {{ ok: true, config: typeof DEFAULT_CONFIG } | { ok: false, errors: Record<string, string> }}
 */
export function validateConfig(input) {
  const src = input && typeof input === "object" ? input : {};
  const errors = {};
  const mode = src.mode === "direct" ? "direct" : src.mode === "ssh" || src.mode == null ? "ssh" : null;
  if (!mode) errors.mode = "Choose Direct or Via SSH.";
  const sshHost = String(src.sshHost ?? DEFAULT_CONFIG.sshHost).trim();
  const remotePort = src.remotePort == null || src.remotePort === "" ? DEFAULT_REMOTE_PORT : Number(src.remotePort);
  const localPort = src.localPort == null || src.localPort === "" ? DEFAULT_LOCAL_PORT : Number(src.localPort);
  let directUrl = String(src.directUrl ?? "").trim();
  if (mode === "ssh") {
    if (!sshHost) errors.sshHost = "Enter an SSH host from your ~/.ssh/config (like homebase-server) or user@host.";
    else if (!SSH_HOST.test(sshHost)) errors.sshHost = "Use a host alias, a host name or user@host: letters, digits, dots, dashes, no spaces.";
    if (!isPort(remotePort)) errors.remotePort = "The hub's port on the server is a number from 1 to 65535.";
    if (!isPort(localPort) || localPort < 1024) errors.localPort = "The local port is a number from 1024 to 65535.";
  }
  if (mode === "direct") {
    const n = normalizeHubUrl(directUrl);
    if (n.ok) directUrl = n.url;
    else errors.directUrl = n.message;
  } else if (directUrl) {
    // Kept for switching back, but only when it is valid.
    const n = normalizeHubUrl(directUrl);
    directUrl = n.ok ? n.url : "";
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, config: { mode, sshHost: sshHost || DEFAULT_CONFIG.sshHost, remotePort, localPort, directUrl } };
}

/**
 * Reads the saved setting. A missing file means the first run (the window asks); a broken file falls back to
 * the defaults and is treated as set, so a bad edit never locks the user out of the app.
 * @param {{ readFileSync: (p: string, enc: string) => string, existsSync: (p: string) => boolean }} fs
 */
export function loadConnectionConfig(file, fs) {
  if (!fs.existsSync(file)) return { config: { ...DEFAULT_CONFIG }, configured: false };
  try {
    const v = validateConfig(JSON.parse(fs.readFileSync(file, "utf8")));
    return v.ok ? { config: v.config, configured: true } : { config: { ...DEFAULT_CONFIG }, configured: true, warning: "The saved connection setting was not valid; using the defaults." };
  } catch {
    return { config: { ...DEFAULT_CONFIG }, configured: true, warning: "The saved connection setting could not be read; using the defaults." };
  }
}

/** @param {{ writeFileSync: Function, renameSync: Function, mkdirSync: Function }} fs */
export function saveConnectionConfig(file, config, fs, dir) {
  if (dir) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, ...config }, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * The ssh command line for the tunnel. BatchMode: never ask for a password or a passphrase (a key that needs
 * one must be in ssh-agent). ExitOnForwardFailure: if the local port is taken, exit instead of running without it.
 * The forward listens on the PC's loopback only.
 */
export function sshArgs(config, localPort) {
  return [
    "-N", "-T",
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-o", "ConnectTimeout=15",
    "-L", `127.0.0.1:${localPort}:127.0.0.1:${config.remotePort}`,
    config.sshHost,
  ];
}

/** Where the window connects, said for people: "homebase-server (SSH)" or the address. */
export function describeTarget(config) {
  return config.mode === "direct" ? config.directUrl || "no address set" : `${config.sshHost} (SSH)`;
}

/**
 * Why ssh stopped, from what it printed. `retry`: false when trying again cannot help until the user fixes
 * something (no ssh, the key is refused, the host key is unknown or changed).
 * @returns {{ code: string, message: string, detail?: string, retry: boolean }}
 */
export function classifySshFailure({ stderr = "", exitCode = null, spawnError = null, host = "the server" } = {}) {
  const detail = lastLines(stderr);
  if (spawnError) {
    if (spawnError.code === "ENOENT") {
      return {
        code: "ssh_missing", retry: false,
        message: "The OpenSSH client (ssh) was not found on this PC. Install it: Windows Settings → System → Optional features → OpenSSH Client. Or switch to Direct if this PC is on Tailscale.",
      };
    }
    return { code: "ssh_failed", retry: true, message: `ssh could not be started: ${spawnError.message}` };
  }
  const s = stderr;
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|host key for .* has changed|No (?:ED25519|RSA|ECDSA)? ?host key is known/i.test(s)) {
    return {
      code: "host_key", retry: false, detail,
      message: `${host}'s host key is not trusted yet (or it changed). Run \`ssh ${host}\` once in a terminal and accept the key, then press Retry.`,
    };
  }
  if (/Permission denied|Too many authentication failures|Authentication failed|no such identity|passphrase|sign_and_send_pubkey|Load key .*: (?:invalid format|bad permissions)/i.test(s)) {
    return {
      code: "auth", retry: false, detail,
      message: `${host} did not accept an SSH key from this PC. HomeBase never asks for a password: \`ssh ${host}\` must work in a terminal without typing one (a key with a passphrase must be loaded into ssh-agent).`,
    };
  }
  if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(s)) {
    return { code: "unreachable", retry: true, detail, message: `Can't find ${host}. Check the host name or your ~/.ssh/config, and the network.` };
  }
  if (/Address already in use|cannot listen to port|Could not request local forwarding|bind \[?127\.0\.0\.1\]?:\d+: /i.test(s)) {
    return { code: "port_in_use", retry: true, detail, message: "The local port for the tunnel was taken; trying another one." };
  }
  if (/timed out|Connection refused|No route to host|Network is unreachable|Connection closed|Connection reset|kex_exchange_identification|Broken pipe|Timeout, server/i.test(s)) {
    return { code: "unreachable", retry: true, detail, message: `Can't reach ${host} over SSH. Check that it is on and that this PC is on its network.` };
  }
  return { code: "ssh_exited", retry: true, detail, message: `The SSH connection to ${host} closed${exitCode != null ? ` (exit ${exitCode})` : ""}.` };
}

function lastLines(text, n = 4) {
  const lines = String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.slice(-n).join("\n") || undefined;
}

// ---------------------------------------------------------------- what the shell runs it with

/** Windows' own OpenSSH first (it reads %USERPROFILE%\.ssh and talks to the Windows ssh-agent), else whatever `ssh` is on PATH. */
export function findSshBinary(env = process.env, platform = process.platform, exists = fs.existsSync) {
  if (env.HB_SSH) return env.HB_SSH;
  if (platform === "win32") {
    const sys = join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "OpenSSH", "ssh.exe");
    if (exists(sys)) return sys;
    return "ssh.exe";
  }
  return "ssh";
}

/** The preferred port when it is free on 127.0.0.1, else one the system picks. */
export function findFreePort(preferred) {
  const tryPort = (port) =>
    new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.unref();
      srv.once("error", reject);
      srv.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
        const p = srv.address().port;
        srv.close(() => resolve(p));
      });
    });
  return (preferred ? tryPort(preferred) : Promise.reject(new Error("no preferred port"))).catch(() => tryPort(0));
}

/** True when the hub at `url` answers its health check. */
export async function probeHub(url, timeoutMs = 4000) {
  try {
    const res = await fetch(`${url}/v1/health`, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
    if (!res.ok) return false;
    const json = await res.json().catch(() => null);
    return json?.ok === true;
  } catch {
    return false;
  }
}

