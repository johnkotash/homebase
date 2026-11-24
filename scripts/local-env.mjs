// Reads the repo's untracked `.env.local` (copy `.env.example`) for the build scripts. Only HOMEBASE_* keys are
// taken, so nothing in it can end up inlined in a client bundle; variables already set in the environment win.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function loadLocalEnv(root = REPO_ROOT, env = process.env) {
  const file = join(root, ".env.local");
  if (!existsSync(file)) return {};
  const vars = Object.fromEntries(Object.entries(parseEnv(readFileSync(file, "utf8"))).filter(([k]) => k.startsWith("HOMEBASE_")));
  for (const [k, v] of Object.entries(vars)) if (env[k] === undefined) env[k] = v;
  return vars;
}

/** The app id for the Android package and the Windows installer (HOMEBASE_APP_ID). */
export const DEFAULT_APP_ID = "com.kotashbuilds.homebase";
export const appId = (env = process.env) => env.HOMEBASE_APP_ID?.trim() || DEFAULT_APP_ID;
