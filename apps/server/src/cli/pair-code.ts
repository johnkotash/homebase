// Prints a fresh pairing code by writing straight to the hub database (WAL allows this while the hub runs).
// Usage: npm run pair-code                    → device code, valid 10 minutes
//        npm run pair-code connector          → connector code
//        npm run pair-code -- --ttl 1440      → device code valid for a day
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, loadEnvFile } from "../config";
import { Directory } from "../directory";
import { NodeSqlStore } from "../hub/SqlStore";

process.removeAllListeners("warning");
loadEnvFile();
const cfg = loadConfig();
const dbPath = join(cfg.dataDir, "homebase.db");
if (!existsSync(dbPath)) {
  console.error(`No database at ${dbPath}. Start the hub once first: npm run dev:server`);
  process.exit(1);
}
const kind = process.argv[2] === "connector" ? "connector" : "device";
const store = new NodeSqlStore(dbPath);
// --ttl <minutes>: how long the code stays valid (default 10, at most 7 days).
const ttlAt = process.argv.indexOf("--ttl");
const ttlMin = Math.min(7 * 24 * 60, Math.max(1, Number(ttlAt > 0 ? process.argv[ttlAt + 1] : 10) || 10));
const { code, expiresAt } = new Directory(store).createPairingCode(kind, null, ttlMin * 60_000);
store.close();
if (process.argv.includes("--raw")) console.log(code);
else console.log(`${kind} pairing code: ${code}  (single use, expires ${new Date(expiresAt).toLocaleString()})`);
