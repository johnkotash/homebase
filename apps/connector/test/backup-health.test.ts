import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InboundFrame, type InboxItem } from "@homebase/protocol";
import type { HubApp } from "../../server/src/app";
import { BackupMonitor, assessBackup, backupHealthConfig, readBackupStatus, type BackupHealthConfig } from "../src/backup-health";
import { queryEntities } from "../../server/src/hub/tables";
import { HubLink } from "../src/HubLink";
import { bootHub, connectDevice, pairToken, waitFor } from "./harness";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-01-10T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("backup alert settings", () => {
  it("defaults: auto, the status file in the data folder, every 10 minutes, overdue after 3 hours", () => {
    const cfg = backupHealthConfig({ HOMEBASE_DATA_DIR: "/home/me/homebase-data" });
    expect(cfg).toEqual({ mode: "auto", statusFile: resolve("/home/me/homebase-data/.backup-status.json"), checkMs: 10 * 60_000, staleMs: 3 * HOUR });
  });

  it("takes configured values and ignores nonsense", () => {
    const cfg = backupHealthConfig({ HB_BACKUP_ALERTS: "on", HB_BACKUP_STATUS_FILE: "/srv/backup/status.json", HB_BACKUP_CHECK_MINUTES: "5", HB_BACKUP_STALE_HOURS: "26" });
    expect(cfg).toEqual({ mode: "on", statusFile: resolve("/srv/backup/status.json"), checkMs: 5 * 60_000, staleMs: 26 * HOUR });
    expect(backupHealthConfig({ HB_BACKUP_ALERTS: "0" }).mode).toBe("off");
    expect(backupHealthConfig({ HB_BACKUP_ALERTS: "off" }).mode).toBe("off");
    const bad = backupHealthConfig({ HB_BACKUP_CHECK_MINUTES: "0", HB_BACKUP_STALE_HOURS: "soon" });
    expect([bad.checkMs, bad.staleMs]).toEqual([10 * 60_000, 3 * HOUR]);
  });

  it("the frame takes monitor alerts and resolves only, with a plain id and no priority", () => {
    const item = { source: "monitor", kind: "alert", externalId: "backup:failed:1", title: "Backup failed" };
    expect(InboundFrame.safeParse({ t: "inbox.ingest", item }).success).toBe(true);
    expect(InboundFrame.safeParse({ t: "inbox.ingest", item: { ...item, kind: "resolve" } }).success).toBe(true);
    expect(InboundFrame.safeParse({ t: "inbox.ingest", item: { ...item, kind: "mail" } }).success).toBe(false);
    expect(InboundFrame.safeParse({ t: "inbox.ingest", item: { ...item, externalId: "backup:%" } }).success).toBe(false);
    expect(JSON.stringify(InboundFrame.parse({ t: "inbox.ingest", item: { ...item, priority: "P0" } }))).not.toContain("P0");
  });
});

