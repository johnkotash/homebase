// Removes the demo content a hub seeded on first start (HOMEBASE_DEMO=1, or any database made before the baseline
// was empty) and keeps everything else. See src/demo-cleanup.ts for what counts as demo.
// Usage: npm run remove-demo                      → dry run: prints what would be removed and what is kept
//        npm run remove-demo -- --apply           → removes it (stop the hub first; a backup is written next to the database)
//        npm run remove-demo -- --db <file>       → another database file (default: <HOMEBASE_DATA_DIR>/homebase.db)
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { openStore } from "../app";
import { expandHome, loadConfig, loadEnvFile } from "../config";
import { WorkspaceHub } from "../hub/WorkspaceHub";
import {
  ReadOnlyStore, applyDemoRemoval, databaseInUse, formatPlan, planDemoRemoval, planIsEmpty, tableCounts,
} from "../demo-cleanup";

process.removeAllListeners("warning");
loadEnvFile();
const cfg = loadConfig();
const argv = process.argv.slice(2);
const at = argv.indexOf("--db");
const defaultDb = join(cfg.dataDir, "homebase.db");
const dbPath = at >= 0 && argv[at + 1] ? resolve(expandHome(argv[at + 1])) : defaultDb;
const apply = argv.includes("--apply");

if (!existsSync(dbPath)) {
  console.error(`No database at ${dbPath}.`);
  process.exit(1);
}

/** Answers when something serves HTTP on the configured hub address. */
async function hubAnswers(): Promise<string | null> {
  const host = cfg.host.split(",")[0]?.trim() || "127.0.0.1";
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${cfg.port}/`;
  try {
    await fetch(url, { signal: AbortSignal.timeout(1500) });
    return url;
  } catch {
    return null;
  }
}

const printCounts = (title: string, before: Record<string, number>, after?: Record<string, number>) => {
  console.log("", title);
  for (const [t, n] of Object.entries(before)) console.log(`  ${t.padEnd(16)} ${String(n).padStart(7)}${after ? `  ->  ${String(after[t] ?? 0).padStart(7)}` : ""}`);
};

console.log(`Database: ${dbPath}${apply ? "" : "  (dry run: nothing is changed)"}`);

if (!apply) {
  const ro = new ReadOnlyStore(dbPath);
  try {
    const plan = planDemoRemoval(ro);
    for (const line of formatPlan(plan)) console.log(line);
    printCounts("Rows per table now (everything not listed above is kept):", tableCounts(ro));
    if (!planIsEmpty(plan)) console.log("\nRun again with --apply to remove it. Stop the hub first.");
  } finally {
    ro.close();
  }
  process.exit(0);
}

// --apply: the running hub keeps state in memory and would not see these changes, so it must be stopped.
if (databaseInUse(dbPath)) {
  console.error("The database is open in another process (a running hub?). Stop the hub, then run this again.");
  process.exit(2);
}
if (dbPath === defaultDb) {
  const url = await hubAnswers();
  if (url) {
    console.error(`A hub answers at ${url}. Stop it, then run this again.`);
    process.exit(2);
  }
}

const store = openStore(dbPath);
const hub = new WorkspaceHub(store, { quiet: true });
try {
  const plan = planDemoRemoval(store);
  for (const line of formatPlan(plan)) console.log(line);
  if (planIsEmpty(plan)) process.exit(0);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = join(dirname(dbPath), `${basename(dbPath, ".db")}.before-remove-demo-${stamp}.db`);
  store.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  console.log(`\nBackup written: ${backup}`);
  const before = tableCounts(store);
  applyDemoRemoval(hub, plan);
  printCounts("Rows per table (before -> after):", before, tableCounts(store));
  console.log("\nDone. Start the hub again; paired devices drop the removed rows on their next sync.");
} finally {
  store.close();
}
