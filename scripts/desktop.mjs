#!/usr/bin/env node
// `npm run desktop`: starts the Expo web dev server if it is not already running, then opens Electron on it.
// Extra args are passed to Electron, e.g. `npm run desktop -- --remote-debugging-port=9222`.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const electron = require(join(root, "node_modules", "electron")); // path to the Electron binary
const PORT = 8081;

const portOpen = () =>
  new Promise((res) => {
    const s = createConnection({ port: PORT, host: "127.0.0.1" });
    s.once("connect", () => (s.destroy(), res(true)));
    s.once("error", () => res(false));
  });

let web = null;
if (!(await portOpen())) {
  console.log("[desktop] starting the web dev server (expo start --web)...");
  web = spawn(process.execPath, [join(root, "node_modules", "expo", "bin", "cli"), "start", "--web", "--port", String(PORT)], {
    cwd: join(root, "apps", "client"), stdio: "ignore", env: { ...process.env, BROWSER: "none" },
  });
  for (let i = 0; i < 120 && !(await portOpen()); i++) await new Promise((r) => setTimeout(r, 500));
}

const child = spawn(electron, [join(root, "apps", "desktop"), ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code) => {
  web?.kill();
  process.exit(code ?? 0);
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill());
