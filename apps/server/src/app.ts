import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Directory } from "./directory";
import { createHttpApp } from "./http";
import { NodeSqlStore, type SqlStore } from "./hub/SqlStore";
import { WorkspaceHub, type HubOptions } from "./hub/WorkspaceHub";
import { seed, type SeedOptions } from "./seed";
import { attachWebSocket } from "./ws";
import { sweepOrphanAttachments } from "./attachments";
import { openWebDir, type WebDir } from "./web";

export const SCHEMA_SQL = readFileSync(fileURLToPath(new URL("./schema.sql", import.meta.url)), "utf8");

export function openStore(path: string): SqlStore {
  const store = new NodeSqlStore(path);
  store.exec(SCHEMA_SQL);
  // Columns added after a database was first created. Existing data is never rewritten.
  const ADDED: Record<string, string[]> = {
    // Claude agent; permission modes and the auth proof; Gmail status. Then model and effort: what the connector offers
    // and is configured with, and the owner's default. All empty on an existing row: the agent runs as it did before.
    agents: ["status_note", "modes", "default_mode", "auth", "gmail", "vault", "models", "efforts", "config_model", "config_effort", "default_model", "default_effort", "images",
      // Folders (2026-11-22, round 6): what the connector has approved, and the owner's default folders for the agent. Empty: as before.
      "folders", "default_cwd", "default_folders"],
    messages: ["card", "attachments"], // "Draft saved in Gmail" cards; pictures the owner attached (2026-11-23)
    // Session organisation (2026-11-22). Every existing thread keeps its row; with no project_id it is in Unsorted.
    // Unread state (last_agent_at, read_at): empty on old rows until the hub's backfill marks them read.
    // A session's own model and effort, and when it was last given a fresh agent session: empty means "follow the agent".
    threads: ["mode", "project_id", "note", "summary", "recap", "recap_at INTEGER", "recap_run_id", "last_run_status", "last_agent_at INTEGER", "read_at INTEGER", "model", "effort", "session_reset_at INTEGER", "image_route",
      // A session's own primary folder and extra folders (round 6). Empty on old rows; the hub writes down where each old session already works.
      "cwd", "folders"],
    // Who makes images in a project's sessions by default (2026-11-22, round 5). Empty: Auto.
    // ... and the extra folders every session in a project gets (round 6). Empty: none.
    projects: ["image_route", "folders"],
    runs: ["mode", "model", "effort", "folders"],
    approvals: ["mode"],
  };
  for (const [table, cols] of Object.entries(ADDED)) {
    const have = store.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);
    for (const def of cols) {
      const [col, type = "TEXT"] = def.split(" ");
      if (!have.includes(col)) store.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
    }
  }
  return store;
}

export interface HubApp {
  hub: WorkspaceHub;
  directory: Directory;
  store: SqlStore;
  server: Server;
  port: number;
  url: string;
  wsUrl: string;
  seeded: boolean;
  /** Where attached pictures are kept. */
  attachmentsDir: string;
  /** The web client this hub serves at /, or null. */
  web: WebDir | null;
  close(): Promise<void>;
}

export interface StartOptions extends HubOptions {
  dbPath: string;
  port?: number;
  host?: string;
  seed?: SeedOptions;
  slaTickMs?: number;
  helloTimeoutMs?: number;
  /** Where the bytes of images made in sessions are kept. Default: an `artifacts` folder next to the database. */
  artifactsDir?: string;
  /** Where pictures the owner attaches to messages are kept. Default: an `attachments` folder next to the database. */
  attachmentsDir?: string;
  /** The Expo web export to serve at / (web.ts). Absent or without index.html: / answers with the hub's JSON. */
  webDir?: string | null;
}

/** Boots a hub: database, seed, HTTP and WebSocket. Used by the CLI entry point and by tests. */
export async function startHub(opts: StartOptions): Promise<HubApp> {
  const store = openStore(opts.dbPath);
  const hub = new WorkspaceHub(store, opts);
  const seeded = seed(hub, opts.seed);
  const directory = new Directory(store, hub.now);
  const artifactsDir = opts.artifactsDir ?? (opts.dbPath === ":memory:" ? mkdtempSync(join(tmpdir(), "hb-artifacts-")) : join(dirname(opts.dbPath), "artifacts"));
  // An in-memory hub (tests) keeps its pictures in a temporary folder, removed again when it closes.
  const tempAttachments = !opts.attachmentsDir && opts.dbPath === ":memory:";
  const attachmentsDir = opts.attachmentsDir ?? (tempAttachments ? mkdtempSync(join(tmpdir(), "hb-attachments-")) : join(dirname(opts.dbPath), "attachments"));
  const web = openWebDir(opts.webDir);
  const app = createHttpApp(hub, directory, { artifactsDir, attachmentsDir, web });
  // Uploads that no message took are cleared after a week (never a sent picture). Once at start, then twice a day.
  const sweep = () => {
    try {
      const n = sweepOrphanAttachments(store, attachmentsDir, hub.now());
      if (n) hub.log(`attachments: removed ${n} upload(s) never sent`);
    } catch (err) {
      hub.log(`attachments: sweep failed: ${(err as Error).message}`);
    }
  };
  sweep();
  const sweeper = setInterval(sweep, 12 * 60 * 60_000);
  sweeper.unref();
  // `host` may list several addresses ("127.0.0.1,100.64.1.2"): loopback for the local connector and
  // `tailscale serve`, plus one private address for phones. A wildcard would expose the cleartext hub
  // on every interface, so it is refused.
  const hosts = (opts.host ?? "127.0.0.1").split(",").map((h) => h.trim()).filter(Boolean);
  if (hosts.some((h) => h === "0.0.0.0" || h === "::" || h === "*")) throw new Error("Refusing to bind the hub to every interface. Use 127.0.0.1 and/or one private address.");
  const host = hosts[0] ?? "127.0.0.1";
  const listen = (hostname: string, p: number) =>
    new Promise<Server>((resolve, reject) => {
      const s = serve({ fetch: app.fetch, port: p, hostname }, () => resolve(s as unknown as Server)) as unknown as Server;
      s.once("error", reject);
    });
  const server = await listen(host, opts.port ?? 0);
  const port = (server.address() as AddressInfo).port;
  const extra: Server[] = [];
  for (const h of hosts.slice(1)) extra.push(await listen(h, port));
  const wss = attachWebSocket([server, ...extra], hub, directory, { helloTimeoutMs: opts.helloTimeoutMs });
  hub.start(opts.slaTickMs ?? 30_000);
  return {
    hub, directory, store, server, port, seeded, attachmentsDir, web,
    url: `http://${host}:${port}`,
    wsUrl: `ws://${host}:${port}/v1/ws`,
    close: () =>
      new Promise<void>((resolve) => {
        hub.stop();
        clearInterval(sweeper);
        for (const c of wss.clients) c.terminate();
        wss.close();
        for (const s of extra) {
          (s as any).closeAllConnections?.();
          s.close();
        }
        (server as any).closeAllConnections?.();
        server.close(() => {
          store.close();
          if (tempAttachments) rmSync(attachmentsDir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}
