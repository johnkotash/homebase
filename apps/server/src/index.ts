import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startHub } from "./app";
import { loadConfig, loadEnvFile } from "./config";
import { VERSION } from "./http";
import { simulate } from "./ingest/simulator";
import type { SimKind } from "@homebase/protocol";

process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name === "ExperimentalWarning" && /SQLite/i.test(w.message)) return; // expected on Node 24
  console.warn(w.name + ": " + w.message);
});

loadEnvFile();
const cfg = loadConfig();
mkdirSync(cfg.dataDir, { recursive: true });
const dbPath = join(cfg.dataDir, "homebase.db");

const app = await startHub({ dbPath, port: cfg.port, host: cfg.host, devMode: cfg.devMode, slaTickMs: cfg.slaTickMs, webDir: cfg.webDir, seed: { workspaceName: cfg.workspaceName, demo: cfg.demo } });
const { hub, directory } = app;

// Boot codes live for 24 h in dev so `npm run dev` can be left running; codes made in Settings last 10 minutes.
// On a server (HOMEBASE_BOOT_CODES=0) no code is minted or logged at boot; use `npm run pair-code` instead.
const ttl = cfg.devMode ? 24 * 60 * 60_000 : 10 * 60_000;
const deviceCode = cfg.bootCodes ? directory.createPairingCode("device", null, ttl) : null;
const connectorCode = cfg.bootCodes ? directory.createPairingCode("connector", null, ttl) : null;
// The connector reads this file on first run when no --pair flag or HB_PAIR_CODE is given (dev convenience).
if (connectorCode) writeFileSync(join(cfg.dataDir, "dev-pairing.json"), JSON.stringify({ hub: app.url, connectorCode: connectorCode.code, expiresAt: connectorCode.expiresAt }, null, 2));

const ws = hub.workspace();
console.log("");
console.log(`  HomeBase hub ${VERSION}`);
console.log(`  Workspace     ${ws.name} (${ws.timezone})${app.seeded ? (cfg.demo ? "  [created, with demo data]" : "  [created]") : ""}`);
console.log(`  HTTP          ${app.url}${cfg.host.includes(",") ? `  (listening on ${cfg.host})` : ""}`);
console.log(`  WebSocket     ${app.wsUrl}`);
console.log(`  Database      ${dbPath}`);
console.log(`  Web client    ${app.web ? `${app.web.dir} (served at /)` : `none${cfg.webDir ? ` (no index.html in ${cfg.webDir})` : " (HOMEBASE_WEB_DIR=off)"}`}`);
if (cfg.publicUrl) console.log(`  Devices use   ${cfg.publicUrl}`);
else console.log(`  Android emulator reaches this hub at http://10.0.2.2:${app.port}`);
console.log("");
if (deviceCode && connectorCode) {
  console.log(`  ┌──────────────────────────────────────────┐`);
  console.log(`  │  Device pairing code:     ${deviceCode.code}      │`);
  console.log(`  │  Connector pairing code:  ${connectorCode.code}      │`);
  console.log(`  └──────────────────────────────────────────┘`);
  console.log(`  Single use. More codes: Settings → Devices in a paired app, or \`npm run pair-code\`.`);
} else {
  console.log("  No pairing codes are printed at boot. Run `npm run pair-code` for a device code.");
}
console.log("");

if (cfg.simIntervalSec > 0) {
  const kinds: SimKind[] = ["gmail", "clickup", "resend", "calendar", "gmail", "monitor"];
  let i = 0;
  setInterval(() => {
    const item = hub.ingest(simulate(kinds[i++ % kinds.length], hub.now()));
    hub.log(`simulated ${item.source} item (${item.priority}): ${item.title}`);
  }, cfg.simIntervalSec * 1000);
  console.log(`  Simulating an inbox item every ${cfg.simIntervalSec}s`);
}

const shutdown = async () => {
  console.log("\n[hub] shutting down");
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