describe("assessing the status file", () => {
  const cfg: BackupHealthConfig = { mode: "auto", statusFile: "/x/.backup-status.json", checkMs: 600_000, staleMs: 3 * HOUR };
  const ok = { at: T0, result: "ok" as const, message: "abc 2026-01-10", lastOkAt: T0 };

  it("a fresh success is healthy; a failure and staleness are separate conditions keyed by the last success", () => {
    expect(assessBackup(ok, cfg, T0 + HOUR, T0)).toEqual({ failed: null, overdue: null });
    const failed = assessBackup({ ...ok, at: T0 + HOUR, result: "failed", message: "restic backup failed (exit 1)" }, cfg, T0 + HOUR, T0)!;
    expect(failed.failed).toMatchObject({ externalId: `backup:failed:${T0}`, title: "Backup failed", snippet: expect.stringContaining("restic backup failed (exit 1)") });
    expect(failed.overdue).toBeNull();
    const stale = assessBackup(ok, cfg, T0 + 4 * HOUR, T0)!;
    expect(stale).toMatchObject({ failed: null, overdue: { externalId: `backup:overdue:${T0}`, title: "Backup overdue" } });
    expect(stale.overdue!.snippet).toContain("2026-01-10 12:00 UTC");
  });

  it("no opinion when alerts are off, the file is unreadable, or missing in auto mode; on mode counts a missing file as overdue", () => {
    expect(assessBackup({ ...ok, result: "failed" }, { ...cfg, mode: "off" }, T0, T0)).toBeNull();
    expect(assessBackup("unreadable", cfg, T0, T0)).toBeNull();
    expect(assessBackup("missing", cfg, T0 + 10 * HOUR, T0)).toBeNull();
    expect(assessBackup("missing", { ...cfg, mode: "on" }, T0 + HOUR, T0)).toBeNull();
    expect(assessBackup("missing", { ...cfg, mode: "on" }, T0 + 4 * HOUR, T0)!.overdue).toMatchObject({ externalId: "backup:overdue:missing" });
  });

  it("reads an older status file without lastOkAt, and a half-written one as unreadable", () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-backup-read-"));
    try {
      const f = join(dir, "s.json");
      writeFileSync(f, JSON.stringify({ at: iso(T0), result: "ok", message: "m" }));
      expect(readBackupStatus(f)).toEqual({ at: T0, result: "ok", message: "m", lastOkAt: T0 });
      writeFileSync(f, '{"at":"2026');
      expect(readBackupStatus(f)).toBe("unreadable");
      expect(readBackupStatus(join(dir, "none.json"))).toBe("missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** The monitor end to end: real hub, real socket, a status file on disk and a clock the test moves. */
describe("backup alerts through the hub", () => {
  let app: HubApp | null = null;
  let link: HubLink | null = null;
  const clients: Array<{ client: { stop(): void } }> = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) c.client.stop();
    link?.stop();
    link = null;
    await app?.close();
    app = null;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function boot(mode: BackupHealthConfig["mode"] = "auto") {
    const dir = mkdtempSync(join(tmpdir(), "hb-backup-"));
    dirs.push(dir);
    const statusFile = join(dir, ".backup-status.json");
    app = await bootHub();
    const { token } = pairToken(app, "connector", "backup-connector");
    link = new HubLink({ hubUrl: app.url, token, name: "backup-connector", log: () => {}, agents: [] });
    link.start();
    await link.whenReady();
    const phone = await connectDevice(app, "Phone");
    clients.push(phone);
    let now = T0;
    const monitor = new BackupMonitor({
      config: { mode, statusFile, checkMs: 600_000, staleMs: 3 * HOUR }, emit: (item) => link?.ingestInbox(item) ?? false, now: () => now,
    });
    const write = (s: object) => writeFileSync(statusFile, JSON.stringify(s));
    const items = () => queryEntities<InboxItem>(app!.store, "inbox_items", "WHERE source = 'monitor' AND external_id LIKE 'backup:%' ORDER BY created_at, id");
    let n = 0;
    const settle = async () => {
      // Frames are applied in order: once a marker item sent after them is in, so is everything before it.
      const marker = `settle:${++n}`;
      link!.ingestInbox({ source: "monitor", kind: "alert", externalId: marker, title: "settle" });
      await waitFor(() => queryEntities<InboxItem>(app!.store, "inbox_items", "WHERE source = 'monitor' AND external_id = ?", marker)[0], "frames applied");
    };
    const check = async (at: number) => {
      now = at;
      const sent = monitor.check();
      await settle();
      return sent;
    };
    return { monitor, write, items, check, phone, statusFile };
  }

  it("ok → nothing; failed → one P1 alert and a notification; repeated checks → still one; recovery → resolved", async () => {
    const s = await boot();
    s.write({ at: iso(T0), result: "ok", message: "snap1", lastOkAt: iso(T0) });
    await s.check(T0 + 60_000);
    expect(s.items()).toHaveLength(0);

    s.write({ at: iso(T0 + HOUR), result: "failed", message: "restic backup failed (exit 1): connection refused", lastOkAt: iso(T0) });
    await s.check(T0 + HOUR + 60_000);
    await waitFor(() => s.items().length === 1, "one alert");
    const [alert] = s.items();
    expect(alert).toMatchObject({ source: "monitor", title: "Backup failed", priority: "P1", status: "new", sender: "Backup monitor", externalId: `backup:failed:${T0}` });
    expect(alert.snippet).toContain("connection refused");
    expect(alert.triageReason).toContain("backup-connector");
    const notified = await waitFor(() => s.phone.notifications.find((n) => n.title === "Backup failed"), "P1 notification");
    expect(notified).toMatchObject({ priority: "P1", channel: "p1_today" });

    // The same failure checked again, and the next hourly failure: still one item, one notification.
    expect(await s.check(T0 + HOUR + 11 * 60_000)).toEqual([]);
    s.write({ at: iso(T0 + 2 * HOUR), result: "failed", message: "restic backup failed (exit 1): timeout", lastOkAt: iso(T0) });
    await s.check(T0 + 2 * HOUR + 60_000);
    await waitFor(() => s.items()[0]?.snippet?.includes("timeout"), "alert updated");
    expect(s.items()).toHaveLength(1);
    expect(s.phone.notifications.filter((n) => n.title === "Backup failed")).toHaveLength(1);

    // Recovery closes it by itself.
    s.write({ at: iso(T0 + 3 * HOUR), result: "ok", message: "snap2", lastOkAt: iso(T0 + 3 * HOUR) });
    await s.check(T0 + 3 * HOUR + 60_000);
    const done = (await waitFor(() => (s.items()[0]?.status === "done" ? s.items()[0] : null), "resolved")) as InboxItem;
    expect(done.snippet).toMatch(/^Resolved: backup succeeded at /);
    expect(s.items()).toHaveLength(1);

    // A failure after that recovery is a new item.
    s.write({ at: iso(T0 + 4 * HOUR), result: "failed", message: "restic backup failed (exit 1)", lastOkAt: iso(T0 + 3 * HOUR) });
    await s.check(T0 + 4 * HOUR + 60_000);
    await waitFor(() => s.items().length === 2, "second episode");
    expect(s.items().filter((i) => i.status === "new")).toHaveLength(1);
  });

  it("no success for longer than the threshold → an overdue alert, resolved by the next success", async () => {
    const s = await boot();
    s.write({ at: iso(T0), result: "ok", message: "snap1", lastOkAt: iso(T0) });
    await s.check(T0 + 2 * HOUR);
    expect(s.items()).toHaveLength(0);
    await s.check(T0 + 3 * HOUR + 60_000);
    const overdue = (await waitFor(() => s.items()[0], "overdue")) as InboxItem;
    expect(overdue).toMatchObject({ title: "Backup overdue", priority: "P1", status: "new", externalId: `backup:overdue:${T0}` });
    await s.check(T0 + 5 * HOUR);
    expect(s.items()).toHaveLength(1);
    s.write({ at: iso(T0 + 5 * HOUR), result: "ok", message: "snap2", lastOkAt: iso(T0 + 5 * HOUR) });
    await s.check(T0 + 5 * HOUR + 60_000);
    await waitFor(() => s.items()[0]?.status === "done", "overdue resolved");
  });

  it("an alert you closed stays closed while the same failure goes on", async () => {
    const s = await boot();
    s.write({ at: iso(T0), result: "failed", message: "boom", lastOkAt: iso(T0 - HOUR) });
    await s.check(T0);
    const item = (await waitFor(() => s.items()[0], "alert")) as InboxItem;
    await s.phone.client.mutate("inbox.update", { itemId: item.id, status: "done" });
    await waitFor(() => s.items()[0]?.status === "done", "closed");
    s.write({ at: iso(T0 + HOUR), result: "failed", message: "boom again", lastOkAt: iso(T0 - HOUR) });
    await s.check(T0 + HOUR);
    await waitFor(() => s.items()[0]?.snippet?.includes("boom again"), "updated");
    expect(s.items()).toHaveLength(1);
    expect(s.items()[0].status).toBe("done");
  });

  it("file missing → nothing; alerts off → nothing even when the backup failed", async () => {
    const s = await boot();
    await s.check(T0 + 10 * HOUR);
    expect(s.items()).toHaveLength(0);
    const off = new BackupMonitor({ config: { ...s.monitor.config, mode: "off" }, emit: () => true });
    s.write({ at: iso(T0), result: "failed", message: "boom", lastOkAt: null });
    expect(off.enabled).toBe(false);
    expect(off.check()).toEqual([]);
  });

  it("with alerts on, a status file that never appears is overdue after the threshold", async () => {
    const s = await boot("on");
    await s.check(T0 + HOUR);
    expect(s.items()).toHaveLength(0);
    await s.check(T0 + 4 * HOUR);
    await waitFor(() => s.items()[0]?.externalId === "backup:overdue:missing", "missing overdue");
  });
});
