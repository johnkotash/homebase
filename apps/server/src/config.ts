import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../..");

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  devMode: boolean;
  simIntervalSec: number;
  slaTickMs: number;
  /** Mint and print a device + connector pairing code at boot (dev convenience). Off on a server. */
  bootCodes: boolean;
  /** The address devices should use, when it differs from the bind address (e.g. a `tailscale serve` URL). Printed only. */
  publicUrl: string | null;
  /** The web client's files (Expo web export) served at /. Default: apps/client/dist in the repo; "off" turns it off. */
  webDir: string | null;
  /** The workspace name used when the database is created (HOMEBASE_WORKSPACE_NAME). */
  workspaceName: string;
  /** Fill a new database with invented demo content (HOMEBASE_DEMO=1). Off: a new workspace starts empty. */
  demo: boolean;
}

/** `~/x` → the user's home directory, so paths in unit files and env files stay readable. */
export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? join(homedir(), p.slice(1)) : p;
}

/**
 * Server deployments keep their settings in one file, `~/.config/homebase/homebase.env` (or the path in
 * HOMEBASE_ENV_FILE), so the hub service, the connector service and `npm run pair-code` all agree on the
 * data directory. Variables already set in the environment win. Does nothing when the file is absent.
 */
export function loadEnvFile(env: NodeJS.ProcessEnv = process.env): string | null {
  const path = resolve(expandHome(env.HOMEBASE_ENV_FILE ?? "~/.config/homebase/homebase.env"));
  if (!existsSync(path)) return null;
  process.loadEnvFile(path);
  return path;
}

function webDirFrom(v: string | undefined): string | null {
  const t = v?.trim();
  if (t && /^(off|0|false|none)$/i.test(t)) return null;
  return resolve(expandHome(t || resolve(REPO_ROOT, "apps", "client", "dist")));
}

/** "1", "true", "yes" or "on" (any case). Anything else, or unset, is off. */
export function isOn(v: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(v?.trim() ?? "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.HOMEBASE_PORT ?? env.PORT ?? 8787),
    // Loopback by default: the hub speaks cleartext. The Android emulator reaches it at 10.0.2.2.
    // On a server keep loopback and put `tailscale serve` in front, or bind one specific private
    // address (a tailnet IP). Never 0.0.0.0.
    host: env.HOMEBASE_HOST ?? env.HOST ?? "127.0.0.1",
    dataDir: resolve(expandHome(env.HOMEBASE_DATA_DIR ?? env.DATA_DIR ?? resolve(REPO_ROOT, "data"))),
    devMode: (env.DEV_MODE ?? "1") !== "0",
    simIntervalSec: Number(env.SIM_INTERVAL_SEC ?? 0),
    slaTickMs: Number(env.SLA_TICK_MS ?? 30_000),
    bootCodes: (env.HOMEBASE_BOOT_CODES ?? "1") !== "0",
    publicUrl: env.HOMEBASE_PUBLIC_URL?.trim() || null,
    webDir: webDirFrom(env.HOMEBASE_WEB_DIR),
    workspaceName: env.HOMEBASE_WORKSPACE_NAME?.trim() || "HomeBase",
    demo: isOn(env.HOMEBASE_DEMO),
  };
}
