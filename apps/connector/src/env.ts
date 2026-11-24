// Loaded first by index.ts. Server deployments keep their settings in `~/.config/homebase/homebase.env`
// (or HOMEBASE_ENV_FILE); the hub reads the same file. Variables already set in the environment win.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const raw = process.env.HOMEBASE_ENV_FILE ?? "~/.config/homebase/homebase.env";
const path = resolve(raw.startsWith("~/") ? join(homedir(), raw.slice(1)) : raw);
if (existsSync(path)) process.loadEnvFile(path);
